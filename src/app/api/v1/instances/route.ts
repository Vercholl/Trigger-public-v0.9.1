// GET /api/v1/instances — список экземпляров воронок с фильтрами и поиском.
// Любая аутентифицированная роль; успех 200 { items, total }. Фильтры:
// status, funnelId, clientId, search + пагинация (page/pageSize).
// Read-only, без побочных эффектов.
import { NextRequest, NextResponse } from 'next/server';
import { parsePagination, withAuth } from '@/lib/api';
import { listInstances } from '@/lib/services/instances';

export const GET = withAuth(async (req): Promise<NextResponse> => {
  // Фильтры из query-string; пустые значения → undefined (сервис их игнорирует).
  const sp = req.nextUrl.searchParams;
  const result = await listInstances({
    status: sp.get('status') ?? undefined,
    funnelId: sp.get('funnelId') ?? undefined,
    clientId: sp.get('clientId') ?? undefined,
    search: sp.get('search') ?? undefined,
    ...parsePagination(sp),
  });
  return NextResponse.json(result);
});
