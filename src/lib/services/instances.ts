// Сервис экземпляров воронок: список, детали с таймлайном, ручная отмена.
// Домен: runtime триггерных сценариев — один экземпляр = один прогон воронки
// по конкретному клиенту (создаётся движком engine/, тикается воркером scheduler/).
// Вызывается из API-роутов: /api/v1/instances (GET-список), /instances/{id}
// (GET-детали), /instances/{id}/cancel (POST). cancelActiveInstancesForClient —
// экспорт «про запас» (массовая отмена активных экземпляров клиента): сегодня
// публичная отписка её СОЗНАТЕЛЬНО не вызывает — отписка блокирует только
// маркетинговые SMS через комплаенс, сервисные шаги воронки продолжают идти
// (см. шапку services/unsubscribe); движок engine продолжает исполнение только
// пока экземпляр не CANCELLED (гарды отмены — engine.ts).
// Таблицы Prisma: WorkflowInstance, InstanceEvent (таймлайн), SmsMessage
// (сообщения экземпляра), ScheduledJob (отмена PENDING-задач), Funnel/Client
// (include), AuditLog через logAudit.
import type { Prisma, WorkflowInstance } from '@prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';
import { logInstanceEvent } from '@/lib/engine/engine';

/** Статусы экземпляра: RUNNING/WAITING — живые, COMPLETED/FAILED/CANCELLED —
 *  терминальные (изменению не подлежат). */
export const INSTANCE_STATUSES = ['RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;

/** Строка WorkflowInstance (+ опциональный клиент) → компактный JSON списка. */
export function serializeInstanceSummary(row: WorkflowInstance & { client?: { id: string; externalId: string; phone: string } | null }): Record<string, unknown> {
  return {
    id: row.id,
    funnelId: row.funnelId,
    funnelName: row.funnelName,
    funnelVersion: row.funnelVersion,
    client: row.client
      ? { id: row.client.id, externalId: row.client.externalId, phone: row.client.phone }
      : null,
    status: row.status,
    currentNodeId: row.currentNodeId,
    error: row.error,
    eventId: row.eventId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Список экземпляров: фильтры по статусу/воронке/клиенту, поиск по имени
 *  воронки и externalId/телефону клиента, пагинация. Чтение — без побочных эффектов. */
export async function listInstances(filters: {
  status?: string;
  funnelId?: string;
  clientId?: string;
  search?: string;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}): Promise<{ items: unknown[]; total: number }> {
  const where: Prisma.WorkflowInstanceWhereInput = {};
  if (filters.status && (INSTANCE_STATUSES as readonly string[]).includes(filters.status)) {
    where.status = filters.status;
  }
  if (filters.funnelId) where.funnelId = filters.funnelId;
  if (filters.clientId) where.clientId = filters.clientId;
  if (filters.search && filters.search.trim() !== '') {
    const s = filters.search.trim();
    where.OR = [
      { funnelName: { contains: s } },
      { client: { OR: [{ externalId: { contains: s } }, { phone: { contains: s } }] } },
    ];
  }

  const [rows, total] = await Promise.all([
    db.workflowInstance.findMany({
      where,
      include: { client: { select: { id: true, externalId: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      skip: filters.skip,
      take: filters.take,
    }),
    db.workflowInstance.count({ where }),
  ]);
  return { items: rows.map(serializeInstanceSummary), total };
}

/** Детали экземпляра: сводка + воронка + клиент + таймлайн InstanceEvent
 *  (payload — JSON-строка, битый парсится в null) + отправленные SmsMessage.
 *  Чтение — без побочных эффектов. */
export async function getInstanceDetail(id: string): Promise<Record<string, unknown>> {
  const instance = await db.workflowInstance.findUnique({
    where: { id },
    include: {
      funnel: { select: { id: true, name: true } },
      client: { select: { id: true, externalId: true, phone: true } },
    },
  });
  if (!instance) throw new ApiError(404, 'Экземпляр не найден');

  const [timeline, messages] = await Promise.all([
    // Таймлайн — по возрастанию (хронология прохождения узлов), SMS — по
    // убыванию (свежие сверху, как в логе). Оба запроса параллельно: подробности
    // экземпляра открывают часто, лишний раунд-трип к SQLite не нужен.
    db.instanceEvent.findMany({ where: { instanceId: id }, orderBy: { createdAt: 'asc' } }),
    db.smsMessage.findMany({ where: { instanceId: id }, orderBy: { createdAt: 'desc' } }),
  ]);

  return {
    instance: serializeInstanceSummary(instance),
    funnel: instance.funnel,
    client: instance.client,
    timeline: timeline.map((ev) => {
      let payload: unknown = null;
      if (ev.payload) {
        try {
          payload = JSON.parse(ev.payload);
        } catch {
          payload = null;
        }
      }
      return {
        id: ev.id,
        type: ev.type,
        nodeId: ev.nodeId,
        nodeType: ev.nodeType,
        message: ev.message,
        payload,
        createdAt: ev.createdAt,
      };
    }),
    messages: messages.map((m) => ({
      id: m.id,
      phone: m.phone,
      body: m.body,
      segments: m.segments,
      provider: m.provider,
      providerMessageId: m.providerMessageId,
      templateName: m.templateName,
      status: m.status,
      rejectReason: m.rejectReason,
      error: m.error,
      sentAt: m.sentAt,
      deliveredAt: m.deliveredAt,
      createdAt: m.createdAt,
    })),
  };
}

/** Внутренняя отмена: статус CANCELLED + INFO-событие + отмена PENDING-задач.
 *  Гард 409: терминальный экземпляр нельзя отменить повторно.
 *  Побочные эффекты: запись WorkflowInstance, InstanceEvent (INFO),
 *  массовое обновление ScheduledJob → CANCELLED. Без audit-лога (его пишет
 *  обёртка cancelInstance — вызовы из отписки не пишут аудит, там нет сессии). */
export async function cancelInstanceInternal(instanceId: string, message: string): Promise<WorkflowInstance> {
  const instance = await db.workflowInstance.findUnique({ where: { id: instanceId } });
  if (!instance) throw new ApiError(404, 'Экземпляр не найден');
  if (instance.status !== 'RUNNING' && instance.status !== 'WAITING') {
    throw new ApiError(409, `Экземпляр уже в терминальном статусе: ${instance.status}`);
  }
  const updated = await db.workflowInstance.update({
    where: { id: instanceId },
    data: { status: 'CANCELLED' },
  });
  await logInstanceEvent(instanceId, 'INFO', { message });
  await db.scheduledJob.updateMany({
    where: { instanceId, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
  return updated;
}

/** Отмена всех активных экземпляров клиента (массовая отмена — зарезервировано;
 *  сегодня вызовов нет, см. шапку файла). Возвращает число отменённых.
 *  Побочные эффекты — как у cancelInstanceInternal для каждого экземпляра. */
export async function cancelActiveInstancesForClient(clientId: string, message: string): Promise<number> {
  const active = await db.workflowInstance.findMany({
    where: { clientId, status: { in: ['RUNNING', 'WAITING'] } },
    select: { id: true },
  });
  for (const inst of active) {
    try {
      await cancelInstanceInternal(inst.id, message);
    } catch {
      // экземпляр мог перейти в терминальный статус параллельно — пропускаем
    }
  }
  return active.length;
}

/** Отмена пользователем панели (обёртка над cancelInstanceInternal с аудит-логом
 *  CANCEL и меткой «Отменено пользователем …» в таймлайне). */
export async function cancelInstance(id: string, user: SessionUser, ip: string): Promise<WorkflowInstance> {
  const updated = await cancelInstanceInternal(id, `Отменено пользователем ${user.email}`);
  await logAudit({
    user,
    action: AuditAction.CANCEL,
    entityType: AuditEntity.INSTANCE,
    entityId: id,
    details: { status: updated.status },
    ip,
  });
  return updated;
}
