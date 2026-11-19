// PUT/DELETE /api/v1/links/{id} — редактирование и удаление именной ссылки.
// Код ссылки сохраняется (QR/напечатанные материалы не ломаются).
// RBAC: MANAGER+. Успех: PUT → 200 + карточка ссылки; DELETE → 204 без тела.
// Ошибки 404 (ссылка не найдена) и 422 (URL/дата) — problem+json (RFC 7807).
// Побочный эффект — audit-лог (UPDATE/DELETE SHORT_LINK).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { deleteNamedLink, namedLinkSchema, updateNamedLink } from '@/lib/compliance/marketing-links';

export const PUT = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const dto = namedLinkSchema.parse(await readJson(req));
    const link = await updateNamedLink(params.id, dto, user, getClientIp(req));
    return NextResponse.json(link);
  },
  { write: 'MANAGER' },
);

export const DELETE = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    await deleteNamedLink(params.id, user, getClientIp(req));
    return new NextResponse(null, { status: 204 });
  },
  { write: 'MANAGER' },
);
