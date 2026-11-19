// PUT/DELETE /api/v1/funnels/{id} — обновление (version+1) и удаление (409 при экземплярах).
// Оба — MANAGER+. PUT: updateFunnelSchema → 200 (version+1); 404/422 (некорректный
// граф definition); audit UPDATE/FUNNEL. Активную воронку редактировать можно —
// изменения применяются к новым запускам.
// DELETE: 204 без тела; 409 — у воронки есть экземпляры (сохраняем историю);
// audit DELETE/FUNNEL.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { deleteFunnel, serializeFunnel, updateFunnel, updateFunnelSchema } from '@/lib/services/funnels';

export const PUT = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Частичное обновление; definition (если передан) заново валидируется в сервисе.
    const dto = updateFunnelSchema.parse(await readJson(req));
    const funnel = await updateFunnel(params.id, dto, user, getClientIp(req));
    return NextResponse.json(serializeFunnel(funnel));
  },
  { write: 'MANAGER' },
);

export const DELETE = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Физическое удаление; 409-гард «есть экземпляры» — в сервисе.
    await deleteFunnel(params.id, user, getClientIp(req));
    return new NextResponse(null, { status: 204 });
  },
  { write: 'MANAGER' },
);
