// POST /api/v1/segments/{id}/freeze — зафиксировать/обновить состав сегмента (MANAGER+).
// Материализует текущий состав подходящих клиентов в срез (SegmentMember):
// число и рассылки «замирают» ровно на этом списке, пока срез не обновят или
// не снимут фиксацию (POST /unfreeze). Повторный вызов = пересъёмка среза.
// Успех: 200 + карточка сегмента (mode=static, frozenCount, frozenAt);
// ошибки 404/422 — problem+json (RFC 7807). Побочные эффекты: запись среза
// SegmentMember, сброс кэша счёта, audit-лог (FREEZE/SEGMENT).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { freezeSegment, serializeSegment } from '@/lib/services/segments';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const row = await freezeSegment(params.id, user, getClientIp(req));
    return NextResponse.json(serializeSegment(row));
  },
  { write: 'MANAGER' },
);
