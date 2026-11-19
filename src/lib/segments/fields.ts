// Реестр полей и операторов сегментов.
// Чистые данные — импортируется и серверным сервисом, и клиентским UI.
// Имена полей — имена карточки (snake_case, 1:1 с карточкой клиента): единый язык
// с шаблонами/воронками.
//
// ПОЛЯ КАРТОЧКИ генерируются из единого реестра registry/card-fields.ts
// (schema-as-code): новое поле источника автоматически попадает в сегментацию,
// CSV-импорт, сериализацию API и подсказки шаблонов — одной строкой реестра.
// Спец-поля вне карточки (не колонки Client) описаны здесь отдельно:
// sms_consent_status — колонка согласия smsConsentStatus;
// unsubscribed (отписка/стоп-лист) — JS-фильтр без колонки.
//
// КАСТОМНЫЕ ПОЛЯ ПРОФИЛЯ ({{cf_*}}) — динамическая часть реестра: живут в БД
// (services/custom-fields), на клиент/сервер приходят списком и превращаются
// в сегментные поля cfToSegmentField (категория «Кастомные»). Для них нет
// prisma-колонки — фильтр строится по relation customFieldValues (SQL EXISTS),
// значения для JS-оценки подгружаются батчем (services/segments).
import {
  CANONICAL_CARD_FIELDS,
  CARD_FIELD_CATEGORIES,
  type CanonicalCardFieldDef,
  type CardFieldCategory,
} from '@/lib/registry/card-fields';
import { CF_KEY_PREFIX } from '@/lib/registry/cf-ns';

export type SegmentFieldType =
  | 'number' // целые/дробные ≥0: статусы, суммы, счётчики
  | 'string' // ФИО, email
  | 'enum' // last_product_type | sms_consent_status
  | 'boolean' // notification_active | person_offer_available | unsubscribed
  | 'date' // абсолютные даты: окно относительно «сейчас»
  | 'birthday'; // день рождения: месяц/день + возраст

export type SegmentValue = number | string | boolean | string[];

export interface SegmentFieldDef {
  key: string; // имя карточки | cf_<key> кастомного поля
  prisma?: string; // колонка Client (нет → relation CF или JS-фильтр)
  label: string;
  type: SegmentFieldType;
  category: string;
  options?: string[]; // для enum
  hint?: string; // подсказка в UI
  /** Поле — только ЦЕЛОЕ число (application_id, статусы, счётчики):
   *  валидация требует Number.isInteger — дробное значение молча совпадало
   *  с 0 клиентов (Prisma принимает float в Int-фильтре) и сегмент «пустел»
   *  без объяснений. */
  intOnly?: boolean;
  /** Только у кастомных полей: маппинг в EAV-таблицу ClientFieldValue.
   *  prisma отсутствует — SQL-фильтр по relation customFieldValues. */
  cf?: { key: string; type: 'text' | 'number' | 'date' | 'bool' };
}

/** Категории полей в порядке отображения UI (из единого реестра карточки). */
export const SEGMENT_CATEGORIES = CARD_FIELD_CATEGORIES;

/** Карточное поле реестра → поле сегментации: ключ совпадает с именем карточки,
 *  тип сужается к сегментным операторам (text→string, int/number→number,
 *  bool→boolean, date→date; person_birthday — override на 'birthday'). */
function toSegmentField(def: CanonicalCardFieldDef): SegmentFieldDef {
  const type: SegmentFieldType =
    def.segmentType === 'birthday'
      ? 'birthday'
      : def.type === 'text'
        ? 'string'
        : def.type === 'int' || def.type === 'number'
          ? 'number'
          : def.type === 'bool'
            ? 'boolean'
            : def.type === 'date'
              ? 'date'
              : 'enum'; // last_product_type
  return {
    key: def.fieldName,
    prisma: def.prisma,
    label: def.label,
    type,
    category: def.category,
    ...(def.type === 'int' ? { intOnly: true } : {}),
    ...(def.options ? { options: [...def.options] } : {}),
    ...(def.hint ? { hint: def.hint } : {}),
  };
}

/** Спец-поля сегментации вне карточки (см. шапку). */
const SEGMENT_EXTRA_FIELDS: SegmentFieldDef[] = [
  { key: 'sms_consent_status', prisma: 'smsConsentStatus', label: 'Согласие на рекламу', type: 'enum', options: ['NONE', 'PENDING', 'GRANTED', 'REVOKED'], category: 'Коммуникации' },
  { key: 'unsubscribed', label: 'Отписан (стоп-лист)', type: 'boolean', category: 'Коммуникации' },
];

// ---------- Кастомные поля (динамическая часть реестра) ----------

/** Категория кастомных полей в конструкторе сегментов (после категорий карточки). */
export const CF_CATEGORY = 'Кастомные';

/** CF-поле реестра custom-fields → сегментное поле: ключ = cf_<key>, тип сужается
 *  к сегментным операторам, cf-маппинг — для SQL-фильтра по relation. */
export function cfToSegmentField(def: { key: string; label: string; type: 'text' | 'number' | 'date' | 'bool' }): SegmentFieldDef {
  const type: SegmentFieldType =
    def.type === 'text' ? 'string' : def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'boolean';
  return {
    key: CF_KEY_PREFIX + def.key,
    label: def.label,
    type,
    category: CF_CATEGORY,
    cf: { key: def.key, type: def.type },
  };
}

/**
 * Исторический порядок полей в конструкторе сегментов — сохранён 1:1 при
 * переводе на реестр, чтобы UI не дёргался. Поля, не перечисленные здесь
 * (например, новые поля реестра), добавляются в КОНЕЦ своей категории в
 * порядке реестра — новая колонка ядра сразу доступна в сегментации.
 */
const SEGMENT_FIELD_ORDER: Record<CardFieldCategory, readonly string[]> = {
  'Профиль': ['client_last_name', 'client_first_name', 'client_middle_name', 'email', 'person_birthday', 'last_product_type'],
  'Заявка': ['application_id', 'application_actual_status', 'application_previous_status', 'ban_days'],
  'Договор': ['agreement_id', 'agreement_actual_status', 'agreement_previous_status', 'loan_amount', 'loan_period', 'agreements_for_lastyear', 'agreements_for_lifetime', 'loan_closed_date'],
  'Преапрув': ['person_offer_approve_money', 'person_offer_approve_days', 'person_offer_date_start', 'person_offer_date_expired', 'person_offer_available'],
  'Коммуникации': ['notification_active', 'sms_consent_status', 'unsubscribed', 'date_update'],
};

/**
 * Реестр полей сегментации: карточные поля из registry/card-fields + спец-поля.
 * prisma-поле → фильтр транслируется в SQL-запрос Prisma (services/segments);
 * поля без prisma (unsubscribed — стоп-лист) фильтруются в JS поверх выдачи.
 */
export const SEGMENT_FIELDS: SegmentFieldDef[] = (() => {
  const fields = [...CANONICAL_CARD_FIELDS.map(toSegmentField), ...SEGMENT_EXTRA_FIELDS];
  const result: SegmentFieldDef[] = [];
  for (const category of SEGMENT_CATEGORIES) {
    const remaining = fields.filter((f) => f.category === category);
    for (const key of SEGMENT_FIELD_ORDER[category]) {
      const idx = remaining.findIndex((f) => f.key === key);
      if (idx >= 0) result.push(...remaining.splice(idx, 1));
    }
    // не указанные в порядке — в конец категории (порядок реестра)
    result.push(...remaining);
  }
  return result;
})();

/** Тип значения оператора: что рисует UI (число/строка/список/да-нет/дни/дата/возраст). */
export type SegmentValueKind = 'number' | 'string' | 'enum' | 'enumMulti' | 'boolean' | 'days' | 'date' | 'years';

/** Описание оператора: op — код в БД, types — применимые типы полей, valueKind — контрол значения. */
export interface SegmentOpDef {
  op: string;
  label: string; // подпись для селекта/человекочитаемого вывода
  types: SegmentFieldType[];
  valueKind: SegmentValueKind;
}

/**
 * Реестр операторов по типам полей: числа (=/≠/</≤…), строки (равно/содержит),
 * enum (один из), булевы, окна «относительно сейчас» для дат (в ближайшие N
 * дней / за последние N / больше N назад / раньше-не раньше даты) и операторы
 * дня рождения (окно без года + возрастные сравнения).
 */
export const SEGMENT_OPERATORS: SegmentOpDef[] = [
  // Числа
  { op: 'eq', label: '=', types: ['number'], valueKind: 'number' },
  { op: 'neq', label: '≠', types: ['number'], valueKind: 'number' },
  { op: 'gt', label: '>', types: ['number'], valueKind: 'number' },
  { op: 'gte', label: '≥', types: ['number'], valueKind: 'number' },
  { op: 'lt', label: '<', types: ['number'], valueKind: 'number' },
  { op: 'lte', label: '≤', types: ['number'], valueKind: 'number' },
  // Строки
  { op: 'eq', label: 'равно', types: ['string'], valueKind: 'string' },
  { op: 'neq', label: 'не равно', types: ['string'], valueKind: 'string' },
  { op: 'contains', label: 'содержит', types: ['string'], valueKind: 'string' },
  // Перечисления
  { op: 'eq', label: '=', types: ['enum'], valueKind: 'enum' },
  { op: 'neq', label: '≠', types: ['enum'], valueKind: 'enum' },
  { op: 'in', label: 'один из', types: ['enum'], valueKind: 'enumMulti' },
  // Булевы
  { op: 'eq', label: '=', types: ['boolean'], valueKind: 'boolean' },
  // Абсолютные даты (окна относительно «сейчас»)
  { op: 'within_next_days', label: 'в ближайшие N дней', types: ['date'], valueKind: 'days' },
  { op: 'within_last_days', label: 'за последние N дней', types: ['date'], valueKind: 'days' },
  { op: 'older_than_days', label: 'больше N дней назад', types: ['date'], valueKind: 'days' },
  { op: 'before_date', label: 'раньше даты', types: ['date'], valueKind: 'date' },
  { op: 'after_date', label: 'не раньше даты', types: ['date'], valueKind: 'date' },
  // День рождения: месяц/день без года + возраст
  { op: 'birthday_within_next_days', label: 'в ближайшие N дней', types: ['birthday'], valueKind: 'days' },
  { op: 'age_gt', label: 'возраст больше, лет', types: ['birthday'], valueKind: 'years' },
  { op: 'age_gte', label: 'возраст не меньше, лет', types: ['birthday'], valueKind: 'years' },
  { op: 'age_lt', label: 'возраст меньше, лет', types: ['birthday'], valueKind: 'years' },
  { op: 'age_lte', label: 'возраст не больше, лет', types: ['birthday'], valueKind: 'years' },
];

/** Определение поля по ключу правила (undefined — ключ не из реестра).
 *  Статическая часть (карточка + спец-поля); для правил с кастомными полями
 *  используйте makeFieldLookup(cfFields) — динамический индекс. */
export function segmentField(key: string): SegmentFieldDef | undefined {
  return SEGMENT_FIELDS.find((f) => f.key === key);
}

/** Индекс полей сегментации: статический реестр + динамические CF-поля.
 *  Единый резолвер для сервера (services/segments — валидация/SQL/JS-оценка)
 *  и UI (конструктор правил); extra — CF-поля, см. cfToSegmentField. */
export type SegmentFieldLookup = (key: string) => SegmentFieldDef | undefined;

export function makeFieldLookup(extra: readonly SegmentFieldDef[] = []): SegmentFieldLookup {
  const map = new Map<string, SegmentFieldDef>();
  for (const f of [...SEGMENT_FIELDS, ...extra]) map.set(f.key, f);
  return (key: string) => map.get(key);
}

/** Операторы, применимые к типу поля — источник для селекта UI конструктора правил. */
export function operatorsForType(type: SegmentFieldType): SegmentOpDef[] {
  return SEGMENT_OPERATORS.filter((o) => o.types.includes(type));
}

/* ============ Человекочитаемое представление (UI) ============ */

const CONSENT_LABELS: Record<string, string> = {
  NONE: 'нет',
  PENDING: 'ожидает',
  GRANTED: 'дано',
  REVOKED: 'отозвано',
};

/** Значение → человекочитаемо: enum-статусы согласия — русские метки,
 * boolean — «да/нет»; прочее — как есть (строкой). */
export function segmentValueLabel(field: SegmentFieldDef, value: SegmentValue): string {
  switch (field.type) {
    case 'enum':
      if (Array.isArray(value)) {
        return value
          .map((v) => (field.key === 'sms_consent_status' ? CONSENT_LABELS[v] ?? v : v))
          .join(' / ');
      }
      return field.key === 'sms_consent_status' ? CONSENT_LABELS[String(value)] ?? String(value) : String(value);
    case 'boolean':
      return value === true ? 'да' : value === false ? 'нет' : String(value);
    case 'date':
      return String(value);
    default:
      return String(value);
  }
}

/** Правило → человекочитаемая строка: «Статус договора = 19». Поля — из
 *  статического реестра; для правил по кастомным полям передайте объединённый
 *  список (SEGMENT_FIELDS + CF) параметром fields. */
export function ruleToText(
  rule: { field: string; op: string; value: SegmentValue },
  fields: readonly SegmentFieldDef[] = SEGMENT_FIELDS,
): string {
  const field = fields.find((f) => f.key === rule.field);
  if (!field) return `${rule.field} ${rule.op} ${String(rule.value)}`;
  const opDef = SEGMENT_OPERATORS.find((o) => o.op === rule.op && o.types.includes(field.type));
  const valueText = segmentValueLabel(field, rule.value);
  switch (opDef?.op) {
    case 'within_next_days':
    case 'within_last_days':
    case 'older_than_days':
    case 'birthday_within_next_days':
      return `${field.label}: ${opDef.label.replace('N', valueText)}`;
    case 'before_date':
      return `${field.label} раньше ${valueText}`;
    case 'after_date':
      return `${field.label} не раньше ${valueText}`;
    case 'age_gt':
    case 'age_gte':
    case 'age_lt':
    case 'age_lte':
      return `${field.label}: ${opDef.label} ${valueText}`;
    case 'contains':
      return `${field.label} содержит «${valueText}»`;
    case 'in':
      return `${field.label} — ${valueText}`;
    default:
      return `${field.label} ${opDef?.label ?? rule.op} ${valueText}`;
  }
}
