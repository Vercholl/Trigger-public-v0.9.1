// Ретеншн журнала MessageEvent (Task 63): окно хранения N дней (настройка
// «Хранить журнал событий доставки», 0 = не удалять) + выгрузка удаляемых
// строк в gz-архив перед удалением.
//
// ЗАЧЕМ: при 6 млн SMS/мес журнал растёт на ~3 ГБ/мес (нагрузочный тест
// Task 62, §8.2 — «ретеншн обязателен»). SmsMessage — бизнес-таблица со
// статусами, не трогается; чистится только append-only журнал событий.
//
// Контракт:
//   • удалению подлежат события receivedAt < cutoff (окно настройки);
//   • при включённом форвардере очередь НЕ удаляется: строки с forwardedAt
//     IS NULL и forwardSkip = false ждут доставки в BI (обратный поток);
//   • перед удалением строки выгружаются в db/message-events-archive/:
//     current.jsonl (plain, доклеивается батчами) → при смене месяца или
//     превышении 1 ГБ упаковывается в message-events-YYYY-MM.jsonl.gz
//     (stream gzip, tmp+rename — атомарно);
//   • батчи по 2000 строк, ≤50 тыс. за прогон (раз в 5 мин из cleanup
//     воркера) — дренаж многомиллионного хвоста растягивается мягко,
//     без длинных транзакций;
//   • после удаления: freelist > 512 МБ → VACUUM (не чаще раза в сутки;
//     SQLite не возвращает страницы файлу без VACUUM).
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, appendFileSync, renameSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { join, dirname, resolve } from 'node:path';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/services/settings';

const ARCHIVE_SUBDIR = 'message-events-archive';
const BATCH = 2000;
const MAX_PER_RUN = 50_000;
const ROTATE_SIZE_BYTES = 1024 * 1024 * 1024; // 1 ГБ
const VACUUM_FREE_BYTES = 512 * 1024 * 1024; // 512 МБ
const VACUUM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Каталог архива — рядом с файлом БД (db/message-events-archive). */
function archiveDir(): string {
  const raw = (process.env.DATABASE_URL ?? '').replace(/^file:/, '').split('?')[0];
  const dbDir = raw !== '' ? dirname(resolve(raw)) : resolve('db');
  return join(dbDir, ARCHIVE_SUBDIR);
}

/** Строка JSONL: полная строка таблицы; JSON-поля payload/result/externalIds
 *  разворачиваются в объекты (читаемость архива), при кривом JSON — строкой. */
function rowToLine(row: Record<string, unknown>): string {
  const out: Record<string, unknown> = { ...row };
  for (const key of ['payload', 'result', 'externalIds']) {
    const v = out[key];
    if (typeof v === 'string' && v !== '') {
      try {
        out[key] = JSON.parse(v);
      } catch {
        // оставляем сырой текст
      }
    }
  }
  return JSON.stringify(out);
}

/** gzip файла: потоково во временный файл + атомарный rename. */
function gzipFile(src: string, dst: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const tmp = `${dst}.tmp`;
    const rs = createReadStream(src);
    const gz = createGzip({ level: 6 });
    const ws = createWriteStream(tmp);
    rs.pipe(gz).pipe(ws);
    ws.on('finish', () => {
      try {
        renameSync(tmp, dst);
        resolvePromise();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    ws.on('error', reject);
    rs.on('error', reject);
    gz.on('error', reject);
  });
}

/** Ротация staging-файла: сменился месяц по mtime или файл > 1 ГБ →
 *  message-events-YYYY-MM.jsonl.gz; staging начинается заново. */
async function rotateIfNeeded(current: string, now: Date): Promise<void> {
  if (!existsSync(current)) return;
  const st = statSync(current);
  if (st.size === 0) return;
  const stamp = `${st.mtime.getUTCFullYear()}-${String(st.mtime.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthChanged =
    st.mtime.getUTCFullYear() !== now.getUTCFullYear() || st.mtime.getUTCMonth() !== now.getUTCMonth();
  if (!monthChanged && st.size < ROTATE_SIZE_BYTES) return;
  await gzipFile(current, join(dirname(current), `message-events-${stamp}.jsonl.gz`));
  unlinkSync(current);
}

/** Выгрузка батча в архив (staging append + ротация по надобности). */
async function archiveBatch(rows: Record<string, unknown>[]): Promise<void> {
  const dir = archiveDir();
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const current = join(dir, 'current.jsonl');
  await rotateIfNeeded(current, now);
  appendFileSync(current, rows.map(rowToLine).join('\n') + '\n');
}

// ---------- VACUUM-гард ----------

let lastVacuumAt = 0;

/** VACUUM при большом freelist (страницы от удалённого не возвращаются файлу).
 *  Не чаще раза в сутки; сбой не критичен (следующий прогон повторит). */
async function maybeVacuum(): Promise<void> {
  if (Date.now() - lastVacuumAt < VACUUM_MIN_INTERVAL_MS) return;
  try {
    const fl = await db.$queryRawUnsafe<{ freelist_count: number }[]>('PRAGMA freelist_count');
    const ps = await db.$queryRawUnsafe<{ page_size: number }[]>('PRAGMA page_size');
    const freeBytes = (fl[0]?.freelist_count ?? 0) * (ps[0]?.page_size ?? 4096);
    if (freeBytes > VACUUM_FREE_BYTES) {
      lastVacuumAt = Date.now();
      console.log(
        `[worker] message-event retention: VACUUM (${Math.round(freeBytes / 1e6)} МБ свободных страниц)`,
      );
      await db.$executeRawUnsafe('VACUUM');
    }
  } catch (e) {
    console.error(
      '[worker] message-event retention vacuum failed:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Один прогон ретеншна: сколько строк архивировано и удалено. Вызывается
 *  из cleanup воркера (раз в 5 минут). Транзакция на батч — короткие записи. */
export async function runMessageEventRetention(): Promise<number> {
  let days = 0;
  let forwarderEnabled = false;
  try {
    const settings = await getSettings();
    days = settings.messageEventRetentionDays;
    forwarderEnabled = settings.forwarderEnabled;
  } catch {
    return 0; // настройки недоступны — пропуск прогона
  }
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Очередь форвардера (недоставленные в приёмник) не удаляем при включённом
  // форвардере — BI-поток важнее окна ретеншна.
  const where: Prisma.MessageEventWhereInput = {
    receivedAt: { lt: cutoff },
    ...(forwarderEnabled
      ? { OR: [{ forwardedAt: { not: null } }, { forwardSkip: true }] }
      : {}),
  };

  let removed = 0;
  for (;;) {
    const batch = await db.messageEvent.findMany({
      where,
      orderBy: { receivedAt: 'asc' },
      take: BATCH,
    });
    if (batch.length === 0) break;
    await archiveBatch(batch as unknown as Record<string, unknown>[]);
    await db.messageEvent.deleteMany({
      where: { id: { in: batch.map((r) => r.id) } },
    });
    removed += batch.length;
    if (removed >= MAX_PER_RUN || batch.length < BATCH) break;
  }
  if (removed > 0) {
    console.log(
      `[worker] message-event retention: archived+removed ${removed} rows (window ${days}d)`,
    );
    await maybeVacuum();
  }
  return removed;
}
