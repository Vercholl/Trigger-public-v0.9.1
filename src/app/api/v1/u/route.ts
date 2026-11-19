// GET/POST /api/v1/u?c={code} — ПУБЛИЧНАЯ отписка по КОРОТКОЙ ссылке (П7).
// Код 7 символов из SMS (…/?u=Xk3fQ9a) резолвится в HMAC-токен из таблицы
// ShortLink; дальше — тот же контракт, что у /api/v1/unsubscribe?t=:
//   GET  — проверка ссылки (маскированный номер, рекламодатель) + фикс перехода;
//   POST — исполнение отписки (идемпотентно; сервисные SMS продолжают уходить).
// ПУБЛИЧНЫЙ (без аутентификации): код 7 символов неугадываем (алфавит без
// похожих глифов) + rate-limit 60/мин/IP. Успех: {ok, phone (маска),
// advertiser?}; битый/истёкший код → 400 {ok:false, title}. Побочные эффекты:
// GET — фикс перехода (visits+1, строка ShortLinkVisit); POST — стоп-лист +
// client.unsubscribedAt + audit-лог (UNSUBSCRIBE, user=null).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, problem, publicRoute } from '@/lib/api';
import { checkUnsubscribeCode, performUnsubscribeByCode } from '@/lib/services/unsubscribe';
import { shortLinkRateLimiter } from '@/lib/security/rate-limiter';

/**
 * Rate-limit публичного эндпоинта: 60 запросов/мин на IP, общий ключ
 * `shortlink:ip:` с редирект-роутом /r. Превышение → 429 problem+json;
 * null — обработка продолжается. Вынесен отдельно, т.к. роут без withAuth.
 */
async function checkRate(req: NextRequest): Promise<NextResponse | null> {
  const ip = getClientIp(req);
  const allowed = await shortLinkRateLimiter.check(`shortlink:ip:${ip}`, 60, 60);
  if (!allowed) {
    return problem(429, 'Слишком много запросов — попробуйте позже');
  }
  return null;
}

export const GET = publicRoute(async (req): Promise<NextResponse> => {
  const limited = await checkRate(req);
  if (limited) return limited;
  const code = req.nextUrl.searchParams.get('c') ?? '';
  const result = await checkUnsubscribeCode(code);
  return NextResponse.json(result.response, { status: result.status });
});

export const POST = publicRoute(async (req): Promise<NextResponse> => {
  const limited = await checkRate(req);
  if (limited) return limited;
  // Резолв без track: переход уже зафиксирован GET-проверкой ссылки.
  const code = req.nextUrl.searchParams.get('c') ?? '';
  const result = await performUnsubscribeByCode(code, getClientIp(req));
  return NextResponse.json(result.response, { status: result.status });
});
