// POST /api/v1/broadcasts/{id}/restart — перезапуск завершённой рассылки (MANAGER+).
// Создаёт НОВЫЙ запуск (появится в истории «Запуски»): рассылка переводится
// в ACTIVE и выполняется немедленно. Защита «не чаще 1 раза в N дней» работает —
// клиенты, получавшие эту рассылку недавно, пропускаются (skippedGuard).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { restartBroadcast } from '@/lib/services/broadcasts';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const { result, broadcast } = await restartBroadcast(params.id, user, getClientIp(req));
    return NextResponse.json({ result, broadcast }, { status: 202 });
  },
  { write: 'MANAGER' },
);
