// Тихие часы в таймзоне клиента (IANA) через Intl.
// Окно [start, end) может переходить через полночь (например 21 → 9).
export interface QuietHoursConfig {
  start: number; // 0..23
  end: number; // 0..23
}

/** Час окна в тихих часах. start === end → окно отключено. */
export function isQuietHour(localHour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return localHour >= start && localHour < end;
  return localHour >= start || localHour < end; // окно через полночь
}

/** Локальный час даты в таймзоне (0..23). При некорректной зоне — UTC. */
export function getLocalHour(date: Date, timezone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    });
    const hour = Number.parseInt(fmt.format(date), 10);
    if (Number.isFinite(hour)) return hour % 24;
  } catch {
    // некорректная зона — откат на UTC
  }
  return date.getUTCHours();
}

/** Дата/время в локали клиента (для сообщений таймлайна). */
export function formatInTimezone(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Ближайшее разрешённое время: шаг +5 минут от исходного момента,
 * максимум 24 часа поиска. Результат округляется до минуты.
 */
export function nextAllowedTime(
  from: Date,
  timezone: string,
  start: number,
  end: number,
): Date {
  let t = new Date(Math.ceil(from.getTime() / 60000) * 60000);
  const stepMs = 5 * 60 * 1000;
  const maxSteps = Math.ceil((24 * 60 * 60 * 1000) / stepMs);
  for (let i = 0; i < maxSteps; i++) {
    if (!isQuietHour(getLocalHour(t, timezone), start, end)) return t;
    t = new Date(t.getTime() + stepMs);
  }
  return t; // не нашли за 24 часа (окно «весь день») — отдаём как есть
}
