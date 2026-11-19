// Массовое обновление клиентов по сегменту (P4).
//
// Оператор выбирает сегмент и задаёт значения полей, которыми управляет ПАНЕЛЬ
// (не система данных): кастомные поля профиля {{cf_*}}, «реклама разрешена»
// (notification_active) и статус SMS-согласия. Воркер применяет их потоковой
// итерацией сегмента порциями (как рассылки — память ограничена чанком),
// каждое ФАКТИЧЕСКОЕ изменение фиксируется в истории профиля (ProfileChangeLog,
// source=MASS_UPDATE) — «проставили is_credit_line=true 40 тыс. клиентов» видно в
// карточке каждого клиента.
//
// ПОЛЯ СИСТЕМЫ ДАННЫХ (суммы/статусы/даты) НЕ поддерживаются сознательно: ближайшее
// событие client_card перезапишет их — массовая правка бессмысленна (Lite).
//
// Предохранители:
//   • maxAffected — кап числа изменений за запуск (по умолчанию 10 тыс.);
//   • дифф «уже равно» — клиенты с целевым значением НЕ считаются изменёнными
//     и не пишут шум в историю (повторный запуск операции идемпотентен);
//   • отмена: PENDING → не начнётся, RUNNING → воркер останавливается между
//     порциями (обработанное остаётся применённым, счётчики сохраняются).
//
// Вызывается из: API-роуты /api/v1/clients/mass-update (GET/POST) и
// /mass-update/{id}/cancel (POST); processDueMassUpdates — тик воркера
// (scheduler/worker). Таблицы: MassUpdateJob, Client, ClientFieldValue,
// Segment, ProfileChangeLog, AuditLog.
import { z } from 'zod';
import type { Client, MassUpdateJob, Segment } from '@prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';
import { CONSENT_STATUSES } from '@/lib/services/clients';
import { cfKeyOfVar, CF_KEY_PREFIX } from '@/lib/registry/cf-ns';
import {
  loadCustomFields,
  normalizeCfValue,
  rawCfValuesForClients,
  type CustomFieldDefLite,
} from '@/lib/services/custom-fields';
import {
  countSegmentClients,
  iterateSegmentClients,
  iterateStaticSegmentClients,
  segmentConditionsSchema,
  type SegmentConditions,
} from '@/lib/services/segments';
import { cfChange, recordProfileChanges, type ProfileChange } from '@/lib/services/profile-history';

// ---------- Схемы ----------

/** Системные поля панели, доступные массовому обновлению (НЕ поля системы данных). */
export const MASS_UPDATE_SYSTEM_FIELDS = ['notification_active', 'sms_consent_status'] as const;
export type MassUpdateSystemField = (typeof MASS_UPDATE_SYSTEM_FIELDS)[number];

/** Поле обновления: системное (notification_active/sms_consent_status) или
 *  кастомное cf_<key>. Значение — string|number|boolean; null = «очистить»
 *  (только для кастомных полей). */
const updateFieldSchema = z.object({
  field: z.union([
    z.enum(MASS_UPDATE_SYSTEM_FIELDS),
    z.string().regex(new RegExp(`^${CF_KEY_PREFIX}[a-z][a-z0-9_]{1,39}$`), {
      message: 'Поле: системное (notification_active, sms_consent_status) или кастомное cf_<ключ>',
    }),
  ]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

/** Создание операции: название, сегмент, ≥1 правила обновления, кап. */
export const createMassUpdateSchema = z.object({
  name: z.string().trim().min(1, 'Название операции обязательно').max(120),
  segmentId: z.string().trim().min(1, 'Выберите сегмент'),
  updates: z
    .array(updateFieldSchema)
    .min(1, 'Укажите хотя бы одно поле для обновления')
    .max(20, 'Не более 20 полей за одну операцию'),
  maxAffected: z.number().int().min(1).max(100_000).default(10_000),
});

export type CreateMassUpdateDto = z.infer<typeof createMassUpdateSchema>;

/** Валидированное обновление после разбора DTO (типизированное по цели). */
type ValidatedUpdate =
  | { kind: 'system'; field: MassUpdateSystemField; value: boolean | (typeof CONSENT_STATUSES)[number] }
  | { kind: 'cf'; field: string; key: string; def: CustomFieldDefLite; value: string | number | boolean | Date | null };

/**
 * Разбор и валидация правил обновления против реестров: системные поля —
 * тип значения; cf_<key> — поле существует (включая деактивированные: их
 * значения можно перезаписать/очистить), значение соответствует типу поля.
 * Возвращает 422 с понятным списком проблем.
 */
async function validateUpdates(
  updates: Array<{ field: string; value: string | number | boolean | null }>,
): Promise<ValidatedUpdate[]> {
  const errors: string[] = [];
  const seen = new Set<string>();
  const cfDefs = await db.customField.findMany({ select: { id: true, key: true, label: true, type: true, isActive: true } });
  const byKey = new Map(cfDefs.map((d) => [d.key, d]));

  const validated: ValidatedUpdate[] = [];
  for (const [idx, u] of updates.entries()) {
    const pos = `правило ${idx + 1}`;
    if (seen.has(u.field)) {
      errors.push(`${pos}: поле «${u.field}» указано дважды`);
      continue;
    }
    seen.add(u.field);

    if (u.field === 'notification_active') {
      // Булево мягко: true/false/«да»/«нет»/1/0 (UI шлёт boolean)
      const normalized = normalizeCfValue('bool', u.value);
      if (normalized === null || 'clear' in normalized) {
        errors.push(`${pos}: notification_active — ожидается true/false (null не допускается)`);
        continue;
      }
      validated.push({ kind: 'system', field: 'notification_active', value: normalized.value as boolean });
      continue;
    }
    if (u.field === 'sms_consent_status') {
      if (typeof u.value !== 'string' || !CONSENT_STATUSES.includes(u.value as (typeof CONSENT_STATUSES)[number])) {
        errors.push(`${pos}: sms_consent_status — ожидается NONE|PENDING|GRANTED|REVOKED`);
        continue;
      }
      validated.push({ kind: 'system', field: 'sms_consent_status', value: u.value as (typeof CONSENT_STATUSES)[number] });
      continue;
    }

    // Кастомное поле cf_<key>
    const key = cfKeyOfVar(u.field);
    if (key === null) {
      errors.push(`${pos}: «${u.field}» — не имя кастомного поля (cf_<ключ>)`);
      continue;
    }
    const def = byKey.get(key);
    if (!def) {
      errors.push(`${pos}: кастомное поле «${key}» не найдено в реестре`);
      continue;
    }
    if (u.value === null) {
      // Очистка значения — допустима только для кастомных полей
      validated.push({
        kind: 'cf',
        field: u.field,
        key,
        def: { id: def.id, key: def.key, label: def.label, type: def.type as CustomFieldDefLite['type'], isActive: def.isActive },
        value: null,
      });
      continue;
    }
    const normalized = normalizeCfValue(def.type as CustomFieldDefLite['type'], u.value);
    if (normalized === null || 'clear' in normalized) {
      errors.push(`${pos}: значение «${String(u.value)}» не соответствует типу поля «${key}» (${def.type})`);
      continue;
    }
    validated.push({
      kind: 'cf',
      field: u.field,
      key,
      def: { id: def.id, key: def.key, label: def.label, type: def.type as CustomFieldDefLite['type'], isActive: def.isActive },
      value: normalized.value as string | number | boolean | Date,
    });
  }
  if (errors.length > 0) {
    throw new ApiError(422, 'Ошибка валидации правил обновления', errors.join('; '));
  }
  return validated;
}

// ---------- Сериализация и CRUD ----------

/** Строка задачи → JSON API: updates распарсены, счётчики прогресса. */
export function serializeMassUpdateJob(row: MassUpdateJob): Record<string, unknown> {
  let updates: unknown = [];
  try {
    updates = JSON.parse(row.updates);
  } catch {
    updates = [];
  }
  return {
    id: row.id,
    name: row.name,
    segmentId: row.segmentId,
    segmentName: row.segmentName,
    updates,
    maxAffected: row.maxAffected,
    status: row.status,
    planned: row.planned,
    processed: row.processed,
    affected: row.affected,
    error: row.error,
    createdByEmail: row.createdByEmail,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Список операций (новейшие первыми) с пагинацией. Чтение. */
export async function listMassUpdateJobs(
  page: { skip: number; take: number },
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const [rows, total] = await Promise.all([
    db.massUpdateJob.findMany({
      orderBy: { createdAt: 'desc' },
      skip: page.skip,
      take: page.take,
    }),
    db.massUpdateJob.count(),
  ]);
  return { items: rows.map(serializeMassUpdateJob), total };
}

/**
 * Создание операции (MANAGER+): валидация правил по реестрам, планируемая
 * численность (счёт сегмента — прогресс-бар операции), запись MassUpdateJob
 * в PENDING (воркер подхватит в ближайшие тики). Побочные эффекты: запись
 * MassUpdateJob, audit-лог CREATE.
 */
export async function createMassUpdateJob(
  dto: CreateMassUpdateDto,
  user: SessionUser,
  ip: string,
): Promise<MassUpdateJob> {
  const segment = await db.segment.findUnique({ where: { id: dto.segmentId } });
  if (!segment) throw new ApiError(404, 'Сегмент не найден');

  const validated = await validateUpdates(dto.updates);

  // Планируемая численность — счёт сегмента (кэш 5 мин у динамических; для
  // прогресса достаточно, точные счётчики выставит воркер по факту итерации)
  let planned = 0;
  try {
    planned = (await countSegmentClients(segment.id)).total;
  } catch {
    planned = 0; // счёт не критичен — операция всё равно итерирует сегмент
  }

  const row = await db.massUpdateJob.create({
    data: {
      name: dto.name,
      segmentId: segment.id,
      segmentName: segment.name,
      updates: JSON.stringify(validated.map((v) => ({ field: v.field, value: v.value }))),
      maxAffected: dto.maxAffected,
      status: 'PENDING',
      planned,
      createdById: user.id,
      createdByEmail: user.email,
    },
  });
  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.MASS_UPDATE_JOB,
    entityId: row.id,
    details: {
      name: row.name,
      segment: segment.name,
      fields: validated.map((v) => v.field),
      maxAffected: row.maxAffected,
      planned,
    },
    ip,
  });
  return row;
}

/**
 * Отмена операции (MANAGER+): PENDING → не начнётся вовсе; RUNNING → воркер
 * останавливается между порциями (обработанное остаётся применённым — откат
 * массовой записи не делается, счётчики сохраняются честно). Терминальные
 * статусы → 409. Побочные эффекты: запись MassUpdateJob, audit-лог CANCEL.
 */
export async function cancelMassUpdateJob(
  id: string,
  user: SessionUser,
  ip: string,
): Promise<MassUpdateJob> {
  const existing = await db.massUpdateJob.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Операция не найдена');
  if (existing.status !== 'PENDING' && existing.status !== 'RUNNING') {
    throw new ApiError(409, 'Операция уже завершена', `Статус: ${existing.status} — отмена доступна только для операций в очереди или в работе`);
  }
  // Compare-and-set: только из PENDING/RUNNING. Безусловный update мог
  // перезаписать DONE, записанный воркером в окне между findUnique и этим
  // апдейтом (отмена «поверх» завершённой операции — недостоверный статус
  // и ложный аудит CANCEL по фактически выполненной работе).
  const claimed = await db.massUpdateJob.updateMany({
    where: { id, status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw new ApiError(409, 'Операция уже завершена', 'Отмена доступна только для операций в очереди или в работе');
  }
  const row = await db.massUpdateJob.findUniqueOrThrow({ where: { id } });
  await logAudit({
    user,
    action: AuditAction.CANCEL,
    entityType: AuditEntity.MASS_UPDATE_JOB,
    entityId: id,
    details: { name: row.name, wasStatus: existing.status, affected: row.affected, processed: row.processed },
    ip,
  });
  return row;
}

// ---------- Исполнение (воркер) ----------

/** Разбор conditions сегмента для ДИНАМИЧЕСКОГО пути. Битый JSON/пустые правила →
 *  null → операция FAILED (а НЕ молчаливое «вся база», как было раньше): массовая
 *  правка полей консервативна — повреждённая строка условий в БД не должна
 *  превращаться в «применить ко всем клиентам». Рассылки в той же ситуации
 *  падают с 422 «пересоздайте сегмент» (broadcasts.parseConditions) — здесь
 *  симметричное поведение: честный FAILED с объяснением в error задачи. */
function tryParseSegmentConditions(segment: Segment): SegmentConditions | null {
  try {
    // segmentConditionsSchema требует rules.min(1) — «пустые условия = вся база»
    // через пустой массив правил пройти не может
    return segmentConditionsSchema.parse(JSON.parse(segment.conditions));
  } catch {
    return null;
  }
}

/** Порция массового обновления: 500 клиентов (на каждого до 20 upsert значений
 *  + записи истории — чанк меньше рассылочного, чтобы транзакция оставалась
 *  короткой на SQLite). */
const MASS_UPDATE_CHUNK = 500;

/** Как часто воркер перепроверяет статус задачи (отмена во время работы) —
 *  каждые N обработанных клиентов (1 запрос к таблице задач). */
const CANCEL_CHECK_EVERY = 2000;

/**
 * Обработка ОДНОГО клиента: сбор фактических изменений (дифф «уже равно» —
 * не считается), применение (update Client / upsert+delete ClientFieldValue),
 * возврат изменений для записи в историю. cfCurrent — значения клиента из
 * батчевого запроса порции.
 */
async function applyUpdatesToClient(
  client: Client,
  updates: readonly ValidatedUpdate[],
  cfCurrent: Record<string, string | number | boolean | Date> | undefined,
  consentAt: Date,
): Promise<ProfileChange[]> {
  const changes: ProfileChange[] = [];
  const cfActions: Array<{ def: CustomFieldDefLite; value: string | number | boolean | Date | null }> = [];
  let clientPatch: Record<string, unknown> = {};

  for (const u of updates) {
    if (u.kind === 'system') {
      if (u.field === 'notification_active') {
        if (client.notificationActive !== u.value) {
          clientPatch = { ...clientPatch, notificationActive: u.value };
          changes.push({
            field: 'notification_active',
            oldValue: client.notificationActive,
            newValue: u.value,
          });
        }
      } else {
        // sms_consent_status: смена согласия фиксируется временем (как в updateClient)
        if (client.smsConsentStatus !== u.value) {
          clientPatch = {
            ...clientPatch,
            smsConsentStatus: u.value,
            smsConsentAt: consentAt,
          };
          changes.push({
            field: 'sms_consent_status',
            oldValue: client.smsConsentStatus,
            newValue: u.value,
          });
        }
      }
      continue;
    }
    // Кастомное поле: дифф против текущего значения (сырой ключ cf_<key> —
    // как в rawCfValuesForClients)
    const current = cfCurrent?.[u.field];
    const change = cfChange(u.key, current ?? null, u.value);
    if (change !== null) cfActions.push({ def: u.def, value: u.value });
    // История: change уже посчитан cfChange (включая очистку)
    if (change !== null) changes.push(change);
  }

  // Применение АТОМАРНО (одна интерактивная $transaction на клиента): патч строки
  // Client и все upsert/delete cf-значений применяются разом — сбой посреди клиента
  // не оставляет «полуобновлённый» профиль (системное поле обновлено, cf — нет).
  // История пишется отдельно ПОСЛЕ транзакции (fail-soft, см. recordProfileChanges).
  await db.$transaction(async (tx) => {
    if (Object.keys(clientPatch).length > 0) {
      await tx.client.update({ where: { id: client.id }, data: clientPatch });
    }
    for (const { def, value } of cfActions) {
      if (value === null) {
        await tx.clientFieldValue.deleteMany({ where: { clientId: client.id, fieldId: def.id } });
      } else {
        const type = def.type;
        const valueData =
          type === 'text'
            ? { valueStr: value as string }
            : type === 'number'
              ? { valueNum: value as number }
              : type === 'date'
                ? { valueDate: value as Date }
                : { valueBool: value as boolean };
        await tx.clientFieldValue.upsert({
          where: { fieldId_clientId: { fieldId: def.id, clientId: client.id } },
          create: { fieldId: def.id, clientId: client.id, ...valueData },
          update: valueData,
        });
      }
    }
  });
  return changes;
}

/**
 * Исполнение PENDING-операций массового обновления (вызов из тика воркера).
 * Одна операция за тик (последовательность как у рассылок): claim PENDING→
 * RUNNING (атомарный updateMany), потоковая итерация сегмента порциями по
 * MASS_UPDATE_CHUNK, применение с диффами, история изменений (MASS_UPDATE),
 * счётчики processed/affected, кап maxAffected, отмена между порциями.
 * Ошибка операции → FAILED (текст в error), воркер продолжает тик.
 */
export async function processDueMassUpdates(): Promise<void> {
  const job = await db.massUpdateJob.findFirst({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
  });
  if (!job) return;

  // Атомарный claim: статус меняет только один тик (SQLite сериализует записи)
  const claimed = await db.massUpdateJob.updateMany({
    where: { id: job.id, status: 'PENDING' },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  if (claimed.count !== 1) return;

  try {
    const rawUpdates = JSON.parse(job.updates) as Array<{ field: string; value: unknown }>;
    // Повторная валидация по ЖИВОМУ реестру (поле могли деактивировать/удалить
    // из реестра после создания задачи — запись значений деактивированного поля
    // допускается, неизвестного — нет)
    const updates = await validateUpdates(
      rawUpdates.map((u) => ({ field: u.field, value: u.value as string | number | boolean | null })),
    );
    if (updates.length === 0) {
      await db.massUpdateJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: 'Пустые правила обновления', finishedAt: new Date() },
      });
      return;
    }

    const segment = await db.segment.findUnique({ where: { id: job.segmentId } });
    if (!segment) {
      await db.massUpdateJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: 'Сегмент удалён — операция не может быть выполнена', finishedAt: new Date() },
      });
      return;
    }

    // cf-ключи порции для батчевого чтения текущих значений (один запрос
    // вместо запроса на клиента)
    const cfKeys = updates.filter((u): u is Extract<ValidatedUpdate, { kind: 'cf' }> => u.kind === 'cf').map((u) => u.key);

    let processed = 0;
    let affected = 0;
    let cancelled = false;

    /** Обработка порции: батчевое чтение cf-значений, применение по клиентам,
     *  история одним createMany, проверка отмены каждые CANCEL_CHECK_EVERY. */
    const handleChunk = async (chunk: Client[]): Promise<boolean> => {
      const cfByClient =
        cfKeys.length > 0
          ? await rawCfValuesForClients(
              chunk.map((c) => c.id),
              cfKeys,
            )
          : new Map<string, Record<string, string | number | boolean | Date>>();
      const consentAt = new Date();
      for (const client of chunk) {
        const changes = await applyUpdatesToClient(client, updates, cfByClient.get(client.id), consentAt);
        if (changes.length > 0) {
          affected += 1;
          await recordProfileChanges(client.id, changes, 'MASS_UPDATE', {
            jobId: job.id,
            jobName: job.name,
          });
        }
        processed += 1;
        // Кап предохранителя: стоп-итерация (дальнейшие клиенты не трогаем)
        if (affected >= job.maxAffected) return false;
      }
      // Мягкая отмена: статус меняется API во время работы — проверяем партиюми
      if (processed % CANCEL_CHECK_EVERY < chunk.length) {
        const fresh = await db.massUpdateJob.findUnique({
          where: { id: job.id },
          select: { status: true },
        });
        if (fresh?.status === 'CANCELLED') {
          cancelled = true;
          return false;
        }
      }
      return true;
    };

    // Получатели: как у рассылок — динамический сегмент потоково по условиям,
    // фиксированный — РОВНО состав среза (потоково, память O(порция), порядок
    // externalId — детерминизм кап-предохранителя). СТОП-флаг обязателен в
    // обоих путях: break внутреннего цикла не останавливает внешний for await —
    // после срабатывания капа/отмены следующие порции продолжали применяться
    // (по одному лишнему клиенту на порцию — превышение maxAffected).
    if (segment.mode === 'static') {
      let stop = false;
      for await (const chunk of iterateStaticSegmentClients(segment.id)) {
        for (let i = 0; i < chunk.length; i += MASS_UPDATE_CHUNK) {
          const goOn = await handleChunk(chunk.slice(i, i + MASS_UPDATE_CHUNK));
          if (!goOn) {
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
    } else {
      // Динамический сегмент: условия ОБЯЗАНЫ быть читаемыми — иначе операция
      // FAILED без единого изменения (см. tryParseSegmentConditions)
      const conditions = tryParseSegmentConditions(segment);
      if (conditions === null) {
        await db.massUpdateJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            error: 'У сегмента некорректные условия — операция прервана из соображений безопасности (пересоздайте сегмент в конструкторе)',
            finishedAt: new Date(),
          },
        });
        console.error(`[mass-update] job ${job.id} aborted: некорректные условия сегмента ${segment.id}`);
        return;
      }
      let stop = false;
      for await (const chunk of iterateSegmentClients(conditions)) {
        // Порции итератора — режем на MASS_UPDATE_CHUNK; стоп-флаг останавливает
        // и внешний for await (см. комментарий у статического пути выше)
        for (let i = 0; i < chunk.length; i += MASS_UPDATE_CHUNK) {
          const goOn = await handleChunk(chunk.slice(i, i + MASS_UPDATE_CHUNK));
          if (!goOn) {
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
    }

    // Финальный статус — compare-and-set: финализация ТОЛЬКО из RUNNING.
    // Отмена, выставленная API в окне между последней проверкой порции и
    // этим апдейтом, не должна «воскрешаться» записью DONE/CANCELLED поверх
    // CANCELLED (и наоборот — см. cancelMassUpdateJob). Если статус уже
    // CANCELLED (отмена API) — сохраняем счётчики обработанного, не трогая
    // терминальный статус: исполнитель — единственный, кто знает реальные
    // processed/affected.
    const finalized = await db.massUpdateJob.updateMany({
      where: { id: job.id, status: 'RUNNING' },
      data: {
        status: cancelled ? 'CANCELLED' : 'DONE',
        processed,
        affected,
        planned: Math.max(job.planned, processed),
        finishedAt: new Date(),
      },
    });
    if (finalized.count !== 1) {
      await db.massUpdateJob
        .updateMany({
          where: { id: job.id, status: 'CANCELLED' },
          data: { processed, affected, planned: Math.max(job.planned, processed) },
        })
        .catch(() => undefined);
      console.log(
        `[mass-update] ${job.name}: статус зафиксирован параллельно (отмена?) — счётчики сохранены: обработано ${processed}, изменено ${affected}`,
      );
    } else {
      console.log(
        `[mass-update] ${job.name}: ${cancelled ? 'CANCELLED' : 'DONE'} — обработано ${processed}, изменено ${affected}`,
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[mass-update] job ${job.id} failed: ${message}`);
    // Гвард: FAILED пишется только поверх RUNNING — параллельная отмена API
    // (CANCELLED) не перезаписывается (терминальный статус уже зафиксирован).
    await db.massUpdateJob
      .updateMany({
        where: { id: job.id, status: 'RUNNING' },
        data: { status: 'FAILED', error: message, finishedAt: new Date() },
      })
      .catch(() => undefined);
  }
}

// Реэкспорт для UI-подсказок (список доступных полей операции).
export { loadCustomFields };
