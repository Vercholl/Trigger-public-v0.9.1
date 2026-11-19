// POST /api/v1/events/{id}/retry — повторная обработка упавшего события (MANAGER+).
// Сброс FAILED → NEW; воркер подхватит событие в ближайший тик.
// Успех 200 (сериализованное событие со статусом NEW); 404 — событие не найдено;
// 409 — статус не FAILED (перезапуск только упавших). Побочный эффект —
// audit RETRY/EVENT с IP инициатора.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { retryEvent, serializeEvent } from '@/lib/services/events';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Атомарный claim в сервисе: статус меняется только у строки в FAILED.
    const row = await retryEvent(params.id, user, getClientIp(req));
    return NextResponse.json(serializeEvent(row));
  },
  { write: 'MANAGER' },
);
