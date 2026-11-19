// МТС OmniChannel — боевой оператор (HTTP API SMS V.1.14). Реализовано по
// официальному документу «МТС OMNIСHANNEL HTTP API SMS V.1.14» (upload/
// «Документация для внешних интеграций по HTTP с каналом SMS.pdf»). Все
// форматы сверены с документом; логин/пароль в логи не пишутся.
//
// Ключевые особенности протокола (разделы документа):
//  - Авторизация: Basic Authentication (login = system_id из договора,
//    пароль) в заголовке КАЖДОГО запроса (раздел «Параметры аутентификации»).
//  - Окружения: PROD https://omnichannel.mts.ru и STAGE (эмулятор)
//    https://stage.omnichannel.mts.ru — выбор через env MTS_BASE_URL
//    (для приёмки без реальной отправки).
//  - Отправка: POST /http-api/v1/messages, тело {"messages":[{content:{short_text},
//    to:[{msisdn,message_id}], from:{sms_address}}], options?} (раздел
//    «Отправка SMS»). msisdn — 11 цифр 7XXXXXXXXXX; sms_address — нейминг
//    (имя отправителя) из договора. Ответ 200: {"messages":[{internal_id,
//    message_id, msisdn}]} — internal_id и есть идентификатор для статусов.
//  - Идемпотентность: message_id — КЛИЕНТСКИЙ идентификатор для корреляции
//    (запрос статусов по msg_ids, коллбэки), НО документ НЕ гарантирует
//    дедупликацию по нему (в отличие от ext_id Т2). Передаём детерминированный
//    message_id из idempotencyScope: трассировка и запрос статусов по msg_ids
//    работают, но ретрай после «зависшего» ответа МОЖЕТ создать дубль —
//    ограничение протокола, ограничиваем его таймаутом всего обмена (10 с).
//  - Ошибки отправки: {code, message}. ВАЖНО: 806/807 приходят с HTTP 200
//    (ошибка конкретного получателя); 802/401 — креды; 803 (MessageLimit has
//    been expired — превышена скорость отправки) — ВРЕМЕННАЯ, ретраим;
//    804/805/808/602 — перманентные (раздел «Коды ошибок»).
//  - Живой шлюз (проверено 03.11.2026, PROD и STAGE) отличается от таблицы
//    V.1.14: на /messages/info отказ кредов приходит с кодом 804 и сообщением
//    Bad credentials (документировано 802; 804 в таблице = «content is
//    required»), а валидация тела — с кодом 612 «…should have at least 1 items»
//    (документирован только 602). Сообщение надёжнее кода — см.
//    isMtsAuthError и checkMtsConnection.
//  - Статусы: POST /http-api/v1/messages/info {"int_ids":[…]} (до 500 id).
//    Ответ {"events_info":[{key, events_info:[{status, event_at, …}]}]} —
//    события накапливаются (200 «отправлено» → 300 «доставлено» и т.д.).
//    Коды событий (приложение): 200 — отправлено; 201 — не отправлено;
//    202 — отправлена лишь часть сегментов; 300 — доставлено; 301 — не
//    доставлено; 302 — доставлена лишь часть сегментов.
//  - Коллбэки: платформа сама шлёт POST {items:[…]} на URL из договора
//    (порты 80/443/5070; подписи в протоколе НЕТ) — роут
//    /api/v1/webhooks/mts; наш ответ — 200 OK.
//  - Лимиты: до 1000 получателей в запросе, до 50 МБ тела; SMS —
//    рекомендовано ≤10 сегментов (670 симв. кириллица / 1530 латиница).
//
// Креды берутся из БД (AppSettings.mtsLogin/mtsPassword — поля «Логин/Пароль
// МТС» на вкладке «Интеграции») с fallback-ом на env MTS_LOGIN/MTS_PASSWORD.
import { createHash, randomUUID } from 'crypto';
import { db } from '@/lib/db';
import type { SmsProvider, SmsRequest, SendResult, DeliveryStatus } from '@/lib/provider/types';
import { TemporaryProviderError } from '@/lib/provider/types';
import { decryptSecret } from '@/lib/security/secrets';

const DEFAULT_BASE_URL = 'https://omnichannel.mts.ru';
const TIMEOUT_MS = 10_000;

/**
 * Базовый URL платформы: env MTS_BASE_URL (STAGE-окружение
 * https://stage.omnichannel.mts.ru — эмулятор без реальной отправки, раздел
 * «Методы») — иначе PROD-адрес. Хвостовые «/» снимаются.
 */
export function mtsBaseUrl(): string {
  return (process.env.MTS_BASE_URL ?? '').trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

// ---------- Креды подключения: БД (поля на вкладке «Интеграции») → fallback env ----------

const CREDS_CACHE_MS = 30_000;
let credsCache: { login: string; password: string; at: number } | null = null;

export interface MtsCredentials {
  login: string;
  password: string;
}

/**
 * Креды подключения МТС OmniChannel (system_id/пароль из договора): сначала
 * AppSettings.mtsLogin/mtsPassword (сохранены из панели), при отсутствии — env
 * MTS_LOGIN/MTS_PASSWORD. Кэш 30 с, чтобы движок отправки не ходил в SQLite на
 * каждое сообщение.
 */
export async function mtsCredentials(): Promise<MtsCredentials | null> {
  if (credsCache && Date.now() - credsCache.at < CREDS_CACHE_MS) {
    return credsCache.login === '' ? null : { login: credsCache.login, password: credsCache.password };
  }
  let login = '';
  let password = '';
  try {
    const row = await db.appSettings.findUnique({
      where: { id: 'app' },
      select: { mtsLogin: true, mtsPassword: true },
    });
    // Креды хранятся зашифрованными (AES-256-GCM) — расшифровываем для отправки;
    // легаси-plaintext (без префикса enc:v1:) проходит как есть
    login = decryptSecret(row?.mtsLogin ?? '').trim();
    password = decryptSecret(row?.mtsPassword ?? '').trim();
  } catch {
    // БД недоступна — fallback на env
    login = '';
    password = '';
  }
  if (login === '' || password === '') {
    login = (process.env.MTS_LOGIN ?? '').trim();
    password = (process.env.MTS_PASSWORD ?? '').trim();
  }
  credsCache = { login, password, at: Date.now() };
  return login === '' || password === '' ? null : { login, password };
}

/** Сброс кэша кредов — вызывается после сохранения/очистки из панели. */
export function invalidateMtsCredentialsCache(): void {
  credsCache = null;
}

// ---------- Парсинг ответов ----------

/** Тело ошибки API МТС (раздел «Коды ошибок»): {"code":802,"message":"…"}. */
interface MtsErrorBody {
  code?: number;
  message?: string;
}

/** Элемент ответа на отправку: internal_id (идентификатор для статусов). */
interface MtsSendResponse {
  messages?: Array<{ internal_id?: string; message_id?: string; msisdn?: string }>;
}

/** Событие сообщения в ответе /messages/info и в коллбэке (разделы «Параметры ответа»/«Параметры callback»). */
export interface MtsEvent {
  status?: number;
  channel?: number;
  destination?: string;
  naming?: string;
  message_id?: string | null;
  internal_id?: string;
  event_at?: string;
  received_at?: string;
  total_parts?: number;
  internal_errors?: number[] | null;
}

/** Ответ /messages/info: {"events_info":[{key, events_info:[…]}]}. */
interface MtsInfoResponse {
  events_info?: Array<{ key?: string; events_info?: MtsEvent[]; error?: boolean; error_description?: string }>;
}

/**
 * POST к API МТС с таймаутом; Basic Auth из кредов. Возвращает HTTP-статус и
 * распарсенный JSON (или null). Таймаут 10 с покрывает ВЕСЬ обмен, включая
 * чтение тела: fetch резолвится на заголовках, «залипшее» тело подвешивало бы
 * сериализованный тик воркера. Сетевые ошибки/5xx → TemporaryProviderError
 * (движок ретраит с backoff).
 */
async function mtsApiPost(
  path: string,
  body: unknown,
): Promise<{ httpStatus: number; json: Record<string, unknown> | null }> {
  const creds = await mtsCredentials();
  if (!creds) {
    throw new Error('МТС: не заданы логин/пароль подключения — сохраните их на вкладке «Интеграции»');
  }
  // Basic Authentication (раздел «Параметры аутентификации»): base64(login:password)
  const auth = Buffer.from(`${creds.login}:${creds.password}`, 'utf8').toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${mtsBaseUrl()}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 429) {
      // Троттлинг платформы (может прийти БЕЗ тела/кода 803) — временная
      // ошибка: движок ретраит с backoff, а не фиксирует перманентный провал
      throw new TemporaryProviderError('МТС вернул HTTP 429 (троттлинг)');
    }
    if (res.status >= 500) {
      throw new TemporaryProviderError(`МТС вернул HTTP ${res.status}`);
    }
    let json: Record<string, unknown> | null = null;
    try {
      const text = (await res.text()).trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        json = JSON.parse(text) as Record<string, unknown>;
      }
    } catch {
      json = null; // битое тело — разбор по httpStatus ниже
    }
    return { httpStatus: res.status, json };
  } catch (e) {
    if (e instanceof TemporaryProviderError) throw e;
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new TemporaryProviderError('Таймаут запроса к МТС (10 с)');
    }
    // сетевые ошибки (DNS, соединение) — временные: движок ретраит с backoff
    throw new TemporaryProviderError(`Сеть недоступна: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Маппинг кодов событий МТС на статусы доставки (приложение, «Коды событий
 * "Status"»):
 *   200 → SENT (успешно отправлено оператору, доставка ещё предстоит)
 *   202 → SENT (отправлена лишь часть сегментов — не финальный провал,
 *          финализацию определят последующие события 300/301/302)
 *   300 → DELIVERED (финальный успех)
 *   301 → FAILED (не доставлено)
 *   302 → FAILED (получена лишь часть сегментов — для комплаенса приравнено
 *          к недоставке: ссылка отписки в «отрезанном» сегменте не дошла)
 *   201 → FAILED (не было отправлено вовсе)
 * Единая функция для status()-поллинга и webhook-а.
 */
export function mapMtsStatus(status: number | undefined | null): DeliveryStatus {
  switch (status) {
    case 300:
      return 'DELIVERED';
    case 200:
    case 202:
      return 'SENT';
    case 201:
    case 301:
    case 302:
      return 'FAILED';
    default:
      return 'QUEUED';
  }
}

/**
 * Детерминированный message_id (клиентский идентификатор сообщения, раздел
 * «Структура сообщения») из стабильного контекста отправки: sha256(scope) в
 * формате UUID. Ретраи движка передают тот же message_id — корреляция в
 * коллбэках и запросах msg_ids остаётся стабильной. ГАРАНТИЙ дедупликации
 * платформой по message_id в документе НЕТ (см. шапку файла). Биты версии (4)
 * и варианта (10xx) проставлены как у randomUUID — строгие валидаторы шлюза
 * не должны отвергать «голый» срез хеша (зеркалит idempotencyKeyFor SMS.Tech).
 */
export function mtsMessageId(scope: string | null | undefined): string {
  if (!scope || scope.trim() === '') return randomUUID();
  const h = createHash('sha256').update(scope).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(12, 15)}`, // версия 4
    `${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`, // вариант 10xx
    h.slice(20, 32),
  ].join('-');
}

/** Разворачивает {code,message} из тела ответа в строку ошибки. */
function mtsErrorText(json: Record<string, unknown> | null, httpStatus: number): string {
  if (json) {
    const code = typeof json.code === 'number' ? json.code : undefined;
    const message = typeof json.message === 'string' ? json.message.trim() : '';
    if (code !== undefined || message !== '') {
      return message !== '' ? `код ${code ?? '?'}: ${message}` : `код ${code ?? '?'}`;
    }
  }
  return `HTTP ${httpStatus}`;
}

/**
 * Адаптер МТС OmniChannel (оператор). Отправка — POST /http-api/v1/messages
 * (один получатель на запрос — SmsRequest панельного контракта); статус —
 * POST /http-api/v1/messages/info по internal_id. Креды — Basic Auth каждого
 * запроса. Особенности протокола и маппинг статусов — в шапке файла и JSDoc.
 */
export class MtsProvider implements SmsProvider {
  readonly name = 'mts';

  /**
   * Отправка сообщения. Протокол:
   * - нет логина/пароля/нейминга, некорректный msisdn (не 11 цифр 7XXXXXXXXXX)
   *   → ok=false — перманентные локальные ошибки;
   * - HTTP 200 + messages[].internal_id → ok=true, providerMessageId =
   *   internal_id (именно он — ключ запросов статусов и коллбэков);
   * - HTTP 200 + code 806/807 (ошибка получателя) → ok=false — перманентно;
   * - HTTP 400 + code 803 (превышена скорость отправки) → TemporaryProviderError
   *   — движок ретраит с backoff;
   * - HTTP 400/401/422 + 802/401/804/805/808/602 → ok=false (креды, тело, шаблоны);
   * - HTTP 429/5xx/таймаут/сеть → TemporaryProviderError;
   * - HTTP 2xx с нечитаемым телом → попытка восстановления по msg_ids
   *   (см. recoverInternalIdByMessageId): internal_id найден → ok=true,
   *   иначе ok=false с честным текстом «могло быть принято».
   */
  async send(req: SmsRequest): Promise<SendResult> {
    const creds = await mtsCredentials();
    if (!creds) {
      return {
        ok: false,
        error: 'МТС: не заданы логин/пароль подключения — сохраните их на вкладке «Интеграции»',
      };
    }
    const sender = req.sender?.trim() ?? '';
    if (sender === '') {
      return {
        ok: false,
        error:
          'МТС: не задано имя отправителя (sms_address обязателен) — настройте «Имя отправителя SMS» или укажите в шаблоне/узле',
      };
    }
    // msisdn — 11 цифр (раздел «Структура сообщения»): normalizePhone даёт +79…,
    // снимаем «+»
    const msisdn = req.phone.replace(/^\+/, '');
    if (!/^7\d{10}$/.test(msisdn)) {
      return { ok: false, error: `МТС: некорректный msisdn «${req.phone}» — ожидается 11 цифр, например 79001234567` };
    }

    // Пример №1 документации: объект сообщения с одним получателем; from
    // передаём в самом сообщении (options не нужен — получатель один).
    const messageId = mtsMessageId(req.idempotencyScope);
    const { httpStatus, json } = await mtsApiPost('/http-api/v1/messages', {
      messages: [
        {
          content: { short_text: req.body }, // UTF-8 (кодировка — раздел «Лимиты»)
          to: [{ msisdn, message_id: messageId }],
          from: { sms_address: sender },
        },
      ],
    });

    // Успех: {"messages":[{"internal_id":"…","message_id":"…","msisdn":"…"}]}
    if (json) {
      const send = json as MtsSendResponse;
      const entry =
        send.messages?.find((m) => m.msisdn === msisdn && m.internal_id) ?? send.messages?.find((m) => m.internal_id);
      if (entry?.internal_id) {
        // Сообщение принято платформой; статусы придут коллбэком / /messages/info
        return { ok: true, providerMessageId: entry.internal_id, immediateDelivery: false };
      }
    }

    // Ошибки. HTTP 200 тоже может нести код 806/807 (ошибка получателя) —
    // оба перманентные. 803 (скорость) — единственная временная.
    const errBody = (json ?? {}) as MtsErrorBody;
    const text = mtsErrorText(json, httpStatus);
    if (errBody.code === 803) {
      throw new TemporaryProviderError(`МТС: превышен лимит скорости отправки (${text})`);
    }
    if (errBody.code !== undefined || httpStatus >= 400) {
      // Явный код ошибки платформы или HTTP 4xx — запрос ОТКЛОНЁН (перманентно).
      // Отказ кредов — с подсказкой, где проверять (живой шлюз: 802 на /messages,
      // 804 на /messages/info — сообщение Bad credentials одинаково)
      const credsHint = isMtsAuthError(json, httpStatus)
        ? ' — логин/пароль (system_id из договора) неверны: проверьте поля на вкладке «Интеграции»'
        : '';
      return { ok: false, error: `МТС отклонил запрос: ${text}${credsHint}` };
    }

    // Здесь: HTTP 2xx, но тело не читается / не содержит messages[] — сообщение
    // МОГЛО быть принято (страница-заглушка прокси и т.п.; у SMS.Tech/Т2 такие
    // случаи наблюдались реально). Ретрай НЕ безопасен (дедупликации по
    // message_id в протоколе нет — был бы дубль), поэтому сначала пытаемся
    // ВОССТАНОВИТЬ факт приёмки: запрос статусов по клиентскому message_id
    // (msg_ids, раздел «Статусы»). Восстановление не удалось — перманентный
    // провал с честным текстом (проверить в кабинете МТС) вместо ложного FAILED.
    const recovered = await recoverInternalIdByMessageId(messageId);
    if (recovered !== null) {
      // Сообщение принято платформой — усыновляем его internal_id как ключ статусов
      return { ok: true, providerMessageId: recovered, immediateDelivery: false };
    }
    return {
      ok: false,
      error: `МТС: нечитаемый ответ шлюза (HTTP ${httpStatus}) — сообщение могло быть принято; проверьте в кабинете МТС по message_id ${messageId}`,
    };
  }

  /**
   * Статус сообщения (POST /http-api/v1/messages/info, int_ids). Ответ —
   * накопленные события по сообщению; итог вычисляем так:
   * - есть событие 300 → DELIVERED (сильнейший факт — как гварды webhook-ов);
   * - есть 201/301 → FAILED (финальный провал);
   * - иначе берём ПОСЛЕДНЕЕ событие (event_at, при равенстве — порядок в
   *   массиве) и маппим mapMtsStatus (200/202 → SENT, 302 → FAILED);
   * - событий нет / сообщение не найдено → QUEUED (ещё в полёте).
   * Временные сбои → TemporaryProviderError; 802/401 → Error (креды).
   */
  async status(providerMessageId: string): Promise<DeliveryStatus> {
    const { httpStatus, json } = await mtsApiPost('/http-api/v1/messages/info', {
      int_ids: [providerMessageId], // до 500 id за запрос (раздел «Параметры запроса»)
    });

    // Сначала креды: тело {"code":802,…}/HTTP 401 либо сообщение Bad credentials
    // при авторизации — перманентная ошибка (иначе молча превратится в QUEUED
    // и воркер будет долбить шлюз вечно)
    if (isMtsAuthError(json, httpStatus)) {
      throw new Error(`МТС status: авторизация отклонена (${mtsErrorText(json, httpStatus)})`);
    }

    if (json) {
      const info = json as MtsInfoResponse;
      // STRICT-матч по key == internal_id (запрашивали ровно его): эрзац-ответы
      // эмуляторов/кэшей и чужие записи НЕ приписываются нашему сообщению.
      // Записи с error-флагом (неизвестный/истёкший id) событий не несут —
      // трактуем как «в полёте» (QUEUED); верхний предел возраста опроса
      // ставит воркер (RECONCILE_MAX_AGE_MS), вечного поллинга нет.
      const entry = info.events_info?.find((e) => e.key === providerMessageId) ?? null;
      const events = entry?.events_info ?? [];
      if (events.length > 0) {
        // Delivery — сильнейший факт: любое событие 300 закрывает вопрос
        if (events.some((ev) => ev.status === 300)) return 'DELIVERED';
        // Финальные провалы: 201 (не отправлено) / 301 (не доставлено)
        if (events.some((ev) => ev.status === 201 || ev.status === 301)) return 'FAILED';
        // Иначе — последнее событие (event_at RFC-3339; при NaN — исходный порядок)
        const last = [...events].sort((a, b) => {
          const ta = Date.parse(a.event_at ?? '');
          const tb = Date.parse(b.event_at ?? '');
          return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
        }).at(-1);
        return mapMtsStatus(last?.status);
      }
      // Событий нет — сообщение ещё не обработано платформой
      return 'QUEUED';
    }

    // Тело без JSON: 5xx/таймаут уже закрыты TemporaryProviderError в mtsApiPost
    throw new TemporaryProviderError(`МТС status: некорректный ответ шлюза (HTTP ${httpStatus})`);
  }
}

/**
 * Восстановление internal_id по клиентскому message_id — запрос статусов
 * msg_ids (раздел «Статусы»): ответ {"events_info":[{key, events_info:[…]}]};
 * STRICT-матч key == message_id исключает усыновление чужого сообщения.
 * null — восстановить не удалось (записи/событий нет, сеть, таймаут, мусор).
 */
async function recoverInternalIdByMessageId(messageId: string): Promise<string | null> {
  let out: { httpStatus: number; json: Record<string, unknown> | null };
  try {
    out = await mtsApiPost('/http-api/v1/messages/info', { msg_ids: [messageId] });
  } catch {
    return null; // сеть/таймаут/5xx/429 — факт приёмки установить нельзя
  }
  const info = out.json as MtsInfoResponse | null;
  const entry = info?.events_info?.find((e) => e.key === messageId) ?? null;
  const events = entry?.events_info ?? [];
  const internalId = events
    .map((ev) => ev.internal_id)
    .find((id) => typeof id === 'string' && id.trim() !== '');
  return typeof internalId === 'string' ? internalId : null;
}

/** Результат проверки подключения к МТС OmniChannel. */
export interface MtsCheckResult {
  ok: boolean;
  detail: string;
}

/**
 * Признак ошибки авторизации МТС: код 802/401 ИЛИ сообщение «Bad credentials».
 * Документация V.1.14 относит Bad credentials к коду 802, но живой шлюз на
 * /messages/info отвечает кодом 804 (наблюдался и на PROD, и на STAGE, при
 * любом паре кредов — включая заведомо ложные; на /messages тот же отказ
 * приходит с 802) — сообщения надёжнее кода. Проверено прямым зондом
 * 03.11.2026: полный валидный запрос отправки с неверными кредами → 802.
 */
function isMtsAuthError(json: Record<string, unknown> | null, httpStatus: number): boolean {
  const message = typeof json?.message === 'string' ? json.message.toLowerCase() : '';
  const code = typeof json?.code === 'number' ? (json.code as number) : undefined;
  return code === 802 || httpStatus === 401 || message.includes('bad credentials');
}

/**
 * Проверка подключения БЕЗ отправки SMS: POST /messages/info с ПУСТЫМ int_ids.
 * Живой шлюз (проверено 03.11.2026, PROD и STAGE) обрабатывает этот эндпоинт
 * в порядке: формат заголовка → КРЕДЫ → валидация тела. Подтверждённые
 * сигнатуры:
 *  - креды неверны → HTTP 400 + {code:804, message:"Bad credentials"} — да,
 *    именно 804 (в документации V.1.14 отказ кредов — код 802, а 804 =
 *    «content is required»; сообщение надёжнее кода);
 *  - креды приняты → проваливается валидация пустого int_ids: HTTP 422 +
 *    код 602/612 «…in body…» (документирован 602, живой шлюз использует и
 *    612) либо 200 — сигнал успешной авторизации.
 * Бесплатная проверка кредов для кнопки «Проверить подключение».
 */
export async function checkMtsConnection(): Promise<MtsCheckResult> {
  const creds = await mtsCredentials();
  if (!creds) {
    return { ok: false, detail: 'Логин/пароль подключения не заданы — сохраните их на вкладке «Интеграции»' };
  }
  let out: { httpStatus: number; json: Record<string, unknown> | null };
  try {
    out = await mtsApiPost('/http-api/v1/messages/info', { int_ids: [] });
  } catch (e) {
    if (e instanceof TemporaryProviderError) {
      return { ok: false, detail: `Шлюз МТС недоступен: ${e.message}` };
    }
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  // Креды отклонены: на живом шлюзе — HTTP 400 + код 804 с сообщением Bad
  // credentials (на /messages тот же отказ — код 802). Сообщение надёжнее кода.
  // Путь до шлюза проверен (форма → trim → AES-256-GCM → Basic): креды уходят
  // ровно как сохранены — причина отказа на стороне МТС, текст подсказывает где искать
  if (isMtsAuthError(out.json, out.httpStatus)) {
    return {
      ok: false,
      detail:
        `Шлюз доступен, но логин/пароль отклонены (${mtsErrorText(out.json, out.httpStatus)}). ` +
        'Креды передаются ровно как сохранены. Логин — это system_id из договора (не логин кабинета МТС и не имя отправителя); ' +
        'при точном совпадении с договором уточните у менеджера МТС активацию HTTP-интеграции и IP-ограничения шлюза',
    };
  }
  // Пустой int_ids не проходит валидацию тела — значит авторизация УСПЕШНА:
  // платформа дошла до проверки параметров (422 + 602/612 «…in body…») либо
  // ответила 200
  const code = typeof out.json?.code === 'number' ? (out.json?.code as number) : undefined;
  const message = typeof out.json?.message === 'string' ? out.json.message : '';
  const isBodyValidation =
    out.httpStatus === 422 || code === 602 || code === 612 || /in body/i.test(message);
  if (isBodyValidation || out.httpStatus === 200) {
    return { ok: true, detail: 'Подключение работает: шлюз доступен, логин/пароль приняты' };
  }
  return { ok: false, detail: `Шлюз МТС ответил: ${mtsErrorText(out.json, out.httpStatus)}` };
}
