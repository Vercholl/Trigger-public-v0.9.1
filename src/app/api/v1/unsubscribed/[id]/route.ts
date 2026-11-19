// DELETE /api/v1/unsubscribed/{id} — удалить из списка (MANAGER+), снимает
// client.unsubscribedAt при совпадении телефона (клиент снова получает
// маркетинговые SMS). Успех: 204 без тела; 404 — problem+json «Запись не найдена».
// Побочный эффект — audit-лог (DELETE, маскированный телефон).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, problem, withAuth } from '@/lib/api';
import { removeUnsubscribed } from '@/lib/services/unsubscribe';

export const DELETE = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Сервис сигнализирует «нет записи» Error('NOT_FOUND') — переводим в 404;
    // прочие исключения уйдут в общий обработчик withAuth (→ problem+json).
    try {
      await removeUnsubscribed(params.id, user, getClientIp(req));
    } catch (e) {
      if (e instanceof Error && e.message === 'NOT_FOUND') {
        return problem(404, 'Запись не найдена');
      }
      throw e;
    }
    return new NextResponse(null, { status: 204 });
  },
  { write: 'MANAGER' },
);
