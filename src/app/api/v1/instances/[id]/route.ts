// GET /api/v1/instances/{id} — детали: экземпляр, воронка, клиент, таймлайн, сообщения.
// Любая аутентифицированная роль; успех 200 — композитный ответ из сервиса
// (summary + timeline + messages); 404 — экземпляр не найден.
// Read-only, без побочных эффектов.
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { getInstanceDetail } from '@/lib/services/instances';

export const GET = withAuth<{ id: string }>(async (_req, _user, params): Promise<NextResponse> => {
  // Сервис собирает сводку из нескольких таблиц (экземпляр, воронка, клиент, события, сообщения).
  const detail = await getInstanceDetail(params.id);
  return NextResponse.json(detail);
});
