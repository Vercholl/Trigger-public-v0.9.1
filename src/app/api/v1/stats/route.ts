// GET /api/v1/stats — статистика дашборда (?days=14, максимум 365).
// RBAC: любая аутентифицированная роль. Успех: 200 {totals, byDay, recentEvents,
// topFunnels, topTemplates} (состав — services/stats.ts); ошибки: 401 problem+json.
// days: не-число/≤0 → 14, >365 → 365. Побочных эффектов нет.
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { getStats } from '@/lib/services/stats';

export const GET = withAuth(async (req): Promise<NextResponse> => {
  // Разбор ?days (дефолт 14, клэмп к 365) → сервис агрегаций за окно.
  const raw = req.nextUrl.searchParams.get('days');
  const parsed = raw ? Number.parseInt(raw, 10) : 14;
  const days = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 365) : 14;
  const result = await getStats(days);
  return NextResponse.json(result);
});
