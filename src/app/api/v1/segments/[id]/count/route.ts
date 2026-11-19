// GET /api/v1/segments/{id}/count — число подходящих клиентов + режим.
// Динамический: точный живой пересчёт (кэш 5 мин, computedAt — когда считали).
// Фиксированный: размер среза (COUNT по индексу — мгновенно, frozenAt — метка
// фиксации). На больших базах это основная информация о сегменте: состав
// показывается постраничным превью в /clients.
// Успех: {total, mode, computedAt, frozenAt}; ошибки 404/422 — problem+json.
// Чтение (любая роль), побочных эффектов нет.
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { countSegmentClients } from '@/lib/services/segments';

export const GET = withAuth<{ id: string }>(
  async (_req, _user, params): Promise<NextResponse> => {
    const result = await countSegmentClients(params.id);
    return NextResponse.json(result);
  },
);
