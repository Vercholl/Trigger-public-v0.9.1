// Сессии панели: токен = 32 случайных байта (hex), в БД хранится sha256(токен).
// Cookie 'tg_sid' HttpOnly. SameSite: Lax для прямого http (localhost);
// None+Secure+Partitioned при HTTPS за шлюзом (детект по нескольким сигналам — см.
// ./https.ts: шлюз затирает x-forwarded-proto, поэтому дополнительно Origin/Referer).
// Фолбэк для сред, где браузер блокирует сторонние cookie целиком (iframe предпросмотра,
// Safari ITP): те же токены принимаются в заголовке Authorization: Bearer.
// Приоритет чтения: cookie → Authorization. HttpOnly-cookie остаётся основным механизмом;
// Bearer используется SPA только когда cookie-сессия не подтверждается (/auth/me → 401).
import { createHash, randomBytes } from 'crypto';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const SESSION_COOKIE = 'tg_sid';

/**
 * TTL сессии (абсолютный): 30 дней по умолчанию — чтобы частые проверки
 * функционала панели не тратили время на повторные входы. При желании
 * ужать/расширить: env SESSION_TTL_HOURS (часы, 1..8760). Cookie max-age
 * берётся из expiresAt сессии, поэтому меняется автоматически.
 */
function resolveSessionTtlMs(): number {
  const raw = Number(process.env.SESSION_TTL_HOURS);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 24 * 365) {
    return Math.floor(raw) * 60 * 60 * 1000;
  }
  return 30 * 24 * 60 * 60 * 1000;
}

/** Абсолютный TTL сессии, мс. Источник значения — resolveSessionTtlMs() выше:
 *  env SESSION_TTL_HOURS (валидные 1..8760) или дефолт 30 дней. */
export const SESSION_TTL_MS = resolveSessionTtlMs();

/**
 * Idle-таймаут (v0.8.6, требование ИБ): сессия, по которой НЕТ активности дольше
 * SESSION_IDLE_HOURS, аннулируется — даже если абсолютный TTL (30 дней) ещё не
 * истёк. Слайдинг: активность продлевает окно (touch с троттлингом записи —
 * не чаще раза в 5 минут на сессию, чтобы не писать в БД на каждый API-вызов).
 * Дефолт 168 ч (7 дней) — сокращает окно жизни угнанной/забытой сессии вчетверо
 * против абсолютного TTL, не тревожа ежедневные проверки панели. 0 — отключено
 * (только абсолютный TTL, как до v0.8.6).
 */
export const SESSION_IDLE_MS = (() => {
  const raw = Number(process.env.SESSION_IDLE_HOURS);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 24 * 365) {
    return Math.floor(raw) * 60 * 60 * 1000;
  }
  return 7 * 24 * 60 * 60 * 1000; // 168 часов
})();

/** Интервал троттлинга touch-записи «последняя активность»: 5 минут. */
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

/** In-memory карта последнего touch (глобальная — переживает hot-reload dev).
 *  Анти-утечка (v0.8.8): записи не удаляются при logout — карта монотонно росла
 *  бы числом уникальных сессий; подтискиваем устаревшие (> TOUCH_THROTTLE_MS)
 *  записи при разрастании и удаляем ключ при разрушении сессии. */
const touchState = (() => {
  const g = globalThis as unknown as { __triggerSessionTouch?: Map<string, number> };
  if (!g.__triggerSessionTouch) g.__triggerSessionTouch = new Map();
  return g.__triggerSessionTouch;
})();

/** Подчистка touchState: записи старше интервала троттлинга безопасно удалять —
 *  при возобновлении активности ключ просто создастся заново (дополнительная
 *  запись в БД — не чаще той, что и так случилась бы). Вызывается редко. */
function pruneTouchState(): void {
  const cutoff = Date.now() - TOUCH_THROTTLE_MS;
  for (const [key, ts] of touchState) {
    if (ts < cutoff) touchState.delete(key);
  }
}

/** Истекла ли сессия по неактивности (idle-таймаут)? 0 = проверка выключена. */
export function isIdleExpired(lastActivityAt: Date): boolean {
  if (SESSION_IDLE_MS <= 0) return false;
  return lastActivityAt.getTime() + SESSION_IDLE_MS <= Date.now();
}

/** Граничная дата «неактивности» для чистки воркером (null — idle выключен). */
export function idleCutoffDate(): Date | null {
  if (SESSION_IDLE_MS <= 0) return null;
  return new Date(Date.now() - SESSION_IDLE_MS);
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
}

/** sha256(input) → hex. Односторонний хеш: в БД лежит idHash, а не токен, поэтому
 *  утечка БД не даёт готовых сессий — токен существует только у клиента (cookie). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

/** Создать сессию: принимает userId (+ опциональные ip/userAgent — для аудита/трейса),
 *  возвращает {token, expiresAt}. Токен — 32 случайных байта (hex); в БД пишется
 *  только sha256(токен), сам токен нигде не хранится и выдаётся один раз (в cookie). */
export async function createSession(
  userId: string,
  ip?: string | null,
  userAgent?: string | null,
): Promise<CreatedSession> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: {
      idHash: sha256Hex(token),
      userId,
      expiresAt,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    },
  });
  return { token, expiresAt };
}

/** Значение Set-Cookie для сессии; Max-Age считается из expiresAt (просрочка → 0).
 *  Почему secure-ветка меняет SameSite: Lax не отправляется в кросс-сайт iframe
 *  предпросмотра, а для iframe нужен None — но None без Secure браузеры отвергают,
 *  поэтому в комплекте идут Secure + Partitioned (см. шапку файла и ./https.ts). */
export function sessionCookieHeader(token: string, expiresAt: Date, secure = false): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  // Partitioned (CHIPS) — даёт cookie собственный partition в кросс-сайт iframe (Chrome);
  // браузеры без поддержки атрибут просто игнорируют (RFC 6265).
  const site = secure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; ${site}; Max-Age=${maxAge}`;
}

/** Set-Cookie, убивающий сессию на клиенте: атрибуты повторяют боевые (иначе
 *  браузер не сочтёт это той же cookie и не перезапишет её), значение пустое, Max-Age=0. */
export function clearSessionCookieHeader(secure = false): string {
  const site = secure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; ${site}; Max-Age=0`;
}

/** Запрос пришёл через HTTPS (напрямую или за reverse-proxy/шлюзом)? */
export { isHttpsRequest as isSecureRequest } from './https';

export async function destroySessionByToken(token: string): Promise<void> {
  const idHash = sha256Hex(token);
  touchState.delete(idHash); // анти-утечка: ключ больше не пригодится
  try {
    await db.session.delete({ where: { idHash } });
  } catch {
    // сессии уже нет — идемпотентно
  }
}

/** Пользователь текущей сессии или null (нет токена / истекла / неактивна /
 *  пользователь неактивен). Слайдинг idle-окна: подтверждённая сессия получает
 *  touch (обновление updatedAt) с троттлингом 5 минут — не пишет в БД на каждый
 *  запрос, но держит актуальность «последней активности» для idle-таймаута. */
export async function getSessionUser(req: NextRequest): Promise<SessionUser | null> {
  const token = getSessionToken(req);
  if (!token) return null;
  const idHash = sha256Hex(token);
  const session = await db.session.findUnique({
    where: { idHash },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await destroySessionByToken(token);
    return null;
  }
  // Idle-таймаут: давно не было активности — сессия аннулируется (токен/cookie
  // остаются у браузера, но перестают работать; cookie истечёт по max-age).
  if (isIdleExpired(session.updatedAt)) {
    await db.session.delete({ where: { idHash } }).catch(() => {});
    return null;
  }
  if (!session.user.isActive) return null;
  touchSessionActivity(idHash);
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    isActive: session.user.isActive,
    mustChangePassword: session.user.mustChangePassword,
  };
}

/** Продление idle-окна: запись updatedAt не чаще раза в TOUCH_THROTTLE_MS
 *  (in-memory троттлинг); сбой записи не влияет на запрос (fail-soft). */
async function touchSessionActivity(idHash: string): Promise<void> {
  const now = Date.now();
  const last = touchState.get(idHash) ?? 0;
  if (now - last < TOUCH_THROTTLE_MS) return;
  // Редкая подтиска устаревших записей (анти-утечка карты — см. pruneTouchState)
  if (touchState.size > 512) pruneTouchState();
  touchState.set(idHash, now);
  try {
    await db.session.update({ where: { idHash }, data: { updatedAt: new Date(now) } });
  } catch {
    // сессия удалена параллельно (logout из другого устройства) — не страшно
  }
}

/** Токен сессии: cookie tg_sid → Authorization: Bearer (фолбэк для iframe). */
export function getSessionToken(req: NextRequest): string | null {
  const cookieToken = req.cookies.get(SESSION_COOKIE)?.value;
  if (cookieToken && /^[0-9a-f]{64}$/.test(cookieToken)) return cookieToken;
  const authorization = req.headers.get('authorization');
  if (authorization) {
    const match = /^Bearer ([0-9a-f]{64})$/i.exec(authorization.trim());
    if (match) return match[1].toLowerCase();
  }
  return null;
}
