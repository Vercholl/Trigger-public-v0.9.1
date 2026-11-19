// Кастомные поля профилей (Lite) — реестр полей ADMIN + значения клиентов.
//
// Реестр полей, которые компания заводит сама (без доработки системы данных), с
// типизацией и сегментацией. Хранение —
// EAV-lite: таблица CustomField (реестр) + ClientFieldValue (значение на пару
// поле×клиент, типизированные колонки valueStr/valueNum/valueDate/valueBool,
// индексы под SQL-фильтрацию) — см. prisma/schema.prisma.
//
// ПРОСТРАНСТВО ИМЁН: ключ поля без префикса (is_credit_line); во всех внешних
// контекстах значение живёт под именем cf_<key>:
//   • переменные шаблонов/воронок/рассылок — {{cf_is_credit_line}};
//   • правила сегментов — field: "cf_is_credit_line";
//   • client_card события — "cf_is_credit_line" (канонично), сырой ключ источника
//     "is_credit_line" или camelCase-написание контракта системы данных
//     "isCreditLine" (признак продукта «Кредитная линия») — приоритет у
//     канонических полей карточки, коллизий не бывает.
// Префикс cf_ исключает коллизии с полями карточки и легаси payload.
//
// Деактивация (isActive=false) — обратимый путь: поле исчезает из конструкторов
// сегментов/подсказок шаблонов и перестаёт приниматься из client_card, но
// значения НЕ удаляются — переменные в живых шаблонах продолжают подставляться
// (выключение поля не ломает собранные SMS и воронки). Реактивация возвращает всё.
// Удаление (deleteCustomField, ADMIN) — безвозвратное: поле + все значения;
// блокируется 409 при живых ссылках на {{cf_<key>}} в шаблонах/воронках/сегментах.
//
// Вызывается из: API-роуты /api/v1/custom-fields (GET/POST/PATCH/DELETE,
// мутации — ADMIN), clients (PUT custom_fields + сериализация), events (ingest —
// извлечение cf-значений из сырой client_card), scheduler/worker (применение
// значений из события), engine/broadcasts (переменные {{cf_*}}), segments
// (валидация правил и SQL-подзапросы), радар unknown-fields (кнопка «создать поле»).
import { z } from 'zod';
import type { CustomField, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';
import { KNOWN_CARD_KEYS } from '@/lib/registry/card-fields';
import {
  CF_FIELD_TYPES,
  CF_KEY_PREFIX,
  CF_KEY_RE,
  cfCamelOfKey,
  cfColumnOfType,
  cfKeyOfVar,
  cfVarName,
  type CustomFieldType,
} from '@/lib/registry/cf-ns';
import { fmtCardDateOnly } from '@/lib/services/client-card';
import { CF_CATEGORY } from '@/lib/segments/fields';
import { cfChange, recordProfileChanges, type ProfileChange } from '@/lib/services/profile-history';

// ---------- Пространство имён: единственная точка определения — registry/cf-ns
// (изоморфный модуль чистых констант; здесь — реэкспорт для серверных потребителей). ----------

export { CF_KEY_PREFIX, CF_KEY_RE, CF_FIELD_TYPES, cfVarName, cfCamelOfKey, cfKeyOfVar, cfColumnOfType };
export type { CustomFieldType };

/** Лимит длины текстового значения (как email карточки — 200). */
const CF_TEXT_MAX = 200;

/** Нормализованная форма ключа для «мягкого» матчинга написаний ядра:
 *  нижний регистр без подчёркиваний (isSravni_client ≡ is_sravni_client ≡
 *  isSravniClient). Доработка №4 (Сравни) передаёт поле именно как
 *  isSravni_client — ни snake_case, ни camelCase; без нормализации значение
 *  терялось бы молча. Коллизии невозможны: это лишь запасной поиск ПОСЛЕ
 *  точных написаний (cf_<key> → <key> → camelCase). */
export function cfNormKey(key: string): string {
  return key.toLowerCase().replace(/_/g, '');
}

/** Множество «известных» написаний кастомных полей для радара unknown-fields:
 *  точные (ключ/cf_<key>/camelCase) + нормализованные формы — ядро не
 *  подсвечивается радаром за нестандартное написание зарегистрированного поля. */
export function cfKnownKeyMatchers(defs: readonly CustomFieldDefLite[]): Set<string> {
  const set = new Set<string>();
  for (const def of defs) {
    set.add(def.key);
    const prefixed = cfVarName(def.key);
    const camel = cfCamelOfKey(def.key);
    set.add(prefixed);
    set.add(camel);
    set.add(cfNormKey(def.key));
    set.add(cfNormKey(camel));
  }
  return set;
}

// ---------- Нормализация значений ----------

/**
 * Сырое значение → типизированное под тип поля. Принимаются «мягкие» формы
 * (число строкой, булев строкой/0/1, дата ISO-строкой/эпохой) — как передаёт
 * ядро в client_card; даты → Date (для valueDate). Возврат:
 *   • { value } — валидное значение (Date/number/boolean/string);
 *   • { clear: true } — null (семантика «очистить значение»);
 *   • null — НЕВАЛИДНО (пропустить: не писать ни в БД, ни в payload).
 */
export function normalizeCfValue(
  type: CustomFieldType,
  raw: unknown,
): { value: string | number | boolean | Date } | { clear: true } | null {
  if (raw === null) return { clear: true };
  switch (type) {
    case 'text': {
      if (typeof raw !== 'string') return null;
      const v = raw.trim();
      if (v === '') return { clear: true };
      if (v.length > CF_TEXT_MAX) return null;
      return { value: v };
    }
    case 'number': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw } : null;
      if (typeof raw === 'string') {
        const v = raw.trim();
        if (v === '') return { clear: true };
        const num = Number(v);
        return Number.isFinite(num) ? { value: num } : null;
      }
      return null;
    }
    case 'date': {
      if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : { value: raw };
      if (typeof raw === 'string') {
        const v = raw.trim();
        if (v === '') return { clear: true };
        const t = Date.parse(v);
        return Number.isNaN(t) ? null : { value: new Date(t) };
      }
      if (typeof raw === 'number') {
        // эпоха в миллисекундах (как передают некоторые интеграции)
        return Number.isFinite(raw) && raw > 0 ? { value: new Date(raw) } : null;
      }
      return null;
    }
    case 'bool': {
      if (typeof raw === 'boolean') return { value: raw };
      if (typeof raw === 'number' && (raw === 0 || raw === 1)) return { value: raw === 1 };
      if (typeof raw === 'string') {
        const v = raw.trim().toLowerCase();
        if (v === '') return { clear: true };
        if (v === 'true' || v === '1' || v === 'да') return { value: true };
        if (v === 'false' || v === '0' || v === 'нет') return { value: false };
      }
      return null;
    }
  }
}

/** Дата → ISO-строка (для JSON-payload события); прочие значения — как есть. */
function cfValueForJson(value: string | number | boolean | Date): string | number | boolean {
  return value instanceof Date ? value.toISOString() : value;
}

// ---------- Кэш реестра (горячий путь) ----------

/** Минимальный деф поля реестра (включая деактивированные). */
export interface CustomFieldDefLite {
  id: string;
  key: string;
  label: string;
  type: CustomFieldType;
  isActive: boolean;
}

const CF_CACHE_TTL_MS = 30_000;
let cfCache: { defs: CustomFieldDefLite[]; expiresAt: number } | null = null;

/** Инвалидация кэша реестра — вызывается мутациями (create/update) и после
 *  ручных правок БД; следующий read перечитает таблицу. */
export function invalidateCustomFieldCache(): void {
  cfCache = null;
}

/**
 * ВСЕ кастомные поля (кэш 30с — горячий путь воркера/рассылок/сегментов читает
 * реестр на каждом событии/сообщении). Пустой список — полей нет: все
 * интеграции вырождаются в no-op без единого лишнего запроса значений.
 * Мутации реестра инвалидируют кэш — свежесть гарантируется.
 */
export async function loadCustomFields(): Promise<CustomFieldDefLite[]> {
  if (cfCache && cfCache.expiresAt > Date.now()) return cfCache.defs;
  const rows = await db.customField.findMany({
    orderBy: { key: 'asc' },
    select: { id: true, key: true, label: true, type: true, isActive: true },
  });
  const defs: CustomFieldDefLite[] = rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    type: r.type as CustomFieldType,
    isActive: r.isActive,
  }));
  cfCache = { defs, expiresAt: Date.now() + CF_CACHE_TTL_MS };
  return defs;
}

/** Активные поля (конструкторы, приём из client_card) — фильтр полного кэша. */
export async function loadActiveCustomFields(): Promise<CustomFieldDefLite[]> {
  const all = await loadCustomFields();
  return all.filter((d) => d.isActive);
}

// ---------- Извлечение cf-значений из сырой client_card (ingest) ----------

/** Результат извлечения cf-значений из сырой карточки события. */
export interface CfCardExtraction {
  /** Нормализованные значения под КЛАНОНИЧЕСКИМИ ключами cf_<key> — мержатся
   *  в payload.client_card (воркер применит их к БД, движок увидит в vars). */
  cfNormalized: Record<string, string | number | boolean>;
  /** Ключи с префиксом cf_, для которых НЕТ активного поля — «неизвестные»
   *  для радара (ядро шлёт наше пространство имён, а поля нет). */
  unknownCfKeys: string[];
}

/**
 * Сырая client_card → cf-значения. Для каждого АКТИВНОГО поля берётся значение
 * по каноническому ключу cf_<key>; при отсутствии — по сыром ключу <key>, при
 * отсутствии — по camelCase-написанию контракта системы данных (is_credit_line →
 * isCreditLine: новые продукты передаются именно так — «Кредитная
 * линия»). Сырые/camel ключи применяются, только пока не заняты
 * реестром карточки. Невалидные по типу значения пропускаются молча
 * (событие не должно падать из-за битого cf). null-значение тоже пропускается
 * при приёме события: очистка — ручная операция панели (автоматическая
 * «очистка по молчанию источника» опасна потерей данных).
 */
export function extractCfFromRawCard(
  rawCard: Record<string, unknown>,
  defs: readonly CustomFieldDefLite[],
): CfCardExtraction {
  const cfNormalized: Record<string, string | number | boolean> = {};
  const activeKeys = new Set(defs.map((d) => d.key));
  // Запасной индекс сырых ключей в нормализованной форме (isSravni_client).
  const rawNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(rawCard)) rawNorm.set(cfNormKey(k), v);
  for (const def of defs) {
    const prefixed = cfVarName(def.key);
    // Защита от коллизии сырого ключа с реестром карточки: если ключ когда-либо
    // станет каноническим полем карточки, приоритет у карточки — cf его не трогает.
    if (KNOWN_CARD_KEYS.has(def.key)) continue;
    // Три написания одного поля: cf_<key> → <key> → camelCase (isCreditLine).
    const camel = cfCamelOfKey(def.key);
    let raw =
      rawCard[prefixed] !== undefined
        ? rawCard[prefixed]
        : rawCard[def.key] !== undefined
          ? rawCard[def.key]
          : rawCard[camel];
    // Четвёртое (запасное) написание — без регистра/подчёркиваний: источник данных
    // передаёт некоторые поля доработок в «смешанном» виде (isSravni_client).
    if (raw === undefined) {
      const byNorm = rawNorm.get(cfNormKey(def.key));
      if (byNorm !== undefined) raw = byNorm;
    }
    if (raw === undefined) continue;
    const normalized = normalizeCfValue(def.type, raw);
    if (normalized === null || 'clear' in normalized) continue;
    cfNormalized[prefixed] = cfValueForJson(normalized.value);
  }
  // Неизвестные cf_-ключи: префикс есть, активного поля нет (радар должен
  // подсветить: кто-то шлёт в наше пространство имён незарегистрированное поле).
  const unknownCfKeys = Object.keys(rawCard).filter(
    (k) => k.startsWith(CF_KEY_PREFIX) && !activeKeys.has(k.slice(CF_KEY_PREFIX.length)),
  );
  return { cfNormalized, unknownCfKeys };
}

// ---------- Значения клиентов ----------

/** Строка значения → сырое значение под ключом cf_<key> (даты — Date,
 *  числа — числами, булевы — булевыми; для JS-оценки сегментов). */
function rowToRawValue(row: { valueStr: string | null; valueNum: number | null; valueDate: Date | null; valueBool: boolean | null }): string | number | boolean | Date | null {
  return row.valueStr ?? row.valueNum ?? row.valueDate ?? row.valueBool;
}

/**
 * Сырые значения кастомных полей ОДНОГО клиента под ключами cf_<key> (даты —
 * Date). Включая деактивированные поля: сегменты с сохранёнными правилами по
 * выключенному полю продолжают вычисляться, а шаблоны — подставлять переменную
 * (семантика «выключили сбор, оставили данные»). Пустой реестр → без запроса.
 */
export async function rawCfValuesForClient(clientId: string): Promise<Record<string, string | number | boolean | Date>> {
  const defs = await loadCustomFields();
  if (defs.length === 0) return {}; // реестр пуст — значений быть не может
  const rows = await db.clientFieldValue.findMany({
    where: { clientId },
    select: { field: { select: { key: true } }, valueStr: true, valueNum: true, valueDate: true, valueBool: true },
  });
  const out: Record<string, string | number | boolean | Date> = {};
  for (const row of rows) {
    const value = rowToRawValue(row);
    if (value === null) continue;
    out[cfVarName(row.field.key)] = value;
  }
  return out;
}

/**
 * Значения для переменных шаблонов {{cf_<key>}}: даты — «дд.мм.гггг»
 * (как поля карточки), числа/булевы/строки — как есть. Только non-null.
 * Реактивация/деактивация не влияет: подставляется всё, что хранится.
 */
export async function cfVarsForClient(clientId: string): Promise<Record<string, unknown>> {
  const raw = await rawCfValuesForClient(clientId);
  const vars: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    vars[name] = value instanceof Date ? fmtCardDateOnly(value) : value;
  }
  return vars;
}

/**
 * Сырые значения для БАТЧА клиентов (JS-оценка cf-правил сегментов при
 * полном проходе): clientId → {cf_<key>: rawValue}. Запрос по индексу clientId
 * с ограничением по полям, задействованным в правилах (пусто — без запроса).
 */
export async function rawCfValuesForClients(
  clientIds: readonly string[],
  cfKeys: readonly string[] = [],
): Promise<Map<string, Record<string, string | number | boolean | Date>>> {
  const result = new Map<string, Record<string, string | number | boolean | Date>>();
  if (clientIds.length === 0 || cfKeys.length === 0) return result;
  const rows = await db.clientFieldValue.findMany({
    where: { clientId: { in: [...clientIds] }, field: { key: { in: [...cfKeys] } } },
    select: { clientId: true, field: { select: { key: true } }, valueStr: true, valueNum: true, valueDate: true, valueBool: true },
  });
  for (const row of rows) {
    const value = rowToRawValue(row);
    if (value === null) continue;
    const name = cfVarName(row.field.key);
    const bucket = result.get(row.clientId) ?? {};
    bucket[name] = value;
    result.set(row.clientId, bucket);
  }
  return result;
}

/** Значение → типизированный объект колонки для Prisma create/update
 *  ({valueStr} | {valueNum} | {valueDate} | {valueBool} — по типу поля). */
function cfValueData(
  type: CustomFieldType,
  value: string | number | boolean | Date,
): { valueStr: string } | { valueNum: number } | { valueDate: Date } | { valueBool: boolean } {
  switch (type) {
    case 'text':
      return { valueStr: value as string };
    case 'number':
      return { valueNum: value as number };
    case 'date':
      return { valueDate: value as Date };
    case 'bool':
      return { valueBool: value as boolean };
  }
}

/** Итог применения значений из события (для result-JSON события). */
export interface CfApplyResult {
  /** Записано новых/обновлено значений. */
  applied: number;
  /** Пропущено: невалидный тип значения под полем (ключи cf_*). */
  skipped: string[];
}

/** Контекст события для записи истории cf-изменений (P5). */
export interface CfHistoryContext {
  eventId: string;
  eventName: string;
}

/**
 * Применение cf-значений из client_card события к профилю клиента (воркер,
 * после upsert карточки): читает КЛАНОНИЧЕСКИЕ ключи cf_<key> из карточки
 * payload (ingest нормализовал и записал их туда), упсертит в ClientFieldValue.
 * НИКОГДА не бросает — битое cf-значение не должно валить обработку события;
 * невалидные попадают в skipped (видно в result события).
 * История профиля (P5): при заданном контексте фактические диффы пишутся в
 * ProfileChangeLog с источником EVENT (что и когда ядро поменяло в cf-полях).
 */
export async function applyCfFromEventCard(
  clientId: string,
  card: Record<string, unknown>,
  history?: CfHistoryContext | null,
): Promise<CfApplyResult> {
  const defs = await loadActiveCustomFields();
  const skipped: string[] = [];
  let applied = 0;
  // Текущие значения для диффа истории: один запрос ДО применения
  const before = history ? await rawCfValuesForClient(clientId) : null;
  const changes: ProfileChange[] = [];
  for (const def of defs) {
    if (KNOWN_CARD_KEYS.has(def.key)) continue; // защита коллизии с реестром карточки
    const raw = card[cfVarName(def.key)];
    if (raw === undefined) continue;
    const normalized = normalizeCfValue(def.type, raw);
    if (normalized === null) {
      skipped.push(cfVarName(def.key));
      continue;
    }
    try {
      if ('clear' in normalized) {
        await db.clientFieldValue.deleteMany({ where: { clientId, fieldId: def.id } });
      } else {
        const valueData = cfValueData(def.type, normalized.value);
        await db.clientFieldValue.upsert({
          where: { fieldId_clientId: { fieldId: def.id, clientId } },
          create: { fieldId: def.id, clientId, ...valueData },
          update: valueData,
        });
      }
      applied += 1;
      if (history && before !== null) {
        const change = cfChange(
          def.key,
          before[cfVarName(def.key)] ?? null,
          'clear' in normalized ? null : normalized.value,
        );
        if (change !== null) changes.push(change);
      }
    } catch (e) {
      // защита области: сбой записи одного поля не валит событие целиком
      console.error('[custom-fields] applyCfFromEventCard:', e instanceof Error ? e.message : String(e));
      skipped.push(cfVarName(def.key));
    }
  }
  if (history && changes.length > 0) {
    await recordProfileChanges(clientId, changes, 'EVENT', {
      eventId: history.eventId,
      event: history.eventName,
    });
  }
  return { applied, skipped };
}

/** Значения клиента под ключами БЕЗ префикса (API custom_fields) — для
 *  сериализации клиента и заполнения формы карточки. Даты — «дд.мм.гггг». */
export async function cfValuesForApi(clientId: string): Promise<Record<string, string | number | boolean>> {
  const raw = await rawCfValuesForClient(clientId);
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = cfKeyOfVar(name);
    if (key === null) continue;
    out[key] = value instanceof Date ? fmtCardDateOnly(value) : value;
  }
  return out;
}

/** Валидированное действие над значением кастомного поля. */
export type CfAction = {
  def: { id: string; key: string; type: string };
  normalized: Exclude<ReturnType<typeof normalizeCfValue>, null>;
};

/**
 * Валидация custom_fields БЕЗ записи в БД: ключи по реестру (включая
 * деактивированные — их значения можно править/чистить), значения по типу.
 * Вызывается ДО создания клиента (POST /clients): невалидный ключ/значение
 * должно отвалиться 422 ДО записи строки Client — иначе клиент уже создан,
 * а повторный POST возвращает 409 «externalId существует» вместо понятной
 * ошибки валидации. Возвращает готовые к применению действия.
 */
export async function validateClientCustomValues(
  values: Record<string, unknown>,
): Promise<CfAction[]> {
  const entries = Object.entries(values);
  if (entries.length === 0) return [];
  const allDefs = await db.customField.findMany({ select: { id: true, key: true, type: true } });
  const byKey = new Map(allDefs.map((d) => [d.key, d]));
  const actions: CfAction[] = [];
  for (const [rawKey, rawValue] of entries) {
    const key = cfKeyOfVar(rawKey) ?? rawKey; // cf_-написание → без префикса
    const def = byKey.get(key);
    if (!def) {
      throw new ApiError(
        422,
        'Ошибка валидации',
        `Неизвестное кастомное поле «${key}» (доступны: ${allDefs.map((d) => d.key).join(', ') || '— реестр пуст'})`,
      );
    }
    const normalized = normalizeCfValue(def.type as CustomFieldType, rawValue);
    if (normalized === null) {
      throw new ApiError(422, 'Ошибка валидации', `Некорректное значение поля «${key}» для типа ${def.type}`);
    }
    actions.push({ def, normalized });
  }
  return actions;
}

/**
 * Установка значений из панели (PUT /clients/{id}, custom_fields): ключи без
 * префикса (допускается и cf_-написание — нормализуется), значение null/'' —
 * очистка. Неизвестный ключ или невалидное значение → 422 со списком доступных
 * (валидация — validateClientCustomValues, ДО первой записи).
 * Побочные эффекты: запись ClientFieldValue (АТОМАРНО — частичный сбой на
 * середине не оставляет «первые два поля применились, остальные нет»),
 * дифф-запись истории профиля (P5, MANUAL), audit-лог UPDATE/CLIENT.
 */
export async function setClientCustomValues(
  clientId: string,
  values: Record<string, unknown>,
  user: SessionUser,
  ip: string,
): Promise<void> {
  const actions = await validateClientCustomValues(values);
  if (actions.length === 0) return;
  // Текущие значения для диффа истории (P5): один запрос ДО применения
  const before = await rawCfValuesForClient(clientId);
  const changes: ProfileChange[] = [];
  // Атомарность: без транзакции сбой на 3-й записи (SQLITE_BUSY при конкурирующей
  // записи) оставлял бы половину применённой и рвал бы историю/аудит — тот же
  // класс проблем, который уже закрыт пер-клиентной транзакцией в mass-update.
  await db.$transaction(async (tx) => {
    for (const { def, normalized } of actions) {
      if ('clear' in normalized) {
        await tx.clientFieldValue.deleteMany({ where: { clientId, fieldId: def.id } });
      } else {
        const valueData = cfValueData(def.type as CustomFieldType, normalized.value);
        await tx.clientFieldValue.upsert({
          where: { fieldId_clientId: { fieldId: def.id, clientId } },
          create: { fieldId: def.id, clientId, ...valueData },
          update: valueData,
        });
      }
      const change = cfChange(
        def.key,
        before[cfVarName(def.key)] ?? null,
        'clear' in normalized ? null : normalized.value,
      );
      if (change !== null) changes.push(change);
    }
  });
  await recordProfileChanges(clientId, changes, 'MANUAL', { actorEmail: user.email });
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.CLIENT,
    entityId: clientId,
    details: { customFields: actions.map((a) => a.def.key) },
    ip,
  });
}

// ---------- Реестр: CRUD (ADMIN) ----------

/** Схема создания: ключ (латиница/цифры/_), метка, тип, описание. */
export const createCustomFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, 'Ключ: минимум 2 символа')
    .max(40, 'Ключ: максимум 40 символов')
    .regex(CF_KEY_RE, 'Ключ: латинские буквы/цифры/подчёркивание, начинается с буквы (например is_credit_line)'),
  label: z.string().trim().min(1, 'Название обязательно').max(100, 'Название: максимум 100 символов'),
  type: z.enum(CF_FIELD_TYPES),
  description: z.string().trim().max(500).nullish(),
});

/** Схема обновления: ключ и тип НЕ меняем (тип задаёт колонку хранения — смена
 *  потребовала бы конвертацию всех значений; в Lite это осознанно запрещено). */
export const updateCustomFieldSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullish(),
  isActive: z.boolean().optional(),
});

export type CreateCustomFieldDto = z.infer<typeof createCustomFieldSchema>;
export type UpdateCustomFieldDto = z.infer<typeof updateCustomFieldSchema>;

/** Строка реестра → JSON API (счётчик заполненных значений — из groupBy). */
export function serializeCustomField(row: CustomField, valueCount?: number): Record<string, unknown> {
  return {
    id: row.id,
    key: row.key,
    varName: cfVarName(row.key), // готовое имя переменной для подсказок
    label: row.label,
    type: row.type,
    description: row.description,
    isActive: row.isActive,
    values: valueCount ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Список полей реестра: по умолчанию только активные (конструкторы сегментов,
 *  подсказки шаблонов); includeInactive — весь реестр (админ-раздел).
 *  Чтение — без побочных эффектов; счётчик значений — одним groupBy. */
export async function listCustomFields(includeInactive = false): Promise<Record<string, unknown>[]> {
  const rows = await db.customField.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ isActive: 'desc' }, { key: 'asc' }],
  });
  const counts = await db.clientFieldValue.groupBy({
    by: ['fieldId'],
    _count: { _all: true },
  });
  const countByField = new Map(counts.map((c) => [c.fieldId, c._count._all]));
  return rows.map((r) => serializeCustomField(r, countByField.get(r.id) ?? 0));
}

/**
 * Создание поля (ADMIN): уникальный ключ, не коллизующий с реестром карточки
 * (сырой ключ источника не должен совпадать — приоритет канонических полей карточки) и
 * не начинающийся с cf_ (двойной префикс — путаница). Побочные эффекты: запись
 * CustomField, удаление «поглощённых» наблюдений радара (fieldName = ключ или
 * cf_+ключ — новое поле закрывает дыру, которую подсвечивал радар), инвалидация
 * кэша, audit-лог CREATE/CUSTOM_FIELD.
 */
export async function createCustomField(
  dto: CreateCustomFieldDto,
  user: SessionUser,
  ip: string,
): Promise<CustomField> {
  if (dto.key.startsWith(CF_KEY_PREFIX)) {
    throw new ApiError(422, 'Ошибка валидации', `Ключ не должен начинаться с «${CF_KEY_PREFIX}» — префикс добавляется автоматически (переменная будет {{${cfVarName(dto.key)}}})`);
  }
  if (KNOWN_CARD_KEYS.has(dto.key)) {
    throw new ApiError(422, 'Ошибка валидации', `Ключ «${dto.key}» совпадает с полем карточки — выберите другой (переменная карточки уже существует)`);
  }
  const existing = await db.customField.findUnique({ where: { key: dto.key } });
  if (existing) {
    throw new ApiError(409, 'Поле с таким ключом уже существует', `Ключ ${dto.key} занят (${existing.isActive ? 'активное' : 'деактивированное'} поле «${existing.label}»)`);
  }
  let row: CustomField;
  try {
    row = await db.customField.create({
      data: {
        key: dto.key,
        label: dto.label,
        type: dto.type,
        description: dto.description ?? null,
        isActive: true,
        createdById: user.id,
      },
    });
  } catch (e) {
    // гонка параллельного создания с тем же ключом
    if ((e as { code?: string })?.code === 'P2002' || (e instanceof Error && e.message.includes('Unique constraint failed'))) {
      throw new ApiError(409, 'Поле с таким ключом уже существует');
    }
    throw e;
  }
  invalidateCustomFieldCache();
  // Новое поле «поглощает» наблюдение радара (если радар подсвечивал этот ключ;
  // все три написания: сырой ключ, каноничный cf_<key> и camelCase контракта системы данных)
  await db.unknownFieldObservation
    .deleteMany({ where: { fieldName: { in: [dto.key, cfVarName(dto.key), cfCamelOfKey(dto.key)] } } })
    .catch(() => undefined);
  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.CUSTOM_FIELD,
    entityId: row.id,
    details: { key: row.key, type: row.type, label: row.label },
    ip,
  });
  return row;
}

/**
 * Обновление поля (ADMIN): метка/описание/активность. Смена isActive —
 * деактивация (поле исчезает из конструкторов, приём cf из client_card
 * прекращается, значения остаются) либо реактивация. Побочные эффекты: запись
 * CustomField, инвалидация кэша, audit-лог (UPDATE или ACTIVATE/DEACTIVATE).
 */
export async function updateCustomField(
  id: string,
  dto: UpdateCustomFieldDto,
  user: SessionUser,
  ip: string,
): Promise<CustomField> {
  const existing = await db.customField.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Поле не найдено');
  const row = await db.customField.update({
    where: { id },
    data: {
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    },
  });
  invalidateCustomFieldCache();
  // Смена активности — отдельные действия аудита (как у шаблонов/воронок)
  if (dto.isActive !== undefined && dto.isActive !== existing.isActive) {
    await logAudit({
      user,
      action: dto.isActive ? AuditAction.ACTIVATE : AuditAction.DEACTIVATE,
      entityType: AuditEntity.CUSTOM_FIELD,
      entityId: id,
      details: { key: row.key },
      ip,
    });
  }
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.CUSTOM_FIELD,
    entityId: id,
    details: { key: row.key, label: dto.label, description: dto.description },
    ip,
  });
  return row;
}

/** Результат удаления поля: ключ и число удалённых значений клиентов. */
export interface DeleteCustomFieldResult {
  key: string;
  deletedValues: number;
}

/**
 * Удаление поля (ADMIN) — безвозвратное, в отличие от деактивации. Удаляются:
 * строка реестра CustomField + ВСЕ значения клиентов (ClientFieldValue, вместе —
 * транзакция; FK тоже каскаден, но явный deleteMany даёт счётчик для аудита) +
 * наблюдения радара по этому ключу (все три написания — как при создании).
 *
 * ГВАРД (409 «Поле используется»): переменная {{cf_<key>}} не должна ссылаться
 * живыми конструкторами — иначе после удаления они молча подставляли бы пусто:
 *   • шаблоны — тело содержит {{cf_<key>}} / {{#if cf_<key>}} (включая
 *     деактивированные: восстановление вернуло бы битую переменную);
 *   • воронки — condition-выражения узлов (definition-JSON);
 *   • сегменты — правила по полю cf_<key> (conditions-JSON, включая static).
 * Рассылки ссылаются на шаблоны опосредованно (templateId) — покрываются
 * проверкой шаблонов. Исторические данные (отправленные SMS, payload событий,
 * история профиля) не блокируют удаление — это журнал, а не живые конструкторы.
 *
 * Побочные эффекты: транзакция (значения + поле), поглощение наблюдений радара,
 * инвалидация кэша, audit-лог DELETE/CUSTOM_FIELD (с числом удалённых значений).
 */
export async function deleteCustomField(
  id: string,
  user: SessionUser,
  ip: string,
): Promise<DeleteCustomFieldResult> {
  const existing = await db.customField.findUnique({ where: { id } });
  if (!existing) throw new ApiError(404, 'Поле не найдено');

  // Точное совпадение идентификатора cf_<key> (границы слова): подстрочный
  // contains дал бы ложные срабатывания на cf_<key>_extra. Двухступенчато:
  // грубый contains в SQL (индекс/фильтр на стороне БД) + точный regex в JS.
  const varName = cfVarName(existing.key);
  const refRe = new RegExp(`\\b${varName}\\b`);

  const templateRows = await db.smsTemplate.findMany({
    where: { body: { contains: varName } },
    select: { name: true, body: true },
  });
  const templateRefs = templateRows.filter((t) => refRe.test(t.body));
  if (templateRefs.length > 0) {
    throw new ApiError(
      409,
      'Поле используется',
      `Переменная {{${varName}}} встречается в шаблонах: ${templateRefs.map((t) => t.name).join(', ')} — удалите или исправьте их сначала`,
    );
  }

  const funnelRows = await db.funnel.findMany({
    where: { definition: { contains: varName } },
    select: { name: true, definition: true },
  });
  const funnelRefs = funnelRows.filter((f) => refRe.test(f.definition));
  if (funnelRefs.length > 0) {
    throw new ApiError(
      409,
      'Поле используется',
      `Переменная {{${varName}}} используется в воронках (условия узлов): ${funnelRefs.map((f) => f.name).join(', ')} — удалите или исправьте их сначала`,
    );
  }

  const segmentRows = await db.segment.findMany({
    where: { conditions: { contains: varName } },
    select: { name: true, conditions: true },
  });
  const segmentRefs = segmentRows.filter((s) => refRe.test(s.conditions));
  if (segmentRefs.length > 0) {
    throw new ApiError(
      409,
      'Поле используется',
      `Поле cf_${existing.key} используется в сегментах: ${segmentRefs.map((s) => s.name).join(', ')} — удалите или исправьте их сначала`,
    );
  }

  // Удаление: значения + поле атомарно (сбой середины не оставит «поле без
  // значений»/«значения-сироты»; FK-каскад продублирован явным deleteMany
  // ради счётчика удалённых значений для audit-записи).
  // Известное ограничение (TOCTOU): гварды выше выполняются ДО транзакции —
  // шаблон, СОХРАНЁННЫЙ параллельно в узком окне между сканом и удалением,
  // останется с «битой» переменной {{cf_<key>}} (рендер подставит пусто —
  // видно в превью, лечится правкой шаблона). Окно микроскопическое (оба
  // действия инициируют админы), последствие видимое и обратимое; перенос
  // гвардов внутрь транзакции без BEGIN IMMEDIATE окно не закрывает.
  const [valuesDeleted] = await db.$transaction([
    db.clientFieldValue.deleteMany({ where: { fieldId: id } }),
    db.customField.delete({ where: { id } }),
  ]);
  invalidateCustomFieldCache();
  // Поглощение наблюдений радара (как при создании — все три написания ключа):
  // если ядро продолжит слать cf_<key>, радар честно подсветит их заново.
  await db.unknownFieldObservation
    .deleteMany({ where: { fieldName: { in: [existing.key, varName, cfCamelOfKey(existing.key)] } } })
    .catch(() => undefined);
  await logAudit({
    user,
    action: AuditAction.DELETE,
    entityType: AuditEntity.CUSTOM_FIELD,
    entityId: id,
    details: { key: existing.key, label: existing.label, deletedValues: valuesDeleted.count },
    ip,
  });
  return { key: existing.key, deletedValues: valuesDeleted.count };
}

// ---------- Сегментация: CF-поля как правила ----------

// Категория CF_CATEGORY — в изоморфном реестре segments/fields (там же
// cfToSegmentField для конструктора правил UI: ключ cf_<key> + сужение типа).
