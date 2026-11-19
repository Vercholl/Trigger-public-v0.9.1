// GET /r?c={code} — ПУБЛИЧНЫЙ редирект по именной короткой ссылке.
// Код из SMS (…/r?c=Xk3fQ9a) → целевой URL с UTM (302) + запись перехода
// в редирект-лог (ShortLinkVisit). Недействительная/истёкшая ссылка —
// понятная HTML-страница 404. Rate-limit — как у отписочной /api/v1/u.
// ПУБЛИЧНЫЙ (без аутентификации): защита — неугадываемый код (алфавит без
// похожих глифов) + rate-limit 60/мин/IP. Редирект 302 (не 301) — браузер
// не кэширует, каждый клик попадает в лог. Побочные эффекты: visits+1 и
// строка ShortLinkVisit (в транзакции; сбой статистики редирект не роняет).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, publicRoute } from '@/lib/api';
import { resolveNamedLink } from '@/lib/compliance/marketing-links';
import { shortLinkRateLimiter } from '@/lib/security/rate-limiter';

/**
 * HTML-страница 404 «Ссылка недействительна» — единый ответ на битый код,
 * истёкшую ссылку и сработавший rate-limit (не раскрывает причину отказа).
 * Текст статичен и не содержит данных пользователя — экранировать нечего.
 */
function invalidLinkPage(): NextResponse {
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ссылка недействительна</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #fafafa; color: #3f3f46;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; padding: 24px; }
  .card { max-width: 420px; margin: 0 auto; text-align: center;
          background: #fff; border: 1px solid #e4e4e7; border-radius: 16px; padding: 40px 32px; }
  .icon { font-size: 40px; }
  h1 { font-size: 20px; margin: 16px 0 8px; color: #18181b; }
  p { font-size: 14px; line-height: 1.5; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">🔗</div>
    <h1>Ссылка недействительна</h1>
    <p>Возможно, акция завершилась или в ссылке опечатка. Проверьте код из SMS или свяжитесь с нами.</p>
  </div>
</body>
</html>`;
  return new NextResponse(html, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export const GET = publicRoute(async (req): Promise<NextResponse> => {
  // Лимит до резолва — защита от брутфорса кодов; превышение неотличимо от битой ссылки.
  const ip = getClientIp(req);
  const allowed = await shortLinkRateLimiter.check(`shortlink:ip:${ip}`, 60, 60);
  if (!allowed) {
    return invalidLinkPage();
  }
  // track=true — фиксация клика: счётчик visits + строка ShortLinkVisit.
  const code = req.nextUrl.searchParams.get('c') ?? '';
  const resolved = await resolveNamedLink(code, { track: true });
  // Страховка от open-redirect: уходим только на http(s)-адрес (целевой URL
  // валидируется при создании ссылки, здесь — повторная проверка схемы).
  if (!resolved || !/^https?:\/\//i.test(resolved.targetUrl)) {
    return invalidLinkPage();
  }
  return NextResponse.redirect(resolved.targetUrl, { status: 302 });
});
