// POST /api/v1/segments/{id}/unfreeze — снять фиксацию сегмента (MANAGER+).
// Срез удаляется, сегмент возвращается к живому пересчёту по условиям.
// Успех: 200 + карточка сегмента (mode=dynamic, frozenCount/frozenAt=null);
// ошибки 404/409 (сегмент не зафиксирован) — problem+json (RFC 7807).
// Побочные эффекты: удаление среза SegmentMember, сброс кэша счёта,
// audit-лог (UNFREEZE/SEGMENT).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { serializeSegment, unfreezeSegment } from '@/lib/services/segments';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const row = await unfreezeSegment(params.id, user, getClientIp(req));
    return NextResponse.json(serializeSegment(row));
  },
  { write: 'MANAGER' },
);
