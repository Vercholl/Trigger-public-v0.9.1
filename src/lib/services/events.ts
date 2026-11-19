// Сервис событий: приём (ingest + дедуп idempotency_key) и список.
// Событие может нести client_card — тогда оно ОБНОВЛЯЕТ карточку клиента
// и запускает воронки (воркер); client_card сохраняется в payload как есть
// (плюс нормализованные ключи кастомных полей cf_* — применяются воркером).
// Ретрай FAILED-событий — сброс в NEW, воркер подхватывает в ближайший тик.
// «Радар» доработок ядра: при приёме сырой client_card сверяется со схемой
// карточки — неизвестные поля фиксируются в EventsInbox.unknownFields и
// агрегируются в UnknownFieldObservation (сводка для UI, см. список ниже);
// ключи зарегистрированных кастомных полей (custom-fields) неизвестными
// НЕ считаются — это наш собственный контур данных.
// Домен: вход триггерных цепочек — «сырьё» для движка воронок (scheduler/worker
// читает EventsInbox, обновляет карточку и стартует экземпляры).
// Вызывается из API-роутов: /api/v1/events (GET-список/POST-ingest),
// /events/test (POST — тест-кнопка из панели), /events/{id}/retry (POST),
// /events/unknown-fields (GET-сводка радара), /events/unknown-fields/{fieldName}
// (DELETE — убрать наблюдение, ADMIN).
// Таблицы Prisma: EventsInbox (inbox-таблица), UnknownFieldObservation
// (агрегат радара), Client/WorkflowInstance трогает уже воркер, AuditLog
// через logAudit (retryEvent и удаление наблюдения).
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { EventsInbox, Prisma, UnknownFieldObservation } from '@prisma/client';
import { db } from '@/lib/db';
import { TRIGGER_EVENTS } from '@/lib/services/funnels';
import { clientCardSchema, unknownCardKeys } from '@/lib/services/client-card';
import {
  cfKnownKeyMatchers,
  cfNormKey,
  extractCfFromRawCard,
  loadCustomFields,
} from '@/lib/services/custom-fields';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';

/** Схема приёма: event — один из TRIGGER_EVENTS; external_id клиента внешней системы;
 *  payload — произвольный JSON; client_card — типизированная карточка
 *  (phone/timezone + поля карточки, см. client-card.ts); idempotency_key ≤200 —
 *  ключ дедупа (не передан → генерируется UUID, событие уникально);
 *  skip_triggers — только обновить карточку, НЕ запуская воронки (импорт). */
export const eventIngestSchema = z.object({
  event: z.enum(TRIGGER_EVENTS, {
    error: `Событие должно быть одним из: ${TRIGGER_EVENTS.join(', ')}`,
  }),
  external_id: z.string().trim().min(1, 'external_id обязателен').max(100),
  payload: z.record(z.string(), z.unknown()).optional(),
  client_card: clientCardSchema.optional(),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
  skip_triggers: z.boolean().optional(),
});

export type EventIngestDto = z.infer<typeof eventIngestSchema>;

/** Максимум строк в батче POST /api/v1/events/batch (как import_batch
 *  legacy-платформы: ≤10 000 профилей/запрос). */
export const EVENTS_BATCH_MAX_ROWS = 10_000;

/** Схема батча: конверт {events: [...]} ≤ 10 000 строк. Строки валидируются
 *  ПОСТРОЧНО в ingestEventsBatch (мусорная строка не роняет батч — ошибка
 *  попадает в results[i]), поэтому здесь — только границы массива. */
export const eventBatchSchema = z.object({
  events: z
    .array(z.unknown())
    .min(1, 'Массив events не может быть пустым')
    .max(EVENTS_BATCH_MAX_ROWS, `Максимум ${EVENTS_BATCH_MAX_ROWS} строк в батче`),
});

/** Метаданные приёма: каким API-ключом вызвано (null — из панели), источник,
 *  IP и baseUrl (для генерации ссылок отписки в экземплярах). */
export interface IngestMeta {
  apiKeyId: string | null;
  source: 'API' | 'PANEL';
  ip: string;
  baseUrl: string;
}

/** Результат приёма: id события и признак дубликата по idempotency_key. */
export interface IngestResult {
  eventId: string;
  duplicate: boolean;
}

/** Подготовленная строка батча/одиночного приёма (после валидации и
 *  нормализации — до дедупа/вставки; общий код ingestEvent/ingestEventsBatch). */
interface PreparedIngest {
  dto: EventIngestDto;
  idempotencyKey: string;
  rawCard: Record<string, unknown>;
  cfNormalized: Record<string, string | number | boolean>;
  unknown: string[];
  unknownEventId: string | null; // id вставленной строки — для агрегата радара
}

/** Валидация строки + подготовка (cf/радар) — без обращений к БД (кроме
 *  кэшированного реестра кастомных полей). */
async function prepareIngestRow(
  dto: EventIngestDto,
  rawClientCard: unknown,
): Promise<PreparedIngest> {
  const idempotencyKey = dto.idempotency_key ?? randomUUID();
  const rawCard: Record<string, unknown> =
    rawClientCard !== null && typeof rawClientCard === 'object' && !Array.isArray(rawClientCard)
      ? (rawClientCard as Record<string, unknown>)
      : {};

  // Кастомные поля (cf): реестр читается ОДНИМ кэшированным запросом.
  //   • ключи зарегистрированных полей (сырой ключ источника, каноничное cf_<key>,
  //     camelCase контракта системы данных или нормализованная форма isSravni_client) —
  //     НЕ «неизвестные» для радара (включая деактивированные);
  //   • нормализованные значения АКТИВНЫХ полей мержатся в payload.client_card
  //     под каноничными cf_<key> — воркер применит их к профилю до запуска
  //     воронок, а движок увидит в vars (payload) как страж.
  const cfDefs = await loadCustomFields();
  const cfKnownKeys = cfKnownKeyMatchers(cfDefs);
  const { cfNormalized } = extractCfFromRawCard(rawCard, cfDefs.filter((d) => d.isActive));

  // «Радар» доработок источника: ключи client_card вне схемы карточки (реестр
  // registry/card-fields + phone/timezone + написания кастомных полей).
  const unknown = unknownCardKeys(rawCard).filter(
    (k) => !cfKnownKeys.has(k) && !cfKnownKeys.has(cfNormKey(k)),
  );

  return { dto, idempotencyKey, rawCard, cfNormalized, unknown, unknownEventId: null };
}

/** Вставка подготовленной строки (дедуп-гонка — P2002 → дубликат). */
async function insertInboxRow(
  p: PreparedIngest,
  meta: IngestMeta,
): Promise<{ eventId: string; duplicate: boolean } | { error: string }> {
  // Событие хранится в payload КАК ЕСТЬ + каноничные cf-ключи в client_card:
  // экземпляр воронки увидит их через context.payload, воркер применит к БД.
  let payloadJson: string | null = null;
  if (p.dto.client_card !== undefined) {
    payloadJson = JSON.stringify({ ...p.dto.payload, client_card: { ...p.dto.client_card, ...p.cfNormalized } });
  } else if (p.dto.payload !== undefined) {
    payloadJson = JSON.stringify(p.dto.payload);
  }
  try {
    const row = await db.eventsInbox.create({
      data: {
        event: p.dto.event,
        externalId: p.dto.external_id,
        payload: payloadJson,
        unknownFields: p.unknown.length > 0 ? JSON.stringify(p.unknown) : null,
        idempotencyKey: p.idempotencyKey,
        status: 'NEW',
        apiKeyId: meta.apiKeyId,
        source: meta.source,
        ip: meta.ip,
        baseUrl: meta.baseUrl,
        skipTriggers: p.dto.skip_triggers === true,
      },
    });
    p.unknownEventId = row.id;
    return { eventId: row.id, duplicate: false };
  } catch (e) {
    // гонка двух запросов с одним ключом: уникальный констрейнт → дубликат.
    if ((e as { code?: string })?.code === 'P2002' || (e instanceof Error && e.message.includes('Unique constraint failed'))) {
      const raced = await db.eventsInbox.findUnique({ where: { idempotencyKey: p.idempotencyKey }, select: { id: true } });
      if (raced) return { eventId: raced.id, duplicate: true };
    }
    // прочее (напр., перегрузка) — как ошибка строки, батч не роняем
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Агрегат радара для набора неизвестных ключей (best-effort — не роняет приём):
 *  counter += сколько раз ключ встретился, lastEvent — последняя вставленная строка. */
async function aggregateRadar(
  observations: Map<string, { count: number; lastEventId: string | null; lastEventName: string }>,
): Promise<void> {
  if (observations.size === 0) return;
  try {
    for (const [fieldName, obs] of observations) {
      if (obs.count <= 0) continue;
      await db.unknownFieldObservation.upsert({
        where: { fieldName },
        create: { fieldName, count: obs.count, lastEventId: obs.lastEventId, lastEventName: obs.lastEventName },
        update: {
          count: { increment: obs.count },
          lastSeenAt: new Date(),
          ...(obs.lastEventId ? { lastEventId: obs.lastEventId, lastEventName: obs.lastEventName } : {}),
        },
      });
    }
  } catch (e) {
    console.error('[events] радар неизвестных полей: сбой агрегата наблюдений', e);
  }
}

/** Приём события в events_inbox со статусом NEW (обработает воркер). Дедуп по ключу.
 *  Побочные эффекты: запись EventsInbox (клиент/воронки НЕ трогает — вся
 *  обработка асинхронная, в scheduler/worker) + агрегат радара при неизвестных
 *  полях карточки. Дубликат — без записи (наблюдение уже учтено первым приёмом).
 *  rawClientCard — СЫРОЙ объект из тела запроса (до zod-стриппинга): по нему
 *  работают радар и извлечение кастомных полей (cf_*); не передан (напр. будущий
 *  вызов без сырья) — fallback на отпарсенный dto.client_card (неизвестных ключей
 *  и cf-значений там уже нет — приём не ломается, просто без CF-обогащения). */
export async function ingestEvent(
  dto: EventIngestDto,
  meta: IngestMeta,
  rawClientCard: unknown = dto.client_card,
): Promise<IngestResult> {
  // Ключ не передан — генерируем UUID (событие уникально); дедуп-проверка одним SELECT.
  const p = await prepareIngestRow(dto, rawClientCard);
  const existing = await db.eventsInbox.findUnique({ where: { idempotencyKey: p.idempotencyKey }, select: { id: true } });
  if (existing) return { eventId: existing.id, duplicate: true };

  const inserted = await insertInboxRow(p, meta);
  if ('error' in inserted) throw new Error(inserted.error);

  // Агрегат радара — best-effort: наблюдаемость не должна ронять приём событий.
  if (p.unknown.length > 0) {
    const obs = new Map<string, { count: number; lastEventId: string | null; lastEventName: string }>();
    for (const fieldName of p.unknown) {
      obs.set(fieldName, { count: 1, lastEventId: p.unknownEventId, lastEventName: p.dto.event });
    }
    await aggregateRadar(obs);
  }
  return { eventId: inserted.eventId, duplicate: inserted.duplicate };
}

// ---------- Батч-приём (POST /api/v1/events/batch, интеграция ядра) ----------

/** Итог строки батча: создано/дубликат (eventId) либо ошибка валидации/вставки. */
export interface BatchRowResult {
  index: number;
  eventId?: string;
  duplicate?: boolean;
  error?: string;
}

export interface BatchIngestResult {
  accepted: number; // валидных строк (включая дубликаты)
  created: number;
  duplicates: number;
  invalid: number;
  results: BatchRowResult[];
}

/** Приём батча ≤10 000 строк. Отличия от одиночного приёма:
 *  • валидация построчная (мусорная строка не роняет батч — ошибка в results[i]);
 *  • дедуп: сначала одним чанкованным SELECT по всем idempotency_key, затем
 *    вставка (дубликат-гонка — как обычно P2002);
 *  • радар неизвестных полей агрегируется ОДНИМ upsert на ключ (не по строке —
 *    при стартовой загрузке 3 млн карточек один и тот же набор полей встретился
 *    бы 3 млн раз);
 *  • ответ — отчёт по строкам (адаптер ядра может повторить только упавшие).
 *  Скорость: ~2-3 запроса к БД на строку — батч 10 000 укладывается в секунды. */
export async function ingestEventsBatch(
  rows: unknown[],
  meta: IngestMeta,
): Promise<BatchIngestResult> {
  const results: BatchRowResult[] = [];
  const prepared: Array<{ p: PreparedIngest; index: number }> = [];
  const seenKeys = new Map<string, number>(); // ключ → index первой строки батча
  // Ключ → индексы ПОСЛЕДУЮЩИХ строк с тем же ключом (внутри-батчевые дубликаты):
  // их eventId проставляется в фазе 3 по результату вставки первой строки ключа
  // (баг v0.8.8: раньше дубликаты оставались без eventId — адаптер ядра не мог
  // связать их с уже созданным событием).
  const inBatchDuplicates = new Map<string, number[]>();
  let invalid = 0;

  // Фаза 1: валидация + подготовка (реестр cf — один кэшированный запрос).
  for (let i = 0; i < rows.length; i++) {
    const parsed = eventIngestSchema.safeParse(rows[i]);
    if (!parsed.success) {
      invalid += 1;
      const issue = parsed.error.issues[0];
      results[i] = { index: i, error: issue ? `${issue.path.join('.') || 'строка'}: ${issue.message}` : 'ошибка валидации' };
      continue;
    }
    const rawClientCard =
      rows[i] !== null && typeof rows[i] === 'object' && !Array.isArray(rows[i])
        ? (rows[i] as Record<string, unknown>).client_card
        : undefined;
    const p = await prepareIngestRow(parsed.data, rawClientCard ?? parsed.data.client_card);
    // Дубликат ВНУТРИ батча (один ключ дважды) — вторая строка пропускается;
    // eventId подставится после вставки первой (backfill в фазе 3).
    if (seenKeys.has(p.idempotencyKey)) {
      const dupIndices = inBatchDuplicates.get(p.idempotencyKey) ?? [];
      dupIndices.push(i);
      inBatchDuplicates.set(p.idempotencyKey, dupIndices);
      results[i] = { index: i, duplicate: true };
      continue;
    }
    seenKeys.set(p.idempotencyKey, i);
    prepared.push({ p, index: i });
    results[i] = { index: i };
  }

  // Фаза 2: дедуп к БД — чанкованный SELECT по ключам (500 за запрос).
  const existingIds = new Map<string, string>();
  const keys = prepared.map((x) => x.p.idempotencyKey);
  for (let c = 0; c < keys.length; c += 500) {
    const chunk = keys.slice(c, c + 500);
    const found = await db.eventsInbox.findMany({
      where: { idempotencyKey: { in: chunk } },
      select: { id: true, idempotencyKey: true },
    });
    for (const f of found) existingIds.set(f.idempotencyKey, f.id);
  }

  // Фаза 3: вставка (дубликаты из БД — пропуском с их eventId).
  let created = 0;
  let duplicates = 0;
  const radar = new Map<string, { count: number; lastEventId: string | null; lastEventName: string }>();
  for (const { p, index } of prepared) {
    // eventId первой строки ключа — им же наполняются внутри-батчевые дубликаты
    let firstEventId: string | null = null;
    if (existingIds.has(p.idempotencyKey)) {
      duplicates += 1;
      firstEventId = existingIds.get(p.idempotencyKey) ?? null;
      results[index] = { index, eventId: firstEventId ?? undefined, duplicate: true };
    } else {
      const inserted = await insertInboxRow(p, meta);
      if ('error' in inserted) {
        invalid += 1;
        results[index] = { index, error: inserted.error };
        continue; // вставка не удалась — внутри-батчевые дубликаты ключа остаются без eventId
      }
      firstEventId = inserted.eventId ?? null;
      if (inserted.duplicate) {
        duplicates += 1;
        results[index] = { index, eventId: inserted.eventId, duplicate: true };
      } else {
        created += 1;
        results[index] = { index, eventId: inserted.eventId, duplicate: false };
        for (const fieldName of p.unknown) {
          const cur = radar.get(fieldName) ?? { count: 0, lastEventId: null, lastEventName: p.dto.event };
          cur.count += 1;
          cur.lastEventId = p.unknownEventId;
          cur.lastEventName = p.dto.event;
          radar.set(fieldName, cur);
        }
      }
    }
    // Backfill: внутри-батчевые дубликаты этого ключа получают eventId события
    // первой строки — адаптер ядра может связать дубликат с событием в БД.
    const dupIndices = inBatchDuplicates.get(p.idempotencyKey);
    if (dupIndices && firstEventId) {
      for (const di of dupIndices) results[di] = { index: di, eventId: firstEventId, duplicate: true };
      inBatchDuplicates.delete(p.idempotencyKey);
    }
  }

  // Фаза 4: агрегат радара — один upsert на ключ за весь батч.
  await aggregateRadar(radar);

  return {
    accepted: rows.length - invalid,
    created,
    duplicates,
    invalid,
    results,
  };
}

/** Сырой client_card из тела запроса (до zod-стриппинга) — для радара.
 *  Роуты, разбиравшие тело через eventIngestSchema, передают сюда body.client_card:
 *  zod-парсing отбрасывает неизвестные ключи, поэтому детекция новых полей ядра
 *  возможна только по сырому объекту. Не-объект/отсутствие → undefined (fallback
 *  ingestEvent на отпарсенную карточку — детекции нет, но приём не ломается). */
export function rawClientCardOf(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>).client_card;
}

/** Строка EventsInbox → JSON API: result и unknownFields — JSON-строки,
 *  безопасно парсимые (битая → null). Чистая функция. */
export function serializeEvent(row: EventsInbox): Record<string, unknown> {
  let result: unknown = null;
  if (row.result) {
    try {
      result = JSON.parse(row.result);
    } catch {
      result = null;
    }
  }
  let unknownFields: string[] | null = null;
  if (row.unknownFields) {
    try {
      const parsed = JSON.parse(row.unknownFields) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
        unknownFields = parsed as string[];
      }
    } catch {
      unknownFields = null; // битая строка — отдаём как «нет данных»
    }
  }
  return {
    id: row.id,
    event: row.event,
    externalId: row.externalId,
    status: row.status,
    result,
    unknownFields,
    error: row.error,
    source: row.source,
    createdAt: row.createdAt,
  };
}

/** Список событий inbox: фильтры по статусу (NEW/PROCESSING/PROCESSED/
 *  FAILED) и типу триггера, пагинация. Чтение — без побочных эффектов.
 *  Статус DUPLICATE не выставляется никому (дубликаты при приёме просто
 *  не вставляются) и из фильтра убран (v0.8.8) — фильтр-пустышка вводил
 *  в заблуждение. */
export async function listEvents(filters: {
  status?: string;
  event?: string;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}): Promise<{ items: unknown[]; total: number }> {
  const where: Prisma.EventsInboxWhereInput = {};
  if (filters.status && ['NEW', 'PROCESSING', 'PROCESSED', 'FAILED'].includes(filters.status)) {
    where.status = filters.status;
  }
  if (filters.event && (TRIGGER_EVENTS as readonly string[]).includes(filters.event)) {
    where.event = filters.event;
  }
  const [rows, total] = await Promise.all([
    db.eventsInbox.findMany({ where, orderBy: { createdAt: 'desc' }, skip: filters.skip, take: filters.take }),
    db.eventsInbox.count({ where }),
  ]);
  return { items: rows.map(serializeEvent), total };
}

/** Повторная обработка упавшего события — сброс FAILED → NEW (воркер подхватит
 * в ближайший тик). Атомарный claim-стиль: статус меняется только у FAILED-строки.
 * Режимы повторного входа воронок (SKIP/SKIP_ACTIVE/REPLACE) защищают от дублей
 * экземпляров; карточка клиента при ретрае просто обновится заново (идемпотентно).
 * Побочные эффекты: запись EventsInbox (status/error/result), audit-лог RETRY. */
export async function retryEvent(
  id: string,
  user: SessionUser,
  ip: string,
): Promise<EventsInbox> {
  const claimed = await db.eventsInbox.updateMany({
    where: { id, status: 'FAILED' },
    data: { status: 'NEW', error: null, result: null },
  });
  if (claimed.count !== 1) {
    const row = await db.eventsInbox.findUnique({ where: { id } });
    if (!row) throw new ApiError(404, 'Событие не найдено');
    throw new ApiError(
      409,
      'Событие нельзя перезапустить',
      `Статус события — ${row.status}; повторный запуск возможен только для упавших (FAILED)`,
    );
  }
  const row = await db.eventsInbox.findUniqueOrThrow({ where: { id } });
  await logAudit({
    user,
    action: AuditAction.RETRY,
    entityType: AuditEntity.EVENT,
    entityId: id,
    details: { event: row.event, externalId: row.externalId },
    ip,
  });
  return row;
}

// ---------- «Радар» неизвестных полей client_card ----------

/** Строка UnknownFieldObservation → JSON API (сводка радара). Чистая функция. */
export function serializeUnknownField(row: UnknownFieldObservation): Record<string, unknown> {
  return {
    fieldName: row.fieldName,
    count: row.count,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    lastEventId: row.lastEventId,
    lastEventName: row.lastEventName,
  };
}

/** Сводка радара: все наблюдаемые поля вне схемы карточки, свежие сверху.
 *  Пусто — ядро передаёт только известные поля (или событий с карточкой нет).
 *  Чтение — без побочных эффектов. */
export async function listUnknownFields(): Promise<Record<string, unknown>[]> {
  const rows = await db.unknownFieldObservation.findMany({
    orderBy: [{ lastSeenAt: 'desc' }],
  });
  return rows.map(serializeUnknownField);
}

/** Удаление наблюдения — «убрать из сводки» (после подключения поля в реестр
 *  или решения игнорировать). Пока поле не в реестре, новое наблюдение воссоздаст
 *  строку — радар не замалчивает дыру в схеме. Побочные эффекты: удаление
 *  UnknownFieldObservation, audit-лог DELETE. */
export async function deleteUnknownField(
  fieldName: string,
  user: SessionUser,
  ip: string,
): Promise<void> {
  const existing = await db.unknownFieldObservation.findUnique({ where: { fieldName } });
  if (!existing) throw new ApiError(404, 'Наблюдение не найдено');
  await db.unknownFieldObservation.delete({ where: { fieldName } });
  await logAudit({
    user,
    action: AuditAction.DELETE,
    entityType: AuditEntity.EVENT,
    entityId: fieldName,
    details: { fieldName, count: existing.count, lastSeenAt: existing.lastSeenAt },
    ip,
  });
}
