// GET /api/v1/segments/{id}/clients — клиенты сегмента (сессия, любая роль):
// постраничный предпросмотр состава (?page/?pageSize, 1..100, умолчание 20).
// Фиксированный срез — страницы из SegmentMember (COUNT по индексу); динамический —
// вычисление по условиям (кэш счёта 5 мин). Успех: {items, total, page, pageSize,
// skip, take}; ошибки 404/422 — problem+json (RFC 7807). Чтение без побочных эффектов.
import { NextRequest, NextResponse } from 'next/server';
import { parsePagination, withAuth } from '@/lib/api';
import { listSegmentClients } from '@/lib/services/segments';

export const GET = withAuth<{ id: string }>(
  async (req, _user, params): Promise<NextResponse> => {
    const { page, pageSize, skip, take } = parsePagination(req.nextUrl.searchParams);
    const result = await listSegmentClients(params.id, page, pageSize);
    // Параметры пагинации дублируются в ответе (echo) — фронт строит пейджер из них.
    return NextResponse.json({ ...result, page, pageSize, skip, take });
  },
);
