// GET /api/v1/clients/{id}/messages — история SMS-отправок клиента (карточка
// во «Клиентах»): пагинация + агрегаты по статусам. Доступ — любой
// аутентифицированный (как и журнал SMS).
// Успех 200 { items, stats { total, delivered, sent, failed, queued, lastAt },
// page, pageSize }; 404 — клиент не найден. Read-only, без побочных эффектов.
import { NextRequest, NextResponse } from 'next/server';
import { parsePagination, withAuth } from '@/lib/api';
import { getClientById } from '@/lib/services/clients';
import { getClientSmsHistory } from '@/lib/services/sms-log';

export const GET = withAuth<{ id: string }>(
  async (req: NextRequest, _user, params): Promise<NextResponse> => {
    // Проверка существования клиента даёт честный 404 вместо пустой истории.
    await getClientById(params.id); // 404, если клиента нет
    const { page, pageSize, skip, take } = parsePagination(req.nextUrl.searchParams);
    const result = await getClientSmsHistory(params.id, { skip, take });
    // page/pageSize дублируются в ответе для пагинации UI.
    return NextResponse.json({ ...result, page, pageSize });
  },
);
