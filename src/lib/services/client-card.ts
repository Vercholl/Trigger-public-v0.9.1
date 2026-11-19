// Карточка клиента: типизированные поля 1:1 по именам из контракта интеграции
// с системой данных. Общий модуль для сервисов clients/events и воркера.
// Вызывается из: services/clients (CRUD/CSV-импорт), services/events (захват
// карточки из события), services/broadcasts (переменные шаблона), services/segments
// (сериализация), scheduler/worker + engine. Prisma напрямую не трогает —
// чистое проецирование DTO ↔ колонки типа Client (таблица Client).
//
// ЕДИНЫЙ РЕЕСТР ПОЛЕЙ — src/lib/registry/card-fields.ts (schema-as-code):
// маппинги ниже (cardFieldsToDb / serializeCardFields / cardVarsFromClient /
// CARD_VAR_NAMES) генерируются циклом по реестру, а ключи zod-схемы сверяются
// с ним на этапе компиляции (satisfies ниже) — схема и реестр не разойдутся.
//
// Имена полей API (snake_case) ↔ Prisma-колонки (camelCase).
// Все поля необязательные; null означает «очистить значение», undefined — «не трогать».
// Даты принимаются ISO-строками (или Date) и нормализуются к Date.
// notification_active — только хранение (в комплаенс НЕ завязано).
import { z } from 'zod';
import type { Client } from '@prisma/client';
import { normalizeTimezoneInput } from '@/lib/time';
import {
  CARD_FIELDS,
  CANONICAL_CARD_FIELDS,
  KNOWN_CARD_KEYS,
  canonicalCardField,
  type CardFieldName,
} from '@/lib/registry/card-fields';

/**
 * СТРОГИЙ валидатор ISO-даты: «ГГГГ-ММ-ДД» или «ГГГГ-ММ-ДД[Т или пробел]
 * ЧЧ:ММ[:СС[.мс]][Z|±ЧЧ:ММ]». Отклоняет всё остальное, потому что lenient-
 * Date.parse в V8:
 *  - читает точечные даты в США-порядке М.Д.Г («05.04.2026» → 4 мая вместо
 *    5 апреля — молчаливая транспозиция месяц/день, порча ДР и дат договоров);
 *  - СКАТЫВАЕТ несуществующие даты («2026-02-30» → 2 марта), а не возвращает
 *    NaN — поэтому нужен round-trip-контроль компонентов после парсинга.
 * Компоненты сверяются в той системе, в которой V8 распарсил строку:
 * date-only и явная зона — UTC; время без зоны — локальное время сервера.
 */
const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function isValidIsoDateTime(input: string): boolean {
  const raw = input.trim();
  const m = ISO_DATE_RE.exec(raw);
  if (!m) return false;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return false;
  const d = new Date(t);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const hasTime = /[T ]\d{2}:\d{2}/.test(raw);
  if (hasZone || !hasTime) {
    return (
      d.getUTCFullYear() === Number(m[1]) &&
      d.getUTCMonth() === Number(m[2]) - 1 &&
      d.getUTCDate() === Number(m[3])
    );
  }
  return (
    d.getFullYear() === Number(m[1]) &&
    d.getMonth() === Number(m[2]) - 1 &&
    d.getDate() === Number(m[3])
  );
}

/** ISO-строка (СТРОГИЙ формат — см. isValidIsoDateTime) | Date | null → Date | null. */
const isoDateTime = z
  .union([
    z.date(),
    z.string().refine(isValidIsoDateTime, {
      message: 'Ожидается ISO-дата (ГГГГ-ММ-ДД или ГГГГ-ММ-ДДЧЧ:ММ:СС); даты «дд.мм.гггг» не принимаются',
    }),
    z.null(),
  ])
  .transform((v) => (v === null ? null : v instanceof Date ? v : new Date(v)));

/** Непустая обрезанная строка ≤ max симв.; null/undefined допустимы
 *  (семантика: null — очистить, undefined — не трогать). */
const trimmedText = (max: number) =>
  z.string().trim().min(1).max(max).nullish();

const nonNegativeInt = z.number().int().min(0).nullish();
const nonNegativeNumber = z.number().min(0).nullish();

/**
 * Валидаторы полей карточки под именами из реестра (без контактов phone/timezone).
 * Сверка с реестром НА ЭТАПЕ КОМПИЛЯЦИИ: satisfies требует все ключи CARD_FIELDS
 * (пропущенное поле реестра — ошибка) и не допускает лишних (поле без записи в
 * реестре — тоже ошибка). Ограничения длин/типов остаются здесь — это логика
 * валидации, реестр хранит только метаданные.
 */
const cardValidators = {
  client_first_name: trimmedText(100), // имя
  client_last_name: trimmedText(100), // фамилия
  client_middle_name: trimmedText(100), // отчество
  email: trimmedText(200),
  application_id: nonNegativeInt, // id последней заявки
  application_actual_status: nonNegativeInt, // текущий статус заявки
  application_previous_status: nonNegativeInt,
  agreement_id: nonNegativeInt, // id последнего договора
  agreement_actual_status: nonNegativeInt, // 16=действующий, 17=пролонгирован, 19=закрыт
  agreement_previous_status: nonNegativeInt,
  loan_amount: nonNegativeNumber, // сумма займа
  loan_period: nonNegativeInt, // срок займа в днях
  loan_closed_date: isoDateTime.nullish(), // дата закрытия последнего займа (расширение, окт. 2026)
  notification_active: z.boolean().nullish(), // разрешение на МАРКЕТИНГОВЫЕ SMS (только хранение)
  person_offer_date_start: isoDateTime.nullish(), // начало преапрува
  person_offer_date_expired: isoDateTime.nullish(), // конец преапрува
  person_offer_approve_money: nonNegativeNumber, // одобренная сумма
  person_offer_approve_days: nonNegativeInt, // одобренный срок
  person_offer_available: z.boolean().nullish(), // доступен ли преапрув
  person_birthday: isoDateTime.nullish(), // день рождения
  last_product_type: z.enum(['PDL', 'IL']).nullish(),
  agreements_for_lastyear: nonNegativeInt, // закрытых договоров за год (каноничное)
  agreements_for_last_year: nonNegativeInt, // алиас из текста контракта
  agreements_for_lifetime: nonNegativeInt, // закрытых договоров за всё время
  ban_days: nonNegativeInt, // дни запрета повторной заявки
  date_update: isoDateTime.nullish(), // дата формирования данных в ядре
} satisfies Record<CardFieldName, z.ZodType>;

/** Поля карточки под именами из реестра (без контактов phone/timezone). */
export const clientCardFieldsShape = cardValidators;

/** Схема только карточных полей (без phone/timezone) — для create/update клиента
 *  и валидации CSV-строк импорта. */
export const clientCardFieldsSchema = z.object(clientCardFieldsShape);

/** Карточка в событии (client_card): поля карточки + контакты (система данных передаёт телефон).
 * timezone — IANA-строка ИЛИ цифровое смещение UTC (как передаёт система данных: 5, "+5",
 * "UTC+5", "+05:00") — нормализуется в IANA-зону; нераспознанное → null (игнор). */
export const clientCardSchema = clientCardFieldsSchema.extend({
  phone: z.string().trim().min(5).max(20).nullish(),
  timezone: z
    .union([z.string().trim().min(1).max(64), z.number()])
    .nullish()
    .transform((v) => (v === null || v === undefined ? null : normalizeTimezoneInput(v))),
});

export type ClientCardDto = z.infer<typeof clientCardSchema>;

/** DTO только карточных полей (без phone/timezone) — для create/update клиента. */
export type CardFieldsDto = z.infer<typeof clientCardFieldsSchema>;

/**
 * Поля карточки → объект для Prisma (camelCase-колонки Client); генерируется
 * из реестра. undefined — поле не передано (не трогаем); null — очистить;
 * иначе — значение. Алиасы (agreements_for_last_year) пишутся в колонку
 * канонического поля: приоритет у канонического значения, если оно передано.
 */
export function cardFieldsToDb(card: CardFieldsDto): Record<string, unknown> {
  const source = card as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const def of CARD_FIELDS) {
    if (def.aliasOf !== undefined) {
      // Алиас источника: применяется, только если каноническое имя не передано
      // (семантика «не трогать» у undefined — каноническое приоритетнее).
      const canonical = canonicalCardField(def.aliasOf);
      if (canonical === undefined) continue; // защита: алиас без канонического поля
      if (source[canonical.fieldName] !== undefined) continue;
      const aliasValue = source[def.fieldName];
      if (aliasValue !== undefined) data[canonical.prisma] = aliasValue;
    } else {
      const value = source[def.fieldName];
      if (value !== undefined) data[def.prisma] = value;
    }
  }
  return data;
}

/** Дата → «дд.мм.гггг» (для шаблонов SMS и человекочитаемого вывода).
 *  Экспорт: то же форматирование применяют кастомные поля даты
 *  (services/custom-fields) — единый вид дат во всех переменных. */
export function fmtCardDateOnly(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

/** Имена переменных карточки — для проверки шаблонов рассылок (П4);
 *  генерируется из реестра: канонические поля (алиасы не являются переменными). */
export const CARD_VAR_NAMES: ReadonlySet<string> = new Set(
  CANONICAL_CARD_FIELDS.map((f) => f.fieldName),
);

/**
 * Карточка клиента (строка БД) → плоские поля карточки для API; генерируется из
 * реестра. Все канонические поля присутствуют всегда (null, если не заполнено)
 * — предсказуемый контракт; порядок ключей = порядок реестра (карточки).
 */
export function serializeCardFields(row: Client): Record<string, unknown> {
  const source = row as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const def of CARD_FIELDS) {
    if (def.aliasOf !== undefined) continue; // у алиаса нет своей колонки/ключа API
    out[def.fieldName] = source[def.prisma];
  }
  return out;
}

/**
 * Типизированные поля карточки → переменные шаблонов/условий под именами карточки;
 *  генерируется из реестра. Только non-null; числа — числами; булевы — булевыми;
 *  даты — строками «дд.мм.гггг» (значение не-дата в датной колонке — как пустое).
 */
export function cardVarsFromClient(row: Client): Record<string, unknown> {
  const source = row as unknown as Record<string, unknown>;
  const vars: Record<string, unknown> = {};
  for (const def of CARD_FIELDS) {
    if (def.aliasOf !== undefined) continue;
    const raw = source[def.prisma];
    const value = def.type === 'date' ? (raw instanceof Date ? fmtCardDateOnly(raw) : null) : raw;
    if (value !== null && value !== undefined) vars[def.fieldName] = value;
  }
  return vars;
}

/**
 * Ключи client_card, НЕ входящие в схему карточки (поля реестра + phone/timezone).
 * «Радар» доработок источника: zod-схема молча отбрасывает неизвестные ключи — без
 * этой проверки новое поле карточки терялось бы бесследно. Не-объект → пустой список
 * (структуру client_card валидирует clientCardSchema на приёме).
 */
export function unknownCardKeys(cardRaw: unknown): string[] {
  if (cardRaw === null || typeof cardRaw !== 'object' || Array.isArray(cardRaw)) return [];
  return Object.keys(cardRaw as Record<string, unknown>).filter((k) => !KNOWN_CARD_KEYS.has(k));
}

/** ФИО из карточки («Фамилия Имя Отчество»), фолбэк — externalId. */
export function clientFullName(row: Pick<Client, 'firstName' | 'lastName' | 'middleName' | 'externalId'>): string {
  const parts = [row.lastName, row.firstName, row.middleName].filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(' ') : row.externalId;
}
