// POST /api/v1/events — ПУБЛИЧНЫЙ приём событий от внешней системы (X-Api-Key).
// GET /api/v1/events — список событий (сессия).
// POST (publicRoute): пре-авторизационный IP-лимит (env, дефолт 600/мин)
// → сверка API-ключа (401) → пер-ключевой лимит (ApiKey.rateLimitPerMin или
// env-дефолт 120/мин) → 202 { eventId, duplicate } — событие ложится в
// events_inbox со статусом NEW, обработает воркер (запуск воронок; строки с
// skip_triggers=true — только upsert карточки); дубликат по idempotency_key —
// тоже 202.
// «Радар»: сырой client_card из тела передаётся в ingest — неизвестные поля
// карточки (расширения источника вне нашей схемы) фиксируются для сводки.
// GET: любая роль; фильтры status/event + пагинация; 200 { items, total }.
import { NextRequest, NextResponse } from 'next/server';
import {
  deriveBaseUrl,
  getClientIp,
  parsePagination,
  publicRoute,
  problem,
  withAuth,
} from '@/lib/api';
import { authenticateApiKey } from '@/lib/security/api-keys';
import { eventsIpRateLimit, eventsKeyRateLimit, eventsRateLimiter } from '@/lib/security/rate-limiter';
import { logSecurityEventThrottled } from '@/lib/security/audit';
import { readJsonBounded } from '@/lib/security/body-limit';
import { eventIngestSchema, ingestEvent, listEvents, rawClientCardOf } from '@/lib/services/events';

/** Лимит тела события: 2 МБ (событие + карточка клиента — с запасом;
 * анти-DoS — см. security/body-limit.ts). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export const POST = publicRoute(async (req): Promise<NextResponse> => {
  // Rate-limit ДО сверки секрета: брутфорс по ключам не нагружает БД.
  const ip = getClientIp(req);
  const allowed = await eventsRateLimiter.check(`events:ip:${ip}`, eventsIpRateLimit(), 60);
  if (!allowed) {
    return problem(429, 'Слишком много запросов', `Превышен лимит ${eventsIpRateLimit()} запросов в минуту с одного IP`);
  }

  // Ключ выдаётся в разделе «API-ключи» панели; сбой сверки — 401 problem+json.
  const auth = await authenticateApiKey(req, ip);
  if (!auth.ok) {
    // Аудит неудачной аутентификации (SECURITY): троттлинг 1 запись / 10 мин
    // на (kind, ip) — молотилка по ключам не раздувает журнал.
    await logSecurityEventThrottled('events_bad_api_key', ip, { path: '/api/v1/events' });
    return problem(401, 'Неверный API-ключ');
  }

  // Пер-ключевой лимит ПОСЛЕ сверки: интеграционный ключ ядра может иметь
  // повышенный потолок (ApiKey.rateLimitPerMin), прочие — env-дефолт 120/мин.
  const keyLimit = auth.rateLimitPerMin ?? eventsKeyRateLimit();
  const keyAllowed = await eventsRateLimiter.check(
    `events:key:${auth.apiKeyId ?? 'static'}`,
    keyLimit,
    60,
  );
  if (!keyAllowed) {
    return problem(429, 'Слишком много запросов', `Превышен лимит ${keyLimit} запросов в минуту для этого API-ключа`);
  }

  const body = await readJsonBounded(req, MAX_BODY_BYTES);
  const dto = eventIngestSchema.parse(body);
  const result = await ingestEvent(
    dto,
    {
      apiKeyId: auth.apiKeyId,
      source: 'API',
      ip,
      baseUrl: deriveBaseUrl(req), // Origin запроса → ссылка отписки
    },
    rawClientCardOf(body),
  );
  return NextResponse.json(result, { status: 202 });
});

export const GET = withAuth(async (req): Promise<NextResponse> => {
  // Фильтры из query-string; пустые/неизвестные значения сервис игнорирует.
  const sp = req.nextUrl.searchParams;
  const result = await listEvents({
    status: sp.get('status') ?? undefined,
    event: sp.get('event') ?? undefined,
    ...parsePagination(sp),
  });
  return NextResponse.json(result);
});
