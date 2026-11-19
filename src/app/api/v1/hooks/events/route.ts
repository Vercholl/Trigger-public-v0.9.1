// POST /api/v1/hooks/events — ПУБЛИЧНЫЙ приёмник «Захвата событий».
// Тело — JSON-массив событий (батч) или одиночный объект. Каждое событие:
// { event_type, event_date, account_id, profile_id, subscription{channel:"sms",
// phone} (объект или массив), event_data{message_id, campaign_id, …},
// custom_data{…}, content{sms, fromnamesms}, is_test }.
//
// Авторизация — токен панели:
//   • заголовок Authorization: Bearer <токен> (предпочтительно — не остаётся
//     в логах доступа);
//   • query-параметр ?token=<значение из карточки «Захват событий»> —
//     для совместимости с уже настроенным отправителем.
// Сравнение токена — timing-safe (sha256-хеши фиксированной длины).
// Rate-limit — 300/мин с IP (webhookRateLimiter, как у приёмников шлюзов):
// публичный POST без лимита нагружал БД (чтение настроек) на каждый запрос
// молотилкой/подбором токена.
//
// Ответ: 200 с телом "OK" (матчит регулярное выражение успеха .*OK.* и пустое).
// Счётчики — в заголовках X-Trigger-* (не ломают проверку тела ответа).
// Батч больше 5000 событий → 413 ProblemDetails (идемпотентность dedupKey
// делает безопасным ретрай меньшими батчами).
//
// Идемпотентность: ретраи отправителя (например, 4 попытки / 15 сек) не создают
// дублей — дедуп по dedupKey (event_type + ids + message_id + event_date).
//
// Тумблер AppSettings.hooksEnabled: выключен → 200 "OK" без записи (отправитель
// не ретраит, события не копятся). Токен не сгенерирован → 401.
//
// is_test=true (инструмент предтеста внешней платформы) — событие пишется
// в журнал, но побочных эффектов (отписка/статусы SMS/корреляция) не даёт.
import { NextRequest, NextResponse } from 'next/server';
import { ApiError, getClientIp, publicRoute, problem } from '@/lib/api';
import { getSettings } from '@/lib/services/settings';
import { hooksTokenMatches, processHookEvents } from '@/lib/services/message-events';
import { webhookRateLimitPerMin, webhookRateLimiter } from '@/lib/security/rate-limiter';
import { logSecurityEventThrottled } from '@/lib/security/audit';
import { readJsonBounded } from '@/lib/security/body-limit';

/** Лимит тела приёмника: 5 МБ (батч ≤ 5000 событий с карточками — с запасом;
 * анти-DoS — см. security/body-limit.ts). */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export const POST = publicRoute(async (req: NextRequest): Promise<NextResponse> => {
  // Rate-limit ДО чтения настроек и сверки токена (единый паттерн публичных
  // приёмников — см. webhooks/smstech): отсекает молотилку без нагрузки на БД.
  const ip = getClientIp(req);
  const allowed = await webhookRateLimiter.check(`hooks:ip:${ip}`, webhookRateLimitPerMin(), 60);
  if (!allowed) {
    return problem(429, 'Слишком много запросов');
  }

  const settings = await getSettings();

  // Тумблер выключен: подтверждаем приём (OK), но ничего не записываем
  if (!settings.hooksEnabled) {
    const resp = new NextResponse('OK');
    resp.headers.set('X-Trigger-Hooks', 'disabled');
    return resp;
  }

  // Токен обязателен: приёмник без токена закрыт. Приоритет — заголовок
  // Authorization: Bearer (не светится в логах доступа), фолбэк — ?token=.
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization')?.trim() ?? '');
  const token = (bearer?.[1] ?? req.nextUrl.searchParams.get('token') ?? '').trim();
  if (settings.hooksToken.trim() === '') {
    return problem(401, 'Приёмник не настроен', 'Сгенерируйте токен в карточке «Захват событий» (Интеграции)');
  }
  if (!hooksTokenMatches(token, settings.hooksToken)) {
    // Аудит неудачной аутентификации (SECURITY): троттлинг 1 запись / 10 мин на
    // (kind, ip) — молотилка не раздувает журнал, факт попытки — виден ИБ.
    await logSecurityEventThrottled('hooks_bad_token', ip, { path: '/api/v1/hooks/events' });
    return problem(401, 'Неверный токен приёмника');
  }

  let body: unknown;
  try {
    body = await readJsonBounded(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 413 || e.status === 400)) {
      return problem(e.status, e.title, e.detail);
    }
    throw e;
  }
  if (typeof body !== 'object' || body === null) {
    return problem(400, 'Некорректное тело запроса', 'Ожидается JSON: массив событий или одиночный объект');
  }

  const summary = await processHookEvents(body);
  const resp = new NextResponse('OK');
  resp.headers.set('X-Trigger-Events-Accepted', String(summary.accepted));
  resp.headers.set('X-Trigger-Events-Created', String(summary.created));
  resp.headers.set('X-Trigger-Events-Duplicates', String(summary.duplicates));
  resp.headers.set('X-Trigger-Events-Invalid', String(summary.invalid));
  return resp;
});

// GET — самодиагностика для оператора (curl/браузер): состояние приёмника
export const GET = publicRoute(async (): Promise<NextResponse> => {
  const settings = await getSettings();
  return NextResponse.json({
    ok: true,
    path: '/api/v1/hooks/events',
    method: 'POST',
    enabled: settings.hooksEnabled,
    tokenRequired: settings.hooksToken.trim() !== '',
    auth: 'Authorization: Bearer <токен> (предпочтительно) или query ?token=<токен>',
    format: 'json-batch: [{ event_type, event_date, subscription{phone}, event_data, custom_data }, …]',
    maxBatch: 5000,
  });
});
