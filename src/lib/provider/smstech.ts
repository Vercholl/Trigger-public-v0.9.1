// SMS.Tech — боевой провайдер через HTTP-шлюз sms-gate.smsleads.ru (агрегатор).
// Реализовано по официальной документации «SMS.Tech — HTTP API шлюза отправки
// сообщений», v2.0 от 23.09.2026 (upload/SMS-Gate_HTTP_SMS.pdf). Все форматы
// сверены с документацией; токен доступа в логи не пишется.
//
// Токен доступа берётся из БД (AppSettings.smstechToken — поле «Токен доступа»
// на вкладке «Интеграции») с fallback-ом на env SMSTECH_ACCESS_TOKEN.
//
// Ключевые особенности протокола (разделы документации):
//  - Аутентификация: meta.access_token в теле каждого запроса (раздел 4).
//  - Идемпотентность: meta.idempotency_key — UUID, хранится шлюзом 24 часа;
//    повторный вызов с тем же ключом возвращает ТО ЖЕ сообщение без дубля
//    (раздел 6). Мы строим ключ детерминированно из стабильного контекста
//    (idempotencyScope), поэтому ретраи после таймаутов/HTTP 500 не создают
//    повторных SMS — ровно как рекомендует раздел 16.1.
//  - Отправка: POST /api/v1/grpc/SmsService/SendMessage, data { recipient,
//    sender_name, text, channel } — НЕИЗВЕСТНЫЕ ПОЛЯ ЗАПРЕЩЕНЫ (HTTP 500,
//    раздел 3), поэтому в data только задокументированные поля.
//  - Статусы: сообщение «новое» — поле status ОТСУТСТВУЕТ (раздел 7.4/9).
//  - Ошибки после приёма (стоп-слова, чёрный список, лимиты) приходят НЕ
//    HTTP-ошибкой, а позже статусом SEND_ERROR (раздел 13).
import { createHash, randomUUID } from 'crypto';
import { db } from '@/lib/db';
import type { SmsProvider, SmsRequest, SendResult, DeliveryStatus } from '@/lib/provider/types';
import { TemporaryProviderError } from '@/lib/provider/types';
import { decryptSecret } from '@/lib/security/secrets';

const DEFAULT_BASE_URL = 'https://sms-gate.smsleads.ru';
const TIMEOUT_MS = 10_000;

/**
 * Базовый URL шлюза: env SMSTECH_BASE_URL (тестовые зеркала/прокси) — иначе
 * продакшен-адрес агрегатора по умолчанию.
 */
export function smsTechBaseUrl(): string {
  return (process.env.SMSTECH_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
}

// ---------- Токен доступа: БД (поле на вкладке «Интеграции») → fallback env ----------

const TOKEN_CACHE_MS = 30_000;
let tokenCache: { token: string; at: number } | null = null;

/**
 * Токен доступа SMS.Tech: сначала AppSettings.smstechToken (сохранён из панели),
 * при отсутствии — env SMSTECH_ACCESS_TOKEN. Кэш 30 с, чтобы движок отправки
 * не ходил в SQLite на каждое сообщение.
 */
export async function smstechAccessToken(): Promise<string> {
  if (tokenCache && Date.now() - tokenCache.at < TOKEN_CACHE_MS) return tokenCache.token;
  let token = '';
  try {
    const row = await db.appSettings.findUnique({
      where: { id: 'app' },
      select: { smstechToken: true },
    });
    // Секрет хранится зашифрованным (AES-256-GCM) — расшифровываем для отправки;
    // легаси-plaintext (без префикса enc:v1:) проходит как есть
    token = decryptSecret(row?.smstechToken ?? '').trim();
  } catch {
    // БД недоступна (например, во время db:push) — fallback на env
    token = '';
  }
  if (token === '') token = (process.env.SMSTECH_ACCESS_TOKEN ?? '').trim();
  tokenCache = { token, at: Date.now() };
  return token;
}

/** Сброс кэша токена — вызывается после сохранения/очистки токена из панели. */
export function invalidateSmstechTokenCache(): void {
  tokenCache = null;
}

// ---------- Типы протокола SMS.Tech (раздел 7.4 «Объект message») ----------

/** Объект message — един для ответов API и webhook-уведомлений (раздел 10.3). */
export interface SmsTechMessage {
  code?: string;
  version?: string; // int64 строкой (раздел 3)
  recipient?: string;
  senderName?: string;
  text?: string;
  status?: string; // отсутствует у нового сообщения
  errorText?: string;
  priceMoney?: { currencyCode?: string; units?: string }; // units — копейки строкой
  segmentsCount?: number;
  operatorCode?: string;
  channel?: string;
  dateCreate?: string;
  dateSend?: string;
  dateDelivered?: string;
  dateError?: string;
  tags?: string[];
}

/** Единый формат ошибок API — Google API error model (раздел 13). */
interface SmsTechApiError {
  code?: string;
  message?: string;
  details?: Array<{
    '@type'?: string;
    fieldViolations?: Array<{ field?: string; description?: string }>;
  }>;
}

/** Разбор JSON-тела ошибки шлюза в человекочитаемый текст. */
function describeApiError(body: SmsTechApiError | null, httpStatus: number): string {
  const parts: string[] = [];
  if (body?.code) parts.push(body.code);
  if (body?.message) parts.push(body.message);
  const violations = (body?.details ?? [])
    .flatMap((d) => d.fieldViolations ?? [])
    .map((v) => [v.field, v.description].filter(Boolean).join(': '));
  if (violations.length > 0) parts.push(violations.join('; '));
  if (parts.length === 0) parts.push(`HTTP ${httpStatus}`);
  return parts.join(' — ');
}

async function readErrorBody(res: Response): Promise<SmsTechApiError | null> {
  try {
    return (await res.json()) as SmsTechApiError;
  } catch {
    return null;
  }
}

/**
 * Маппинг статусов SMS.Tech на статусы доставки (раздел 9):
 *   поле отсутствует / MESSAGE_STATUS_UNSPECIFIED → новое (QUEUED)
 *   MESSAGE_STATUS_SEND          → передано оператору (SENT)
 *   MESSAGE_STATUS_DELIVERED     → доставлено (DELIVERED)
 *   MESSAGE_STATUS_SEND_ERROR    → ошибка (FAILED)
 * Единая функция для status()-поллинга и webhook-а. Отправка EMAIL/TG
 * (каналы, которых у нас нет) сюда не попадает: SEND_ERROR/Error — FAILED.
 */
export function mapSmsTechStatus(status: string | undefined | null): DeliveryStatus {
  switch (status) {
    case 'MESSAGE_STATUS_DELIVERED':
      return 'DELIVERED';
    case 'MESSAGE_STATUS_SEND':
      return 'SENT';
    case 'MESSAGE_STATUS_SEND_ERROR':
      return 'FAILED';
    default:
      // новое сообщение (поле отсутствует) либо UNSPECIFIED
      return 'QUEUED';
  }
}

/**
 * Детерминированный UUID для meta.idempotency_key из стабильного контекста
 * (scope): sha256(scope) → 32 hex → раскладка UUIDv4. Ретрай того же сообщения
 * (тот же scope) даёт тот же ключ → шлюз не создаёт дубль (раздел 6).
 * Если scope не передан — свежий UUID (одноразовая отправка без защиты от дублей).
 */
export function idempotencyKeyFor(scope: string | null | undefined): string {
  if (!scope || scope.trim() === '') return randomUUID();
  const hex = createHash('sha256').update(scope).digest('hex').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`, // версия 4
    `${((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`, // вариант
    hex.slice(20, 32),
  ].join('-');
}

/** POST к методу SmsService с таймаутом и единой обработкой сети. */
async function smsServicePost<T>(
  method: string,
  body: Record<string, unknown>,
  token: string,
): Promise<{ httpStatus: number; json: T | null; errorText: string | null }> {
  const url = `${smsTechBaseUrl()}/api/v1/grpc/SmsService/${method}`;
  const controller = new AbortController();
  // Таймаут 10 с покрывает ВЕСЬ обмен, включая чтение тела: fetch резолвится
  // уже на заголовках, а «залипшее» тело (перегруженный шлюз/прокси) раньше
  // читалось без таймаута — undici ждал бы ~300 с, подвешивая сериализованный
  // тик воркера. abort() во время res.json() корректно бросает AbortError.
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json: T | null = null;
    try {
      json = (await res.json()) as T;
    } catch {
      json = null;
    }

    // 5xx (в т.ч. «Error processing request» по разделу 3) — временные:
    // документация прямо требует повторить запрос С ТЕМ ЖЕ idempotency_key
    // (раздел 13/16.1).
    if (res.status >= 500) {
      throw new TemporaryProviderError(
        `SMS.Tech вернул HTTP ${res.status}${json ? '' : ' (некорректный ответ)'}`,
      );
    }
    // 2xx/3xx с неразобранным телом (HTML-заглушка обратного прокси, обрыв
    // тела) — тоже ВРЕМЕННАЯ ошибка: идемпотентный ключ делает ретрай
    // бесплатным и без дублей; раньше такое навсегда «зависало» как ok:false.
    if (json === null && res.status < 400) {
      throw new TemporaryProviderError(
        `SMS.Tech вернул не-JSON ответ (HTTP ${res.status}) — вероятна заглушка прокси`,
      );
    }
    // 4xx (400/401/402/403) с любым телом — перманентный отказ: отдаётся
    // вызывающему для человекочитаемой диагностики (баланс/креды/контент).
    return { httpStatus: res.status, json, errorText: json ? null : `HTTP ${res.status}` };
  } catch (e) {
    if (e instanceof TemporaryProviderError) throw e;
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new TemporaryProviderError('Таймаут запроса к SMS.Tech (10 с)');
    }
    // сетевые ошибки (DNS, соединение) — временные (раздел 16.1: повторить)
    throw new TemporaryProviderError(
      `Сеть недоступна: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Адаптер SMS.Tech (агрегатор). send — POST SmsService/SendMessage с
 * meta.access_token и детерминированным meta.idempotency_key (безопасные
 * ретраи); статус — POST SmsService/GetMessageByCode. Особенности протокола
 * и маппинг ошибок — в шапке файла и JSDoc методов.
 */
export class SmsTechProvider implements SmsProvider {
  readonly name = 'smstech';

  /**
   * Отправка сообщения. Протокол:
   * - нет токена/имени отправителя → ok=false (перманентно, без ретрая) —
   *   это локальные настройки, а не сбой шлюза;
   * - сеть/таймаут 10 с/HTTP 5xx → исключение TemporaryProviderError (ретрай
   *   с тем же idempotency_key дубля не создаст — раздел 6 документации);
   * - HTTP 200 + message.code → ok=true, id = message.code, счёт сегментов —
   *   биллинговый segmentsCount шлюза;
   * - 4xx (400/401/402/403) → ok=false с человекочитаемым описанием из
   *   Google API error model (402 — баланс, подсказка с hub.sms.tech).
   */
  async send(req: SmsRequest): Promise<SendResult> {
    const token = await smstechAccessToken();
    if (token === '') {
      return { ok: false, error: 'SMS.Tech: не задан токен доступа — сохраните его на вкладке «Интеграции»' };
    }
    const sender = req.sender?.trim() ?? '';
    if (sender === '') {
      // sender_name обязателен (раздел 7.1) и должен быть привязан к аккаунту
      return {
        ok: false,
        error:
          'SMS.Tech: не задано имя отправителя (настройте «Имя отправителя SMS» или укажите в шаблоне/узле)',
      };
    }

    // data — ТОЛЬКО задокументированные поля: неизвестные дают HTTP 500 (раздел 3)
    const data: Record<string, unknown> = {
      recipient: req.phone,
      sender_name: sender,
      text: req.body,
      channel: 'sms',
    };
    if (req.tags && req.tags.length > 0) {
      data.tags = req.tags.slice(0, 10).map((t) => t.slice(0, 255));
    }

    const { httpStatus, json } = await smsServicePost<{ message?: SmsTechMessage } | SmsTechApiError>(
      'SendMessage',
      {
        meta: {
          access_token: token,
          idempotency_key: idempotencyKeyFor(req.idempotencyScope),
        },
        data,
      },
      token,
    );

    const message = (json as { message?: SmsTechMessage } | null)?.message;
    if (httpStatus === 200 && message?.code) {
      // Сообщение принято; тарификация/статусы придут webhook-ом (разделы 9–10)
      return {
        ok: true,
        providerMessageId: message.code,
        immediateDelivery: false,
        // segmentsCount — биллинговое число сегментов по данным шлюза (раздел 7.4)
        segmentsCount:
          typeof message.segmentsCount === 'number' && message.segmentsCount > 0
            ? message.segmentsCount
            : undefined,
      };
    }

    // 4xx — постоянные ошибки (раздел 13): 400 INVALID_ARGUMENT (невалидное поле,
    // иностранного получателя, неразрешённое имя), 401 UNAUTHENTICATED,
    // 402 FAILED_PRECONDITION (баланс), 403 PERMISSION_DENIED.
    const err = json as SmsTechApiError | null;
    const balance =
      httpStatus === 402 ? 'Недостаточно средств на счёте SMS.Tech — пополните баланс в hub.sms.tech' : '';
    return {
      ok: false,
      error: `SMS.Tech отклонил запрос: ${balance || describeApiError(err, httpStatus)}`,
    };
  }

  /**
   * Статус сообщения по code (GetMessageByCode). Новое сообщение — поле
   * status отсутствует → QUEUED (mapSmsTechStatus). 404/403 и прочие не-200
   * бросают Error — реконсиляция воркера просто пропустит такт.
   */
  async status(providerMessageId: string): Promise<DeliveryStatus> {
    const token = await smstechAccessToken();
    if (token === '') throw new Error('SMS.Tech: токен доступа не задан');

    // GetMessageByCode: code на верхнем уровне запроса рядом с meta (раздел 8)
    const { httpStatus, json } = await smsServicePost<{ message?: SmsTechMessage } | SmsTechApiError>(
      'GetMessageByCode',
      { meta: { access_token: token }, code: providerMessageId },
      token,
    );

    if (httpStatus === 200) {
      return mapSmsTechStatus((json as { message?: SmsTechMessage } | null)?.message?.status);
    }
    // 404 NOT_FOUND / 403 — по разделу 8; для точки зрения движка это провал
    const err = json as SmsTechApiError | null;
    throw new Error(`SMS.Tech GetMessageByCode: ${describeApiError(err, httpStatus)}`);
  }
}

/** Результат проверки подключения к SMS.Tech (ResolveOperators, раздел 12). */
export interface SmsTechCheckResult {
  ok: boolean;
  /** Человекочитаемый итог для панели. */
  detail: string;
  /** Определитель оператора для проверяемого номера (когда ок). */
  operator?: string;
  normalizedPhone?: string;
}

/**
 * Проверка подключения БЕЗ отправки SMS: ResolveOperators по пробному номеру.
 * Отличает «токен неверен» (401) от «шлюз доступен» (200), нормализует номер —
 * бесплатная альтернатива тестовой отправке для кнопки «Проверить подключение».
 */
export async function checkSmsTechConnection(phone?: string): Promise<SmsTechCheckResult> {
  const token = await smstechAccessToken();
  if (token === '') {
    return { ok: false, detail: 'Токен доступа не задан — сохраните его на вкладке «Интеграции»' };
  }
  const probe = phone?.trim() || '+79001234567';
  let out: { httpStatus: number; json: unknown; errorText: string | null };
  try {
    out = await smsServicePost<Record<string, Record<string, { normalizedPhone?: string; operatorCode?: string; error?: string }>> | SmsTechApiError>(
      'ResolveOperators',
      { meta: { access_token: token }, phones: [probe] },
      token,
    );
  } catch (e) {
    if (e instanceof TemporaryProviderError) {
      return { ok: false, detail: `Шлюз недоступен: ${e.message}` };
    }
    throw e;
  }

  const err = out.json as SmsTechApiError | null;
  if (out.httpStatus === 200) {
    const results = (out.json as { results?: Record<string, { normalizedPhone?: string; operatorCode?: string; error?: string }> } | null)
      ?.results;
    const info = results?.[probe];
    if (info?.error) {
      return { ok: false, detail: `Шлюз доступен, токен действителен. Номер не распознан: ${info.error}` };
    }
    return {
      ok: true,
      detail: `Подключение работает: шлюз доступен, токен действителен${
        info?.operatorCode ? `, оператор номера — ${info.operatorCode}` : ''
      }`,
      operator: info?.operatorCode,
      normalizedPhone: info?.normalizedPhone,
    };
  }
  if (out.httpStatus === 401) {
    return { ok: false, detail: 'Токен не распознан шлюзом (401 UNAUTHENTICATED) — проверьте значение токена' };
  }
  return { ok: false, detail: `Шлюз ответил ошибкой: ${describeApiError(err, out.httpStatus)}` };
}
