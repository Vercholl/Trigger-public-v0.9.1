// GET /api/v1/short-links/stats — статистика коротких ссылок отписки (П7)
// для карточки настроек: создано/переходов/отписок. Чтение — любая роль.
// Учитывает только kind=UNSUBSCRIBE (именные LINK — отдельно в GET /api/v1/links).
// Успех: {total, total30d, visited, visits, last30dVisits, unsubscribed30d,
// unsubscribedTotal}. Чтение — побочных эффектов нет.
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { db } from '@/lib/db';
import { getShortLinkStats } from '@/lib/compliance/short-links';

export const GET = withAuth(async (): Promise<NextResponse> => {
  // Три независимых счёта (по ссылкам + стоп-лист за 30 дней + весь стоп-лист) — параллельно.
  const [stats, unsub30d, unsubTotal] = await Promise.all([
    getShortLinkStats(),
    db.unsubscribeList.count({ where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } } }),
    db.unsubscribeList.count(),
  ]);
  return NextResponse.json({ ...stats, unsubscribed30d: unsub30d, unsubscribedTotal: unsubTotal });
});
