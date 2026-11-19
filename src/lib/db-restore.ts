// Авто-восстановление данных после сброса песочницы платформой.
//
// Контекст: платформенный /start.sh при каждом рестарте песочницы восстанавливает
// проект из /home/sync/repo.tar, который НЕ содержит db/ и .env — пользователь
// терял все тестовые данные и секреты. Канал сохранности — каталог /home/sync
// (host-volume, переживает рестарт): туда воркер пишет снапшот БД
// (custom.db) и копию .env (env.backup) — см. ./db-backup.ts.
//
// Этот модуль запускается из instrumentation.ts ДО бутстрапа БД:
//  1) restoreEnvSecrets() — возвращает в process.env/.env секреты из env.backup
//     (SECRETS_KEY и пр.: без них старые зашифрованные значения из снапшота БД
//     не расшифруются);
//  2) restoreDatabaseIfFresh() — если живая БД «свежая» (только дефолтный админ,
//     ни клиентов, ни воронок, ни шаблонов — типичное состояние после сброса),
//     а снапшот содержит данные — подменяет файл БД снапшотом (с канареечными
//     запросами против дрейфа схемы).
//
// Оба шага никогда не роняют сервер: любая ошибка — лог и продолжение работы.
// Выключатели: TRIGGER_DB_RESTORE=off (не восстанавливать), TRIGGER_DB_BACKUP=off (см. db-backup).
// «Сбросить данные насовсем»: удалить /home/sync/db-backup/custom.db.
import { existsSync, statSync, rmSync, copyFileSync, chmodSync, appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

const BACKUP_DIR = '/home/sync/db-backup';
const BACKUP_DB = join(BACKUP_DIR, 'custom.db');
const BACKUP_ENV = join(BACKUP_DIR, 'env.backup');
/** Меньше 4 КБ — не БД со схемой, мусор/огрызок: не восстанавливать. */
const MIN_BACKUP_BYTES = 4096;

/** Путь живой БД ( DATABASE_URL из .env/start.sh, иначе ./db/custom.db). */
function liveDbPath(): string {
  const raw = process.env.DATABASE_URL?.trim();
  if (raw && raw.startsWith('file:')) {
    const p = raw.slice('file:'.length);
    if (p) return resolve(p);
  }
  return resolve('db/custom.db');
}

/** Живая БД — одноразовая тестовая установка (/tmp)? Холодная верификация
 *  дистрибутива в песочнице (с общим /home/sync) БЕЗ TRIGGER_DB_RESTORE=off
 *  втягивала dev-снапшот в тестовую БД — тест проверял чужие данные, а не
 *  чистую установку (инцидент 30.10.2026, см. db-backup.liveDbIsTemporary).
 *  Предохранитель: /tmp-установки не восстанавливаются никогда. */
function liveDbIsTemporary(): boolean {
  const p = liveDbPath();
  return p.startsWith('/tmp/') || p.startsWith('/var/tmp/');
}

/** Одноразовый клиент к указанному файлу БД (для проверок ДО основного коннекта). */
function clientFor(path: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: `file:${path}` } } });
}

/** Удалить файл БД вместе с журналами (WAL/SHM/rollback), чтобы подмена была чистой. */
function removeDbFile(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      rmSync(path + suffix, { force: true });
    } catch {
      /* нет прав/не существует — не критично */
    }
  }
}

/** Парсер env-файла: KEY=VALUE / KEY="VALUE", без комментариев и пустых строк. */
function parseEnvFile(content: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    out.push([m[1], value]);
  }
  return out;
}

/**
 * Шаг 1. Секреты: для каждого ключа из env.backup, отсутствующего в текущем
 * окружении, — выставить process.env и дописать в .env проекта (start.sh
 * перезаписывает .env минимально, секреты теряются на каждом рестарте).
 */
export function restoreEnvSecrets(): void {
  try {
    // /tmp-установка (холодный тест) не должна тянуть dev-переменные —
    // см. liveDbIsTemporary: иначе тестовая сборка получает лишние
    // env-переменные песочницы на своём экране входа.
    if (liveDbIsTemporary()) return;
    if (!existsSync(BACKUP_ENV)) return;
    const content = readText(BACKUP_ENV);
    if (!content) return;
    const missing: Array<[string, string]> = parseEnvFile(content).filter(
      ([key]) => !(process.env[key] ?? '').trim(),
    );
    if (missing.length === 0) return;
    // Кавычки не только при пробелах: dotenv обрезает НЕзакавыченное значение по «#»
    // как комментарий (пароль со спецсимволом «#» в значении терял хвост при
    // обратной записи в .env).
    // env.backup парсится с кавычек-снятием, поэтому при обратной записи их надо вернуть,
    // иначе после первого же рестарта секрет молча портится.
    const lines = missing.map(([k, v]) => `${k}=${/[\s#]/.test(v) ? `"${v}"` : v}`);
    for (const [k, v] of missing) process.env[k] = v;
    try {
      appendFileSync('.env', `\n# восстановлено из ${BACKUP_ENV} (db-restore)\n${lines.join('\n')}\n`);
    } catch {
      /* .env недоступен для записи — process.env уже выставлен, этого достаточно */
    }
    console.log(`[db-restore] секреты восстановлены из env.backup: ${missing.map(([k]) => k).join(', ')}`);
  } catch (err: unknown) {
    console.error('[db-restore] restoreEnvSecrets не выполнен (продолжаем):', err);
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** «Свежая» БД = только дефолтный админ и ни одной сущности (после сброса платформы). */
async function isFreshDb(path: string): Promise<boolean> {
  const client = clientFor(path);
  try {
    try {
      const [users, clients, funnels, templates] = await Promise.all([
        client.user.count(),
        client.client.count(),
        client.funnel.count(),
        client.smsTemplate.count(),
      ]);
      return users <= 1 && clients === 0 && funnels === 0 && templates === 0;
    } catch {
      // таблиц нет (db:push ещё не выполнялся) — файл пустой, восстанавливаем
      return true;
    }
  } finally {
    await client.$disconnect().catch(() => {});
  }
}

/** Канарейка против дрейфа схемы: выборка из ключевых таблиц снапшота текущим клиентом. */
async function backupSchemaOk(path: string): Promise<boolean> {
  const client = clientFor(path);
  try {
    await client.user.findFirst();
    await client.client.findFirst();
    await client.funnel.findFirst();
    await client.smsTemplate.findFirst();
    await client.workflowInstance.findFirst();
    await client.smsMessage.findFirst();
    return true;
  } catch {
    return false;
  } finally {
    await client.$disconnect().catch(() => {});
  }
}

/**
 * Шаг 2. БД: подменить файл живой БД снапшотом, если живая — свежая,
 * а снапшот содержателен. Вызывать ДО создания основного коннекта
 * (instrumentation) — подменять файл под открытым коннектом нельзя.
 */
export async function restoreDatabaseIfFresh(): Promise<boolean> {
  try {
    if ((process.env.TRIGGER_DB_RESTORE ?? '').trim() === 'off') return false;
    if (liveDbIsTemporary()) {
      console.warn('[db-restore] живая БД в /tmp (тестовая установка?) — авто-восстановление пропущено');
      return false;
    }
    if (!existsSync(BACKUP_DB) || statSync(BACKUP_DB).size < MIN_BACKUP_BYTES) return false;

    const live = liveDbPath();
    if (existsSync(live) && !(await isFreshDb(live))) {
      // в живой БД есть данные (обычный рестарт на месте) — не трогаем
      return false;
    }
    if (!(await backupSchemaOk(BACKUP_DB))) {
      console.warn('[db-restore] снапшот не читается текущей схемой — восстановление пропущено');
      return false;
    }

    // окна «нет файла вовсе» быть не должно, но и его обрабатываем так же
    removeDbFile(live);
    copyFileSync(BACKUP_DB, live);
    try {
      chmodSync(live, 0o644);
    } catch {
      /* права не критичны */
    }
    console.log(
      `[db-restore] БД восстановлена из снапшота ${BACKUP_DB} ` +
        `(${statSync(BACKUP_DB).size} байт) — тестовые данные возвращены после сброса песочницы`,
    );
    return true;
  } catch (err: unknown) {
    console.error('[db-restore] восстановление БД не выполнено (продолжаем):', err);
    return false;
  }
}
