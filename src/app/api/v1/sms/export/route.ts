// GET /api/v1/sms/export — CSV-экспорт лога (BOM, «;», attachment). Аудит EXPORT.
// Любая аутентифицированная роль. Фильтры те же, что в GET /sms, но без
// пагинации: выгрузка до 10 000 строк (кап). Ответ 200 text/csv; имя файла
// sms_log_YYYYMMDD.csv, число строк — в заголовке X-Rows-Count.
// Побочный эффект — audit EXPORT/SMS (фильтры и число строк).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { exportSmsCsv } from '@/lib/services/sms-log';

export const GET = withAuth(async (req, user): Promise<NextResponse> => {
  // Фильтры повторяют журнал (GET /sms) — выгрузка «что вижу, то и получаю».
  const sp = req.nextUrl.searchParams;
  const { csv, filename, count } = await exportSmsCsv(
    {
      status: sp.get('status') ?? undefined,
      search: sp.get('search') ?? undefined,
      from: sp.get('from') ?? undefined,
      to: sp.get('to') ?? undefined,
    },
    user,
    getClientIp(req),
  );
  // Ответ-файл: BOM (внутри csv — от сервиса) даёт корректную кириллицу в Excel;
  // X-Rows-Count — число выгруженных строк без парсинга файла.
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Rows-Count': String(count),
    },
  });
});
