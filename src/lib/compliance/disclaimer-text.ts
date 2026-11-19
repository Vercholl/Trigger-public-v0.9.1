// Изоморфная логика шаблона рекламной приписки (П7) — без node-зависимостей,
// используется и сервером (short-links, settings), и клиентом (живой предпросмотр
// в настройках). Плейсхолдеры: {link} — персональная ссылка отписки,
// {advertiser} — название рекламодателя.

/** Допустимые плейсхолдеры приписки. */
export const DISCLAIMER_PLACEHOLDERS = ['link', 'advertiser'] as const;

/** Стандартный текст приписки (используется, когда в настройках пусто). */
export const DEFAULT_DISCLAIMER_TEMPLATE = 'Реклама. {advertiser}. Отказаться: {link}';

/** Подстановка плейсхолдеров в шаблон приписки. Неизвестные плейсхолдеры
 * остаются как есть (валидация настроек их отклоняет заранее). */
export function renderDisclaimerText(
  disclaimerTemplate: string,
  advertiserName: string,
  link: string,
): string {
  const template =
    disclaimerTemplate.trim() !== '' ? disclaimerTemplate : DEFAULT_DISCLAIMER_TEMPLATE;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const key = name.toLowerCase();
    if (key === 'link') return link;
    if (key === 'advertiser') return advertiserName;
    return match;
  });
}

/** Валидация шаблона приписки: допустимы только {link} и {advertiser};
 * {link} обязателен — иначе клиент не сможет отписаться (комплаенс).
 * Возвращает текст ошибки или null. */
export function validateDisclaimerTemplate(template: string): string | null {
  if (template.trim() === '') return null;
  const placeholders = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1].toLowerCase());
  if (!placeholders.includes('link')) {
    return 'Приписка должна содержать {link} — ссылку отписки (без неё клиент не сможет отписаться)';
  }
  const unknown = placeholders.filter((p) => p !== 'link' && p !== 'advertiser');
  if (unknown.length > 0) {
    return `Неизвестные плейсхолдеры: ${unknown.map((p) => `{${p}}`).join(', ')} — допустимы {link} и {advertiser}`;
  }
  return null;
}
