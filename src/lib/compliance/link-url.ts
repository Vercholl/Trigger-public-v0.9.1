// Изоморфная URL-механика именных коротких ссылок (без node-зависимостей —
// используется и на сервере, и в живом предпросмотре UI). Паттерн disclaimer-text.ts.

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type UtmParams = Partial<Record<UtmKey, string>>;

export const UTM_FIELD_META: Array<{ key: UtmKey; label: string; placeholder: string }> = [
  { key: 'utm_source', label: 'Источник', placeholder: 'sms' },
  { key: 'utm_medium', label: 'Канал', placeholder: 'cpc' },
  { key: 'utm_campaign', label: 'Кампания', placeholder: 'zarpromо_2026' },
  { key: 'utm_content', label: 'Содержание', placeholder: 'variant_a' },
  { key: 'utm_term', label: 'Ключевое слово', placeholder: 'займы' },
];

/** Собрать итоговый URL: UTM-метки дописываются к targetUrl
 * (существующие одноимённые параметры — заменяются, пустые — убираются).
 * Возвращает null, если targetUrl — не корректный http(s) URL. */
export function buildTargetUrl(targetUrl: string, utm: UtmParams): string | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  for (const key of UTM_KEYS) {
    const value = (utm[key] ?? '').trim();
    if (value === '') {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/** Разобрать сохранённый URL обратно на «чистый» адрес + UTM-метки
 * (форма редактирования: храним итоговый URL, разбираем при показе). */
export function splitTargetUrl(targetUrl: string): { base: string; utm: UtmParams } {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return { base: targetUrl, utm: {} };
  }
  const utm: UtmParams = {};
  for (const key of UTM_KEYS) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      utm[key] = value;
      url.searchParams.delete(key);
    }
  }
  return { base: url.toString(), utm };
}

/** Сколько UTM-меток в URL (бейдж в списке). */
export function countUtmParams(targetUrl: string): number {
  const { utm } = splitTargetUrl(targetUrl);
  return Object.values(utm).filter(Boolean).length;
}
