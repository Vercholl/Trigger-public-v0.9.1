// ЕДИНЫЙ РЕЕСТР ПОЛЕЙ КАРТОЧКИ КЛИЕНТА (schema-as-code).
//
// Один источник правды для всех слоёв, работающих с полями карточки:
//   • валидация API/CSV — zod-схема client-card.ts (ключи сверяются с реестром
//     на этапе компиляции через satisfies — разойтись не дадут);
//   • маппинги DTO ↔ колонки Prisma, сериализация API и переменные шаблонов —
//     генерируются циклом по CARD_FIELDS (client-card.ts);
//   • реестр сегментации SEGMENT_FIELDS — генерируется из CARD_FIELDS +
//     спец-поля (segments/fields.ts);
//   • CSV-импорт: имена колонок и типы разбора — из CARD_FIELDS (clients.ts);
//   • подсказки переменных в редакторе шаблонов — из CARD_FIELDS (sms-utils.ts).
//
// ПОДКЛЮЧЕНИЕ НОВОГО ПОЛЯ ИСТОЧНИКА = строка здесь + строка в zod-схеме
// client-card.ts (компилятор сверит множества ключей) + колонка в
// prisma/schema.prisma (db:push + перегенерация DDL, см. db-bootstrap.ts).
// До перевода на реестр это были 5 правок в 4 файлах, которые легко
// рассинхронизировать (пример дрейфа: loan_closed_date добавили в реестр
// сегментов и CSV, но забыли в подсказки переменных шаблонов).
//
// Модуль — ЧИСТЫЕ ДАННЫЕ (без zod/prisma/серверных импортов): используется и
// серверными сервисами, и клиентским UI — как segments/fields.ts.
//
// «Радар» доработок источника: ключи client_card, не входящие в KNOWN_CARD_KEYS
// (поля реестра + phone/timezone), фиксируются приёмником событий
// (services/events.ts → EventsInbox.unknownFields + UnknownFieldObservation) —
// так источник, начав передавать новое поле, обнаруживается в день включения,
// а не после жалоб «где поле X в карточке?».

/** Категория поля — группы в конструкторе сегментов и справочниках UI. */
export type CardFieldCategory = 'Профиль' | 'Заявка' | 'Договор' | 'Преапрув' | 'Коммуникации';

/** Категории в порядке отображения UI (единственный источник порядка). */
export const CARD_FIELD_CATEGORIES = [
  'Профиль',
  'Заявка',
  'Договор',
  'Преапрув',
  'Коммуникации',
] as const satisfies readonly CardFieldCategory[];

/** Тип значения поля: валидация (client-card.ts) + производные типы
 *  сегментации (segments/fields.ts) и разбора CSV (clients.ts). */
export type CardFieldType = 'text' | 'int' | 'number' | 'bool' | 'date' | 'enum';

/** Каноническое поле карточки: своя колонка Client (Prisma). */
export interface CanonicalCardFieldDef {
  /** Имя поля в API источника (snake_case) — ключ client_card, CSV-колонка,
   *  имя переменной шаблона и правила сегментации. */
  fieldName: string;
  /** Колонка таблицы Client (camelCase) — 1:1 с prisma/schema.prisma. */
  prisma: string;
  type: CardFieldType;
  /** Человекочитаемая метка (реестр сегментов, общие подписи UI). */
  label: string;
  /** Подпись в подсказках переменных шаблонов, если контекст требует
   *  уточнения (единицы, варианты значений) — иначе используется label. */
  tplLabel?: string;
  category: CardFieldCategory;
  /** Демо-значение для предпросмотра шаблонов (sms-utils). */
  sample: string;
  /** Подсказка в UI конструктора сегментов. */
  hint?: string;
  /** Варианты для type='enum'. */
  options?: readonly string[];
  /** Лимит длины для type='text'. */
  maxLength?: number;
  /** Переопределение типа в сегментации: person_birthday → 'birthday'
   *  (операторы месяца/дня без года + возраст). */
  segmentType?: 'birthday';
  /** У канонического поля алиаса нет (дискриминант объединения CardFieldDef). */
  aliasOf?: undefined;
}

/** Алиас: второе имя того же поля в источнике данных (своей колонки нет,
 *  значение пишется в колонку канонического поля). */
export interface AliasCardFieldDef {
  fieldName: string;
  /** Имя канонического поля, к которому относится алиас. */
  aliasOf: string;
  /** Тип значения (разбор CSV и «радар» используют те же правила). */
  type: CardFieldType;
}

export type CardFieldDef = CanonicalCardFieldDef | AliasCardFieldDef;

/**
 * Реестр полей карточки. ПОРЯДОК = порядок карточки в API (serializeCardFields)
 * и порядок переменных в подсказках редактора шаблонов — не менять без нужды.
 * Типы/подписи/подсказки сверены с контрактом интеграции (окт. 2026,
 * включая loan_closed_date — расширение источника).
 *
 * Структура из двух экспортов: литеральный источник (приватный) даёт тип-объединение
 * имён полей для compile-проверок (CardFieldName), а публичный CARD_FIELDS
 * типизирован объединением CardFieldDef — с сужением canonical/alias при обходе.
 */
const CARD_FIELDS_LITERAL = [
  // Профиль: ФИО и e-mail
  { fieldName: 'client_first_name', prisma: 'firstName', type: 'text', label: 'Имя', category: 'Профиль', sample: 'Иван', maxLength: 100 },
  { fieldName: 'client_last_name', prisma: 'lastName', type: 'text', label: 'Фамилия', category: 'Профиль', sample: 'Тестов', maxLength: 100 },
  { fieldName: 'client_middle_name', prisma: 'middleName', type: 'text', label: 'Отчество', category: 'Профиль', sample: 'Иванович', maxLength: 100 },
  { fieldName: 'email', prisma: 'email', type: 'text', label: 'E-mail', category: 'Профиль', sample: 'ivan.testov@example.com', maxLength: 200 },
  // Заявка
  { fieldName: 'application_id', prisma: 'applicationId', type: 'int', label: 'ID заявки', category: 'Заявка', sample: '551001' },
  { fieldName: 'application_actual_status', prisma: 'applicationStatus', type: 'int', label: 'Статус заявки', category: 'Заявка', sample: '4', hint: '4 — одобрена, 9 — отказ' },
  { fieldName: 'application_previous_status', prisma: 'applicationPrevStatus', type: 'int', label: 'Предыдущий статус заявки', tplLabel: 'Пред. статус заявки', category: 'Заявка', sample: '1' },
  // Договор
  { fieldName: 'agreement_id', prisma: 'agreementId', type: 'int', label: 'ID договора', category: 'Договор', sample: '101001' },
  { fieldName: 'agreement_actual_status', prisma: 'agreementStatus', type: 'int', label: 'Статус договора', tplLabel: 'Статус договора (16/17/19)', category: 'Договор', sample: '16', hint: '16 — действующий, 17 — пролонгирован, 19 — закрыт' },
  { fieldName: 'agreement_previous_status', prisma: 'agreementPrevStatus', type: 'int', label: 'Предыдущий статус договора', tplLabel: 'Пред. статус договора', category: 'Договор', sample: '15' },
  { fieldName: 'loan_amount', prisma: 'loanAmount', type: 'number', label: 'Сумма займа', tplLabel: 'Сумма займа, ₽', category: 'Договор', sample: '15000' },
  { fieldName: 'loan_period', prisma: 'loanPeriod', type: 'int', label: 'Срок займа, дней', category: 'Договор', sample: '21' },
  { fieldName: 'loan_closed_date', prisma: 'loanClosedAt', type: 'date', label: 'Дата закрытия займа', category: 'Договор', sample: '24.10.2026', hint: 'когда закрыт последний займ (расширение)' },
  { fieldName: 'notification_active', prisma: 'notificationActive', type: 'bool', label: 'Реклама разрешена', tplLabel: 'Разрешение на рекламу', category: 'Коммуникации', sample: 'true' },
  // Преапрув
  { fieldName: 'person_offer_date_start', prisma: 'offerDateStart', type: 'date', label: 'Начало преапрува', tplLabel: 'Преапрув: начало', category: 'Преапрув', sample: '01.11.2026' },
  { fieldName: 'person_offer_date_expired', prisma: 'offerDateExpired', type: 'date', label: 'Истекает преапрув', tplLabel: 'Преапрув: конец', category: 'Преапрув', sample: '15.11.2026' },
  { fieldName: 'person_offer_approve_money', prisma: 'offerApproveMoney', type: 'number', label: 'Сумма преапрува', tplLabel: 'Преапрув: сумма, ₽', category: 'Преапрув', sample: '25000' },
  { fieldName: 'person_offer_approve_days', prisma: 'offerApproveDays', type: 'int', label: 'Срок преапрува, дней', tplLabel: 'Преапрув: срок, дней', category: 'Преапрув', sample: '21' },
  { fieldName: 'person_offer_available', prisma: 'offerAvailable', type: 'bool', label: 'Преапрув доступен', category: 'Преапрув', sample: 'true' },
  // Профиль: демография (продолжение — порядок карточки)
  { fieldName: 'person_birthday', prisma: 'birthday', type: 'date', label: 'День рождения', category: 'Профиль', sample: '14.03.1985', segmentType: 'birthday' },
  { fieldName: 'last_product_type', prisma: 'lastProductType', type: 'enum', label: 'Продукт', tplLabel: 'Продукт (PDL/IL)', category: 'Профиль', sample: 'PDL', options: ['PDL', 'IL'] },
  // Договор: счётчики закрытых договоров (каноничное имя + алиас из контракта)
  { fieldName: 'agreements_for_lastyear', prisma: 'agreementsLastYear', type: 'int', label: 'Закрыто договоров за год', category: 'Договор', sample: '2' },
  { fieldName: 'agreements_for_last_year', aliasOf: 'agreements_for_lastyear', type: 'int' },
  { fieldName: 'agreements_for_lifetime', prisma: 'agreementsLifetime', type: 'int', label: 'Закрыто договоров всего', category: 'Договор', sample: '5' },
  // Заявка (продолжение)
  { fieldName: 'ban_days', prisma: 'banDays', type: 'int', label: 'Дни запрета заявки', category: 'Заявка', sample: '30', hint: '30/90 при отказе' },
  // Коммуникации
  { fieldName: 'date_update', prisma: 'profileUpdatedAt', type: 'date', label: 'Обновление профиля', tplLabel: 'Дата данных', category: 'Коммуникации', sample: '20.10.2026' },
] as const satisfies readonly CardFieldDef[];

/** Реестр полей карточки (обход с сужением canonical/alias по def.aliasOf). */
export const CARD_FIELDS: readonly CardFieldDef[] = CARD_FIELDS_LITERAL;

/** Имена всех полей реестра (канонические и алиасы) — литеральный тип-объединение
 *  для compile-проверок ключей: client-card.ts сверяет zod-схему через
 *  satisfies Record<CardFieldName, …> — множества не разойдутся. */
export type CardFieldName = (typeof CARD_FIELDS_LITERAL)[number]['fieldName'];

/** Канонические поля (алиасы отфильтрованы), порядок карточки. */
export const CANONICAL_CARD_FIELDS: readonly CanonicalCardFieldDef[] = CARD_FIELDS.filter(
  (f): f is CanonicalCardFieldDef => f.aliasOf === undefined,
);

/** Имя канонического поля → его def (для разрешения алиасов и поиска). */
const CANONICAL_BY_NAME = new Map<string, CanonicalCardFieldDef>(
  CANONICAL_CARD_FIELDS.map((f) => [f.fieldName, f]),
);

/** Каноническое поле по имени карточки (алиас или неизвестное имя → undefined). */
export function canonicalCardField(fieldName: string): CanonicalCardFieldDef | undefined {
  return CANONICAL_BY_NAME.get(fieldName);
}

/**
 * Ключи client_card, известные схеме карточки: поля реестра (включая алиасы)
 * плюс контакты phone/timezone. Всё, что не входит в множество, — «радар»
 * передаёт в EventsInbox.unknownFields (источник начал передавать новое поле).
 */
export const KNOWN_CARD_KEYS: ReadonlySet<string> = new Set<string>([
  ...CARD_FIELDS.map((f) => f.fieldName),
  'phone',
  'timezone',
]);
