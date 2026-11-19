// Rate-limiter на БД (интерфейс RateLimiter; Redis — позже, если понадобится).
// Счётчик в скользящем окне «фиксированное окно на ключ»: строка RateLimitEntry,
// при устаревании окна счётчик сбрасывается. Очистку старых строк делает воркер.
import { db } from '@/lib/db';

export interface RateLimiter {
  /**
   * Разрешить ли запрос. Инкрементирует счётчик окна и возвращает true,
   * если лимит не превышен, иначе false (запрос уже посчитан — блокируем).
   */
  check(key: string, limit: number, windowSec: number): Promise<boolean>;
}

export class DbRateLimiter implements RateLimiter {
  async check(key: string, limit: number, windowSec: number): Promise<boolean> {
    const now = new Date();
    const windowMs = windowSec * 1000;
    try {
      const existing = await db.rateLimitEntry.findUnique({ where: { key } });
      if (!existing || existing.windowStart.getTime() + windowMs <= now.getTime()) {
        await db.rateLimitEntry.upsert({
          where: { key },
          create: { key, windowStart: now, count: 1 },
          update: { windowStart: now, count: 1 },
        });
        return limit >= 1;
      }
      const updated = await db.rateLimitEntry.update({
        where: { key },
        data: { count: { increment: 1 } },
      });
      return updated.count <= limit;
    } catch (e) {
      // Лимитер не должен валить основной сценарий: при сбое БД — разрешаем.
      console.error('[rate-limiter] check failed:', e instanceof Error ? e.message : String(e));
      return true;
    }
  }
}

/** Лимит входа: 30 попыток / 5 минут с одного IP. */
export const loginRateLimiter: RateLimiter = new DbRateLimiter();
/** Лимит приёма событий: 120 запросов / минуту с одного IP. */
export const eventsRateLimiter: RateLimiter = new DbRateLimiter();
/** Лимит резолва коротких ссылок: 60 запросов / минуту с одного IP. */
export const shortLinkRateLimiter: RateLimiter = new DbRateLimiter();
/** Лимит операций с секретами подключений (сохранение/удаление токена и
 *  логина/пароля Т2): 20 запросов / минуту с одного IP — защита от брутфорса
 *  через API даже при скомпрометированной сессии администратора. */
export const secretsRateLimiter: RateLimiter = new DbRateLimiter();
/** Лимит попыток смены пароля (подбор старого пароля при украденной сессии):
 *  10 попыток / 10 минут на пользователя — см. services/auth.ts. */
export const passwordRateLimiter: RateLimiter = new DbRateLimiter();
/** Лимит webhook-уведомлений провайдеров: 300 запросов / минуту с одного IP.
 *  Оставляет запас для легитимных пиков шлюза (посылки по 1000+ сообщений
 *  укладываются), но отсекает молотилку по кодам/подбор секрета.
 *  Настраивается env WEBHOOK_RATE_LIMIT_PER_MIN (боевым контурам с пиками
 *  коллбэков МТС, напр. 50 тыс. СМС/час, рекомендуется 2000+). */
export const webhookRateLimiter: RateLimiter = new DbRateLimiter();

// ---------- Настраиваемые лимиты интеграции (env, G6) ----------

/** Целое из env с диапазоном и дефолтом (некорректное значение — дефолт). */
function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min || n > max) return def;
  return n;
}

/** Пре-авторизационный IP-лимит приёма событий (до сверки ключа — анти-DoS):
 *  600/мин. Выше прежних 120: боевой адаптер ядра шлёт события чаще
 *  (волны статусов), а реальную защиту даёт пер-ключевой лимит ПОСЛЕ сверки. */
export function eventsIpRateLimit(): number {
  return envInt('EVENTS_IP_RATE_LIMIT_PER_MIN', 600, 1, 100_000);
}

/** Дефолтный пер-ключевой лимит приёма событий (120/мин) — действует для
 *  статического env-ключа и ключей БД без rateLimitPerMin. Интеграционный
 *  ключ ядра получает собственное значение (ApiKey.rateLimitPerMin). */
export function eventsKeyRateLimit(): number {
  return envInt('EVENTS_KEY_RATE_LIMIT_PER_MIN', 120, 1, 100_000);
}

/** Пер-ключевой лимит батч-запросов (каждый несёт до 10 000 строк): 60/мин. */
export function eventsBatchKeyRateLimit(): number {
  return envInt('EVENTS_BATCH_KEY_RATE_LIMIT_PER_MIN', 60, 1, 100_000);
}

/** Лимит webhook-уведомлений провайдеров и приёмника внешнего захвата
 *  (300/мин; на бою под пики коллбэков МТС поднять до 2000+). */
export function webhookRateLimitPerMin(): number {
  return envInt('WEBHOOK_RATE_LIMIT_PER_MIN', 300, 1, 100_000);
}

/** Удаление давно истёкших записей (вызывается воркером периодически). */
export async function cleanupRateLimitEntries(olderThanMs: number): Promise<number> {
  const res = await db.rateLimitEntry.deleteMany({
    where: { windowStart: { lt: new Date(Date.now() - olderThanMs) } },
  });
  return res.count;
}
