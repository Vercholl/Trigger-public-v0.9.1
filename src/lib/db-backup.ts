// Периодический снапшот БД и .env в /home/sync/db-backup — канал сохранности
// данных между сбросами песочницы (см. ./db-restore.ts — восстановление).
// Вызывается из тика воркера (каждые 5 минут и на первом тике).
//
// Снапшот — SQLite «VACUUM INTO»: транзакционно-согласованная копия в один файл
// (включая закоммиченный WAL), без остановки записи. Атомарная замена целевого
// файла — rename(2) поверх (на одной ФС это атомарно).
//
// Защита от порчи: пустую/свежую БД НЕ пишем поверх содержательного снапшота
// (после сброса платформы до восстановления), иначе авто-восстановлению
// было бы нечего возвращать. .env копируется целиком (секреты нужны для
// расшифровки значений из снапшота БД).
//
// Среда без /home/sync (публикация платформы, standalone, свой сервер):
// тихо no-op. Выключатель: TRIGGER_DB_BACKUP=off.
import { existsSync, statSync, unlinkSync, renameSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { db } from './db';

const BACKUP_DIR = '/home/sync/db-backup';
const BACKUP_DB = join(BACKUP_DIR, 'custom.db');
const BACKUP_DB_TMP = join(BACKUP_DIR, 'custom.db.tmp');
const BACKUP_ENV = join(BACKUP_DIR, 'env.backup');
/** Меньше 4 КБ — не содержательный снапшот. */
const MIN_BACKUP_BYTES = 4096;

/** Живая БД — одноразовая тестовая установка (каталог /tmp)? Инцидент
 *  30.10.2026: холодная верификация дистрибутива БЕЗ TRIGGER_DB_*=off подняла
 *  второй воркер, который: (а) восстановил dev-снапшот в тестовую БД,
 *  (б) ЗАТЁР env.backup своим .env с DATABASE_URL → /tmp/… (мусорный путь +
 *  чужие секреты — после сброса песочницы восстановились бы они). Правило
 *  холодных тестов задокументировано в developer-guide; это программный
 *  предохранитель поверх него: БД из /tmp не бэкапим никогда. */
function liveDbIsTemporary(): boolean {
  const path = resolve((process.env.DATABASE_URL ?? '').replace(/^file:/, '').split('?')[0] || '');
  return path.startsWith('/tmp/') || path.startsWith('/var/tmp/');
}

let failureLogged = false;
/** Логируем первый успешный снапшот после старта процесса (дальше — молча,
 * раз в 5 минут): одна строка в логе сразу показывает, что канал сохранности
 * жив (диагностика инцидентов «данные пропали»: застой mtime снапшота =
 * воркер мёртв, например после OOM-убийства dev-сервера). */
let successLogged = false;

/** Интервал снапшотов в тиках воркера (5 с/тик). VACUUM INTO копирует файл
 * ЦЕЛИКОМ: на маленькой БД (≤1 ГБ) это секунды — раз в 5 минут уместно;
 * на боевой много-гигабайтной копия длится десятки секунд и греет диск —
 * интервал растягивается до 30 минут. Переопределение: TRIGGER_DB_BACKUP_TICKS. */
let cachedTicks: number | null = null;
export function backupEveryTicks(): number {
  const env = Number.parseInt(process.env.TRIGGER_DB_BACKUP_TICKS ?? '', 10);
  if (Number.isFinite(env) && env > 0) return env;
  if (cachedTicks === null) {
    try {
      // db.ts добавляет в DATABASE_URL query-параметры (connection_limit=1) —
      // statSync по пути с «?» всегда ENOENT, и ветка >1 ГБ никогда не срабатывала
      // (адаптивный интервал молча деградировал до «раз в 5 минут»). Отрезаем query.
      const path = (process.env.DATABASE_URL ?? '').replace(/^file:/, '').split('?')[0];
      const bytes = path !== '' ? statSync(path).size : 0;
      cachedTicks = bytes > 1024 * 1024 * 1024 ? 360 : 60; // >1 ГБ → раз в 30 мин
    } catch {
      cachedTicks = 60;
    }
  }
  return cachedTicks;
}

/** В живой БД есть пользовательские данные? (не только дефолтный админ) */
async function liveHasData(): Promise<boolean> {
  try {
    const [users, clients, funnels, templates] = await Promise.all([
      db.user.count(),
      db.client.count(),
      db.funnel.count(),
      db.smsTemplate.count(),
    ]);
    return users > 1 || clients > 0 || funnels > 0 || templates > 0;
  } catch {
    return false;
  }
}

/** Снапшот БД (VACUUM INTO tmp → атомарный rename) + копия .env. */
export async function backupDatabase(): Promise<boolean> {
  if ((process.env.TRIGGER_DB_BACKUP ?? '').trim() === 'off') return false;
  try {
    if (!existsSync(BACKUP_DIR)) return false; // среда без /home/sync — no-op
    // Предохранитель тестовых установок — см. liveDbIsTemporary: /tmp-базы
    // не имеют права затирать канал сохранности (случайный запуск холодного
    // теста без TRIGGER_DB_BACKUP=off больше не портит env.backup).
    if (liveDbIsTemporary()) {
      if (!failureLogged) {
        console.warn('[db-backup] живая БД в /tmp (тестовая установка?) — снапшот пропущен, канал сохранности не трогаем');
        failureLogged = true;
      }
      return false;
    }

    // Не затирать содержательный снапшот свежей (сброшенной) БД: восстановление
    // из него — единственный шанс вернуть данные (см. db-restore.ts).
    const backupMeaningful = existsSync(BACKUP_DB) && statSync(BACKUP_DB).size > MIN_BACKUP_BYTES;
    if (backupMeaningful && !(await liveHasData())) return false;

    try {
      unlinkSync(BACKUP_DB_TMP);
    } catch {
      /* tmp не существует — норма */
    }
    await db.$executeRawUnsafe(`VACUUM INTO '${BACKUP_DB_TMP}'`);
    if (!existsSync(BACKUP_DB_TMP)) throw new Error('VACUUM INTO не создал файл снапшота');
    renameSync(BACKUP_DB_TMP, BACKUP_DB); // атомарная замена на той же ФС
    try {
      chmodSync(BACKUP_DB, 0o600);
    } catch {
      /* права не критичны */
    }

    // .env → env.backup: секреты для расшифровки значений из снапшота
    try {
      if (existsSync('.env')) {
        copyFileSync('.env', BACKUP_ENV);
        chmodSync(BACKUP_ENV, 0o600);
      }
    } catch {
      /* не критично: главный артефакт — снапшот БД */
    }

    if (!successLogged) {
      successLogged = true;
      console.log(`[db-backup] снапшот БД обновлён: ${BACKUP_DB} (${statSync(BACKUP_DB).size} байт); далее — каждые ${backupEveryTicks() * 5} c без лога`);
    }
    failureLogged = false;
    return true;
  } catch (err: unknown) {
    // Логируем только первый сбой (каждые 5 минут спамить dev.log незачем),
    // после успешного снапшота снова сообщим, если сломается.
    if (!failureLogged) {
      console.error('[db-backup] сбой снапшота БД (до следующего успеха лог не повторяется):', err);
      failureLogged = true;
    }
    return false;
  }
}
