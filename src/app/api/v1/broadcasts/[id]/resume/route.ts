// POST /api/v1/broadcasts/{id}/resume — возобновление паузы (MANAGER+).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { resumeBroadcast } from '@/lib/services/broadcasts';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const row = await resumeBroadcast(params.id, user, getClientIp(req));
    return NextResponse.json(row);
  },
  { write: 'MANAGER' },
);
