// POST /api/v1/funnels/{id}/deactivate — деактивация (MANAGER+).
// Успех 200 (воронка isActive=false); 404 — воронка не найдена. Новые события
// triggerEvent больше не запускают воронку (воркер выбирает только активные);
// уже идущие экземпляры дорабатывают до конца. Побочный эффект —
// audit DEACTIVATE/FUNNEL.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { serializeFunnel, setFunnelActive } from '@/lib/services/funnels';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Деактивация = только флаг: без валидации графа и без отмены экземпляров.
    const funnel = await setFunnelActive(params.id, false, user, getClientIp(req));
    return NextResponse.json(serializeFunnel(funnel));
  },
  { write: 'MANAGER' },
);
