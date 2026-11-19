// Сервис статистики дашборда. Message-метрики и топы (шаблонов/воронок)
// считаются за окно `days`;
// activeInstances/waitingJobs — текущее состояние; unsubscribed — всего строк.
// Переходы по коротким ссылкам за период (редирект-лог ShortLinkVisit)
// разбиваются по дням и типу (именные LINK / отписочные UNSUBSCRIBE);
// топ шаблонов — отправки/доставки/отказы за период.
// Вызывается из API-роута: /api/v1/stats?days=N (дашборд панели).
// Таблицы Prisma (только чтение): SmsMessage, ShortLinkVisit, UnsubscribeList,
// WorkflowInstance, ScheduledJob, EventsInbox. Побочных эффектов нет.
import { db } from '@/lib/db';
import { serializeEvent } from '@/lib/services/events';

export interface StatsResult {
  totals: {
    sent: number;
    delivered: number;
    failed: number;
    rejected: number;
    unsubscribed: number;
    activeInstances: number;
    waitingJobs: number;
    /** Переходы по именным коротким ссылкам за период. */
    linkClicks: number;
    /** Переходы по отписочным коротким ссылкам за период. */
    unsubLinkVisits: number;
    /** Новые отписки за период. */
    unsubscribedInPeriod: number;
  };
  byDay: Array<{ date: string; sent: number; delivered: number; failed: number; rejected: number; clicks: number }>;
  recentEvents: unknown[];
  topFunnels: Array<{ name: string; count: number }>;
  /** Топ шаблонов за период. */
  topTemplates: Array<{ name: string; sent: number; delivered: number; rejected: number }>;
}

/** Дата → ключ дня «ГГГГ-ММ-ДД» в UTC (группировка byDay без локальных сюрпризов). */
function utcDateKey(d: Date): string {
  return [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

/** Агрегация за окно `days` (по умолчанию от роута — 30): тоталы, разбивка
 *  по дням UTC, топ-5 воронок и шаблонов, последние 5 событий inbox.
 *  Чистое чтение — без побочных эффектов.
 *
 *  МАСШТАБ: сообщений в окне — сотни тысяч (500 тыс./мес), поэтому счётчики
 *  и разбивки считаются ГРУППИРОВКОЙ В SQL (`GROUP BY день/статус/шаблон`),
 *  а не выгрузкой строк: было findMany(500 тыс. строк → 4–5 с и сотни МБ
 *  промежуточных объектов), стало O(дней × статусов) строк из БД (~200).
 *  Формат хранения DateTime в SQLite — INTEGER-миллисекунды (проверено на
 *  dev- и нагрузочной БД), день = целочисленное деление на 86400000. */
interface DayStatusRow {
  day: number | bigint;
  status: string;
  c: number | bigint;
}
interface TemplateStatusRow {
  templateName: string;
  status: string;
  c: number | bigint;
}
interface VisitRow {
  day: number | bigint;
  kind: string;
  c: number | bigint;
}

export async function getStats(days: number): Promise<StatsResult> {
  const now = new Date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  const windowStartMs = windowStart.getTime();

  const [dayStatusRows, templateRows, visitRows] = await Promise.all([
    // Сообщения за окно: (UTC-день, статус) → счёт. Индекс SmsMessage(createdAt)
    // даёт диапазонное сканирование вместо полной таблицы
    db.$queryRawUnsafe<DayStatusRow[]>(
      `SELECT (createdAt / 86400000) AS day, status, COUNT(*) AS c
         FROM SmsMessage WHERE createdAt >= ? GROUP BY day, status`,
      windowStartMs,
    ),
    // Топ шаблонов: (шаблон, статус) → счёт; аггрегация по дням в JS не нужна
    db.$queryRawUnsafe<TemplateStatusRow[]>(
      `SELECT templateName, status, COUNT(*) AS c
         FROM SmsMessage WHERE createdAt >= ? AND templateName IS NOT NULL
         GROUP BY templateName, status`,
      windowStartMs,
    ),
    // Редирект-лог за окно: (UTC-день, тип ссылки) → счёт
    db.$queryRawUnsafe<VisitRow[]>(
      `SELECT (createdAt / 86400000) AS day, kind, COUNT(*) AS c
         FROM ShortLinkVisit WHERE createdAt >= ? GROUP BY day, kind`,
      windowStartMs,
    ),
  ]);

  const totals = { sent: 0, delivered: 0, failed: 0, rejected: 0, linkClicks: 0, unsubLinkVisits: 0 };
  const byDayMap = new Map<
    string,
    { sent: number; delivered: number; failed: number; rejected: number; clicks: number }
  >();
  // каркас дней с нулями
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1) + i));
    byDayMap.set(utcDateKey(d), { sent: 0, delivered: 0, failed: 0, rejected: 0, clicks: 0 });
  }
  const bucketFor = (dayIdx: number) => {
    const key = utcDateKey(new Date(dayIdx * 86400000));
    let bucket = byDayMap.get(key);
    if (!bucket) {
      bucket = { sent: 0, delivered: 0, failed: 0, rejected: 0, clicks: 0 };
      byDayMap.set(key, bucket);
    }
    return bucket;
  };
  for (const r of dayStatusRows) {
    const bucket = bucketFor(Number(r.day)); // BigInt из raw-SQL → number
    const c = Number(r.c);
    // sent = SENT + DELIVERED (контракт; REJECTED/FAILED не считаются отправкой)
    if (r.status === 'SENT' || r.status === 'DELIVERED') {
      bucket.sent += c;
      totals.sent += c;
    }
    if (r.status === 'DELIVERED') {
      bucket.delivered += c;
      totals.delivered += c;
    }
    if (r.status === 'FAILED') {
      bucket.failed += c;
      totals.failed += c;
    }
    if (r.status === 'REJECTED_BY_COMPLIANCE') {
      bucket.rejected += c;
      totals.rejected += c;
    }
  }
  for (const v of visitRows) {
    const bucket = bucketFor(Number(v.day));
    const c = Number(v.c);
    bucket.clicks += c;
    if (v.kind === 'LINK') {
      totals.linkClicks += c;
    } else {
      totals.unsubLinkVisits += c;
    }
  }

  // Топ шаблонов за период (по имени; системные SMS без шаблона — вне топа)
  const templateAgg = new Map<string, { sent: number; delivered: number; rejected: number }>();
  for (const r of templateRows) {
    const agg = templateAgg.get(r.templateName) ?? { sent: 0, delivered: 0, rejected: 0 };
    const c = Number(r.c);
    if (r.status === 'SENT' || r.status === 'DELIVERED') agg.sent += c;
    if (r.status === 'DELIVERED') agg.delivered += c;
    if (r.status === 'REJECTED_BY_COMPLIANCE') agg.rejected += c;
    templateAgg.set(r.templateName, agg);
  }
  const topTemplates = Array.from(templateAgg.entries())
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.sent - a.sent)
    .slice(0, 5);

  const [unsubscribed, unsubscribedInPeriod, activeInstances, waitingJobs, recentEventRows, funnelGroups] = await Promise.all([
    // Отписки: всего строк стоп-листа и новые за окно
    db.unsubscribeList.count(),
    db.unsubscribeList.count({ where: { createdAt: { gte: windowStart } } }),
    db.workflowInstance.count({ where: { status: { in: ['RUNNING', 'WAITING'] } } }),
    db.scheduledJob.count({ where: { status: 'PENDING' } }),
    db.eventsInbox.findMany({ orderBy: { createdAt: 'desc' }, take: 5 }),
    // Топ воронок — за то же окно days, что и остальные метрики карточки
    // (иначе смена периода дашборда меняла бы соседние топы, а этот — нет).
    db.workflowInstance.groupBy({ by: ['funnelName'], _count: { _all: true }, where: { createdAt: { gte: windowStart } } }),
  ]);

  const topFunnels = funnelGroups
    .map((g) => ({ name: g.funnelName, count: g._count._all }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totals: {
      sent: totals.sent,
      delivered: totals.delivered,
      failed: totals.failed,
      rejected: totals.rejected,
      unsubscribed,
      activeInstances,
      waitingJobs,
      linkClicks: totals.linkClicks,
      unsubLinkVisits: totals.unsubLinkVisits,
      unsubscribedInPeriod,
    },
    byDay: Array.from(byDayMap.entries()).map(([date, v]) => ({ date, ...v })),
    recentEvents: recentEventRows.map(serializeEvent),
    topFunnels,
    topTemplates,
  };
}
