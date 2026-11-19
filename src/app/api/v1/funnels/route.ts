// GET/POST /api/v1/funnels — список и создание воронок (запись — MANAGER+).
// GET — любая роль: фильтры search, triggerEvent + пагинация; 200 { items, total }.
// POST — MANAGER+: createFunnelSchema → 201; 422 — некорректный граф
// definition (сервис валидирует узлы/шаблоны). Новая воронка создаётся
// неактивной (isActive=false). Побочный эффект — audit CREATE/FUNNEL.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, parsePagination, readJson, withAuth } from '@/lib/api';
import { createFunnel, createFunnelSchema, listFunnels, serializeFunnel } from '@/lib/services/funnels';

export const GET = withAuth(async (req): Promise<NextResponse> => {
  // Фильтры из query-string; пустые значения → undefined (сервис их игнорирует).
  const sp = req.nextUrl.searchParams;
  const result = await listFunnels({
    search: sp.get('search') ?? undefined,
    triggerEvent: sp.get('triggerEvent') ?? undefined,
    ...parsePagination(sp),
  });
  return NextResponse.json(result);
});

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    // Структура воронки (граф узлов) валидируется в сервисе до записи в БД.
    const dto = createFunnelSchema.parse(await readJson(req));
    const funnel = await createFunnel(dto, user, getClientIp(req));
    return NextResponse.json(serializeFunnel(funnel), { status: 201 });
  },
  { write: 'MANAGER' },
);
