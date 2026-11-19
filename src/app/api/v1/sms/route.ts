// GET /api/v1/sms — SMS-лог с фильтрами (status, search, from, to) и пагинацией.
// Любая аутентифицированная роль; успех 200 { items, total }. from/to — даты
// (ISO или YYYY-MM-DD, по времени createdAt); неизвестный status → 422. Read-only.
import { NextRequest, NextResponse } from 'next/server';
import { parsePagination, withAuth } from '@/lib/api';
import { listSms } from '@/lib/services/sms-log';

export const GET = withAuth(async (req): Promise<NextResponse> => {
  // Фильтры из query-string; пустые значения → undefined (сервис их игнорирует).
  const sp = req.nextUrl.searchParams;
  const result = await listSms(
    {
      status: sp.get('status') ?? undefined,
      search: sp.get('search') ?? undefined,
      from: sp.get('from') ?? undefined,
      to: sp.get('to') ?? undefined,
    },
    parsePagination(sp),
  );
  return NextResponse.json(result);
});
