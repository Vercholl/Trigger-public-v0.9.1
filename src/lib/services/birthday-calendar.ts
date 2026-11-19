// Календарь дней рождения (Task 63): таблица BirthdayCalendar (clientId → monthDay,
// 101..1231) — SQL-ускорение сегментов «ДР в ближайшие N дней» и ДР-рассылок.
//
// ЗАЧЕМ: спец-правило birthday_within_next_days («день рождения в ближайшие N
// дней» без года) не выражалось в SQL и считалось JS-курсором по всей таблице
// Client — ~2 мин на 4 млн строк (нагрузочный тест Task 62, §8.4). Календарь
// с индексом monthDay превращает это в один индексный запрос за миллисекунды.
//
// Согласованность — три уровня:
//   1) точки записи карточки (воркер событий, панель, CSV-импорт) синхронизируют
//      строку календаря сразу при ИЗМЕНЕНИИ birthday (сравнение до записи — на
//      потоке 6 млн событий/мес лишних upsert нет);
//   2) паритет счётчиков (календарь = клиенты с ДР) проверяется перед SQL-путём
//      сегментов (кэш 60 с): расхождение → сегмент считается JS-фолбэком как
//      раньше + асинхронно запускается починка;
//   3) починка воркером раз в час + на первом минутном тике (после обновления
//      схемы на существующей БД строит календарь по всем клиентам).
//
// monthDay = (месяц+1)*100 + день по UTC-компонентам birthday (1 января = 101).
// 29 февраля нормализуется в 301 (1 марта) — семантика nextBirthdayOccurrence
// (segments.ts): Date.UTC(y,1,29) в невисокосном году скатывается на 1 марта,
// т.е. JS-путь «поздравляет» 29.02-клиентов 1 марта. Расхождение SQL/JS
// возможно только 29.02 високосного года (SQL — 1 марта), ~0,07% населения.
import { db } from '@/lib/db';

/** monthDay по UTC-компонентам даты ДР; 29.02 → 301. */
export function birthdayMonthDay(birthday: Date): number {
  let m = birthday.getUTCMonth() + 1;
  let d = birthday.getUTCDate();
  if (m === 2 && d === 29) {
    m = 3;
    d = 1;
  }
  return m * 100 + d;
}

/** monthDay окна [today, today+N] включительно (обход конуса года естественный).
 *  Семантика 1:1 с JS birthday_within_next_days: diffDays = следующее ДР −
 *  сегодня, совпадение при 0 ≤ diffDays ≤ N. */
export function birthdayMonthDayWindow(now: Date, days: number): number[] {
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: number[] = [];
  for (let i = 0; i <= days; i++) {
    const d = new Date(base + i * 86_400_000);
    out.push((d.getUTCMonth() + 1) * 100 + d.getUTCDate());
  }
  return out;
}

/** Синхронизация строки календаря одного клиента — вызывается точками записи
 *  карточки ТОЛЬКО при изменении birthday (null/undefined → строка убирается).
 *  Идемпотентен; сбой не роняет запись карточки (ловится уровнем 2/3). */
export async function syncBirthdayCalendar(
  clientId: string,
  birthday: Date | null | undefined,
): Promise<void> {
  try {
    if (birthday === null || birthday === undefined) {
      await db.birthdayCalendar.deleteMany({ where: { clientId } });
      return;
    }
    const monthDay = birthdayMonthDay(birthday);
    await db.birthdayCalendar.upsert({
      where: { clientId },
      create: { clientId, monthDay },
      update: { monthDay },
    });
  } catch (e) {
    console.error(
      '[birthday-calendar] sync failed:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Изменился ли birthday (сравнение до записи — cheap-guard для точек записи). */
export function birthdayChanged(before: Date | null | undefined, after: Date | null | undefined): boolean {
  if ((before ?? null) === (after ?? null)) return false;
  return (before?.getTime() ?? null) !== (after?.getTime() ?? null);
}

// ---------- Паритет (уровень 2) ----------

const PARITY_TTL_MS = 60_000;
let parityCache: { ok: boolean; at: number } | null = null;
/** Форс-сброс кэша паритета (после починки). */
export function invalidateBirthdayParity(): void {
  parityCache = null;
}

/** Календарь синхронен? Счётчики (календарь = клиенты с ДР) — оба по индексам,
 *  кэш 60 с. Счёт равен → SQL-путь; расхождение → JS-фолбэк + починка.
 *  Равные счётчики при неверном monthDay невозможны: строка создаётся/правится
 *  только syncBirthdayCalendar/починкой из самой колонки birthday. */
export async function birthdayCalendarInSync(): Promise<boolean> {
  if (parityCache && Date.now() - parityCache.at < PARITY_TTL_MS) return parityCache.ok;
  let ok = false;
  try {
    const rows = await db.$queryRawUnsafe<{ cal: bigint | number; cli: bigint | number }[]>(
      'SELECT (SELECT COUNT(*) FROM "BirthdayCalendar") AS cal, ' +
        '(SELECT COUNT(*) FROM "Client" WHERE "birthday" IS NOT NULL) AS cli',
    );
    ok = Number(rows[0]?.cal ?? -1) === Number(rows[0]?.cli ?? -2);
  } catch {
    ok = false; // таблицы нет/БД занята — фолбэк JS
  }
  parityCache = { ok, at: Date.now() };
  return ok;
}

// ---------- Починка (уровень 3) ----------

let repairing = false;

/** Починка календаря. Быстрый путь (deep=false, ежечасно из воркера) —
 *  только паритет счётчиков (оба по индексам, миллисекунды): синхронно →
 *  выход. Глубокий проход (deep=true: по расписанию раз в сутки, на первом
 *  минутном тике и при рассинхроне из classifyRules) — (1) удалить строки
 *  клиентов без ДР; (2) добавить недостающие — raw INSERT…SELECT батчами по
 *  20 тыс. (на 4 млн строк полное построение ≈ десятки секунд, разово после
 *  обновления). monthDay считается в SQL: Prisma хранит DateTime как
 *  epoch-ms INTEGER → birthday/1000 + 'unixepoch'. */
export async function repairBirthdayCalendar(opts?: { deep?: boolean }): Promise<void> {
  if (repairing) return;
  repairing = true;
  try {
    const deep = opts?.deep !== false;
    if (!deep) {
      const rows = await db.$queryRawUnsafe<{ cal: bigint | number; cli: bigint | number }[]>(
        'SELECT (SELECT COUNT(*) FROM "BirthdayCalendar") AS cal, ' +
          '(SELECT COUNT(*) FROM "Client" WHERE "birthday" IS NOT NULL) AS cli',
      );
      if (Number(rows[0]?.cal ?? -1) === Number(rows[0]?.cli ?? -2)) return; // синхронно
    }
    await db.$executeRawUnsafe(
      'DELETE FROM "BirthdayCalendar" WHERE "clientId" IN ' +
        '(SELECT "id" FROM "Client" WHERE "birthday" IS NULL)',
    );
    for (;;) {
      const n = await db.$executeRawUnsafe(
        'INSERT INTO "BirthdayCalendar" ("id","monthDay","clientId","tenantId","createdAt") ' +
          'SELECT lower(hex(randomblob(16))), ' +
          "CASE WHEN strftime('%m%d', \"birthday\"/1000, 'unixepoch') = '0229' THEN 301 " +
          "ELSE CAST(strftime('%m%d', \"birthday\"/1000, 'unixepoch') AS INTEGER) END, " +
          '"id", "tenantId", CURRENT_TIMESTAMP ' +
          'FROM "Client" WHERE "birthday" IS NOT NULL ' +
          'AND NOT EXISTS (SELECT 1 FROM "BirthdayCalendar" b WHERE b."clientId" = "Client"."id") ' +
          'LIMIT 20000',
      );
      if (n === 0) break;
    }
    invalidateBirthdayParity();
  } catch (e) {
    console.error(
      '[birthday-calendar] repair failed:',
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    repairing = false;
  }
}

/** Ленивый запуск починки из вычисления сегментов (fire-and-forget). */
export function scheduleBirthdayRepair(): void {
  void repairBirthdayCalendar();
}
