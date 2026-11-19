// GET /api/v1/clients/{id}/history — история изменений профиля клиента (P5):
// диффы «было → стало» по всем источникам (MANUAL | IMPORT | EVENT |
// MASS_UPDATE), новейшие первыми. ?page=&pageSize= (по умолчанию 10).
// Успех: 200 {items, total, page, pageSize}; 404 — клиент не найден.
// Чтение — без побочных эффектов (любая аутентифицированная роль).
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { getClientById } from '@/lib/services/clients';
import { getClientProfileHistory } from '@/lib/services/profile-history';

const MAX_PAGE_SIZE = 50;

export const GET = withAuth<{ id: string }>(async (req: NextRequest, _user, params): Promise<NextResponse> => {
  // 404, если клиента нет (гард единого контракта с /clients/{id})
  await getClientById(params.id);
  const page = Math.max(1, Number(req.nextUrl.searchParams.get('page')) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.nextUrl.searchParams.get('pageSize')) || 10));
  const result = await getClientProfileHistory(params.id, { skip: (page - 1) * pageSize, take: pageSize });
  return NextResponse.json({ ...result, page, pageSize });
});
