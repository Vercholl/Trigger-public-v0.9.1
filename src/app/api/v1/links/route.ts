// GET  /api/v1/links — список именных коротких ссылок (kind=LINK, любая роль):
// {items} с visits/lastVisitAt/smsCount (новые сверху).
// POST /api/v1/links — создать ссылку (MANAGER+): название + целевой URL + UTM →
// короткий код для SMS ({base}/r?c={code}). Успех: 201 + карточка ссылки;
// ошибки 422 (URL/дата действия) — problem+json (RFC 7807).
// Побочный эффект POST — audit-лог (CREATE/SHORT_LINK).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { createNamedLink, listNamedLinks, namedLinkSchema } from '@/lib/compliance/marketing-links';

export const GET = withAuth(async (): Promise<NextResponse> => {
  const items = await listNamedLinks();
  return NextResponse.json({ items });
});

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    const dto = namedLinkSchema.parse(await readJson(req));
    const link = await createNamedLink(dto, user, getClientIp(req));
    return NextResponse.json(link, { status: 201 });
  },
  { write: 'MANAGER' },
);
