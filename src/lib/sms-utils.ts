'use client';

/**
 * Клиентские счётчики SMS (сегменты/кодировка) — живой предпросмотр.
 * Сервер остаётся источником истины (POST /api/v1/templates/preview).
 * Рендер, разбор переменных и подсчёт сегментов — общие изоморфные модули
 * @/lib/sms/render и @/lib/sms/segments (единая GSM-таблица на клиенте и сервере).
 *
 * Слой: клиентские утилиты UI. Используют views/templates-view, views/funnels-view
 * (редакторы шаблонов с живым предпросмотром SMS) и views/settings-view
 * (humanDuration для тихих часов). Реальная отправка считается ТОЛЬКО на сервере.
 */
import {
  extractVariables as engineExtractVariables,
  requiredVariables as engineRequiredVariables,
  renderTemplate,
  RenderError,
  validateTemplateSyntax,
} from '@/lib/sms/render';
import { analyzeSms, type SmsAnalysis } from '@/lib/sms/segments';
import { CANONICAL_CARD_FIELDS } from '@/lib/registry/card-fields';
import { cfVarName } from '@/lib/registry/cf-ns';
import type { CustomFieldItem } from '@/components/views/shared';

/** Реэкспорт типа анализа SMS — чтобы view-компоненты импортировали всё из одного модуля. */
export type { SmsAnalysis };

/** Известные переменные шаблонов: поля карточки из единого реестра
 *  (registry/card-fields — там же типы/подписи/демо-значения; рукописный список
 *  здесь дрейфил — loan_closed_date в него забыли) + легаси payload-поля +
 *  кастомные поля профиля {{cf_<key>}} (динамический реестр из БД — группа
 *  'custom', собирается customTemplateVars на каждом рендере редактора). */
export interface KnownVar {
  name: string;
  label: string;
  sample: string;
  group: 'card' | 'payload' | 'custom';
}

/** Карточные переменные: генерируются из реестра, порядок = карточке. */
const CARD_TEMPLATE_VARS: KnownVar[] = CANONICAL_CARD_FIELDS.map((f) => ({
  name: f.fieldName,
  label: f.tplLabel ?? f.label,
  sample: f.sample,
  group: 'card' as const,
}));

/** Легаси-поля события/data (payload приоритетнее карточки). */
const PAYLOAD_TEMPLATE_VARS: KnownVar[] = [
  { name: 'name', label: 'Полное ФИО (легаси)', sample: 'Тестов Иван Иванович', group: 'payload' },
  { name: 'loan_number', label: 'Номер займа', sample: 'LN-0001', group: 'payload' },
  { name: 'overdue_days', label: 'Дней просрочки', sample: '3', group: 'payload' },
  { name: 'due_date', label: 'Дата платежа', sample: '25.12.2025', group: 'payload' },
  { name: 'payment_amount', label: 'Сумма платежа, ₽', sample: '5000', group: 'payload' },
  { name: 'promo_code', label: 'Промо-код', sample: 'HBD2025', group: 'payload' },
];

/** Справочник известных переменных шаблонов для UI: подписи в подсказках
 * редактора и демо-значения предпросмотра. На серверный рендер НЕ влияет —
 * это только метаданные (движок подставляет любые {{var}} из данных клиента). */
export const KNOWN_TEMPLATE_VARS: KnownVar[] = [...CARD_TEMPLATE_VARS, ...PAYLOAD_TEMPLATE_VARS];

/** Демо-значения кастомных полей по типу — для предпросмотра шаблонов. */
const CF_SAMPLES: Record<CustomFieldItem['type'], string> = {
  text: 'значение',
  number: '100',
  date: '01.01.2027',
  bool: 'да',
};

/** Кастомные поля профиля → переменные-подсказки {{cf_<key>}} (группа 'custom').
 *  Вызывается редакторами шаблонов/воронок на каждом рендере — реестр живёт
 *  в useCustomFields (TanStack Query, кэш 60с). */
export function customTemplateVars(fields: readonly CustomFieldItem[]): KnownVar[] {
  return fields.map((f) => ({
    name: f.varName || cfVarName(f.key), // varName от API — с фолбэком на ключ
    label: f.label,
    sample: CF_SAMPLES[f.type] ?? 'значение',
    group: 'custom' as const,
  }));
}

/** Быстрый поиск описания переменной по имени (для sampleValueFor). */
const KNOWN_VARS_MAP = new Map<string, KnownVar>(KNOWN_TEMPLATE_VARS.map((v) => [v.name, v]));

// Реэкспорт анализа сегментов/кодировки (GSM 03.38 / UCS-2) — единая точка импорта для view.
export { analyzeSms };

/** Уникальные имена переменных {{var}} (включая условия/варианты) в порядке появления. */
export function extractVariables(body: string): string[] {
  return engineExtractVariables(body);
}

/** Результат живого предпросмотра шаблона (renderPreview). */
export interface RenderPreview {
  text: string;
  missing: string[];
  /** true — шаблон отменил отправку ({{#cancel}}). */
  cancelled: boolean;
  /** Ошибка синтаксиса шаблона (для живого предпросмотра). */
  syntaxError: string | null;
}

/** Подстановка с живым предпросмотром: незаполненные остаются как {{var}}.
 * Механика «стражей»: обязательные переменные без значения получают маркер
 * \u0001 (движок не падает на отсутствующих данных), а после рендера маркеры
 * возвращаются в вид {{var}} — так предпросмотр честно показывает, что
 * уйдёт в SMS, а что не заполнено (эти имена — в missing).
 * @param vars значения переменных (обычно — демо из sampleValueFor)
 * @returns syntaxError — первая ошибка синтаксиса или причина отказа рендера */
export function renderPreview(body: string, vars: Record<string, string>): RenderPreview {
  const syntaxErrors = validateTemplateSyntax(body);
  if (syntaxErrors.length > 0) {
    return { text: body, missing: [], cancelled: false, syntaxError: syntaxErrors[0] };
  }

  const allVars = engineExtractVariables(body);
  const required = new Set(engineRequiredVariables(body));
  // Незаполненные ОБЯЗАТЕЛЬНЫЕ переменные — плейсхолдер, чтобы движок не падал;
  // переменные с дефолтом остаются undefined → предпросмотр показывает дефолт.
  const sentinel = (name: string): string => `\u0001${name}\u0001`;
  const filled: Record<string, unknown> = {};
  for (const name of allVars) {
    const value = vars[name];
    if (value !== undefined && value !== '') {
      filled[name] = value;
    } else if (required.has(name)) {
      filled[name] = sentinel(name);
    }
  }

  try {
    const result = renderTemplate(body, filled, { variantSeed: 'preview' });
    if (result.cancelled) {
      return { text: '', missing: [], cancelled: true, syntaxError: null };
    }
    const text = result.text.replace(/\u0001(.+?)\u0001/g, (_m, name: string) => `{{${name}}}`);
    const missing = allVars.filter((name) => required.has(name) && text.includes(`{{${name}}}`));
    return { text, missing, cancelled: false, syntaxError: null };
  } catch (e) {
    const msg = e instanceof RenderError ? e.message : 'Ошибка рендера шаблона';
    return { text: body, missing: [], cancelled: false, syntaxError: msg };
  }
}

/** Человекочитаемая длительность: «1 сут 2 ч», «45 мин». */
export function humanDuration(hours: number, minutes: number): string {
  const totalMinutes = Math.max(0, Math.round(hours)) * 60 + Math.max(0, Math.round(minutes));
  if (totalMinutes === 0) return '0 мин';
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d} сут`);
  if (h > 0) parts.push(`${h} ч`);
  if (m > 0) parts.push(`${m} мин`);
  return parts.join(' ');
}

/** Демо-значение переменной для предпросмотра шаблона (сначала — известные переменные карточки). */
export function sampleValueFor(name: string): string {
  const known = KNOWN_VARS_MAP.get(name);
  if (known) return known.sample;
  const lower = name.toLowerCase();
  if (lower === 'name' || lower.endsWith('_name')) return 'Иван';
  if (lower.endsWith('_days')) return '3';
  if (lower.endsWith('_amount') || lower.endsWith('_sum')) return '15000';
  if (lower.includes('date')) return '25.12.2025';
  if (lower.includes('phone')) return '+79001234567';
  return 'значение';
}
