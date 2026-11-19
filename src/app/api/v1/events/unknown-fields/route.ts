// GET /api/v1/events/unknown-fields — сводка «радара» доработок системы данных:
// поля client_card, которых нет в схеме карточки (registry/card-fields),
// с счётчиком и первым/последним упоминанием. Любая роль (чтение).
// 200 { items: [{ fieldName, count, firstSeenAt, lastSeenAt, lastEventName }] }.
// Пусто — внешняя система передаёт только известные поля (или событий с карточкой нет).
// Удаление наблюдения — DELETE /events/unknown-fields/{fieldName} (ADMIN).
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { listUnknownFields } from '@/lib/services/events';

export const GET = withAuth(async (): Promise<NextResponse> => {
  const items = await listUnknownFields();
  return NextResponse.json({ items });
});
