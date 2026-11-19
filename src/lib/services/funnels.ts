// Сервис воронок: CRUD с валидацией графа, активация/деактивация, версионирование.
// Домен: триггерные сценарии — граф узлов (sms/delay/condition/waitEvent),
// стартующий по событию ядра (см. events.ts + scheduler/worker, движок — engine/).
// Вызывается из API-роутов: /api/v1/funnels (GET/POST), /funnels/{id}
// (GET/PUT/DELETE), /funnels/{id}/activate, /funnels/{id}/deactivate.
// Таблицы Prisma: Funnel (основная; definition — JSON-строка), SmsTemplate —
// проверка активных шаблонов в валидаторе, WorkflowInstance — count-гард
// в deleteFunnel, AuditLog через logAudit.
import { z } from 'zod';
import type { Funnel, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';
import { validateFunnelGraph } from '@/lib/engine/validate';
import { TRIGGER_EVENTS } from '@/lib/engine/types';
import type { FunnelDefinition, FunnelNode } from '@/lib/engine/types';

// 9 типов триггерных событий: 5 базовых + 4 категории.
// Единый реестр живёт в engine/types.ts — здесь и в events.ts переэкспорт/импорт.
export { TRIGGER_EVENTS };

/** Режимы повторного входа воронки при новом событии. */
export const ENTRY_MODES = ['SKIP', 'SKIP_ACTIVE', 'REPLACE', 'PARALLEL'] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];

/** Схема узла графа: id ≤100, один из 4 типов, плюс поля конкретного типа
 *  (sms: templateId/senderName; delay: часы/минуты + абсолютные паузы
 *  mode/atHour/atMinute/atDate; condition: expression/onTrue/onFalse;
 *  waitEvent: event/timeout/onEvent/onTimeout). Диапазоны: часы 0–720,
 *  минуты 0–59, expression ≤1000. */
const nodeSchema = z.object({
  id: z.string().trim().min(1, 'id узла обязателен').max(100),
  type: z.enum(['sms', 'delay', 'condition', 'waitEvent']),
  name: z.string().trim().max(200).optional(),
  templateId: z.string().trim().optional(),
  senderName: z.string().trim().max(50).nullish(),
  hours: z.number().int().min(0).max(720).optional(),
  minutes: z.number().int().min(0).max(59).optional(),
  expression: z.string().max(1000).optional(),
  next: z.string().nullish(),
  onTrue: z.string().nullish(),
  onFalse: z.string().nullish(),
  // waitEvent-узел
  event: z.string().trim().max(64).optional(),
  timeoutHours: z.number().int().min(0).max(720).optional(),
  timeoutMinutes: z.number().int().min(0).max(59).optional(),
  onEvent: z.string().nullish(),
  onTimeout: z.string().nullish(),
  // Абсолютные паузы delay-узла
  mode: z.enum(['relative', 'until_time', 'until_date', 'until_birthday']).optional(),
  atHour: z.number().int().min(0).max(23).optional(),
  atMinute: z.number().int().min(0).max(59).optional(),
  atDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат ГГГГ-ММ-ДД')
    .optional(),
});

/** Определение воронки: точка входа start_node + непустой массив узлов. */
export const funnelDefinitionSchema = z.object({
  start_node: z.string().trim().min(1, 'start_node обязателен'),
  nodes: z.array(nodeSchema).min(1, 'Нужен хотя бы один узел'),
});

/** Схема создания: имя ≤200, триггер из реестра TRIGGER_EVENTS, определение,
 *  режим повтора (по умолчанию SKIP_ACTIVE), описание ≤1000. */
export const createFunnelSchema = z.object({
  name: z.string().trim().min(1, 'Название обязательно').max(200),
  triggerEvent: z.enum(TRIGGER_EVENTS),
  definition: funnelDefinitionSchema,
  entryMode: z.enum(ENTRY_MODES).default('SKIP_ACTIVE'),
  description: z.string().trim().max(1000).nullish(),
});

/** Схема обновления — все поля опциональны (partial). */
export const updateFunnelSchema = createFunnelSchema.partial();

export type CreateFunnelDto = z.infer<typeof createFunnelSchema>;
export type UpdateFunnelDto = z.infer<typeof updateFunnelSchema>;

/** Приведение распарсенных узлов к строгим типам движка. Задача — добить
 *  различие DTO ↔ внутреннего представления: zod-схема помечает поля
 *  optional (чтобы принимать старые определения без них), а движку нужны
 *  конкретные типы — ссылка «нет следующего узла» это null (не undefined),
 *  часы/минуты это 0, id шаблона это ''. Необязательные мета-поля (name,
 *  mode, atHour…) вносятся условным спредом, чтобы НЕ попадать в объект как
 *  undefined: JSON-сериализация определения остаётся чистой ( absence ≠ null ),
 *  а движок различает «поле задано» и «поле отсутствует». */
function normalizeNodes(raw: z.infer<typeof funnelDefinitionSchema>['nodes']): FunnelNode[] {
  return raw.map((n): FunnelNode => {
    const next = n.next ?? null;
    switch (n.type) {
      case 'sms':
        return {
          id: n.id,
          type: 'sms',
          ...(n.name !== undefined ? { name: n.name } : {}),
          templateId: n.templateId ?? '',
          senderName: n.senderName ?? null,
          next,
        };
      case 'delay':
        return {
          id: n.id,
          type: 'delay',
          ...(n.name !== undefined ? { name: n.name } : {}),
          hours: n.hours ?? 0,
          minutes: n.minutes ?? 0,
          ...(n.mode !== undefined ? { mode: n.mode } : {}),
          ...(n.atHour !== undefined ? { atHour: n.atHour } : {}),
          ...(n.atMinute !== undefined ? { atMinute: n.atMinute } : {}),
          ...(n.atDate !== undefined ? { atDate: n.atDate } : {}),
          next,
        };
      case 'condition':
        return {
          id: n.id,
          type: 'condition',
          ...(n.name !== undefined ? { name: n.name } : {}),
          expression: n.expression ?? '',
          onTrue: n.onTrue ?? null,
          onFalse: n.onFalse ?? null,
        };
      case 'waitEvent':
        return {
          id: n.id,
          type: 'waitEvent',
          ...(n.name !== undefined ? { name: n.name } : {}),
          event: n.event ?? '',
          timeoutHours: n.timeoutHours ?? 0,
          timeoutMinutes: n.timeoutMinutes ?? 0,
          onEvent: n.onEvent ?? null,
          onTimeout: n.onTimeout ?? null,
        };
    }
  });
}

/** Полная валидация: структура графа + существование активных шаблонов sms-узлов. */
async function validateDefinition(raw: z.infer<typeof funnelDefinitionSchema>): Promise<FunnelDefinition> {
  const nodes = normalizeNodes(raw.nodes);
  const definition: FunnelDefinition = { start_node: raw.start_node, nodes };

  const errors = validateFunnelGraph(definition);

  const templateIds = Array.from(
    new Set(nodes.filter((n) => n.type === 'sms').map((n) => (n as { templateId: string }).templateId)),
  );
  if (templateIds.length > 0) {
    const activeTemplates = await db.smsTemplate.findMany({
      where: { id: { in: templateIds }, isActive: true },
      select: { id: true },
    });
    const activeIds = new Set(activeTemplates.map((t) => t.id));
    for (const id of templateIds) {
      if (!activeIds.has(id)) {
        errors.push(`sms-узел ссылается на несуществующий или неактивный шаблон: ${id}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new ApiError(422, 'Ошибка валидации воронки', errors.join('; '));
  }
  return definition;
}

/** Строка Funnel → JSON API: definition распарсивается из JSON-строки
 *  (+ nodeCount для списка), битый JSON → definition:null (не роняет выдачу). */
export function serializeFunnel(row: Funnel): Record<string, unknown> {
  let definition: unknown = null;
  let nodeCount = 0;
  try {
    const parsed = JSON.parse(row.definition) as FunnelDefinition;
    definition = parsed;
    nodeCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : 0;
  } catch {
    definition = null;
  }
  return {
    id: row.id,
    name: row.name,
    triggerEvent: row.triggerEvent,
    isActive: row.isActive,
    version: row.version,
    definition,
    entryMode: row.entryMode,
    description: row.description,
    nodeCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Список воронок: поиск по имени/описанию, фильтр по триггеру, пагинация.
 *  Чтение — без побочных эффектов. */
export async function listFunnels(filters: {
  search?: string;
  triggerEvent?: string;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}): Promise<{ items: unknown[]; total: number }> {
  const where: Prisma.FunnelWhereInput = {};
  if (filters.search && filters.search.trim() !== '') {
    where.OR = [
      { name: { contains: filters.search.trim() } },
      { description: { contains: filters.search.trim() } },
    ];
  }
  if (filters.triggerEvent && (TRIGGER_EVENTS as readonly string[]).includes(filters.triggerEvent)) {
    where.triggerEvent = filters.triggerEvent;
  }
  const [rows, total] = await Promise.all([
    db.funnel.findMany({ where, orderBy: { createdAt: 'desc' }, skip: filters.skip, take: filters.take }),
    db.funnel.count({ where }),
  ]);
  return { items: rows.map(serializeFunnel), total };
}

/** Воронка по id; 404 через ApiError, если не найдена. */
export async function getFunnelById(id: string): Promise<Funnel> {
  const row = await db.funnel.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Воронка не найдена');
  return row;
}

/** Создание воронки (всегда неактивной — включается отдельно через activate):
 *  определение проходит полную валидацию (граф + шаблоны). Побочные эффекты:
 *  запись Funnel (definition — JSON-строка), audit-лог CREATE. */
export async function createFunnel(dto: CreateFunnelDto, user: SessionUser, ip: string): Promise<Funnel> {
  const definition = await validateDefinition(dto.definition);
  const row = await db.funnel.create({
    data: {
      name: dto.name,
      triggerEvent: dto.triggerEvent,
      definition: JSON.stringify(definition),
      entryMode: dto.entryMode,
      description: dto.description ?? null,
      isActive: false, // новая воронка создаётся неактивной
      version: 1,
    },
  });
  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.FUNNEL,
    entityId: row.id,
    details: { name: row.name, triggerEvent: row.triggerEvent, nodeCount: definition.nodes.length },
    ip,
  });
  return row;
}

/** Обновление: частичное; новое определение (если передано) — полная
 *  валидация заново. Побочные эффекты: запись Funnel (version+1), audit-лог UPDATE. */
export async function updateFunnel(
  id: string,
  dto: UpdateFunnelDto,
  user: SessionUser,
  ip: string,
): Promise<Funnel> {
  const existing = await getFunnelById(id);
  let definitionJson = existing.definition;
  if (dto.definition !== undefined) {
    const definition = await validateDefinition(dto.definition);
    definitionJson = JSON.stringify(definition);
  }
  const row = await db.funnel.update({
    where: { id },
    data: {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.triggerEvent !== undefined ? { triggerEvent: dto.triggerEvent } : {}),
      ...(dto.definition !== undefined ? { definition: definitionJson } : {}),
      ...(dto.entryMode !== undefined ? { entryMode: dto.entryMode } : {}),
      ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
      version: existing.version + 1, // версионирование
    },
  });
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.FUNNEL,
    entityId: row.id,
    details: { name: row.name, version: row.version },
    ip,
  });
  return row;
}

/** Активация/деактивация. При активации определение перепроверяется
 *  (шаблоны могли быть удалены/заархивированы после создания — иначе активная
 *  воронка стартовала бы со ссылками в никуда). Побочные эффекты: запись
 *  Funnel.isActive, audit-лог ACTIVATE/DEACTIVATE. */
export async function setFunnelActive(
  id: string,
  active: boolean,
  user: SessionUser,
  ip: string,
): Promise<Funnel> {
  const existing = await getFunnelById(id);
  if (active) {
    // Активировать можно только валидную воронку (шаблоны могли удалиться/деактивироваться).
    // Битый JSON определения (порча строки/частичная запись) — 422 с понятным
    // текстом, а не необработанное исключение SyntaxError → 500.
    let raw: z.infer<typeof funnelDefinitionSchema>;
    try {
      raw = JSON.parse(existing.definition) as z.infer<typeof funnelDefinitionSchema>;
    } catch {
      throw new ApiError(
        422,
        'Определение воронки повреждено',
        'JSON определения не читается — пересоздайте воронку в редакторе',
      );
    }
    await validateDefinition(raw);
  }
  const row = await db.funnel.update({ where: { id }, data: { isActive: active } });
  await logAudit({
    user,
    action: active ? AuditAction.ACTIVATE : AuditAction.DEACTIVATE,
    entityType: AuditEntity.FUNNEL,
    entityId: row.id,
    details: { name: row.name },
    ip,
  });
  return row;
}

/** Удаление — только без экземпляров (история прогонов сохраняется, 409
 *  при WorkflowInstance-ссылках; дезактивируйте вместо удаления).
 *  Побочные эффекты: физическое удаление Funnel, audit-лог DELETE. */
export async function deleteFunnel(id: string, user: SessionUser, ip: string): Promise<void> {
  await getFunnelById(id);
  const instanceCount = await db.workflowInstance.count({ where: { funnelId: id } });
  if (instanceCount > 0) {
    throw new ApiError(409, 'Нельзя удалить воронку: у неё есть экземпляры');
  }
  await db.funnel.delete({ where: { id } });
  await logAudit({
    user,
    action: AuditAction.DELETE,
    entityType: AuditEntity.FUNNEL,
    entityId: id,
    ip,
  });
}
