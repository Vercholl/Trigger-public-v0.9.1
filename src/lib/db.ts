// Единая точка доступа к Prisma Client всего приложения (import { db } from '@/lib/db').
// До создания клиента здесь гарантируется валидный DATABASE_URL и накатываются
// SQLite-прагмы под нагрузку — импортировать prisma/client напрямую нельзя.
import { PrismaClient } from '@prisma/client'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// Гарантия валидного DATABASE_URL ДО создания PrismaClient (критично для
// standalone/production и публикации платформы — см. src/lib/db-bootstrap.ts).
//
// Приоритет:
//  1. env-переменная, если её файл или хотя бы каталог файла существует:
//     - dev-песочница: file:/home/z/my-project/db/custom.db (её задаёт платформа/.env);
//     - опубликованный контейнер платформы: file:/app/db/custom.db (задаёт start.sh);
//  2. существующий db/custom.db: в dev — ./db (CWD = корень проекта), в standalone
//     и в next-service-dist контейнера — ../db (server.js делает chdir в свой каталог,
//     БД лежит уровнем выше). Порядок кандидатов выбирается по наличию server.js в CWD;
//  3. если ничего не нашлось — путь по тем же правилам, каталог создаётся,
//     файл и таблицы создаст бутстрап db-bootstrap.ts.
//
/** Доп. параметры соединения для SQLite-URL: единое соединение (SQLite —
 * single-writer, пул соединений лишь порождает SQLITE_BUSY между своими
 * коннектами) — основа для пер-соединенческих PRAGMA ниже. */
function withSqliteTuning(url: string): string {
  if (!url.startsWith('file:')) return url;
  if (url.includes('connection_limit=')) return url;
  return url.includes('?') ? `${url}&connection_limit=1` : `${url}?connection_limit=1`;
}

// Проверка существования обязательна: .env песочницы, случайно попавший в
// standalone-сборку, содержит абсолютный путь песочницы, которого в контейнере нет
// (build-скрипт его вычищает — двойная защита).
function ensureDatabaseUrl(): void {
  const raw = process.env.DATABASE_URL?.trim();
  if (raw) {
    const p = raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
    if (p) {
      const abs = resolve(p);
      if (existsSync(abs)) {
        process.env.DATABASE_URL = withSqliteTuning(`file:${abs}`); // файл есть — главный случай (dev/боевой контейнер)
        return;
      }
      if (existsSync(dirname(abs))) {
        process.env.DATABASE_URL = withSqliteTuning(`file:${abs}`); // каталог есть — файл создаст бутстрап
        return;
      }
    }
  }

  const cwd = process.cwd();
  const standaloneRoot = existsSync(resolve(cwd, 'server.js'));
  const candidates = standaloneRoot
    ? [resolve(cwd, '../db/custom.db'), resolve(cwd, 'db/custom.db')]
    : [resolve(cwd, 'db/custom.db'), resolve(cwd, '../db/custom.db')];

  for (const c of candidates) {
    if (existsSync(c)) {
      process.env.DATABASE_URL = withSqliteTuning(`file:${c}`);
      return;
    }
  }
  for (const c of candidates) {
    if (existsSync(dirname(c))) {
      process.env.DATABASE_URL = withSqliteTuning(`file:${c}`);
      return;
    }
  }

  const target = candidates[0];
  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch {
    // нет прав — оставим как есть, ошибка проявится в запросах и health
  }
  process.env.DATABASE_URL = withSqliteTuning(`file:${target}`);
}

ensureDatabaseUrl()

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Синглтон на globalThis: в dev Next.js горячо перезагружает модули, и без
// кэша каждый HMR плодил бы новый PrismaClient (утечка соединений, SQLITE_BUSY).
// В production глобаль не пишем — процесс один, одного клиента достаточно.
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ---------- Прагмы SQLite под нагрузку ----------
// ЗАЧЕМ: по умолчанию SQLite живёт в journal_mode=DELETE + synchronous=FULL —
// fsync на каждом коммите: построчная запись (воркер, ингест событий) упирается
// в диск, а чтение блокирует запись. На боевых объёмах (миллионы SMS/событий)
// это узкое место №1 по записи.
//   • journal_mode=WAL — персистентен (хранится в файле БД, достаточно одного
//     выполнения): читатели не блокируют писателя, запись в -wal-файл;
//   • synchronous=NORMAL — при WAL безопасен (даже при краше теряется последний
//     незасинканный коммит WAL, а не вся БД) и убирает fsync из горячего пути;
//   • busy_timeout — ожидание вместо мгновенного SQLITE_BUSY при чужой записи;
//   • cache_size — 64 МБ страничного кэша вместо 2 МБ по умолчанию.
// connection_limit=1 (см. withSqliteTuning) — все прагмы применяются к ЕДИНСТВЕННОМУ
// соединению пула и не теряются. Ошибки не падают процесс: настройки применятся
// на следующем старте либо запросы продолжат работать с дефолтами SQLite.
void (async () => {
  try {
    await db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await db.$executeRawUnsafe('PRAGMA synchronous=NORMAL');
    await db.$queryRawUnsafe('PRAGMA busy_timeout=5000');
    await db.$queryRawUnsafe('PRAGMA cache_size=-65536');
  } catch {
    // БД занята другим процессом/недоступна — работают дефолты SQLite
  }
})();
