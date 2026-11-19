// GET/POST /api/v1/unsubscribe — ПУБЛИЧНАЯ отписка по HMAC-токену (?t=).
// GET — проверка ссылки (маскированный номер, рекламодатель);
// POST — исполнение отписки (идемпотентно).
// Rate-limit симметрично коротким ссылкам /u (защита от перебора токенов).
// ПУБЛИЧНЫЙ (без аутентификации): подпись HMAC в токене и есть авторизация —
// отписка без входа в панель. Успех: {ok, phone (маска), advertiser?};
// битый/истёкший токен → 400 {ok:false, title}. Побочные эффекты POST:
// upsert в стоп-лист, client.unsubscribedAt, audit-лог (UNSUBSCRIBE, user=null).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, problem, publicRoute } from '@/lib/api';
import { checkUnsubscribeToken, performUnsubscribe } from '@/lib/services/unsubscribe';
import { shortLinkRateLimiter } from '@/lib/security/rate-limiter';

/**
 * Rate-limit публичного эндпоинта: 60 запросов/мин на IP (shortLinkRateLimiter,
 * счётчик в БД). Превышение → 429 problem+json; null — лимит не исчерпан,
 * обработка продолжается. Вынесен отдельно, т.к. роут без withAuth.
 */
async function checkRate(req: NextRequest): Promise<NextResponse | null> {
  const ip = getClientIp(req);
  const allowed = await shortLinkRateLimiter.check(`unsub:ip:${ip}`, 60, 60);
  if (!allowed) {
    return problem(429, 'Слишком много запросов — попробуйте позже');
  }
  return null;
}

export const GET = publicRoute(async (req): Promise<NextResponse> => {
  const limited = await checkRate(req);
  if (limited) return limited;
  const token = req.nextUrl.searchParams.get('t') ?? '';
  const result = await checkUnsubscribeToken(token);
  return NextResponse.json(result.response, { status: result.status });
});

export const POST = publicRoute(async (req): Promise<NextResponse> => {
  const limited = await checkRate(req);
  if (limited) return limited;
  const token = req.nextUrl.searchParams.get('t') ?? '';
  const result = await performUnsubscribe(token, getClientIp(req));
  return NextResponse.json(result.response, { status: result.status });
});
