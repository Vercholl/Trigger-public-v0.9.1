// POST /api/v1/instances/{id}/cancel — отмена активного экземпляра (MANAGER+).
// Успех 200 (сводка экземпляра со статусом CANCELLED); 404 — не найден;
// 409 — экземпляр уже в терминальном статусе. Отмена гасит и PENDING-задачи
// (планировщик их больше не отправит), пишет INFO-событие в таймлайн и
// audit CANCEL/INSTANCE.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { cancelInstance, serializeInstanceSummary } from '@/lib/services/instances';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Валидируемые переходы — RUNNING/WAITING → CANCELLED; остальное — 409 в сервисе.
    const updated = await cancelInstance(params.id, user, getClientIp(req));
    return NextResponse.json(serializeInstanceSummary(updated));
  },
  { write: 'MANAGER' },
);
