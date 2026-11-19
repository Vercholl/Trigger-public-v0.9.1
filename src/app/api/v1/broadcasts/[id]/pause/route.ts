// POST /api/v1/broadcasts/{id}/pause — пауза: новые запуски и отправка очереди замирают (MANAGER+).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { pauseBroadcast } from '@/lib/services/broadcasts';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const row = await pauseBroadcast(params.id, user, getClientIp(req));
    return NextResponse.json(row);
  },
  { write: 'MANAGER' },
);
