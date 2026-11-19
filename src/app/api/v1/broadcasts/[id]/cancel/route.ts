// POST /api/v1/broadcasts/{id}/cancel — терминальная отмена рассылки (MANAGER+).
// Будущие запуски прекращаются, запланированные, но не отправленные QUEUED-сообщения
// переводятся в CANCELLED; карточка и история запусков остаются. Отменить можно
// активную или приостановленную (DONE перезапускается, CANCELLED уже необратим).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { cancelBroadcast } from '@/lib/services/broadcasts';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const row = await cancelBroadcast(params.id, user, getClientIp(req));
    return NextResponse.json(row);
  },
  { write: 'MANAGER' },
);
