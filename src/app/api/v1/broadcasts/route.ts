// GET /api/v1/broadcasts — список рассылок со статистикой последнего запуска.
// POST /api/v1/broadcasts — создать рассылку (MANAGER+). Origin запроса
// сохраняется в рассылку — база ссылки отписки в SMS (как у событий).
import { NextRequest, NextResponse } from 'next/server';
import { deriveBaseUrl, getClientIp, readJson, withAuth } from '@/lib/api';
import { createBroadcast, createBroadcastSchema, listBroadcasts } from '@/lib/services/broadcasts';

export const GET = withAuth(async (): Promise<NextResponse> => {
  const result = await listBroadcasts();
  return NextResponse.json(result);
});

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    const dto = createBroadcastSchema.parse(await readJson(req));
    const row = await createBroadcast(dto, user, getClientIp(req), deriveBaseUrl(req));
    return NextResponse.json(row, { status: 201 });
  },
  { write: 'MANAGER' },
);
