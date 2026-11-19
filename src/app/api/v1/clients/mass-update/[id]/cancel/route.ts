// POST /api/v1/clients/mass-update/{id}/cancel — отмена операции (MANAGER+).
// PENDING → не начнётся; RUNNING → воркер остановится между порциями
// (обработанное остаётся применённым). Терминальные статусы → 409.
// Успех: 200 + карточка операции. Побочные эффекты: запись MassUpdateJob,
// audit-лог CANCEL. Тело запроса не требуется (пустое допустимо).
import { NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { cancelMassUpdateJob, serializeMassUpdateJob } from '@/lib/services/mass-update';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const row = await cancelMassUpdateJob(params.id, user, getClientIp(req));
    return NextResponse.json(serializeMassUpdateJob(row));
  },
  { write: 'MANAGER' },
);
