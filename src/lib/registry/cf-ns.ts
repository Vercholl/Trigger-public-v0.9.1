// Пространство имён кастомных полей профиля (cf_*) — ЧИСТЫЕ константы.
//
// Изоморфный модуль (без db/zod-серверных импортов): используется серверным
// сервисом services/custom-fields (реестр + значения), клиентскими реестрами
// segments/fields и sms-utils (конструкторы правил и подсказки шаблонов).
// Единственная точка определения префикса/формата ключа — не размножать строки.
//
// Контракт имён: ключ поля без префикса (is_credit_line) живёт в реестре
// CustomField (БД); во ВСЕХ внешних контекстах значение выступает под именем
// cf_<key>:
//   • переменные шаблонов/воронок/рассылок — {{cf_is_credit_line}};
//   • правила сегментов — field: "cf_is_credit_line";
//   • ключи client_card события — "cf_is_credit_line" (канонично), сырой ключ
//     источника "is_credit_line" или camelCase-написание контракта системы
//     данных "isCreditLine" (кредитная линия) — все три варианта
//     применяются, пока ключ не занят реестром карточки.
// Префикс исключает коллизии с полями карточки и легаси payload.

/** Префикс имён кастомных полей во внешних контекстах. */
export const CF_KEY_PREFIX = 'cf_';

/** Формат ключа поля (без префикса): латиница/цифры/подчёркивание, 2–40 симв., начинается с буквы. */
export const CF_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** Типы кастомных полей (в скобках — колонка хранения ClientFieldValue). */
export const CF_FIELD_TYPES = ['text', 'number', 'date', 'bool'] as const;
export type CustomFieldType = (typeof CF_FIELD_TYPES)[number];

/** Ключ → имя переменной/правила/ключа client_card (is_credit_line → cf_is_credit_line). */
export function cfVarName(key: string): string {
  return CF_KEY_PREFIX + key;
}

/** Ключ → camelCase-написание контракта системы данных (is_credit_line → isCreditLine):
 *  так переменные новых продуктов приходят в client_card (например, isCreditLine
 *  признак продукта «Кредитная линия»). Используется как
 *  ДОПОЛНИТЕЛЬНЫЙ вариант поиска значения рядом с каноничным cf_<key> и сырым
 *  <key>; ключи без подчёркиваний возвращаются как есть. */
export function cfCamelOfKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Имя переменной/ключа client_card → ключ поля (cf_is_credit_line → is_credit_line);
 *  null — имя не является кастомным (нет префикса или остаток не проходит формат). */
export function cfKeyOfVar(name: string): string | null {
  if (!name.startsWith(CF_KEY_PREFIX)) return null;
  const rest = name.slice(CF_KEY_PREFIX.length);
  return CF_KEY_RE.test(rest) ? rest : null;
}

/** Колонка ClientFieldValue под тип поля (тип → колонка хранения 1:1). */
export function cfColumnOfType(
  type: CustomFieldType,
): 'valueStr' | 'valueNum' | 'valueDate' | 'valueBool' {
  switch (type) {
    case 'text':
      return 'valueStr';
    case 'number':
      return 'valueNum';
    case 'date':
      return 'valueDate';
    case 'bool':
      return 'valueBool';
  }
}
