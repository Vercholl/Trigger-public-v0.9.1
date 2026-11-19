// GET /api/v1/broadcasts/{id} — карточка рассылки + запуски (последние 20, с причинами отказов).
// PUT /api/v1/broadcasts/{id} — редактирование (MANAGER+, только ACTIVE/PAUSED).
// DELETE /api/v1/broadcasts/{id} — удаление: очередь снимается, запуски удаляются,
// SMS-история остаётся с именем рассылки (MANAGER+).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { deleteBroadcast, getBroadcast, updateBroadcast, updateBroadcastSchema } from '@/lib/services/broadcasts';

export const GET = withAuth<{ id: string }>(
  async (_req, _user, params): Promise<NextResponse> => {
    const row = await getBroadcast(params.id);
    return NextResponse.json(row);
  },
);

export const PUT = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const dto = updateBroadcastSchema.parse(await readJson(req));
    const row = await updateBroadcast(params.id, dto, user, getClientIp(req));
    return NextResponse.json(row);
  },
  { write: 'MANAGER' },
);

export const DELETE = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    await deleteBroadcast(params.id, user, getClientIp(req));
    return new NextResponse(null, { status: 204 });
  },
  { write: 'MANAGER' },
);
