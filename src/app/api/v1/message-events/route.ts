// GET /api/v1/message-events — журнал «События доставки»: события
// отправок/доставок/кликов/отписок со всех источников + статистика.
// Фильтры: q (телефон, contains), type, source, period (дней; 0/нет — всё),
// page/pageSize. Чтение — любая аутентифицированная роль.
// Успех 200 { items, total, page, pageSize, stats } — stats считается по ВСЕМУ
// журналу (без фильтров) параллельно со списком. Read-only.
import { NextRequest, NextResponse } from 'next/server';
import { parsePagination, withAuth } from '@/lib/api';
import { listMessageEvents, messageEventStats } from '@/lib/services/message-events';

/** Значение фильтра из query: пустая строка и служебное 'ALL' означают
 *  «не фильтровать» (→ undefined). */
function filterValue(sp: URLSearchParams, key: string): string | undefined {
  const v = (sp.get(key) ?? '').trim();
  return v === '' || v === 'ALL' ? undefined : v;
}

export const GET = withAuth(async (req: NextRequest): Promise<NextResponse> => {
  const sp = req.nextUrl.searchParams;
  const pagination = parsePagination(sp);
  // period — предустановленные «времянки» UI (0/1/7/30/90); мусор → 0 (всё время).
  const periodRaw = Number.parseInt(sp.get('period') ?? '0', 10);
  const periodDays = Number.isFinite(periodRaw) && periodDaysOk(periodRaw) ? periodRaw : 0;

  // Список (с фильтрами) и глобальная статистика — параллельно, одним заходом.
  const [list, stats] = await Promise.all([
    listMessageEvents({
      q: (sp.get('q') ?? '').trim() || undefined,
      type: filterValue(sp, 'type'),
      source: filterValue(sp, 'source'),
      periodDays,
      ...pagination,
    }),
    messageEventStats(),
  ]);
  return NextResponse.json({ ...list, stats });
});

/** Разрешённые значения period (дней): 0 (всё время), 1, 7, 30, 90. */
function periodDaysOk(v: number): boolean {
  return v === 0 || v === 1 || v === 7 || v === 30 || v === 90;
}
