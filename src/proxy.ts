// Рантайм-фрейм-протекция: X-Frame-Options: DENY при FRAME_PROTECTION=1 в .env.
// Статические security-заголовки задаются в next.config.ts headers() и попадают
// в routes-manifest на этапе СБОРКИ (см. docs/security.md); X-Frame-Options
// намеренно вынесен сюда (convention proxy — бывший middleware, Next.js 16) —
// компания разворачивает готовый архив и должна уметь включать защиту от
// встраивания в iframe без пересборки (runtime env).
import { NextRequest, NextResponse } from 'next/server';

export function proxy(_req: NextRequest): NextResponse {
  if (process.env.FRAME_PROTECTION !== '1') return NextResponse.next();
  const res = NextResponse.next();
  res.headers.set('X-Frame-Options', 'DENY');
  return res;
}

export const config = {
  // Все пути, кроме статики Next (она без frame-рисков, экономим вызовы)
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
