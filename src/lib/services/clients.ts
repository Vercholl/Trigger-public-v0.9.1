// Сервис клиентов: CRUD, валидация телефона E.164, CSV-импорт (только синтетика).
// Карточка клиента — типизированные поля карточки (П1, см. client-card.ts).
// Домен: база получателей SMS — профиль, согласия, часовой пояс, отписка.
// Вызывается из API-роутов: /api/v1/clients (GET-список/POST-создание),
// /clients/{id} (GET/PUT/DELETE), /clients/import (POST), /clients/{id}/messages
// (проверка существования); normalizePhone переиспользуют services/message-events
// и services/integrations, воркер — при захвате событий.
// Таблицы Prisma: Client (основная); SmsMessage/WorkflowInstance — только count
// в deleteClient (гард ссылочной целостности); AuditLog через logAudit.
import { z } from 'zod';
import type { Prisma, Client } from '@prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { normalizeTimezoneInput } from '@/lib/time';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';
import {
  cardFieldsToDb,
  clientCardFieldsSchema,
  clientCardFieldsShape,
  isValidIsoDateTime,
  serializeCardFields,
  type CardFieldsDto,
} from '@/lib/services/client-card';
import { cfValuesForApi, setClientCustomValues, validateClientCustomValues } from '@/lib/services/custom-fields';
import { CARD_FIELDS, type CardFieldType } from '@/lib/registry/card-fields';
import { birthdayChanged, syncBirthdayCalendar } from '@/lib/services/birthday-calendar';
import {
  diffProfileUpdates,
  recordProfileChanges,
  recordProfileCreated,
} from '@/lib/services/profile-history';

/** Допустимые статусы SMS-согласия клиента (таблица согласия системы данных).
 *  NONE — не запрашивалось, PENDING — запрошено, GRANTED — выдано,
 *  REVOKED — отозвано. */
export const CONSENT_STATUSES = ['NONE', 'PENDING', 'GRANTED', 'REVOKED'] as const;

/** Нормализация к E.164: очистка пробелов/дефисов/скобок, затем «+». */
export function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-()]/g, '');
  if (!/^\+?[1-9]\d{7,14}$/.test(cleaned)) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

/** Общие поля клиента: externalId (1–100 симв.), телефон (5–20, сырой — нормализуется
 *  ниже), timezone (IANA-имя или число — см. time.ts), произвольный JSON-data,
 *  статус/источник согласия. */
const clientBaseSchema = z.object({
  externalId: z.string().trim().min(1, 'externalId обязателен').max(100),
  phone: z.string().trim().min(5, 'Телефон обязателен').max(20),
  timezone: z.union([z.string().trim().max(64), z.number()]).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  smsConsentStatus: z.enum(CONSENT_STATUSES).optional(),
  smsConsentSource: z.string().trim().max(100).optional(),
});

/** Create/update DTO: карточка принимается на верхнем уровне под именами полей карточки
 *  (client_first_name, loan_amount, … — полный список в client-card.ts).
 *  custom_fields — значения кастомных полей профиля под ключами БЕЗ префикса
 *  (is_credit_line: true; допускается и cf_-написание — нормализуется), значения
 *  валидируются по типам реестра (services/custom-fields). update — то же,
 *  но все поля опциональны (partial). */
export const createClientSchema = z.object({
  ...clientBaseSchema.shape,
  ...clientCardFieldsShape,
  custom_fields: z.record(z.string(), z.unknown()).optional(),
});
export const updateClientSchema = createClientSchema.partial();

export type CreateClientDto = z.infer<typeof createClientSchema>;
export type UpdateClientDto = z.infer<typeof updateClientSchema>;

/** Проецирует строку Client в JSON API: JSON-data безопасно парсится
 *  (битая строка → пустой объект), карточка сериализуется в имена полей карточки,
 *  externalId дублируется в client_id для совместимости с API ядра.
 *  Кастомные поля (customFields) — отдельным async-обогащением
 *  serializeClientWithCf (список без CF: таблице они не нужны). */
export function serializeClient(row: Client): Record<string, unknown> {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.data) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return {
    id: row.id,
    externalId: row.externalId,
    client_id: row.externalId, // алиас под внешний контракт
    phone: row.phone,
    timezone: row.timezone,
    ...serializeCardFields(row),
    data,
    smsConsentStatus: row.smsConsentStatus,
    smsConsentSource: row.smsConsentSource,
    smsConsentAt: row.smsConsentAt,
    unsubscribedAt: row.unsubscribedAt,
    createdAt: row.createdAt,
  };
}

/** Полная карточка для API: serializeClient + значения кастомных полей под
 *  ключами БЕЗ префикса (customFields: {is_credit_line: true}; даты — дд.мм.гггг).
 *  GET /clients/{id} и PUT — подробный ответ; списку хватает serializeClient. */
export async function serializeClientWithCf(row: Client): Promise<Record<string, unknown>> {
  const customFields = await cfValuesForApi(row.id);
  return {
    ...serializeClient(row),
    ...(Object.keys(customFields).length > 0 ? { customFields } : { customFields: {} }),
  };
}

/** Фильтры списка: поиск (externalId/телефон/ФИО/email/data), статус согласия,
 *  отписка + пагинация (skip/take уже вычислены роутом из page/pageSize). */
export interface ClientListFilters {
  search?: string;
  consent?: string;
  unsubscribed?: string;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

/** Список клиентов с фильтрами и пагинацией; search ищет подстроку по
 *  externalId/телефону/ФИО/email и внутри JSON-data (грубое «contains» по строке).
 *  Чтение — без побочных эффектов. */
export async function listClients(filters: ClientListFilters): Promise<{ items: unknown[]; total: number }> {
  const where: Prisma.ClientWhereInput = {};
  if (filters.search && filters.search.trim() !== '') {
    const q = filters.search.trim();
    where.OR = [
      { externalId: { contains: q } },
      { phone: { contains: q } },
      { firstName: { contains: q } },
      { lastName: { contains: q } },
      { middleName: { contains: q } },
      { email: { contains: q } },
      { data: { contains: `"${q}"` } },
    ];
  }
  if (filters.consent && CONSENT_STATUSES.includes(filters.consent as (typeof CONSENT_STATUSES)[number])) {
    where.smsConsentStatus = filters.consent;
  }
  if (filters.unsubscribed === 'true') {
    where.unsubscribedAt = { not: null };
  } else if (filters.unsubscribed === 'false') {
    where.unsubscribedAt = null;
  }

  const [rows, total] = await Promise.all([
    db.client.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: filters.skip,
      take: filters.take,
    }),
    db.client.count({ where }),
  ]);
  return { items: rows.map(serializeClient), total };
}

/** Клиент по внутреннему id; 404 через ApiError, если не найден. */
export async function getClientById(id: string): Promise<Client> {
  const row = await db.client.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Клиент не найден');
  return row;
}

/** Сливает существующий JSON-data клиента с новым dto.data (передаёт приоритет);
 *  битый существующий JSON тихо заменяется на {}. Возвращает строку для колонки data. */
function buildClientData(dto: CreateClientDto | UpdateClientDto, existingData?: string): string {
  let merged: Record<string, unknown> = {};
  if (existingData) {
    try {
      const parsed = JSON.parse(existingData) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        merged = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      merged = {};
    }
  }
  if (dto.data !== undefined) {
    merged = { ...merged, ...dto.data };
  }
  return JSON.stringify(merged);
}

/** Нормализация/валидация телефона (E.164) и таймзоны из DTO.
 *  Возвращает null для «поле не передано» (обновление не трогает колонку);
 *  некорректное значение — 422 через ApiError. */
function validateClientFields(dto: CreateClientDto | UpdateClientDto): { phone: string | null; timezone: string | null } {
  let phone: string | null = null;
  if (dto.phone !== undefined) {
    phone = normalizePhone(dto.phone);
    if (!phone) throw new ApiError(422, 'Ошибка валидации', 'Некорректный номер телефона (ожидается E.164, например +79001234567)');
  }
  let timezone: string | null = null;
  if (dto.timezone !== undefined && dto.timezone !== '') {
    // IANA-строка («Asia/Yekaterinburg») или цифровое смещение UTC, как передаёт система данных
    // (5, "+5", "-3", "+05:00", "UTC+5") — нормализуем в IANA-зону.
    timezone = normalizeTimezoneInput(dto.timezone);
    if (timezone === null) {
      throw new ApiError(
        422,
        'Ошибка валидации',
        `Некорректный часовой пояс: ${dto.timezone} (IANA-имя, например Asia/Yekaterinburg, или цифровое смещение UTC: 5, "+5", "UTC+5", "+05:00")`,
      );
    }
  }
  return { phone, timezone };
}

/** Создание клиента: externalId уникален (409 при дубле), телефон обязателен,
 *  таймзона по умолчанию — DEFAULT_TIMEZONE или Asia/Novosibirsk.
 *  Побочные эффекты: запись Client, строка «профиль создан» в истории профиля
 *  (P5), audit-лог CREATE. */
export async function createClient(dto: CreateClientDto, user: SessionUser, ip: string): Promise<Client> {
  const { phone, timezone } = validateClientFields(dto);
  // Прогон валидации custom_fields ДО записи Client: невалидный ключ/значение
  // отвалятся 422 здесь — иначе клиент уже создан, а повторный POST получает
  // 409 «externalId существует» вместо понятной ошибки валидации.
  if (dto.custom_fields !== undefined) {
    await validateClientCustomValues(dto.custom_fields);
  }
  const existing = await db.client.findUnique({ where: { externalId: dto.externalId } });
  if (existing) {
    throw new ApiError(409, 'Клиент с таким externalId уже существует');
  }
  // Факт согласия фиксируем временем создания/обновления (консент-лог ведёт система данных)
  const consentAt = dto.smsConsentStatus ? new Date() : null;
  let row: Client;
  try {
    row = await db.client.create({
      data: {
        externalId: dto.externalId,
        phone: phone ?? '',
        timezone: timezone ?? (process.env.DEFAULT_TIMEZONE?.trim() || 'Asia/Novosibirsk'),
        ...cardFieldsToDb(dto),
        data: buildClientData(dto),
        smsConsentStatus: dto.smsConsentStatus ?? 'NONE',
        smsConsentSource: dto.smsConsentSource ?? null,
        smsConsentAt: consentAt,
      },
    });
  } catch (e) {
    // гонка: клиент с этим externalId создан параллельным запросом между
    // findUnique и create — отдаём тот же 409, а не 500 (как в updateClient).
    if (
      (e as { code?: string })?.code === 'P2002' ||
      (e instanceof Error && e.message.includes('Unique constraint failed'))
    ) {
      throw new ApiError(409, 'Клиент с таким externalId уже существует');
    }
    throw e;
  }
  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.CLIENT,
    entityId: row.id,
    details: { externalId: row.externalId },
    ip,
  });
  // История профиля (P5): факт создания — одна спец-строка __created__
  await recordProfileCreated(row.id, 'MANUAL', { actorEmail: user.email });
  // Календарь ДР (Task 63): строка создаётся вместе с клиентом (если ДР задан)
  if (row.birthday) {
    await syncBirthdayCalendar(row.id, row.birthday);
  }
  // Кастомные поля — отдельной записью после создания клиента (аудит внутри)
  if (dto.custom_fields !== undefined) {
    await setClientCustomValues(row.id, dto.custom_fields, user, ip);
  }
  return row;
}

/** Обновление клиента по id: меняются только переданные поля (частичное);
 *  data сливается с существующим (см. buildClientData), смена согласия
 *  перезаписывает smsConsentAt. Побочные эффекты: запись Client, дифф-запись
 *  истории профиля (P5, только реальные изменения), audit-лог UPDATE. */
export async function updateClient(id: string, dto: UpdateClientDto, user: SessionUser, ip: string): Promise<Client> {
  const existing = await getClientById(id);
  const { phone, timezone } = validateClientFields(dto);
  const cardData = cardFieldsToDb(dto);
  // Дифф для истории (P5): поля карточки + нормализованные контакты/согласие
  // (undefined = «не передано» — не логируется; ручная правка = MANUAL)
  const changes = diffProfileUpdates(existing, {
    ...(dto as unknown as Record<string, unknown>),
    phone: phone ?? undefined,
    timezone: timezone ?? undefined,
  } as Parameters<typeof diffProfileUpdates>[1]);
  let row: Client;
  try {
    row = await db.client.update({
    where: { id },
    data: {
      ...(dto.externalId !== undefined ? { externalId: dto.externalId } : {}),
      ...(phone !== null ? { phone } : {}),
      ...(timezone !== null ? { timezone } : {}),
      ...(Object.keys(cardData).length > 0 || dto.data !== undefined || dto.externalId !== undefined
        ? { data: buildClientData(dto, existing.data) }
        : {}),
      ...cardData,
      ...(dto.smsConsentStatus !== undefined
        ? { smsConsentStatus: dto.smsConsentStatus, smsConsentAt: new Date() }
        : {}),
      ...(dto.smsConsentSource !== undefined ? { smsConsentSource: dto.smsConsentSource } : {}),
    },
  });
  } catch (e) {
    // Смена externalId на существующий — честный 409, а не 500 (гонка с параллельным созданием)
    if (e instanceof Error && e.message.includes('Unique constraint failed')) {
      throw new ApiError(409, 'Клиент с таким externalId уже существует');
    }
    throw e;
  }
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.CLIENT,
    entityId: row.id,
    details: { externalId: row.externalId },
    ip,
  });
  // История профиля (P5): диффы «было → стало» после успешного обновления
  await recordProfileChanges(row.id, changes, 'MANUAL', { actorEmail: user.email });
  // Календарь ДР (Task 63): пересинхронизация при изменении birthday
  if (birthdayChanged(existing.birthday, row.birthday)) {
    await syncBirthdayCalendar(row.id, row.birthday);
  }
  // Кастомные поля — упсерт/очистка отдельным вызовом (аудит внутри);
  // ключи без префикса, невалидные значения → 422 (клиент уже обновлён —
  // повторная отправка с исправленным значением идемпотентна)
  if (dto.custom_fields !== undefined) {
    await setClientCustomValues(row.id, dto.custom_fields, user, ip);
  }
  return row;
}

/** Удаление клиента — запрещено (409), если на него ссылаются сообщения или
 *  экземпляры воронок: история коммуникаций важнее чистки базы.
 *  Побочные эффекты: удаление Client, audit-лог DELETE. */
export async function deleteClient(id: string, user: SessionUser, ip: string): Promise<void> {
  await getClientById(id);
  const [messageCount, instanceCount] = await Promise.all([
    db.smsMessage.count({ where: { clientId: id } }),
    db.workflowInstance.count({ where: { clientId: id } }),
  ]);
  if (messageCount > 0 || instanceCount > 0) {
    throw new ApiError(409, 'Нельзя удалить клиента: есть сообщения или экземпляры воронок');
  }
  await db.client.delete({ where: { id } });
  await logAudit({
    user,
    action: AuditAction.DELETE,
    entityType: AuditEntity.CLIENT,
    entityId: id,
    ip,
  });
}

// ---------- CSV-импорт ----------

/** Схема импорта: только поле csv (строка 1–2 МБ, кап в сообщении). */
export const importClientsSchema = z.object({
  // Кап 2 МБ (~10-15 тыс. строк): защита от OOM/блокировки SQLite гигантским CSV;
  // большие выгрузки ядра — чанками через API интеграции (П8).
  csv: z.string().min(1, 'Пустой CSV').max(2_000_000, 'CSV слишком большой (максимум 2 МБ — разбейте файл на части)'),
});

/** Ошибка одной строки CSV: номер строки + человекочитаемое сообщение. */
export interface ImportLineError {
  line: number;
  message: string;
}

/** Итог импорта: создано/обновлено/список ошибок по строкам. */
export interface ImportResult {
  created: number;
  updated: number;
  errors: ImportLineError[];
}

/** Автодетект разделителя CSV: ';' или ',' — по количеству вхождений
 *  (русская локаль Excel экспортирует «;», англоязычные инструменты — «,»). */
function detectDelimiter(csv: string): ';' | ',' {
  const semicolons = (csv.match(/;/g) ?? []).length;
  const commas = (csv.match(/,/g) ?? []).length;
  return semicolons >= commas ? ';' : ',';
}

/** Тип разбора CSV-значения (как parseCsvValue ниже). */
type CsvValueKind = 'text' | 'int' | 'number' | 'bool' | 'date' | 'enum';

/** Тип поля реестра → тип разбора CSV. enum разбирается как текст: итоговое
 *  значение валидируется схемой карточки (clientCardFieldsSchema) после разбора. */
const CSV_KIND_BY_TYPE: Record<CardFieldType, CsvValueKind> = {
  text: 'text',
  int: 'int',
  number: 'number',
  bool: 'bool',
  date: 'date',
  enum: 'text',
};

/** Служебные колонки импорта (не поля карточки): идентификатор, контакты,
 *  легаси-имя и статус согласия. */
const CSV_SERVICE_COLUMNS: Record<string, CsvValueKind> = {
  external_id: 'text',
  externalid: 'text',
  phone: 'text',
  timezone: 'text',
  name: 'text',
  consent: 'enum',
};

/** Имена служебных колонок (исключаются из разбора карточки). */
const CSV_SERVICE_COLUMN_NAMES = new Set(Object.keys(CSV_SERVICE_COLUMNS));

/** Колонки CSV с типизацией значений (header-режим: маппинг по именам колонок).
 *  Карточные поля — из единого реестра registry/card-fields (schema-as-code):
 *  новое поле ядра автоматически доступно и в CSV-импорте. */
const CSV_COLUMNS: Record<string, CsvValueKind> = {
  ...CSV_SERVICE_COLUMNS,
  ...Object.fromEntries(CARD_FIELDS.map((f) => [f.fieldName, CSV_KIND_BY_TYPE[f.type]])),
};

/** Типизация значения CSV-колонки: int/number ≥0, bool (true/1/да/…), date
 *  (ISO или дд.мм.гггг → нормализуется в ISO-порядок), текст/enum — как есть.
 *  Некорректное значение → ошибка строки импорта, а не всего файла. */
function parseCsvValue(raw: string, kind: CsvValueKind): { ok: true; value: string | number | boolean | null } | { ok: false; message: string } {
  const v = raw.trim();
  if (v === '') return { ok: true, value: null };
  switch (kind) {
    case 'text':
      return { ok: true, value: v };
    case 'enum':
      return { ok: true, value: v };
    case 'int': {
      const n = Number(v.replace(',', '.'));
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        return { ok: false, message: `ожидалось целое число ≥0, получено «${v}»` };
      }
      return { ok: true, value: n };
    }
    case 'number': {
      const n = Number(v.replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, message: `ожидалось число ≥0, получено «${v}»` };
      }
      return { ok: true, value: n };
    }
    case 'bool': {
      const lower = v.toLowerCase();
      if (['true', '1', 'да', 'yes'].includes(lower)) return { ok: true, value: true };
      if (['false', '0', 'нет', 'no'].includes(lower)) return { ok: true, value: false };
      return { ok: false, message: `ожидалось true/false, получено «${v}»` };
    }
    case 'date': {
      // дд.мм.гггг → ГГГГ-ММ-ДД. Однозначные «5.4.2026» раньше проскальзывали
      // мимо нормализатора и попадали в lenient-парсер карточки — тот читал
      // их в США-порядке и записывал «2 января» вместо 5 апреля.
      const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
      const normalized = dotted
        ? `${dotted[3]}-${dotted[2].padStart(2, '0')}-${dotted[1].padStart(2, '0')}`
        : v;
      // Строгий ISO-контроль с round-trip: «2026-02-30» V8 скатывает в 2 марта
      if (!isValidIsoDateTime(normalized)) {
        return { ok: false, message: `ожидалась дата (ISO или дд.мм.гггг), получено «${v}»` };
      }
      return { ok: true, value: normalized };
    }
  }
}

/** Признак легаси-заголовка позиционного формата: ПЕРВАЯ колонка строки —
 *  ровно external_id/externalid. Раньше матчили подстроку «external» где
 *  угодно в строке — строка ДАННЫХ с этим словом (например, имя клиента
 *  «External audit Ltd») молча проглатывалась как заголовок. */
function isLegacyHeaderLine(line: string, delimiter: string): boolean {
  const first = (line.split(delimiter)[0] ?? '').trim().toLowerCase();
  return first === 'external_id' || first === 'externalid';
}

/** Импорт CSV клиентов. Два формата: header-режим (маппинг по именам колонок
 *  из CSV_COLUMNS, богатая карточка) и легаси-позиционный
 *  «external_id;phone;timezone;name;consent». Строки обрабатываются по одной,
 *  ошибки агрегируются (строка с ошибкой не прерывает импорт). Существующий
 *  externalId → обновление (upsert-семантика), новый без телефона → ошибка строки.
 *  Побочные эффекты: массовая запись Client, audit-лог IMPORT (сводка).
 *  Известное ограничение: кавычки CSV (RFC 4180) не поддерживаются — значения
 *  с разделителем внутри ячейки дают ошибку строки (видна в сводке импорта). */
export async function importClients(
  csv: string,
  user: SessionUser,
  ip: string,
): Promise<ImportResult> {
  const delimiter = detectDelimiter(csv);
  const lines = csv.split(/\r?\n/);
  const errors: ImportLineError[] = [];
  let created = 0;
  let updated = 0;

  // Первая непустая строка — заголовок, если содержит известные имена колонок (кроме phone/name):
  // тогда маппинг по именам, иначе — легаси-позиционный формат external_id;phone;timezone;name;consent.
  const firstLineIdx = lines.findIndex((l) => l.trim() !== '');
  let headerMode = false;
  let headerColumns: string[] = [];
  if (firstLineIdx >= 0) {
    const candidates = lines[firstLineIdx].split(delimiter).map((f) => f.trim().toLowerCase());
    const known = candidates.filter((c) => c !== '' && c !== 'phone' && c !== 'name' && c in CSV_COLUMNS);
    if (known.length > 0) {
      headerMode = true;
      headerColumns = candidates;
    }
  }

  let sawLegacyHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const lineNo = i + 1;
    const fields = line.split(delimiter).map((f) => f.trim());

    if (headerMode) {
      if (i === firstLineIdx) continue; // строка-заголовок (маппинг по именам колонок)
    } else if (!sawLegacyHeader && isLegacyHeaderLine(line, delimiter)) {
      // легаси: первая строка, чья первая колонка — external_id/externalid
      sawLegacyHeader = true;
      continue;
    }

    let externalId: string;
    let phoneRaw: string;
    let timezoneRaw: string;
    let nameRaw: string;
    let consentRaw: string;
    let cardRaw: Record<string, string | number | boolean | null> = {};

    if (headerMode) {
      const record: Record<string, string> = {};
      for (let c = 0; c < headerColumns.length; c++) {
        const col = headerColumns[c];
        if (col === '') continue;
        record[col] = fields[c] ?? '';
      }
      externalId = record['external_id'] ?? record['externalid'] ?? '';
      phoneRaw = record['phone'] ?? '';
      timezoneRaw = record['timezone'] ?? '';
      nameRaw = record['name'] ?? '';
      consentRaw = record['consent'] ?? '';
      for (const [col, kind] of Object.entries(CSV_COLUMNS)) {
        if (CSV_SERVICE_COLUMN_NAMES.has(col)) continue;
        const raw = record[col];
        if (raw === undefined) continue;
        const parsed = parseCsvValue(raw, kind);
        if (!parsed.ok) {
          errors.push({ line: lineNo, message: `колонка ${col}: ${parsed.message}` });
        } else if (parsed.value !== null) {
          cardRaw[col] = parsed.value;
        }
      }
    } else {
      if (fields.length < 2) {
        errors.push({ line: lineNo, message: 'Ожидается минимум 2 колонки: external_id и phone' });
        continue;
      }
      [externalId, phoneRaw, timezoneRaw, nameRaw, consentRaw] = fields;
    }

    if (externalId === '') {
      errors.push({ line: lineNo, message: 'Пустой external_id' });
      continue;
    }
    // Единый лимит с POST /clients (createClientSchema max(100)): CSV-путь
    // раньше пропускал external_id произвольной длины (подтверждено аудитом:
    // 300-символьный идентификатор из импорта ложился в БД без отказа).
    if (externalId.length > 100) {
      errors.push({ line: lineNo, message: 'external_id длиннее 100 символов' });
      continue;
    }
    const phone = phoneRaw === '' ? null : normalizePhone(phoneRaw);
    if (phoneRaw !== '' && !phone) {
      errors.push({ line: lineNo, message: `Некорректный номер телефона: ${phoneRaw}` });
      continue;
    }
    // Пояс: IANA-имя или цифровое смещение UTC (как передаёт система данных: 5, "+5", "UTC+5")
    const timezoneRawValue = timezoneRaw ?? '';
    const timezone =
      timezoneRawValue !== '' ? normalizeTimezoneInput(timezoneRawValue) : null;
    if (timezoneRawValue !== '' && timezone === null) {
      errors.push({
        line: lineNo,
        message: `Некорректный часовой пояс: ${timezoneRawValue} (IANA-имя или смещение UTC: 5, "+5", "UTC+5", "+05:00")`,
      });
      continue;
    }
    let consent: (typeof CONSENT_STATUSES)[number] | null = null;
    if (consentRaw && consentRaw !== '') {
      const upper = consentRaw.toUpperCase();
      if (!CONSENT_STATUSES.includes(upper as (typeof CONSENT_STATUSES)[number])) {
        errors.push({ line: lineNo, message: `Некорректный consent: ${consentRaw} (NONE|PENDING|GRANTED|REVOKED)` });
        continue;
      }
      consent = upper as (typeof CONSENT_STATUSES)[number];
    }

    // Карточка: валидация полей карточки единой схемой
    let cardData: Record<string, unknown> = {};
    let cardDto: Record<string, unknown> = {}; // ключи карточки — для диффа истории (P5)
    if (Object.keys(cardRaw).length > 0) {
      const parsedCard = clientCardFieldsSchema.safeParse(cardRaw);
      if (!parsedCard.success) {
        const first = parsedCard.error.issues[0];
        errors.push({
          line: lineNo,
          message: `карточка: ${first ? `${first.path.join('.') || 'поле'}: ${first.message}` : 'некорректные поля'}`,
        });
        continue;
      }
      cardDto = parsedCard.data as Record<string, unknown>;
      cardData = cardFieldsToDb(parsedCard.data as CardFieldsDto);
    }

    const existing = await db.client.findUnique({ where: { externalId } });
    if (existing) {
      const dataMerge: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(existing.data) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(dataMerge, parsed);
        }
      } catch {
        // пустой data
      }
      if (nameRaw && nameRaw !== '') dataMerge.name = nameRaw;
      await db.client.update({
        where: { id: existing.id },
        data: {
          ...(phone ? { phone } : {}),
          ...(timezone !== null ? { timezone } : {}),
          ...(nameRaw && nameRaw !== '' ? { data: JSON.stringify(dataMerge) } : {}),
          ...(consent ? { smsConsentStatus: consent, smsConsentAt: new Date() } : {}),
          ...cardData,
        },
      });
      updated++;
      // История профиля (P5): дифф «было → стало» по строке импорта (легаси-имя
      // в data не логируется — это JSON-блоб, а не поле карточки)
      const changes = diffProfileUpdates(existing, {
        ...cardDto,
        ...(phone ? { phone } : {}),
        ...(timezone !== null ? { timezone } : {}),
        ...(consent ? { smsConsentStatus: consent } : {}),
      });
      await recordProfileChanges(existing.id, changes, 'IMPORT', { line: lineNo });
      // Календарь ДР (Task 63): пересинхронизация при изменении birthday;
      // ДР из строки — cardData.birthday, было — existing.birthday
      const importedBirthday = (cardData as { birthday?: Date | null }).birthday;
      if (importedBirthday !== undefined && birthdayChanged(existing.birthday, importedBirthday)) {
        await syncBirthdayCalendar(existing.id, importedBirthday ?? null);
      }
    } else {
      if (!phone) {
        errors.push({ line: lineNo, message: 'Для нового клиента обязателен телефон' });
        continue;
      }
      const createdRow = await db.client.create({
        data: {
          externalId,
          phone,
          timezone: timezone ?? (process.env.DEFAULT_TIMEZONE?.trim() || 'Asia/Novosibirsk'),
          ...cardData,
          data: nameRaw && nameRaw !== '' ? JSON.stringify({ name: nameRaw }) : '{}',
          smsConsentStatus: consent ?? 'NONE',
        },
      });
      created++;
      await recordProfileCreated(createdRow.id, 'IMPORT', { line: lineNo });
      // Календарь ДР (Task 63): строка создаётся вместе с клиентом (если ДР задан)
      if (createdRow.birthday) {
        await syncBirthdayCalendar(createdRow.id, createdRow.birthday);
      }
    }
  }

  await logAudit({
    user,
    action: AuditAction.IMPORT,
    entityType: AuditEntity.CLIENT,
    details: { created, updated, errors: errors.length, delimiter, headerMode },
    ip,
  });

  return { created, updated, errors };
}
