// PUT /api/v1/segments/{id} — обновить сегмент (MANAGER+): {name?, description?, conditions?}.
// DELETE /api/v1/segments/{id} — удалить сегмент (MANAGER+) → 204 без тела.
// PUT: 409 — правка conditions у зафиксированного (static) среза; 422 — некорректные правила.
// DELETE: 404 — сегмента нет; 409 — на сегмент ссылается ACTIVE/PAUSED-рассылка.
// Ошибки — problem+json (RFC 7807); оба метода пишут audit-лог (UPDATE/DELETE SEGMENT).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { deleteSegment, serializeSegment, updateSegment, updateSegmentSchema } from '@/lib/services/segments';

export const PUT = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const dto = updateSegmentSchema.parse(await readJson(req));
    const row = await updateSegment(params.id, dto, user, getClientIp(req));
    return NextResponse.json(serializeSegment(row));
  },
  { write: 'MANAGER' },
);

export const DELETE = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    await deleteSegment(params.id, user, getClientIp(req));
    return new NextResponse(null, { status: 204 });
  },
  { write: 'MANAGER' },
);
