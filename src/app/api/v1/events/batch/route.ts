// POST /api/v1/events/batch — ПУБЛИЧНЫЙ батч-приём событий от адаптера внешней
// системы (X-Api-Key): {events: [{event, external_id, payload?, client_card?,
// idempotency_key?, skip_triggers?}]} ≤ 10 000 строк, тело ≤ 10 МБ
// (как import_batch legacy-платформы: ≤10 000 профилей / ≤10 МБ).
//
// Назначение: стартовая загрузка базы (3 млн карточек), ЧДП-джоб и прочие
// массовые обновления — без упора в лимиты одиночного /events. Строки со
// skip_triggers=true воркер обрабатывает «только upsert карточки» (без
// запуска воронок) ускоренным батчем по 2000 строк — 3 млн ≈ 1–2 часа.
//
// Ответ 202 — отчёт по строкам (мусорная строка не роняет батч, адаптер
// повторяет только упавшие): {accepted, created, duplicates, invalid,
// results: [{index, eventId?, duplicate?, error?}]}.
// Ошибки problem+json: 429 (лимиты IP/ключа), 401 (ключ), 413 (тело),
// 422 (структура: не массив / пусто / > 10 000).
// Лимиты: пре-авторизационный IP (env EVENTS_IP_RATE_LIMIT_PER_MIN, 600/мин),
// пер-ключевой на батч-запросы (ApiKey.rateLimitPerMin либо env
// EVENTS_BATCH_KEY_RATE_LIMIT_PER_MIN, дефолт 60/мин → до 600 тыс. строк/мин).
import { NextResponse } from 'next/server';
import {
  deriveBaseUrl,
  getClientIp,
  publicRoute,
  problem,
} from '@/lib/api';
import { authenticateApiKey } from '@/lib/security/api-keys';
import {
  eventsBatchKeyRateLimit,
  eventsIpRateLimit,
  eventsRateLimiter,
} from '@/lib/security/rate-limiter';
import { logSecurityEventThrottled } from '@/lib/security/audit';
import { readJsonBounded } from '@/lib/security/body-limit';
import { eventBatchSchema, ingestEventsBatch } from '@/lib/services/events';

/** Лимит тела батча: 10 МБ (10 000 карточек по ~1 КБ — с запасом; анти-DoS —
 *  security/body-limit.ts, ранний 413 по Content-Length до чтения тела). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export const POST = publicRoute(async (req): Promise<NextResponse> => {
  // Rate-limit ДО сверки секрета (как у одиночного приёма).
  const ip = getClientIp(req);
  const allowed = await eventsRateLimiter.check(`events:ip:${ip}`, eventsIpRateLimit(), 60);
  if (!allowed) {
    return problem(429, 'Слишком много запросов', `Превышен лимит ${eventsIpRateLimit()} запросов в минуту с одного IP`);
  }

  const auth = await authenticateApiKey(req, ip);
  if (!auth.ok) {
    await logSecurityEventThrottled('events_bad_api_key', ip, { path: '/api/v1/events/batch' });
    return problem(401, 'Неверный API-ключ');
  }

  // Пер-ключевой лимит батч-запросов: каждый запрос несёт до 10 000 строк,
  // поэтому дефолт ниже одиночного (60/мин; интеграционный ключ — свой потолок).
  const keyLimit = auth.rateLimitPerMin ?? eventsBatchKeyRateLimit();
  const keyAllowed = await eventsRateLimiter.check(
    `events-batch:key:${auth.apiKeyId ?? 'static'}`,
    keyLimit,
    60,
  );
  if (!keyAllowed) {
    return problem(429, 'Слишком много запросов', `Превышен лимит ${keyLimit} батч-запросов в минуту для этого API-ключа`);
  }

  const body = await readJsonBounded(req, MAX_BODY_BYTES);
  const dto = eventBatchSchema.parse(body);
  const result = await ingestEventsBatch(dto.events, {
    apiKeyId: auth.apiKeyId,
    source: 'API',
    ip,
    baseUrl: deriveBaseUrl(req),
  });
  return NextResponse.json(result, { status: 202 });
});
