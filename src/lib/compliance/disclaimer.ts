// Дисклеймер рекламных SMS и HMAC-токены отписки.
// Токен: base64url(`tenant.clientId.expMs`) + '.' + base64url(hmacSha256(payload)),
// срок действия 180 дней. Секрет — только из env UNSUBSCRIBE_SECRET.
// Текст приписки ({link}/{advertiser}) — изоморфный disclaimer-text.ts.
import { createHmac, timingSafeEqual } from 'crypto';
import type { AppSettings } from '@prisma/client';

export * from './disclaimer-text';

/** Срок жизни токена отписки: 180 дней — по ссылке из SMS клиент может перейти
 *  спустя месяцы после отправки, отписка обязана сработать и тогда. */
export const UNSUBSCRIBE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function getSecret(): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? '';
  if (secret.length === 0) {
    // Пустой секрет делал бы HMAC предсказуемым (токены можно подделать) —
    // fail-fast вместо молчаливой слабой подписи.
    throw new Error('UNSUBSCRIBE_SECRET не задан в окружении — генерация/проверка токенов отписки запрещена');
  }
  return secret;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function hmacB64url(payload: string): string {
  return createHmac('sha256', getSecret()).update(payload, 'utf8').digest('base64url');
}

/** Токен отписки для клиента (срок 180 дней). */
export function generateUnsubscribeToken(clientId: string, nowMs: number = Date.now()): string {
  const expMs = nowMs + UNSUBSCRIBE_TOKEN_TTL_MS;
  const payload = `${process.env.TENANT_ID ?? 'trigger'}.${clientId}.${expMs}`;
  return `${b64url(payload)}.${hmacB64url(payload)}`;
}

export type VerifyTokenResult =
  | { ok: true; clientId: string; expMs: number }
  | { ok: false; reason: 'format' | 'signature' | 'expired' };

/** Проверить токен отписки. Возвращает {ok:true, clientId, expMs} либо {ok:false, reason},
 *  где reason различает причины отказа: 'format' — структура/base64 не парсится (не
 *  наш токен, обрезан/бит), 'signature' — HMAC не совпал (подделка или чужой/незаданный
 *  секрет), 'expired' — срок жизни истёк. Разделение нужно вызывающим, чтобы показать
 *  честную причину на публичной странице отписки, а не безликий 500. */
export function verifyUnsubscribeToken(token: string): VerifyTokenResult {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return { ok: false, reason: 'format' };
  }
  let payload: string;
  try {
    payload = Buffer.from(parts[0], 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'format' };
  }
  // Пустой секрет (ошибка конфигурации) → считаем подпись невалидной, а не 500 на публичной странице
  let expectedSig: Buffer;
  try {
    expectedSig = Buffer.from(hmacB64url(payload), 'base64url');
  } catch (e) {
    console.error('[unsubscribe] HMAC secret error:', e instanceof Error ? e.message : String(e));
    return { ok: false, reason: 'signature' };
  }
  // Сравнение подписей за постоянное время: обе стороны декодируются из base64url
  // в сырые 32 байта HMAC (lengths всегда равны при валидном формате).
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[1], 'base64url');
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (provided.length !== expectedSig.length || !timingSafeEqual(provided, expectedSig)) {
    return { ok: false, reason: 'signature' };
  }
  const segs = payload.split('.');
  if (segs.length !== 3) return { ok: false, reason: 'format' };
  const clientId = segs[1];
  const expMs = Number(segs[2]);
  if (!clientId || !Number.isFinite(expMs)) return { ok: false, reason: 'format' };
  if (expMs <= Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, clientId, expMs };
}

/** Маскировка номера: «+» и код страны + «***» + последние 4 цифры («+7***1234»). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return '***';
  const countryCode = digits.slice(0, 1);
  return `+${countryCode}***${digits.slice(-4)}`;
}

/** Базовый URL ссылки отписки: приоритет — контекст экземпляра, настройки, env, хост по умолчанию. */
export function resolveUnsubscribeBaseUrl(
  instanceBaseUrl: string | null | undefined,
  settings: AppSettings,
): string {
  if (instanceBaseUrl && instanceBaseUrl.trim() !== '') return instanceBaseUrl.trim();
  if (settings.unsubscribeBaseUrl && settings.unsubscribeBaseUrl.trim() !== '') {
    return settings.unsubscribeBaseUrl.trim();
  }
  const envUrl = process.env.UNSUBSCRIBE_BASE_URL;
  if (envUrl && envUrl.trim() !== '') return envUrl.trim();
  const host = process.env.SERVER_PUBLIC_HOST || 'localhost';
  return `http://${host}:3000`;
}
