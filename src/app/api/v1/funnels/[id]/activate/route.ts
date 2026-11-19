// POST /api/v1/funnels/{id}/activate — активация (с повторной валидацией графа).
// MANAGER+. Успех 200 (воронка isActive=true); 404 — воронка не найдена;
// 422 — граф некорректен (шаблоны могли удалиться/отключиться с момента
// редактирования). После активации воркер начнёт запускать воронку по её
// triggerEvent. Побочный эффект — audit ACTIVATE/FUNNEL.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { serializeFunnel, setFunnelActive } from '@/lib/services/funnels';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Валидация графа выполняется в сервисе ПЕРЕД сменой флага — активной
    // не может стать «сломанная» воронка.
    const funnel = await setFunnelActive(params.id, true, user, getClientIp(req));
    return NextResponse.json(serializeFunnel(funnel));
  },
  { write: 'MANAGER' },
);
