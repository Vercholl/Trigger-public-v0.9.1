// Определение HTTPS за reverse-proxy/шлюзом по НЕСКОЛЬКИМ независимым сигналам.
//
// Причина: внутренний Caddy-шлюз песочницы слушает :81 по HTTP и выставляет
// `header_up X-Forwarded-Proto {scheme}`, что ЗАТИРАЕТ значение внешнего
// HTTPS-терминатора ('https' → 'http'). Из-за этого признак HTTPS до приложения
// по x-forwarded-proto не доходит, cookie ставится как SameSite=Lax и браузер
// отбрасывает её в кросс-сайт iframe предпросмотра → цикл авторизации.
//
// Надёжный обходной сигнал — браузерные заголовки Origin/Referer: страница SPA
// открыта по https, значит и все её fetch-запросы приходят с https-страницы.
// Прокси эти заголовки не подменяет. Дополнительно поддержаны классические
// сигналы терминаторов (X-Forwarded-SSL/Front-End-Https) и ЛЮБОЙ сегмент
// X-Forwarded-Proto (цепочки прокси дописывают свои значения справа).
import type { NextRequest } from 'next/server';

/** Любой сегмент x-forwarded-proto равен https (прокси-цепочки дописывают значения). */
function forwardedProtoHttps(req: NextRequest): boolean {
  const xfp = req.headers.get('x-forwarded-proto');
  if (!xfp) return false;
  return xfp
    .split(',')
    .some((segment) => segment.trim().toLowerCase() === 'https');
}

/** Классические сигналы терминаторов: `X-Forwarded-SSL: on` (nginx), `Front-End-Https: on` (IIS). */
function proxySslHeaders(req: NextRequest): boolean {
  const ssl = req.headers.get('x-forwarded-ssl');
  if (ssl && ssl.split(',')[0]?.trim().toLowerCase() === 'on') return true;
  const frontEndHttps = req.headers.get('front-end-https');
  if (frontEndHttps && frontEndHttps.split(',')[0]?.trim().toLowerCase() === 'on') {
    return true;
  }
  return false;
}

/** Браузерный сигнал: страница открыта по https (Origin на POST, Referer на GET). */
function browserHttpsSignal(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (origin && origin.toLowerCase().startsWith('https://')) return true;
  const referer = req.headers.get('referer');
  if (referer && referer.toLowerCase().startsWith('https://')) return true;
  return false;
}

/** Запрос пришёл к приложению по HTTPS — напрямую или за reverse-proxy/шлюзом? */
export function isHttpsRequest(req: NextRequest): boolean {
  if (forwardedProtoHttps(req)) return true;
  if (proxySslHeaders(req)) return true;
  if (browserHttpsSignal(req)) return true;
  try {
    return req.nextUrl.protocol === 'https:';
  } catch {
    return false;
  }
}
