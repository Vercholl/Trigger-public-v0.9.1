// Наблюдаемость интеграции (G7): единый JSON-снимок здоровья всех потоков
// конвейера «система данных → Trigger → провайдер → BI» для карточки
// «Интеграция» в панели (refetch 15 с) и мониторинга (zabbix/grafana —
// JSON-экспорт: числа и секунды, пороги удобно сравнивать напрямую).
//
// Метрики по секциям:
//  • inbox — приём событий: глубина очереди NEW/PROCESSING/FAILED, лаг
//    (возраст старейшего NEW — «сколько событие ждёт воркера»), обороты 24 ч;
//  • imports — ускоренный поток батч-импорта (skip_triggers): pending;
//  • funnels/broadcasts — активные сущности и очередь SMS к отправке;
//  • sms — отправки/доставки/ошибки за 24 ч;
//  • forwarder — очередь обратного потока (services/forwarder.ts);
//  • worker — свежесть тика (совпадает с /api/health).
// Чтение — без побочных эффектов; все счётчики — агрегаты по индексам.
// Вызывается из API-роута /api/v1/integrations/status (GET, любая роль).
import { db } from '@/lib/db';
import { getWorkerState } from '@/lib/scheduler/worker';
import { getSettings } from '@/lib/services/settings';
import { forwarderStats } from '@/lib/services/forwarder';

/** Лаг обработки: возраст старейшего NEW-события (сек) — null при пустой
 *  очереди. Норма: < 15 с (тик воркера + запас); > 60 с — сигнал голода. */
async function inboxLag(): Promise<{ oldestNewAt: Date | null; lagSeconds: number | null }> {
  const oldest = await db.eventsInbox.findFirst({
    where: { status: 'NEW' },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  if (!oldest) return { oldestNewAt: null, lagSeconds: null };
  return {
    oldestNewAt: oldest.createdAt,
    lagSeconds: Math.max(0, Math.round((Date.now() - oldest.createdAt.getTime()) / 1000)),
  };
}

/** Сводный снимок (см. комментарий модуля). */
export async function getIntegrationStatus(): Promise<Record<string, unknown>> {
  const cutoff24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [
    inboxNew,
    inboxProcessing,
    inboxFailed,
    inboxProcessed24h,
    inboxFailed24h,
    lastIngest,
    importsPending,
    importsProcessed24h,
    funnelsActive,
    broadcastsActive,
    smsQueued,
    smsSending,
    smsDue,
    smsSent24h,
    smsDelivered24h,
    smsFailed24h,
    lag,
    forwarder,
    settings,
  ] = await Promise.all([
    db.eventsInbox.count({ where: { status: 'NEW', skipTriggers: false } }),
    db.eventsInbox.count({ where: { status: 'PROCESSING', skipTriggers: false } }),
    db.eventsInbox.count({ where: { status: 'FAILED' } }),
    db.eventsInbox.count({ where: { status: 'PROCESSED', updatedAt: { gte: cutoff24 } } }),
    db.eventsInbox.count({ where: { status: 'FAILED', updatedAt: { gte: cutoff24 } } }),
    db.eventsInbox.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true, event: true } }),
    db.eventsInbox.count({ where: { status: 'NEW', skipTriggers: true } }),
    db.eventsInbox.count({
      where: { status: 'PROCESSED', skipTriggers: true, updatedAt: { gte: cutoff24 } },
    }),
    db.funnel.count({ where: { isActive: true } }),
    db.broadcast.count({ where: { status: 'ACTIVE' } }),
    db.smsMessage.count({ where: { status: 'QUEUED', scheduledFor: null } }),
    db.smsMessage.count({ where: { status: 'SENDING' } }),
    db.smsMessage.count({ where: { status: 'QUEUED', scheduledFor: { lte: new Date() } } }),
    db.smsMessage.count({ where: { sentAt: { gte: cutoff24 } } }),
    db.smsMessage.count({ where: { deliveredAt: { gte: cutoff24 } } }),
    db.smsMessage.count({ where: { status: 'FAILED', updatedAt: { gte: cutoff24 } } }),
    inboxLag(),
    forwarderStats(),
    getSettings(),
  ]);

  const worker = getWorkerState();
  return {
    generatedAt: new Date().toISOString(),
    inbox: {
      new: inboxNew,
      processing: inboxProcessing,
      failed: inboxFailed,
      processed24h: inboxProcessed24h,
      failed24h: inboxFailed24h,
      lastIngestAt: lastIngest?.createdAt ?? null,
      lastIngestEvent: lastIngest?.event ?? null,
      oldestNewAt: lag.oldestNewAt,
      lagSeconds: lag.lagSeconds,
    },
    imports: {
      pending: importsPending,
      processed24h: importsProcessed24h,
    },
    funnels: { active: funnelsActive },
    broadcasts: {
      active: broadcastsActive,
      smsQueued,
      smsSending,
      smsDue,
    },
    sms: {
      sent24h: smsSent24h,
      delivered24h: smsDelivered24h,
      failed24h: smsFailed24h,
    },
    forwarder,
    worker: {
      lastTickAt: worker ? new Date(worker.lastTickAt).toISOString() : null,
      tickCount: worker?.tickCount ?? 0,
      lastTickAgoSeconds: worker && worker.lastTickAt > 0
        ? Math.max(0, Math.round((Date.now() - worker.lastTickAt) / 1000))
        : null,
    },
    provider: settings.provider,
  };
}
