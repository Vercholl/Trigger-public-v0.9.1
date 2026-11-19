// POST /api/v1/broadcasts/{id}/run — запуск прямо сейчас (MANAGER+).
// Анти-дубль: не чаще одного запуска рассылки в минуту (409).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { runBroadcastNow } from '@/lib/services/broadcasts';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const { result, broadcast } = await runBroadcastNow(params.id, user, getClientIp(req));
    return NextResponse.json({ result, broadcast }, { status: 202 });
  },
  { write: 'MANAGER' },
);
