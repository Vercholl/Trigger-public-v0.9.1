// Сервис SMS-шаблонов: CRUD (версионирование, soft-delete) и предпросмотр рендера.
// Домен: контент рассылок — тексты сообщений с переменными {{...}} и дисклеймером.
// Вызывается из API-роутов: /api/v1/templates (GET-список/POST), /templates/{id}
// (GET/PUT/DELETE), /templates/preview (POST — без записи в БД).
// Таблицы Prisma: SmsTemplate (основная), Funnel/Broadcast — read-only гварды
// в deleteTemplate, AuditLog через logAudit.
import { z } from 'zod';
import type { Prisma, SmsTemplate } from '@prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';
import {
  extractVariables,
  renderTemplate,
  requiredVariables,
  validateTemplateSyntax,
} from '@/lib/sms/render';
import { countSegments } from '@/lib/sms/segments';
import { getSettings } from '@/lib/services/settings';
import { resolveUnsubscribeBaseUrl } from '@/lib/compliance/disclaimer';
import { buildSampleMarketingSmsBody } from '@/lib/compliance/short-links';

/** Схема создания: name (1–100), body (1–1000), флаг маркетингового SMS,
 *  описание ≤500, senderName ≤20 (латиница/цифры/дефис), maxSegments 0–10
 *  (0 — лимит частей не задан). */
export const createTemplateSchema = z.object({
  name: z.string().trim().min(1, 'Название обязательно').max(100, 'Максимум 100 символов'),
  body: z.string().min(1, 'Текст шаблона обязателен').max(1000, 'Максимум 1000 символов'),
  isMarketing: z.boolean(),
  // Настройки шаблона
  description: z.string().trim().max(500, 'Максимум 500 символов').nullish(),
  senderName: z
    .string()
    .trim()
    .max(20, 'Имя отправителя — максимум 20 символов')
    .regex(/^[A-Za-z0-9\-\s]*$/, 'Имя отправителя: латиница, цифры, дефис')
    .nullish(),
  maxSegments: z.number().int().min(0).max(10).default(0),
});

/** Схема обновления — то же, но все поля опциональны (partial). */
export const updateTemplateSchema = createTemplateSchema.partial();

/** Схема предпросмотра: текст + опциональные sampleData (значения переменных),
 *  флаг маркетинга и лимит частей. Записи в БД не делает. */
export const previewTemplateSchema = z.object({
  body: z.string().min(1, 'Текст шаблона обязателен').max(1000, 'Максимум 1000 символов'),
  sampleData: z.record(z.string(), z.unknown()).optional(),
  isMarketing: z.boolean(),
  maxSegments: z.number().int().min(0).max(10).optional(),
});

export type CreateTemplateDto = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateDto = z.infer<typeof updateTemplateSchema>;
export type PreviewTemplateDto = z.infer<typeof previewTemplateSchema>;

/** Строка SmsTemplate → JSON API (включая version и isActive-признак архива). */
export function serializeTemplate(row: SmsTemplate): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    isMarketing: row.isMarketing,
    description: row.description,
    senderName: row.senderName,
    maxSegments: row.maxSegments,
    version: row.version,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Список шаблонов с поиском по названию/тексту и пагинацией; по умолчанию
 *  мягко удалённые (isActive=false) скрыты. Чтение — без побочных эффектов. */
export async function listTemplates(filters: {
  search?: string;
  /** По умолчанию список без архивных (soft-deleted) шаблонов;
   * includeDeleted=true — с ними (бейдж «удалён» в UI). */
  includeDeleted?: boolean;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}): Promise<{ items: unknown[]; total: number }> {
  const where: Prisma.SmsTemplateWhereInput = {};
  if (!filters.includeDeleted) where.isActive = true;
  if (filters.search && filters.search.trim() !== '') {
    where.OR = [
      { name: { contains: filters.search.trim() } },
      { body: { contains: filters.search.trim() } },
    ];
  }
  const [rows, total] = await Promise.all([
    db.smsTemplate.findMany({ where, orderBy: { createdAt: 'desc' }, skip: filters.skip, take: filters.take }),
    db.smsTemplate.count({ where }),
  ]);
  return { items: rows.map(serializeTemplate), total };
}

/** Шаблон по id; 404 через ApiError, если не найден (в т.ч. архивный). */
export async function getTemplateById(id: string): Promise<SmsTemplate> {
  const row = await db.smsTemplate.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Шаблон не найден');
  return row;
}

/** Создание шаблона: тело проверяется синтаксическим валидатором (422 при
 *  ошибках), версия стартует с 1. Побочные эффекты: запись SmsTemplate, audit-лог CREATE. */
export async function createTemplate(dto: CreateTemplateDto, user: SessionUser, ip: string): Promise<SmsTemplate> {
  const syntaxErrors = validateTemplateSyntax(dto.body);
  if (syntaxErrors.length > 0) {
    throw new ApiError(422, 'Ошибка синтаксиса шаблона', syntaxErrors.join('; '));
  }
  const row = await db.smsTemplate.create({
    data: {
      name: dto.name,
      body: dto.body,
      isMarketing: dto.isMarketing,
      description: dto.description?.trim() || null,
      senderName: dto.senderName?.trim() || null,
      maxSegments: dto.maxSegments,
      version: 1,
    },
  });
  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.TEMPLATE,
    entityId: row.id,
    details: { name: row.name, isMarketing: row.isMarketing, maxSegments: row.maxSegments },
    ip,
  });
  return row;
}

/** Обновление: меняются только переданные поля; body (если передан) проходит
 *  проверку синтаксиса; version инкрементируется при каждом обновлении.
 *  Побочные эффекты: запись SmsTemplate, audit-лог UPDATE. */
export async function updateTemplate(
  id: string,
  dto: UpdateTemplateDto,
  user: SessionUser,
  ip: string,
): Promise<SmsTemplate> {
  const existing = await getTemplateById(id);
  if (dto.body !== undefined) {
    const syntaxErrors = validateTemplateSyntax(dto.body);
    if (syntaxErrors.length > 0) {
      throw new ApiError(422, 'Ошибка синтаксиса шаблона', syntaxErrors.join('; '));
    }
  }
  const row = await db.smsTemplate.update({
    where: { id },
    data: {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
      ...(dto.isMarketing !== undefined ? { isMarketing: dto.isMarketing } : {}),
      ...(dto.description !== undefined ? { description: dto.description?.trim() || null } : {}),
      ...(dto.senderName !== undefined ? { senderName: dto.senderName?.trim() || null } : {}),
      ...(dto.maxSegments !== undefined ? { maxSegments: dto.maxSegments } : {}),
      version: existing.version + 1, // версионирование при каждом обновлении
    },
  });
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.TEMPLATE,
    entityId: row.id,
    details: { name: row.name, version: row.version, maxSegments: row.maxSegments },
    ip,
  });
  return row;
}

/** Soft-delete (isActive=false; физическая строка остаётся для истории
 *  отправленных сообщений); 409, если шаблон используется активной воронкой
 *  (ищется в JSON-определении узлов типа sms) или ACTIVE/PAUSED-рассылкой.
 *  Побочные эффекты: запись SmsTemplate.isActive, audit-лог DELETE. */
export async function deleteTemplate(id: string, user: SessionUser, ip: string): Promise<void> {
  await getTemplateById(id);
  const activeFunnels = await db.funnel.findMany({
    where: { isActive: true },
    select: { id: true, definition: true },
  });
  // Гард воронок: определение хранится JSON-строкой — парсим и ищем sms-узлы
  // с этим templateId (битый JSON трактуем как «не используется»).
  const usedBy = activeFunnels.some((f) => {
    try {
      const def = JSON.parse(f.definition) as { nodes?: Array<{ type: string; templateId?: string }> };
      return (def.nodes ?? []).some((n) => n.type === 'sms' && n.templateId === id);
    } catch {
      return false;
    }
  });
  if (usedBy) {
    throw new ApiError(409, 'Шаблон используется в активной воронке');
  }
  // Рассылки ссылаются на шаблон без FK: у ACTIVE/PAUSED-рассылки каждый запуск
  // упирался бы в 422 «Шаблон не найден или отключён» — блокируем удаление.
  const broadcastRefs = await db.broadcast.count({
    where: { templateId: id, status: { in: ['ACTIVE', 'PAUSED'] } },
  });
  if (broadcastRefs > 0) {
    throw new ApiError(
      409,
      'Шаблон используется рассылками',
      `На шаблон ссылается активных/приостановленных рассылок: ${broadcastRefs} — удалите их или смените шаблон в них`,
    );
  }
  await db.smsTemplate.update({ where: { id }, data: { isActive: false } });
  await logAudit({
    user,
    action: AuditAction.DELETE,
    entityType: AuditEntity.TEMPLATE,
    entityId: id,
    ip,
  });
}

/**
 * Предпросмотр: рендер по sampleData, подсчёт символов/сегментов/кодировки,
 * список переменных, вариант с дисклеймером (токен — демонстрационный) и
 * проверка лимита частей (maxSegments).
 */
export async function previewTemplate(dto: PreviewTemplateDto): Promise<Record<string, unknown>> {
  const syntaxErrors = validateTemplateSyntax(dto.body);
  if (syntaxErrors.length > 0) {
    throw new ApiError(422, 'Ошибка синтаксиса шаблона', syntaxErrors.join('; '));
  }

  const vars: Record<string, unknown> = dto.sampleData ?? {};
  let renderedResult: { text: string; cancelled: boolean };
  try {
    renderedResult = renderTemplate(dto.body, vars, { variantSeed: 'preview' });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Ошибка рендера шаблона';
    throw new ApiError(422, 'Ошибка рендера шаблона', detail);
  }

  const variables = extractVariables(dto.body);
  const required = requiredVariables(dto.body);
  const info = countSegments(renderedResult.text);

  const settings = await getSettings();
  const maxSegments = dto.maxSegments ?? 0;
  let renderedWithDisclaimer = renderedResult.text;
  let segmentsWithDisclaimer = info.segments;
  if (dto.isMarketing && !renderedResult.cancelled) {
    // Превью БЕЗ записи в БД: короткая ссылка — с примером кода Xk3fQ9a,
    // полная — с демонстрационным HMAC-токеном; приписка — из настроек (П7).
    const baseUrl = resolveUnsubscribeBaseUrl(null, settings);
    renderedWithDisclaimer = buildSampleMarketingSmsBody(renderedResult.text, settings, baseUrl);
    segmentsWithDisclaimer = countSegments(renderedWithDisclaimer).segments;
  }

  const effectiveSegments = dto.isMarketing && !renderedResult.cancelled ? segmentsWithDisclaimer : info.segments;
  const overLimit = maxSegments > 0 && !renderedResult.cancelled && effectiveSegments > maxSegments;

  return {
    rendered: renderedResult.text,
    cancelled: renderedResult.cancelled,
    chars: info.chars,
    segments: info.segments,
    encoding: info.encoding,
    variables,
    requiredVariables: required,
    renderedWithDisclaimer,
    segmentsWithDisclaimer,
    maxSegments,
    overLimit,
  };
}
