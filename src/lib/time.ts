// Стеночное («настенное») время в часовом поясе клиента — для рассылок.
// РФ без DST, поэтому двухшаговое вычисление через Intl достаточно точно;
// при некорректной зоне — откат на UTC (как в compliance/quiet-hours).
//
// Слой: чистые функции без побочных эффектов. Используют: планировщик
// рассылок (lib/services/broadcasts), executor'ы воронок (lib/engine/executors),
// сегменты/карточка клиента (lib/services/clients, client-card) и UI-подписи
// (views/shared: tzOffsetLabel). Ничего не зависит от БД/React.

/** Составляющие стеночного времени (m: 1..12). */
interface WallParts {
  y: number;
  m: number; // 1..12
  d: number;
  h: number;
  min: number;
  s: number;
}

/** Разложение Date на составляющие в зоне через Intl.DateTimeFormat
 * (без внешних библиотек типа date-fns-tz). null — зона не распознана
 * или числовые части невалидны. */
function partsInZone(date: Date, timeZone: string): WallParts | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = fmt.formatToParts(date);
    const get = (type: string): number => {
      const p = parts.find((x) => x.type === type);
      return p ? Number.parseInt(p.value, 10) : Number.NaN;
    };
    const y = get('year');
    const m = get('month');
    const d = get('day');
    let h = get('hour');
    if (h === 24) h = 0; // некоторые среды отдают «24» для полуночи
    const min = get('minute');
    const s = get('second');
    if ([y, m, d, h, min, s].some((v) => !Number.isFinite(v))) return null;
    return { y, m, d, h, min, s };
  } catch {
    return null;
  }
}

/** Стеночные составляющие даты в зоне (или null при некорректной зоне). */
export function wallPartsInZone(date: Date, timeZone: string): {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
} | null {
  const p = partsInZone(date, timeZone);
  if (!p) return null;
  return { y: p.y, m: p.m, d: p.d, h: p.h, min: p.min };
}

/** Смещение зоны (мс, восток положительный) на момент date. Некорректная зона → 0 (UTC). */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  if (!p) return 0;
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - date.getTime();
}

/**
 * Стеночное время (y, m, d, h, min) в зоне → UTC-момент.
 * Двухшаговое уточнение (DST-границы); для зон РФ достаточно одного шага.
 */
export function zonedTimeToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, h, min, 0);
  const offset = tzOffsetMs(new Date(guess), timeZone);
  let utc = new Date(guess - offset);
  // уточнение: смещение могло измениться на границе
  const offset2 = tzOffsetMs(utc, timeZone);
  if (offset2 !== offset) utc = new Date(guess - offset2);
  return utc;
}

/**
 * Ближайшее наступление стеночного времени (час:минуты, опционально день недели
 * 1=Пн..7=Вс) в зоне timeZone, строго ПОСЛЕ from. Максимум 8 суток поиска.
 */
export function nextWallClockOccurrence(
  from: Date,
  timeZone: string,
  hour: number,
  minute: number,
  weekday: number | null,
): Date {
  const p = partsInZone(from, timeZone) ?? {
    y: from.getUTCFullYear(),
    m: from.getUTCMonth() + 1,
    d: from.getUTCDate(),
    h: from.getUTCHours(),
    min: from.getUTCMinutes(),
    s: 0,
  };
  // target weekday в терминах getUTCDay: 1..6 → Пн..Сб, 7(Вс) → 0
  const targetWd = weekday === null ? null : weekday % 7;
  let y = p.y;
  let m = p.m;
  let d = p.d;
  // «Сегодня + до 8 дней»: любой час суток повторяется ежедневно, любой день
  // недели — не реже раза в 7 суток, поэтому окно всегда находит валидный момент.
  for (let i = 0; i < 9; i++) {
    const utc = zonedTimeToUtc(y, m, d, hour, minute, timeZone);
    if (utc.getTime() > from.getTime()) {
      const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      if (targetWd === null || wd === targetWd) return utc;
    }
    const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
    y = nextDay.getUTCFullYear();
    m = nextDay.getUTCMonth() + 1;
    d = nextDay.getUTCDate();
  }
  // fallback (не должен достигаться): ближайший день без проверки weekday
  return zonedTimeToUtc(y, m, d, hour, minute, timeZone);
}

/** «дд.мм.гггг чч:мм» по зоне (для человекочитаемых подписей расписания). */
export function formatWallClock(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  if (!p) return date.toISOString().slice(0, 16).replace('T', ' ');
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${pad(p.d)}.${pad(p.m)}.${p.y} ${pad(p.h)}:${pad(p.min)}`;
}

/**
 * Ближайшее наступление дня рождения (месяц/день БЕЗ года, 29 февраля в
 * невисокосный год → 1 марта, как в сегментах) в стеночном времени клиента.
 * Возвращает null, если передан некорректный день рождения.
 */
export function nextBirthdayWall(
  from: Date,
  birthday: { month: number; day: number }, // 1..12 / 1..31
  timeZone: string,
  hour: number,
  minute: number,
): Date | null {
  if (birthday.month < 1 || birthday.month > 12 || birthday.day < 1 || birthday.day > 31) {
    return null;
  }
  const nowParts = partsInZone(from, timeZone);
  if (!nowParts) return null;
  for (const year of [nowParts.y, nowParts.y + 1]) {
    // Date.UTC(2025, 1, 29) = 1 марта 2025 — авто-переход невисокосного года
    const candidate = zonedTimeToUtc(year, birthday.month, birthday.day, hour, minute, timeZone);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  return null; // недостижимо (следующий год всегда в будущем), для типизации
}

/* ============ Часовые пояса: валидация, нормализация, подписи ============ */

/** Канонические зоны РФ по целочисленному смещению UTC (РФ без DST с 2014). */
const RF_OFFSET_ZONES: ReadonlyMap<number, string> = new Map([
  [2, 'Europe/Kaliningrad'],
  [3, 'Europe/Moscow'],
  [4, 'Europe/Samara'],
  [5, 'Asia/Yekaterinburg'],
  [6, 'Asia/Omsk'],
  [7, 'Asia/Novosibirsk'],
  [8, 'Asia/Irkutsk'],
  [9, 'Asia/Yakutsk'],
  [10, 'Asia/Vladivostok'],
  [11, 'Asia/Magadan'],
  [12, 'Asia/Kamchatka'],
]);

/** Валидная IANA-зона (включая Etc/GMT-±N и ссылки вида Europe/Kirov). */
export function isValidTimeZone(tz: string): boolean {
  const t = tz.trim();
  if (t.length === 0 || t.length > 64) return false;
  // Etc/GMT±N — валидные IANA-зоны фиксированного смещения (знак инвертирован по
  // POSIX: Etc/GMT+3 = UTC-3). Node НЕ отдаёт их в supportedValuesOf (только
  // «региональные» зоны), хотя DateTimeFormat принимает — сверяем явно.
  if (/^Etc\/GMT[+-]\d{1,2}$/.test(t)) return true;
  if (/^Etc\/(GMT|UTC|UCT)$/.test(t)) return true;
  try {
    const zones = Intl.supportedValuesOf?.('timeZone');
    if (Array.isArray(zones)) return zones.includes(t);
  } catch {
    // supportedValuesOf недоступен (старые рантаймы) — грубая проверка формата
  }
  return /^[A-Za-z0-9/+_-]+$/.test(t);
}

/** Целочисленное смещение (часы, восток положительный) → IANA-зона или null. */
function zoneForOffsetHours(offsetHours: number): string | null {
  if (!Number.isInteger(offsetHours) || offsetHours < -14 || offsetHours > 14) return null;
  const rf = RF_OFFSET_ZONES.get(offsetHours);
  if (rf) return rf;
  // Прочие целые смещения: Etc/GMT c POSIX-инверсией знака (UTC+5 = Etc/GMT-5)
  const sign = offsetHours >= 0 ? '-' : '+';
  return `Etc/GMT${sign}${Math.abs(offsetHours)}`;
}

/**
 * Нормализация часового пояса из внешних систем: система данных передаёт СМЕЩЕНИЕ UTC
 * в цифровом виде. Принимает IANA-строку («Asia/Yekaterinburg») либо цифровые
 * формы — число 5 / строки «5», «+5», «-3», «+05:00», «UTC+5», «GMT-07:00».
 * Целое смещение +2..+12 → каноническая зона РФ; прочие целые → Etc/GMT∓N;
 * дробные смещения и мусор → null (вызывающий решает: 422 или «игнорировать»).
 */
export function normalizeTimezoneInput(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? zoneForOffsetHours(raw) : null;
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '') return null;
  // Строки «UTC+5» / «GMT-07:00» — цифровые формы, хоть и содержат буквы
  if (/^(?:utc|gmt)\s*[+-]/i.test(s)) {
    const m = /^(?:utc|gmt)\s*([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(s);
    if (!m || (m[3] && Number.parseInt(m[3], 10) !== 0)) return null;
    return zoneForOffsetHours((m[1] === '-' ? -1 : 1) * Number.parseInt(m[2], 10));
  }
  // IANA-имя (содержит буквы) — валидируем и отдаём как есть
  if (/[A-Za-z]/.test(s)) return isValidTimeZone(s) ? s : null;
  // Чисто цифровые строки: «5», «+5», «-3», «+05:00», «05:00»
  const m = /^([+-])?(\d{1,2})(?::(\d{2}))?$/.exec(s);
  if (!m || (m[3] && Number.parseInt(m[3], 10) !== 0)) return null;
  return zoneForOffsetHours((m[1] === '-' ? -1 : 1) * Number.parseInt(m[2], 10));
}

/**
 * Подпись смещения зоны для UI: «UTC+5», «UTC+5:30», «UTC-3» — рядом с IANA-именем
 * («Asia/Yekaterinburg (UTC+5)», как передаёт внешняя система). Некорректная зона → ''.
 */
export function tzOffsetLabel(timeZone: string, at: Date = new Date()): string {
  const p = partsInZone(at, timeZone);
  if (!p) return '';
  const wallAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  const offsetMin = Math.round((wallAsUtc - at.getTime()) / 60000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m > 0 ? `:${String(m).padStart(2, '0')}` : ''}`;
}
