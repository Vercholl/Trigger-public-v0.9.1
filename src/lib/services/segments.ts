// Сервис сегментов: CRUD + вычисление членства.
//
// Формат условий: {match:"all"|"any", rules:[{field, op, value}]} — поля под именами карточки
// либо cf_<key> кастомных полей профиля (custom-fields, динамический реестр).
// Вычисление многофазное:
//   1) стандартные правила (колонка Client) → Prisma where (AND при all / OR при any);
//   2) CF-правила (cf_*) → там же, EXISTS-подзапросом по relation customFieldValues
//      (типизированные колонки value* с индексами — SQL, не JS, на миллионах строк);
//   3) спец-правила (unsubscribed — стоп-лист; birthday — месяц/день без года
//      при НЕсинхронном календаре) → JS-фильтр. ДР-правила переведены в SQL
//      (Task 63): возраст — прямые сравнения birthday с датой-срезом,
//      «в ближайшие N дней» — через таблицу BirthdayCalendar (индекс monthDay);
//      при расхождении счётчиков календаря — JS-фолбэк + фоновая починка.
// При match=any со спец-правилами — полный проход по клиентам с JS-оценкой всех правил
// (иначе терялись бы клиенты, прошедшие только спец-правило); CF-значения порции
// подгружаются одним запросом (rawCfValuesForClients). Семантика null как в Prisma:
// пустые поля не совпадают ни с одним оператором (включая ≠).
// Домен: таргетинг массовых рассылок (Broadcast ссылается на сегмент по id).
// Вызывается из API-роутов: /api/v1/segments (GET/POST), /segments/{id}
// (PUT/DELETE), /segments/preview (POST), /segments/{id}/clients (GET),
// /segments/{id}/count (GET), /segments/{id}/freeze, /segments/{id}/unfreeze
// (POST); evaluateSegment/clientsOfStaticSegment — сервис broadcasts,
// invalidateSegmentCountCache — сервис clients (после импорта).
// Таблицы Prisma: Segment (conditions — JSON-строка), SegmentMember (срез
// фиксированных), Client, UnsubscribeList (стоп-лист для спец-правила),
// CustomField/ClientFieldValue (правила cf_*), Broadcast (count-гард удаления), AuditLog.
import { z } from 'zod';
import type { Prisma, Client, Segment } from '@prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';
import { serializeCardFields } from '@/lib/services/client-card';
import {
  birthdayCalendarInSync,
  birthdayMonthDayWindow,
  scheduleBirthdayRepair,
} from '@/lib/services/birthday-calendar';
import {
  cfToSegmentField,
  makeFieldLookup,
  SEGMENT_OPERATORS,
  type SegmentFieldDef,
  type SegmentFieldLookup,
} from '@/lib/segments/fields';
import { loadCustomFields, rawCfValuesForClients } from '@/lib/services/custom-fields';

type SegmentMode = 'dynamic' | 'static';

// ---------- Схемы ----------

/** Одно правило: поле из реестра segments/fields, оператор, значение
 *  (число/строка/булев/массив для оператора in). */
export const segmentRuleSchema = z.object({
  field: z.string().min(1),
  op: z.string().min(1),
  value: z.union([z.number(), z.string(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
});

/** Условия сегмента: режим сопоставления правил (all=И / any=ИЛИ) и
 *  непустой список правил. */
export const segmentConditionsSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  rules: z.array(segmentRuleSchema).min(1, 'Нужен хотя бы один критерий'),
});

/** Схема создания: имя ≤120, описание ≤500, условия. */
export const createSegmentSchema = z.object({
  name: z.string().trim().min(1, 'Название обязательно').max(120),
  description: z.string().trim().max(500).nullish(),
  conditions: segmentConditionsSchema,
});

/** Схема обновления — все поля опциональны (условия нельзя менять у static). */
export const updateSegmentSchema = createSegmentSchema.partial();

/** Схема предпросмотра: условия + размер выборки 1–50 (по умолчанию 20).
 *  Записи в БД не делает. */
export const previewSegmentSchema = z.object({
  conditions: segmentConditionsSchema,
  sampleSize: z.number().int().min(1).max(50).default(20),
});

export type SegmentConditions = z.infer<typeof segmentConditionsSchema>;
export type SegmentRule = z.infer<typeof segmentRuleSchema>;

/** Индекс полей сегментации со всеми зарегистрированными кастомными полями
 *  (включая деактивированные — сохранённые правила продолжают вычисляться).
 *  Реестр CF читается из кэша — дёшево на каждый вызов. */
async function fieldIndex(): Promise<SegmentFieldLookup> {
  const cfDefs = await loadCustomFields();
  return makeFieldLookup(cfDefs.map(cfToSegmentField));
}

/** Семантическая валидация правил по реестру (поле существует, оператор допустим,
 *  тип значения верный). CF-поля (cf_*) резолвятся через lookup — их список
 *  динамический, lives в БД. */
export function validateRules(conditions: SegmentConditions, lookup: SegmentFieldLookup): string[] {
  const errors: string[] = [];
  conditions.rules.forEach((rule, idx) => {
    const field = lookup(rule.field);
    const pos = `критерий ${idx + 1}`;
    if (!field) {
      errors.push(`${pos}: неизвестное поле «${rule.field}»`);
      return;
    }
    const opDef = SEGMENT_OPERATORS.find((o) => o.op === rule.op && o.types.includes(field.type));
    if (!opDef) {
      const allowed = SEGMENT_OPERATORS.filter((o) => o.types.includes(field.type)).map((o) => o.op);
      errors.push(`${pos}: оператор «${rule.op}» не применим к полю «${field.label}» (доступны: ${allowed.join(', ')})`);
      return;
    }
    const v = rule.value;
    switch (opDef.valueKind) {
      case 'number':
      case 'days':
      case 'years':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          errors.push(`${pos}: ${field.label} — ожидается неотрицательное число`);
        } else if (field.intOnly === true && !Number.isInteger(v)) {
          // Дробное значение в целочисленном поле (application_id, статусы):
          // Prisma молча принимает float в Int-фильтре — сегмент без ошибок
          // совпадал бы с 0 клиентов. Отклоняем с внятным текстом.
          errors.push(`${pos}: ${field.label} — ожидается ЦЕЛОЕ число (дробное не имеет смысла для этого поля)`);
        }
        break;
      case 'string':
        if (typeof v !== 'string' || v.trim() === '') {
          errors.push(`${pos}: ${field.label} — ожидается непустая строка`);
        }
        break;
      case 'enum':
        if (typeof v !== 'string' || !field.options?.includes(v)) {
          errors.push(`${pos}: ${field.label} — ожидается одно из: ${field.options?.join(' | ')}`);
        }
        break;
      case 'enumMulti':
        // Контракт допускает и скаляр ("PDL"), и список (["PDL","IL"]) — нормализуем
        if (
          (typeof v !== 'string' && !Array.isArray(v)) ||
          (typeof v === 'string' && v.trim() === '') ||
          (Array.isArray(v) && (v.length === 0 || !v.every((x) => typeof x === 'string' && field.options?.includes(x)))) ||
          (typeof v === 'string' && !field.options?.includes(v))
        ) {
          errors.push(`${pos}: ${field.label} — ожидается значение или непустой список из: ${field.options?.join(' | ')}`);
        }
        break;
      case 'boolean':
        if (typeof v !== 'boolean') {
          errors.push(`${pos}: ${field.label} — ожидается true/false`);
        }
        break;
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
          errors.push(`${pos}: ${field.label} — ожидается дата в формате ГГГГ-ММ-ДД`);
        }
        break;
    }
  });
  return errors;
}

// ---------- Prisma-часть (стандартные правила) ----------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Дата, в которую рождённый «исполняет N лет» сегодня (UTC-компоненты now) —
 *  срез для SQL-сравнений возраста; семантика = fullYears JS-пути (у обоих
 *  UTC-геттеры, 29.02 скатывается на 1 марта невисокосного среза). */
function yearsAgo(now: Date, years: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
}

/** Перевод правил в Prisma-where (стандартные правила; null — спец-правило,
 *  его оценит JS-часть). Датные операторы считаются от `now`.
 *  CF-правила (field.cf) — EXISTS-подзапрос по relation customFieldValues
 *  (поле CustomField.key + типизированная колонка значения; индексы
 *  (fieldId, value*) делают подзапрос дешёвым и на миллионах строк). */
function ruleToPrisma(rule: SegmentRule, now: Date, lookup: SegmentFieldLookup): Prisma.ClientWhereInput | null {
  const field = lookup(rule.field);
  if (!field) return null; // неизвестное поле → JS не оценит (false) — как раньше
  const v = rule.value;

  // Кастомное поле: {customFieldValues: {some: {field: {key}, value<Col>: cond}}}
  if (field.cf) {
    const cfWhere = (col: string, cond: unknown): Prisma.ClientWhereInput =>
      ({
        customFieldValues: { some: { field: { key: field.cf!.key }, [col]: cond } },
      }) as unknown as Prisma.ClientWhereInput;
    switch (field.cf.type) {
      case 'text':
        switch (rule.op) {
          case 'eq':
            return cfWhere('valueStr', String(v));
          case 'neq':
            return cfWhere('valueStr', { not: String(v) });
          case 'contains':
            return cfWhere('valueStr', { contains: String(v) });
          default:
            return null;
        }
      case 'number':
        switch (rule.op) {
          case 'eq':
            return cfWhere('valueNum', v as number);
          case 'neq':
            return cfWhere('valueNum', { not: v as number });
          case 'gt':
            return cfWhere('valueNum', { gt: v as number });
          case 'gte':
            return cfWhere('valueNum', { gte: v as number });
          case 'lt':
            return cfWhere('valueNum', { lt: v as number });
          case 'lte':
            return cfWhere('valueNum', { lte: v as number });
          default:
            return null;
        }
      case 'date':
        switch (rule.op) {
          case 'within_next_days':
            return cfWhere('valueDate', { gte: now, lte: new Date(now.getTime() + (v as number) * DAY_MS) });
          case 'within_last_days':
            return cfWhere('valueDate', { gte: new Date(now.getTime() - (v as number) * DAY_MS), lte: now });
          case 'older_than_days':
            return cfWhere('valueDate', { lt: new Date(now.getTime() - (v as number) * DAY_MS) });
          case 'before_date':
            return cfWhere('valueDate', { lt: new Date(`${String(v)}T00:00:00.000Z`) });
          case 'after_date':
            return cfWhere('valueDate', { gte: new Date(`${String(v)}T00:00:00.000Z`) });
          default:
            return null;
        }
      case 'bool':
        return rule.op === 'eq' ? cfWhere('valueBool', v === true) : null;
    }
  }

  if (!field.prisma) return null; // спец-правило → JS
  const col = field.prisma;
  // Значения уже прошли семантическую валидацию — приводим к типу Prisma целиком.
  switch (rule.op) {
    case 'eq':
      return { [col]: v } as unknown as Prisma.ClientWhereInput;
    case 'neq':
      // Prisma not: null-строки НЕ попадают (SQL <>) — семантика «пустое ≠ значение» = false
      return { [col]: { not: v } } as unknown as Prisma.ClientWhereInput;
    case 'gt':
      return { [col]: { gt: v as number } } as unknown as Prisma.ClientWhereInput;
    case 'gte':
      return { [col]: { gte: v as number } } as unknown as Prisma.ClientWhereInput;
    case 'lt':
      return { [col]: { lt: v as number } } as unknown as Prisma.ClientWhereInput;
    case 'lte':
      return { [col]: { lte: v as number } } as unknown as Prisma.ClientWhereInput;
    case 'contains':
      return { [col]: { contains: String(v) } } as unknown as Prisma.ClientWhereInput;
    case 'in':
      return { [col]: { in: Array.isArray(v) ? v : [v] } } as unknown as Prisma.ClientWhereInput;
    case 'within_next_days': {
      const n = v as number;
      return { [col]: { gte: now, lte: new Date(now.getTime() + n * DAY_MS) } } as unknown as Prisma.ClientWhereInput;
    }
    case 'within_last_days': {
      const n = v as number;
      return { [col]: { gte: new Date(now.getTime() - n * DAY_MS), lte: now } } as unknown as Prisma.ClientWhereInput;
    }
    case 'older_than_days':
      return { [col]: { lt: new Date(now.getTime() - (v as number) * DAY_MS) } } as unknown as Prisma.ClientWhereInput;
    case 'before_date':
      return { [col]: { lt: new Date(`${String(v)}T00:00:00.000Z`) } } as unknown as Prisma.ClientWhereInput;
    case 'after_date':
      return { [col]: { gte: new Date(`${String(v)}T00:00:00.000Z`) } } as unknown as Prisma.ClientWhereInput;
    // ---------- ДР-правила в SQL (Task 63) ----------
    // «ДР в ближайшие N дней»: окно monthDay [today, today+N] по календарю
    // (индекс BirthdayCalendar.monthDay); NULL-birthday исключён — строки
    // календаря нет. Семантика = JS birthday_within_next_days.
    case 'birthday_within_next_days':
      return {
        birthdayCalendar: { monthDay: { in: birthdayMonthDayWindow(now, v as number) } },
      } as unknown as Prisma.ClientWhereInput;
    // Возраст: birthday против среза yearsAgo (NULL не сравнивается — как JS).
    case 'age_gt':
      return { [col]: { lt: yearsAgo(now, v as number) } } as unknown as Prisma.ClientWhereInput;
    case 'age_gte':
      return { [col]: { lte: yearsAgo(now, v as number) } } as unknown as Prisma.ClientWhereInput;
    case 'age_lt':
      return { [col]: { gt: yearsAgo(now, v as number) } } as unknown as Prisma.ClientWhereInput;
    case 'age_lte':
      return { [col]: { gte: yearsAgo(now, v as number) } } as unknown as Prisma.ClientWhereInput;
    default:
      return null;
  }
}

/** Сборка where из списка правил: AND при match=all / OR при any;
 *  пустой список правил → пустой where (все клиенты). */
function buildPrismaWhere(rules: SegmentRule[], match: 'all' | 'any', now: Date, lookup: SegmentFieldLookup): Prisma.ClientWhereInput {
  const parts = rules
    .map((r) => ruleToPrisma(r, now, lookup))
    .filter((p): p is Prisma.ClientWhereInput => p !== null);
  if (parts.length === 0) return {};
  return match === 'all' ? { AND: parts } : { OR: parts };
}

// ---------- JS-часть (спец-правила + полный оценщик для match=any) ----------

/** Спец-правило — JS-оценка: без колонки И без CF-relation (unsubscribed —
 *  стоп-лист) либо тип birthday (месяц/день, возраст). CF-правила НЕ спец —
 *  они всегда уходят в SQL (relation); в JS-путь попадают только при полном
 *  проходе match=any (там значения подгружаются батчем — cfValues). */
function isSpecialRule(rule: SegmentRule, lookup: SegmentFieldLookup): boolean {
  const field = lookup(rule.field);
  // Без колонки (unsubscribed) или тип birthday (месяц/день, возраст) — JS-оценка:
  // SQL не умеет ни «день рождения в ближайшие N дней» без года, ни стоп-лист-объединение.
  return (!field?.prisma && !field?.cf) || field?.type === 'birthday';
}

/** ДР-правило, выражаемое в SQL (Task 63): возраст — прямые сравнения
 *  birthday с датой-срезом (календарь не нужен); «в ближайшие N дней» —
 *  только при синхронном BirthdayCalendar (иначе JS-фолбэк, как раньше). */
function isBirthdaySqlRule(rule: SegmentRule, lookup: SegmentFieldLookup, calendarOk: boolean): boolean {
  const field = lookup(rule.field);
  if (field?.type !== 'birthday') return false;
  if (rule.op === 'birthday_within_next_days') return calendarOk;
  return rule.op === 'age_gt' || rule.op === 'age_gte' || rule.op === 'age_lt' || rule.op === 'age_lte';
}

/** Классификация правил с учётом SQL-возможности ДР: спец-правила — в JS
 *  (стоп-лист; ДР-окно при рассинхроне), остальные — в SQL (ДР-возраст —
 *  всегда). При рассинхроне календаря — фоновая починка (scheduleBirthdayRepair);
 *  вычисление до её завершения идёт JS-фолбэком, как до Task 63. */
async function classifyRules(rules: readonly SegmentRule[], lookup: SegmentFieldLookup) {
  const needCalendar = rules.some((r) => {
    const f = lookup(r.field);
    return f?.type === 'birthday' && r.op === 'birthday_within_next_days';
  });
  const calendarOk = needCalendar ? await birthdayCalendarInSync() : true;
  if (needCalendar && !calendarOk) scheduleBirthdayRepair();
  const goesSql = (r: SegmentRule) =>
    !isSpecialRule(r, lookup) || isBirthdaySqlRule(r, lookup, calendarOk);
  return {
    specialRules: rules.filter((r) => !goesSql(r)),
    standardRules: rules.filter(goesSql),
  };
}

/** Значение поля строки клиента для JS-оценки: колонка Client, стоп-лист или
 *  CF-значение клиента (cfValues — подгруженный батч, ключи cf_<key>). */
function clientFieldValue(
  client: Client,
  key: string,
  lookup: SegmentFieldLookup,
  cfValues?: Record<string, unknown>,
): unknown {
  switch (key) {
    case 'unsubscribed':
      return client.unsubscribedAt !== null; // стоп-лист добирается отдельно
    default: {
      const field = lookup(key);
      if (field?.cf) return cfValues?.[key];
      if (!field?.prisma) return undefined;
      return (client as unknown as Record<string, unknown>)[field.prisma];
    }
  }
}

/** Ближайший следующий день рождения (год заменяется на текущий/следующий) —
 *  для оператора birthday_within_next_days без учёта года рождения.
 *  ДР хранится UTC-полночью (SQLite), поэтому месяц/день берём UTC-геттерами —
 *  так же, как движок пауз until_birthday (engine/executors.ts): при TZ
 *  процесса ≠ UTC локальные геттеры сдвигали бы дату ДР на сутки (баг v0.8.8). */
function nextBirthdayOccurrence(birthday: Date, now: Date): Date {
  const y = now.getUTCFullYear();
  let occ = new Date(Date.UTC(y, birthday.getUTCMonth(), birthday.getUTCDate()));
  const today = new Date(Date.UTC(y, now.getUTCMonth(), now.getUTCDate()));
  if (occ.getTime() < today.getTime()) {
    occ = new Date(Date.UTC(y + 1, birthday.getUTCMonth(), birthday.getUTCDate()));
  }
  return occ;
}

/** Полных лет на дату `now` (день рождения в этом году ещё не наступил → -1).
 *  UTC-геттеры — по той же причине, что в nextBirthdayOccurrence. */
function fullYears(birthday: Date, now: Date): number {
  let age = now.getUTCFullYear() - birthday.getUTCFullYear();
  const hadBirthday =
    now.getUTCMonth() > birthday.getUTCMonth() ||
    (now.getUTCMonth() === birthday.getUTCMonth() && now.getUTCDate() >= birthday.getUTCDate());
  if (!hadBirthday) age -= 1;
  return age;
}

/** JS-оценка одного правила по строке клиента (спец-правила и режим any). Синхронна —
 *  используется в Array.filter: async-функция вернула бы Promise (всегда truthy)!
 *  cfValues — значения кастомных полей ЭТОГО клиента (ключи cf_<key>, даты —
 *  Date), подгруженные батчем ДО вызова (rawCfValuesForClients). */
function jsCheckRule(
  rule: SegmentRule,
  client: Client,
  stopPhones: Set<string>,
  now: Date,
  lookup: SegmentFieldLookup,
  cfValues?: Record<string, unknown>,
): boolean {
  const field = lookup(rule.field);
  if (!field) return false;
  const v = rule.value;

  if (field.key === 'unsubscribed') {
    const unsubscribed = client.unsubscribedAt !== null || stopPhones.has(client.phone);
    return rule.op === 'eq' ? unsubscribed === (v === true) : false;
  }

  if (field.type === 'birthday') {
    if (!client.birthday) return false; // null никогда не совпадает
    switch (rule.op) {
      case 'birthday_within_next_days': {
        const occ = nextBirthdayOccurrence(client.birthday, now);
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const diffDays = Math.round((occ.getTime() - today.getTime()) / DAY_MS);
        return diffDays >= 0 && diffDays <= (v as number);
      }
      case 'age_gt':
        return fullYears(client.birthday, now) > (v as number);
      case 'age_gte':
        return fullYears(client.birthday, now) >= (v as number);
      case 'age_lt':
        return fullYears(client.birthday, now) < (v as number);
      case 'age_lte':
        return fullYears(client.birthday, now) <= (v as number);
      default:
        return false;
    }
  }

  // Общие операторы (режим any — JS-оценка и стандартных правил; семантика как в Prisma)
  const val = clientFieldValue(client, field.key, lookup, cfValues);
  switch (rule.op) {
    case 'eq':
      return val !== null && val !== undefined && val === v;
    case 'neq':
      return val !== null && val !== undefined && val !== v;
    case 'gt':
      return typeof val === 'number' && typeof v === 'number' && val > v;
    case 'gte':
      return typeof val === 'number' && typeof v === 'number' && val >= v;
    case 'lt':
      return typeof val === 'number' && typeof v === 'number' && val < v;
    case 'lte':
      return typeof val === 'number' && typeof v === 'number' && val <= v;
    case 'contains':
      return typeof val === 'string' && typeof v === 'string' && val.includes(v);
    case 'in':
      return typeof val === 'string' && (Array.isArray(v) ? (v as string[]) : [String(v)]).includes(val);
    case 'within_next_days':
    case 'within_last_days':
    case 'older_than_days':
    case 'before_date':
    case 'after_date': {
      if (!(val instanceof Date)) return false;
      const t = val.getTime();
      switch (rule.op) {
        case 'within_next_days':
          return t >= now.getTime() && t <= now.getTime() + (v as number) * DAY_MS;
        case 'within_last_days':
          return t >= now.getTime() - (v as number) * DAY_MS && t <= now.getTime();
        case 'older_than_days':
          return t < now.getTime() - (v as number) * DAY_MS;
        case 'before_date':
          return t < Date.parse(`${String(v)}T00:00:00.000Z`);
        case 'after_date':
          return t >= Date.parse(`${String(v)}T00:00:00.000Z`);
      }
      return false;
    }
    default:
      return false;
  }
}

// ---------- Вычисление сегмента ----------

/** CF-ключи (без префикса) из списка правил — для подгрузки значений перед
 *  JS-оценкой (полный проход match=any оценивает в JS и CF-правила). */
function cfKeysOfRules(rules: readonly SegmentRule[], lookup: SegmentFieldLookup): string[] {
  const keys = new Set<string>();
  for (const r of rules) {
    const field = lookup(r.field);
    if (field?.cf) keys.add(field.cf.key);
  }
  return [...keys];
}

/** Результат вычисления: клиенты и их число. */
export interface SegmentEvaluation {
  clients: Client[];
  total: number;
}

/** Вычислить множество клиентов сегмента ЦЕЛИКОМ (без пагинации, в памяти).
 * Полные строки (вкл. data/timezone) — для рассылок: там нужны карточка и пояс.
 * Для просмотра/подсчёта используйте scanSegment (не читает тяжёлый JSON data).
 * ВНИМАНИЕ: на базах в миллионах строк материализует миллионы полных строк
 * (гигабайты RAM) — для запуска рассылок используйте потоковый аналог
 * iterateSegmentClients (порции в порядке externalId, память ограничена). */
export async function evaluateSegment(conditions: SegmentConditions): Promise<SegmentEvaluation> {
  const clients: Client[] = [];
  for await (const chunk of iterateSegmentClients(conditions)) {
    clients.push(...chunk);
  }
  return { clients, total: clients.length };
}

/** Порция потоковой итерации клиентов сегмента (строк за один запрос к БД). */
export const SEGMENT_ITERATE_CHUNK = 1000;

/**
 * Потоковая итерация клиентов сегмента ПОРЦИЯМИ в порядке externalId ASC.
 * Замена материализации «всё в память» (evaluateSegment) для боевых объёмов:
 * стандартные правила — в SQL-WHERE, спец-правила (ДР/стоп-лист) — JS-оценка
 * строк порции; курсор по уникальному externalId — стабильный (не смещается
 * вставками/удалениями во время итерации), порядок детерминирован — основа
 * честного порционного лимита рассылок (первые N по externalId).
 * Полные строки (вкл. data/timezone) — созданию сообщений нужны карточка и пояс.
 */
export async function* iterateSegmentClients(
  conditions: SegmentConditions,
): AsyncGenerator<Client[], void, void> {
  const now = new Date();
  const { match, rules } = conditions;
  const lookup = await fieldIndex();
  const { specialRules, standardRules } = await classifyRules(rules, lookup);
  const hasSpecial = specialRules.length > 0;

  // SQL-часть: match=all — стандартные правила (CF — EXISTS-подзапросами);
  // any + спец-правила — полный проход (иначе потеряем клиентов, подходящих
  // только по спец-правилу)
  const where: Prisma.ClientWhereInput =
    match === 'all'
      ? buildPrismaWhere(standardRules, 'all', now, lookup)
      : hasSpecial
        ? {}
        : buildPrismaWhere(standardRules, 'any', now, lookup);
  const stopPhones = hasSpecial
    ? new Set((await db.unsubscribeList.findMany({ select: { phone: true } })).map((r) => r.phone))
    : new Set<string>();
  // CF-значения нужны в JS только при полном проходе match=any (rules.some
  // оценивает и CF-правила); при match=all CF уже отфильтрованы SQL-частью.
  const jsCfKeys = hasSpecial && match === 'any' ? cfKeysOfRules(rules, lookup) : [];

  let cursorExternalId: string | null = null;
  for (;;) {
    const batch = await db.client.findMany({
      where,
      orderBy: { externalId: 'asc' },
      ...(cursorExternalId !== null ? { cursor: { externalId: cursorExternalId }, skip: 1 } : {}),
      take: SEGMENT_ITERATE_CHUNK,
    });
    if (batch.length === 0) return;
    cursorExternalId = batch[batch.length - 1].externalId;

    if (!hasSpecial) {
      yield batch;
    } else {
      // Спец-правила — JS-поверх SQL-выборки (семантика как у evaluateSegment);
      // при match=any CF-значения батча подгружаются одним запросом (IN + поля)
      const cfByClient =
        jsCfKeys.length > 0
          ? await rawCfValuesForClients(
              batch.map((c) => c.id),
              jsCfKeys,
            )
          : new Map<string, Record<string, unknown>>();
      yield batch.filter((c) =>
        match === 'all'
          ? specialRules.every((r) => jsCheckRule(r, c, stopPhones, now, lookup))
          : rules.some((r) => jsCheckRule(r, c, stopPhones, now, lookup, cfByClient.get(c.id))),
      );
    }
    if (batch.length < SEGMENT_ITERATE_CHUNK) return; // сегмент исчерпан
  }
}

// ---------- Масштабируемое вычисление (просмотр/подсчёт) ----------
//
// Просмотр «кто подходит» и подсчёт обязаны работать на базах в миллионы строк:
// evaluateSegment тут непригоден (материализует ВСЕ полные строки в памяти).
// scanSegment читает только скалярные колонки карточки (без тяжёлого JSON data):
//   • только стандартные правила — счёт и страница целиком в SQL (COUNT + LIMIT/OFFSET);
//   • есть спец-правила (ДР/стоп-лист) — курсорное сканирование порциями по id,
//     память ограничена порцией; страница собирается на лету, счёт — по ходу.

/** Скалярные колонки, достаточные для JS-оценки правил и сериализации превью. */
const SEGMENT_SCAN_SELECT = {
  id: true,
  externalId: true,
  phone: true,
  unsubscribedAt: true,
  smsConsentStatus: true,
  firstName: true,
  lastName: true,
  middleName: true,
  email: true,
  applicationId: true,
  applicationStatus: true,
  applicationPrevStatus: true,
  agreementId: true,
  agreementStatus: true,
  agreementPrevStatus: true,
  loanAmount: true,
  loanPeriod: true,
  loanClosedAt: true,
  notificationActive: true,
  offerDateStart: true,
  offerDateExpired: true,
  offerApproveMoney: true,
  offerApproveDays: true,
  offerAvailable: true,
  birthday: true,
  lastProductType: true,
  agreementsLastYear: true,
  agreementsLifetime: true,
  banDays: true,
  profileUpdatedAt: true,
} satisfies Prisma.ClientSelect;

type SegmentScanRow = Prisma.ClientGetPayload<{ select: typeof SEGMENT_SCAN_SELECT }>;

/** Порция курсорного сканирования (строк за один запрос к БД). */
const SEGMENT_SCAN_BATCH = 5000;

/** Результат масштабируемого вычисления: точный total + страница превью. */
export interface SegmentScan {
  total: number;
  page: SegmentScanRow[];
}

/**
 * Посчитать подходящих клиентов и/или собрать страницу превью.
 *   • needPage=false, needCount=true  — только точный счёт;
 *   • needPage=true,  needCount=false — страница; сканирование останавливается,
 *     как только окно [skip, skip+take) набрано (total вернётся неточным —
 *     берите его из кэша счёта).
 */
async function scanSegment(
  conditions: SegmentConditions,
  opts: { skip: number; take: number; needPage: boolean; needCount: boolean },
): Promise<SegmentScan> {
  const now = new Date();
  const { match, rules } = conditions;
  const lookup = await fieldIndex();
  const { specialRules, standardRules } = await classifyRules(rules, lookup);
  const hasSpecial = specialRules.length > 0;

  // Быстрый путь: только стандартные правила (CF — EXISTS-подзапросами) —
  // счёт и страница целиком в SQL
  if (!hasSpecial) {
    const where = buildPrismaWhere(standardRules, match, now, lookup);
    const total = opts.needCount ? await db.client.count({ where }) : 0;
    const page = opts.needPage
      ? ((await db.client.findMany({
          where,
          orderBy: { externalId: 'asc' },
          skip: opts.skip,
          take: opts.take,
          select: SEGMENT_SCAN_SELECT,
        })) as SegmentScanRow[])
      : [];
    return { total, page };
  }

  // Спец-правила: курсорное сканирование порциями, JS-оценка каждой строки;
  // при match=any CF-значения порции подгружаются одним запросом (IN + поля)
  const stopPhones = new Set(
    (await db.unsubscribeList.findMany({ select: { phone: true } })).map((r) => r.phone),
  );
  const where = match === 'all' ? buildPrismaWhere(standardRules, 'all', now, lookup) : {};
  const jsCfKeys = match === 'any' ? cfKeysOfRules(rules, lookup) : [];

  let cursorId: string | null = null;
  let total = 0;
  const page: SegmentScanRow[] = [];
  for (;;) {
    const batch = (await db.client.findMany({
      where,
      orderBy: { id: 'asc' },
      ...(cursorId !== null ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take: SEGMENT_SCAN_BATCH,
      select: SEGMENT_SCAN_SELECT,
    })) as SegmentScanRow[];
    if (batch.length === 0) break;
    cursorId = batch[batch.length - 1].id;

    const cfByClient =
      jsCfKeys.length > 0
        ? await rawCfValuesForClients(
            batch.map((r) => r.id),
            jsCfKeys,
          )
        : new Map<string, Record<string, unknown>>();
    for (const row of batch) {
      const client = row as unknown as Client;
      const ok =
        match === 'all'
          ? specialRules.every((r) => jsCheckRule(r, client, stopPhones, now, lookup))
          : rules.some((r) => jsCheckRule(r, client, stopPhones, now, lookup, cfByClient.get(client.id)));
      if (!ok) continue;
      if (opts.needPage && total >= opts.skip && page.length < opts.take) page.push(row);
      total += 1;
    }

    if (batch.length < SEGMENT_SCAN_BATCH) break;
    // Счёт не нужен и страница набрана — дальше сканировать незачем
    if (!opts.needCount && opts.needPage && page.length >= opts.take) break;
  }
  return { total, page };
}

/** Сериализация строки сканирования (имена карточки, как у клиентов; без тяжёлого data). */
function serializeSegmentRow(row: SegmentScanRow): Record<string, unknown> {
  return {
    id: row.id,
    externalId: row.externalId,
    client_id: row.externalId,
    phone: row.phone,
    ...serializeCardFields(row as unknown as Client),
    smsConsentStatus: row.smsConsentStatus,
    unsubscribedAt: row.unsubscribedAt,
  };
}

// ---------- Кэш счёта ----------
//
// Точный счёт на миллионах строк — самое дорогое (для спец-правил — полный
// проход). Кэшируем на 5 минут (только динамические сегменты); правка/удаление
// сегмента и фиксация/снятие фиксации инвалидируют запись. Импорт клиентов
// меняет состав — TTL 5 минут сглаживает. Фиксированные сегменты не кэшируются:
// COUNT(SegmentMember) по индексу моментальный.

const COUNT_CACHE_TTL_MS = 5 * 60 * 1000;
const segmentCountCache = new Map<string, { total: number; computedAt: Date; expiresAt: number }>();

/** Ручная инвалидация кэша счёта (правка/удаление сегмента, фиксация);
 *  без id — сброс всего кэша. */
export function invalidateSegmentCountCache(segmentId?: string): void {
  if (segmentId) segmentCountCache.delete(segmentId);
  else segmentCountCache.clear();
}

function cachedCount(segmentId: string): number | null {
  const hit = segmentCountCache.get(segmentId);
  return hit && hit.expiresAt > Date.now() ? hit.total : null;
}

function cachedComputedAt(segmentId: string): Date | null {
  const hit = segmentCountCache.get(segmentId);
  return hit && hit.expiresAt > Date.now() ? hit.computedAt : null;
}

function rememberCount(segmentId: string, total: number): Date {
  const computedAt = new Date();
  segmentCountCache.set(segmentId, { total, computedAt, expiresAt: Date.now() + COUNT_CACHE_TTL_MS });
  return computedAt;
}

// ---------- Preview ----------

/** Результат предпросмотра: точный total + компактная выборка клиентов. */
export interface SegmentPreviewResult {
  total: number;
  sample: Array<Record<string, unknown>>;
}

/** Предпросмотр условий (конструктор сегментов): валидация правил + счёт +
 *  sample-выборка через scanSegment. Чтение — без побочных эффектов. */
export async function previewSegment(dto: z.infer<typeof previewSegmentSchema>): Promise<SegmentPreviewResult> {
  const errors = validateRules(dto.conditions, await fieldIndex());
  if (errors.length > 0) {
    throw new ApiError(422, 'Ошибка валидации условий', errors.join('; '));
  }
  // Масштабируемо: счёт + первая порция без материализации всей базы (scanSegment)
  const { total, page } = await scanSegment(dto.conditions, {
    skip: 0,
    take: dto.sampleSize,
    needPage: true,
    needCount: true,
  });
  const sample = page.map((c) => ({
    id: c.id,
    externalId: c.externalId,
    fullName: [c.lastName, c.firstName, c.middleName].filter(Boolean).join(' ') || c.externalId,
    phone: c.phone,
    agreementStatus: c.agreementStatus,
    lastProductType: c.lastProductType,
    smsConsentStatus: c.smsConsentStatus,
    notificationActive: c.notificationActive,
    birthday: c.birthday,
    offerApproveMoney: c.offerApproveMoney,
    offerDateExpired: c.offerDateExpired,
  }));
  return { total, sample };
}

// ---------- Сериализация ----------

/** Строка Segment → JSON API: conditions парсится из JSON-строки (битая →
 *  пустые условия, выдачу не роняет). */
export function serializeSegment(row: Segment): Record<string, unknown> {
  let conditions: unknown;
  try {
    conditions = JSON.parse(row.conditions);
  } catch {
    conditions = { match: 'all', rules: [] };
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    conditions,
    mode: row.mode,
    frozenCount: row.frozenCount,
    frozenAt: row.frozenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------- CRUD ----------

/** Список всех сегментов (без пагинации — их единицы). Чтение. */
export async function listSegments(): Promise<{ items: unknown[]; total: number }> {
  const rows = await db.segment.findMany({ orderBy: { createdAt: 'asc' } });
  return { items: rows.map(serializeSegment), total: rows.length };
}

/** Сегмент по id; 404 через ApiError, если не найден. */
async function getSegmentRow(id: string): Promise<Segment> {
  const row = await db.segment.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Сегмент не найден');
  return row;
}

/** Создание сегмента (динамический): семантическая валидация правил (422 при
 *  ошибках). Побочные эффекты: запись Segment, audit-лог CREATE. */
export async function createSegment(
  dto: z.infer<typeof createSegmentSchema>,
  user: SessionUser,
  ip: string,
): Promise<Segment> {
  const errors = validateRules(dto.conditions, await fieldIndex());
  if (errors.length > 0) {
    throw new ApiError(422, 'Ошибка валидации условий', errors.join('; '));
  }
  const row = await db.segment.create({
    data: {
      name: dto.name,
      description: dto.description ?? null,
      conditions: JSON.stringify(dto.conditions),
    },
  });
  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.SEGMENT,
    entityId: row.id,
    details: { segment: row.name, rules: dto.conditions.rules.length },
    ip,
  });
  return row;
}

/** Обновление: имя/описание всегда; условия — только у динамического
 *  (409 «Сегмент зафиксирован» для static) и с повторной валидацией.
 *  Побочные эффекты: запись Segment, инвалидация кэша счёта, audit-лог UPDATE. */
export async function updateSegment(
  id: string,
  dto: z.infer<typeof updateSegmentSchema>,
  user: SessionUser,
  ip: string,
): Promise<Segment> {
  const existing = await getSegmentRow(id);
  // Фиксированный срез и критерии не должны расходиться: пока состав «заморожен»,
  // правка условий запрещена (название/описание менять можно).
  if (existing.mode === 'static' && dto.conditions !== undefined) {
    throw new ApiError(
      409,
      'Сегмент зафиксирован',
      'Состав заморожен срезом. Снимите фиксацию, затем правьте критерии и зафиксируйте заново',
    );
  }
  let conditionsJson: string | undefined;
  if (dto.conditions !== undefined) {
    const errors = validateRules(dto.conditions, await fieldIndex());
    if (errors.length > 0) {
      throw new ApiError(422, 'Ошибка валидации условий', errors.join('; '));
    }
    conditionsJson = JSON.stringify(dto.conditions);
  }
  const row = await db.segment.update({
    where: { id },
    data: {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
      ...(conditionsJson !== undefined ? { conditions: conditionsJson } : {}),
    },
  });
  invalidateSegmentCountCache(id); // состав меняется только вместе с условиями
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.SEGMENT,
    entityId: row.id,
    details: { segment: row.name },
    ip,
  });
  return row;
}

/** Удаление — запрещено (409), пока на сегмент ссылается ACTIVE/PAUSED-рассылка
 *  (FK в БД нет; DONE/CANCELLED не блокируют — см. комментарий внутри).
 *  Побочные эффекты: физическое удаление Segment, инвалидация кэша, audit-лог DELETE. */
export async function deleteSegment(id: string, user: SessionUser, ip: string): Promise<void> {
  await getSegmentRow(id);
  // Рассылки ссылаются на сегмент без FK в БД: удаление «из-под» живой рассылки
  // ломало бы каждый её следующий запуск (422 «Сегмент не найден» — для
  // еженедельной RECURRING это FAILED-запуски навсегда). Блокируем, пока на
  // сегмент ссылается ACTIVE/PAUSED-рассылка; DONE/CANCELLED не блокируют.
  const refs = await db.broadcast.count({
    where: { segmentId: id, status: { in: ['ACTIVE', 'PAUSED'] } },
  });
  if (refs > 0) {
    throw new ApiError(
      409,
      'Сегмент используется рассылками',
      `На сегмент ссылается активных/приостановленных рассылок: ${refs} — удалите их или смените сегмент в них`,
    );
  }
  await db.segment.delete({ where: { id } });
  invalidateSegmentCountCache(id);
  await logAudit({
    user,
    action: AuditAction.DELETE,
    entityType: AuditEntity.SEGMENT,
    entityId: id,
    ip,
  });
}

// ---------- Фиксация состава (static-срез) ----------

/** Итератор ID клиентов, подходящих под условия — порциями, без материализации
 * всей базы в памяти (быстрый путь — SQL по id-курсору; спец-правила — курсорные
 * порции с JS-оценкой, как в scanSegment). */
async function* iterateSegmentClientIds(
  conditions: SegmentConditions,
): AsyncGenerator<string> {
  const now = new Date();
  const { match, rules } = conditions;
  const lookup = await fieldIndex();
  const { specialRules, standardRules } = await classifyRules(rules, lookup);
  const hasSpecial = specialRules.length > 0;

  if (!hasSpecial) {
    // Быстрый путь: только скалярные критерии (CF — EXISTS) — id-курсором в SQL
    const where = buildPrismaWhere(standardRules, match, now, lookup);
    let cursorId: string | null = null;
    for (;;) {
      const batch = await db.client.findMany({
        where,
        orderBy: { id: 'asc' },
        ...(cursorId !== null ? { cursor: { id: cursorId }, skip: 1 } : {}),
        take: SEGMENT_SCAN_BATCH,
        select: { id: true },
      });
      if (batch.length === 0) break;
      cursorId = batch[batch.length - 1].id;
      for (const row of batch) yield row.id;
      if (batch.length < SEGMENT_SCAN_BATCH) break;
    }
    return;
  }

  // Спец-правила: порции полных скалярных строк + JS-оценка (как scanSegment);
  // при match=any CF-значения порции подгружаются одним запросом (IN + поля)
  const stopPhones = new Set(
    (await db.unsubscribeList.findMany({ select: { phone: true } })).map((r) => r.phone),
  );
  const where = match === 'all' ? buildPrismaWhere(standardRules, 'all', now, lookup) : {};
  const jsCfKeys = match === 'any' ? cfKeysOfRules(rules, lookup) : [];
  let cursorId: string | null = null;
  for (;;) {
    const batch = (await db.client.findMany({
      where,
      orderBy: { id: 'asc' },
      ...(cursorId !== null ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take: SEGMENT_SCAN_BATCH,
      select: SEGMENT_SCAN_SELECT,
    })) as SegmentScanRow[];
    if (batch.length === 0) break;
    cursorId = batch[batch.length - 1].id;
    const cfByClient =
      jsCfKeys.length > 0
        ? await rawCfValuesForClients(
            batch.map((r) => r.id),
            jsCfKeys,
          )
        : new Map<string, Record<string, unknown>>();
    for (const row of batch) {
      const client = row as unknown as Client;
      const ok =
        match === 'all'
          ? specialRules.every((r) => jsCheckRule(r, client, stopPhones, now, lookup))
          : rules.some((r) => jsCheckRule(r, client, stopPhones, now, lookup, cfByClient.get(client.id)));
      if (ok) yield row.id;
    }
    if (batch.length < SEGMENT_SCAN_BATCH) break;
  }
}

/** Порция вставки членов среза (createMany). */
const FREEZE_INSERT_BATCH = 5000;

/** «Обновить срез» — тот же эндпоинт/функция: пересня́ть текущий состав. */
export async function freezeSegment(
  id: string,
  user: SessionUser,
  ip: string,
): Promise<Segment> {
  const row = await getSegmentRow(id);
  const conditions = parseSegmentConditions(row);
  const errors = validateRules(conditions, await fieldIndex());
  if (errors.length > 0) {
    throw new ApiError(422, 'У сегмента некорректные условия', errors.join('; '));
  }

  // ПЕРЕСЪЁМКА — безопасный порядок: сегмент переводится в dynamic ДО
  // deleteMany среза. При пересъёмке (сегмент уже static) старый порядок
  // «удалить всё → сканировать минуты → вставить → пометить static» оставлял
  // при крахе на середине УСЕЧЁННЫЙ срез (5 тыс. из 40 тыс.) под статическим
  // режимом: UI показывал 40 тыс., а рассылка/масс-обновление молча шли по
  // 5 тыс. Теперь крах в середине оставляет честный ДИНАМИЧЕСКИЙ сегмент
  // (условия вычисляются на лету, срез не используется) — данные не теряются.
  // Для первой фиксации (dynamic→static) поведение идентично прежнему.
  const wasStatic = row.mode === 'static';
  if (wasStatic) {
    await db.segment.update({
      where: { id },
      data: { mode: 'dynamic', frozenCount: null, frozenAt: null },
    });
  }

  // Старый срез убираем ДО сканирования — insert-ы ниже не встретят
  // конфликтов уникальности (segmentId, clientId).
  await db.segmentMember.deleteMany({ where: { segmentId: id } });

  let total = 0;
  let pending: { segmentId: string; clientId: string }[] = [];
  for await (const clientId of iterateSegmentClientIds(conditions)) {
    pending.push({ segmentId: id, clientId });
    total += 1;
    if (pending.length >= FREEZE_INSERT_BATCH) {
      await db.segmentMember.createMany({ data: pending });
      pending = [];
    }
  }
  if (pending.length > 0) await db.segmentMember.createMany({ data: pending });

  // Режим переключается ПОСЛЕ полной записи среза — сбой на середине оставит
  // сегмент динамическим (срез не используется), а не «полустатическим».
  const updated = await db.segment.update({
    where: { id },
    data: { mode: 'static', frozenCount: total, frozenAt: new Date() },
  });
  invalidateSegmentCountCache(id);
  await logAudit({
    user,
    action: AuditAction.FREEZE,
    entityType: AuditEntity.SEGMENT,
    entityId: id,
    details: { segment: row.name, members: total, refreeze: row.mode === 'static' },
    ip,
  });
  return updated;
}

/** Снятие фиксации: срез SegmentMember удаляется, сегмент снова динамический.
 *  Побочные эффекты: удаление SegmentMember, запись Segment, инвалидация кэша,
 *  audit-лог UNFREEZE. */
export async function unfreezeSegment(
  id: string,
  user: SessionUser,
  ip: string,
): Promise<Segment> {
  const row = await getSegmentRow(id);
  if (row.mode !== 'static') {
    throw new ApiError(409, 'Сегмент не зафиксирован', 'Фиксацию можно снять только у фиксированного сегмента');
  }
  await db.segmentMember.deleteMany({ where: { segmentId: id } });
  const updated = await db.segment.update({
    where: { id },
    data: { mode: 'dynamic', frozenCount: null, frozenAt: null },
  });
  invalidateSegmentCountCache(id);
  await logAudit({
    user,
    action: AuditAction.UNFREEZE,
    entityType: AuditEntity.SEGMENT,
    entityId: id,
    details: { segment: row.name, frozenMembers: row.frozenCount },
    ip,
  });
  return updated;
}

// ---------- Клиенты сегмента (пагинированный предпросмотр + счёт) ----------

/** Условия сегмента из строки БД (валидируя формат). */
function parseSegmentConditions(row: Segment): SegmentConditions {
  try {
    return segmentConditionsSchema.parse(JSON.parse(row.conditions));
  } catch {
    throw new ApiError(422, 'У сегмента некорректные условия', 'Пересоздайте сегмент в конструкторе');
  }
}

/**
 * Клиенты сегмента: точный total + страница превью.
 * Динамический — вычисление по условиям (не материализует базу целиком);
 * фиксированный — страницы из среза SegmentMember (COUNT по индексу моментальный).
 */
export async function listSegmentClients(
  id: string,
  page: number,
  pageSize: number,
): Promise<{ items: unknown[]; total: number }> {
  const row = await getSegmentRow(id);

  if (row.mode === 'static') {
    const total = await db.segmentMember.count({ where: { segmentId: id } });
    const members = await db.segmentMember.findMany({
      where: { segmentId: id },
      // Уникальный индекс (segmentId, clientId) делает порядок и пагинацию дешёвыми
      orderBy: { clientId: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { client: { select: SEGMENT_SCAN_SELECT } },
    });
    return { items: members.map((m) => serializeSegmentRow(m.client as SegmentScanRow)), total };
  }

  const conditions = parseSegmentConditions(row);
  const errors = validateRules(conditions, await fieldIndex());
  if (errors.length > 0) {
    throw new ApiError(422, 'У сегмента некорректные условия', errors.join('; '));
  }
  const known = cachedCount(id);
  const { total, page: rows } = await scanSegment(conditions, {
    skip: (page - 1) * pageSize,
    take: pageSize,
    needPage: true,
    // счёт уже в кэше — сканируем ровно до заполнения страницы
    needCount: known === null,
  });
  const finalTotal = known !== null ? known : total;
  // Запоминаем ТОЛЬКО свежепосчитанный счёт: продление TTL при каждом попадании
  // в кэш превращало его в «скользящее окно» — пока оператор листал клиентов
  // сегмента, протухшее число не пересчитывалось бесконечно (импорт менял
  // состав, UI продолжал показывать старое). TTL честно истекает через 5 минут
  // после последнего РЕАЛЬНОГО пересчёта.
  if (known === null) {
    rememberCount(id, finalTotal);
  }
  return { items: rows.map(serializeSegmentRow), total: finalTotal };
}

/** Результат подсчёта: число, режим и метки времени (пересчёт/фиксация). */
export interface SegmentCountResult {
  total: number;
  mode: SegmentMode;
  /** Момент вычисления счёта (для динамических — когда пересчитывали). */
  computedAt: string;
  /** Момент фиксации среза (для фиксированных). */
  frozenAt: string | null;
}

/** Счёт подходящих клиентов.
 * Динамический — точный живой пересчёт (кэш 5 мин; инвалидируется правкой сегмента);
 * фиксированный — размер среза (COUNT по индексу, всегда актуален: удалённые
 * клиенты каскадно выпадают из среза). */
export async function countSegmentClients(id: string): Promise<SegmentCountResult> {
  const row = await getSegmentRow(id);

  if (row.mode === 'static') {
    const total = await db.segmentMember.count({ where: { segmentId: id } });
    return {
      total,
      mode: 'static',
      computedAt: new Date().toISOString(),
      frozenAt: row.frozenAt ? row.frozenAt.toISOString() : null,
    };
  }

  const known = cachedCount(id);
  if (known !== null) {
    const at = cachedComputedAt(id) ?? new Date();
    return {
      total: known,
      mode: 'dynamic',
      computedAt: at.toISOString(),
      frozenAt: null,
    };
  }
  const conditions = parseSegmentConditions(row);
  const errors = validateRules(conditions, await fieldIndex());
  if (errors.length > 0) {
    throw new ApiError(422, 'У сегмента некорректные условия', errors.join('; '));
  }
  const { total } = await scanSegment(conditions, { skip: 0, take: 0, needPage: false, needCount: true });
  const computedAt = rememberCount(id, total);
  return { total, mode: 'dynamic', computedAt: computedAt.toISOString(), frozenAt: null };
}

/** Потоковая итерация клиентов фиксированного среза (рассылки и массовое
 *  обновление): полные строки Client (карточка + пояс), порядок — externalId
 *  asc (детерминизм порционного лимита «первые N», как в динамическом пути
 *  iterateSegmentClients). Уникальный индекс (segmentId, clientId) делает
 *  EXISTS-фильтр дешёвым; курсор + порция держат память O(порция) — прежняя
 *  версия копила ВЕСЬ срез в памяти (миллионы членов → OOM воркера). */
export async function* iterateStaticSegmentClients(
  segmentId: string,
): AsyncGenerator<Client[], void, void> {
  let cursorExternalId: string | null = null;
  for (;;) {
    const batch = await db.client.findMany({
      where: { segmentMembers: { some: { segmentId } } },
      orderBy: { externalId: 'asc' },
      ...(cursorExternalId !== null ? { cursor: { externalId: cursorExternalId }, skip: 1 } : {}),
      take: SEGMENT_ITERATE_CHUNK,
    });
    if (batch.length === 0) return;
    cursorExternalId = batch[batch.length - 1].externalId;
    yield batch;
    if (batch.length < SEGMENT_ITERATE_CHUNK) return; // срез исчерпан
  }
}
