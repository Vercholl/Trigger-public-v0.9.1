// Подсчёт сегментов SMS: GSM-7 (160/153) против UCS-2 (70/67).
// Расширенные символы GSM-7 (CR, {, }, €, [..] и т.п.) занимают 2 позиции.
//
// Правило тарификации SMS (GSM 03.38 / 3GPP TS 23.040):
// - GSM-7 (латиница + базовая пунктуация): ОДНА часть = 160 символов.
//   Если текст длиннее — сообщение разбивается на части (multipart) и
//   склеивается телефоном в одно; в каждой части место занимает заголовок
//   UDH (User Data Header, 6 байт) → полезная ёмкость части = 153 символа.
// - UCS-2 (кириллица и всё, что не влезло в GSM-7): символ занимает 16 бит,
//   ОДНА часть = 70 символов; multipart — 67 на часть (UDH отбирает ~3,5 «символа»).
// - Один РАСШИРЕННЫЙ символ GSM-7 (^ { } \ [ ~ ] | €) занимает ДВЕ позиции
//   (Escape + символ) — поэтому «длина» текста ≠ число символов.
// Кириллическое SMS — почти всегда UCS-2: практические пределы одной части 70
// символов, двух — 134 (67×2), трёх — 201. Отсюда лимиты maxSegments шаблонов
// и предупреждение «превышен лимит частей» в UI редактора.
const GSM7_BASIC = new Set(
  (
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ' +
    ' !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
    '¿abcdefghijklmnopqrstuvwxyzäöñüà'
  ).split(''),
);

// Расширенная таблица GSM-7: Escape-последовательности — каждый символ здесь
// занимает 2 позиции (см. шапку файла).
const GSM7_EXTENDED = new Set(['\f', '^', '{', '}', '\\', '[', '~', ']', '|', '€']);

export type SmsEncoding = 'GSM-7' | 'UCS-2';

/** Результат тарификации: число частей, кодировка и «длина» в позициях. */
export interface SegmentInfo {
  /** Число частей SMS (тарифицирует оператор; 0 для пустой строки). */
  segments: number;
  encoding: SmsEncoding;
  /** Число «позиций» (для GSM-7 расширенные символы считаются за 2). */
  chars: number;
}

/**
 * true, если весь текст представим в GSM-7 (базовая + расширенная таблица) —
 * тогда SMS идёт «латинским» тарифом 160/153. ЛЮБОЙ иной символ (кириллица,
 * «ё», эмодзи, типографские кавычки) переводит ВСЁ сообщение в UCS-2 (70/67).
 */
export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

/** Длина текста в ПОЗИЦИЯХ GSM-7: базовый символ = 1, расширенный = 2. */
function gsm7Length(text: string): number {
  let len = 0;
  for (const ch of text) {
    len += GSM7_EXTENDED.has(ch) ? 2 : 1;
  }
  return len;
}

/**
 * Число сегментов SMS + кодировка — для тарификации, лимита maxSegments
 * шаблона и колонки SmsMessage.segments. Правило (см. шапку файла):
 * GSM-7: ≤160 позиций — 1 часть, иначе ceil(позиции/153);
 * UCS-2: ≤70 символов — 1 часть, иначе ceil(символы/67).
 * Пустая строка — 0 сегментов (отправка всё равно отменится как «пустой рендер»).
 */
export function countSegments(text: string): SegmentInfo {
  if (text.length === 0) {
    return { segments: 0, encoding: 'GSM-7', chars: 0 };
  }
  if (isGsm7(text)) {
    const len = gsm7Length(text);
    // 160 → 1 часть; длиннее — multipart по 153 (UDH съедает 7 позиций на часть)
    return {
      segments: len <= 160 ? 1 : Math.ceil(len / 153),
      encoding: 'GSM-7',
      chars: len,
    };
  }
  const len = text.length; // UTF-16 кодовых единиц (UCS-2 = 16 бит на символ)
  // 70 → 1 часть; длиннее — multipart по 67 (UDH отбирает 3 символа на часть)
  return {
    segments: len <= 70 ? 1 : Math.ceil(len / 67),
    encoding: 'UCS-2',
    chars: len,
  };
}

/**
 * Расширенный анализ для живого предпросмотра (единая реализация для клиента и
 * сервера — раньше таблицы GSM дублировались и расходились). В отличие от
 * countSegments возвращает И chars (число символов), И units (позиции GSM-7) —
 * счётчик в UI показывает «позиции из лимита» (160/70), а не символы.
 */
export interface SmsAnalysis {
  chars: number;
  /** Длина в юнитах (расширенные символы GSM-7 считаются за 2). */
  units: number;
  segments: number;
  encoding: SmsEncoding;
}

/** Анализ текста: символы/позиции/сегменты/кодировка — для UI-предпросмотра SMS. */
export function analyzeSms(text: string): SmsAnalysis {
  if (text.length === 0) {
    return { chars: 0, units: 0, segments: 0, encoding: 'GSM-7' };
  }
  if (isGsm7(text)) {
    const units = gsm7Length(text);
    return {
      chars: text.length,
      units,
      segments: units <= 160 ? 1 : Math.ceil(units / 153),
      encoding: 'GSM-7',
    };
  }
  const len = text.length; // UTF-16 кодовых единиц (эмодзи вне BMP = 2 юнита)
  return { chars: len, units: len, segments: len <= 70 ? 1 : Math.ceil(len / 67), encoding: 'UCS-2' };
}
