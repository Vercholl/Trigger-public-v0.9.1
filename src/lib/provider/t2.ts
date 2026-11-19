// Т2 «Бизнес SMS» — боевой оператор (прямой корпоративный договор).
// Реализовано по официальному документу «Услуга "Бизнес SMS". Использование
// протоколов HTTP/SMTP» (upload/http_connect.pdf). Все форматы сверены с документом;
// логин/пароль подключения в логи не пишутся.
//
// Ключевые особенности протокола (разделы документа):
//  - Авторизация: login/password РАССЫЛКИ (подключения) в query каждого запроса
//    (раздел 4) — генерируются в ЛК bsms.t2.ru при создании HTTP-рассылки.
//  - Отправка: GET/POST https://bsms.t2.ru/api/?operation=send&login=..&password=..
//    &msisdn=79XXXXXXXXX&shortcode=<имя ≤11 ASCII>&text=<UTF-8, URL-encode>&format=ext
//    (раздел 4). Ответ JSON: {"code":0,"data":{"id":<транзакция>}} либо
//    {"code":-1,"message":"ERROR: …"} (раздел 4, «format=ext»).
//  - Идемпотентность: необязательный ext_id — целое число, «предотвращает
//    повторную отправку сообщений» (раздел 4). Строим детерминированно из
//    стабильного контекста (idempotencyScope): ретраи после таймаутов не
//    создают дублей. ptag='trigger' для выгрузок в ЛК/отчётах Т2.
//  - Статусы: GET ?operation=status&id=<транзакция> → delivered / expired /
//    undeliverable / rejected / unknown / billed / not_sent / accepted / enrote
//    (раздел 6). С format=ext — JSON {transaction_id, status, parts[], …}.
//  - Уведомления партнёра: Т2 по заявке шлёт HTTP GET на наш webhook с
//    параметрами status/id/parts/transaction_id/ptag/text/abonent/sender/
//    error_codes/delivery_type (раздел 7) — роут /api/v1/webhooks/t2.
//  - Симулятор для отладки клиентского ПО: https://bsms.t2.ru/simulator-api/
//    (раздел 10) — параметры идентичны, реальной отправки нет.
//
// Логин/пароль берутся из БД (AppSettings.t2Login/t2Password — поля «Логин/Пароль
// Т2» на вкладке «Интеграции») с fallback-ом на env T2_LOGIN/T2_PASSWORD.
import { createHash } from 'crypto';
import { db } from '@/lib/db';
import type { SmsProvider, SmsRequest, SendResult, DeliveryStatus } from '@/lib/provider/types';
import { TemporaryProviderError } from '@/lib/provider/types';
import { decryptSecret } from '@/lib/security/secrets';

const DEFAULT_BASE_URL = 'https://bsms.t2.ru';
const TIMEOUT_MS = 10_000;

/**
 * Базовый URL шлюза: env T2_BASE_URL (симулятор bsms.t2.ru/simulator-api/ —
 * раздел 10 документа — для отладки без реальной отправки) — иначе прод-адрес.
 * Хвостовые «/» снимаются, чтобы query-строка не «терялась».
 */
export function t2BaseUrl(): string {
  return (process.env.T2_BASE_URL ?? '').trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

// ---------- Креды подключения: БД (поля на вкладке «Интеграции») → fallback env ----------

const CREDS_CACHE_MS = 30_000;
let credsCache: { login: string; password: string; at: number } | null = null;

export interface T2Credentials {
  login: string;
  password: string;
}

/**
 * Креды подключения Т2: сначала AppSettings.t2Login/t2Password (сохранены из
 * панели), при отсутствии — env T2_LOGIN/T2_PASSWORD. Кэш 30 с, чтобы движок
 * отправки не ходил в SQLite на каждое сообщение.
 */
export async function t2Credentials(): Promise<T2Credentials | null> {
  if (credsCache && Date.now() - credsCache.at < CREDS_CACHE_MS) {
    return credsCache.login === '' ? null : { login: credsCache.login, password: credsCache.password };
  }
  let login = '';
  let password = '';
  try {
    const row = await db.appSettings.findUnique({
      where: { id: 'app' },
      select: { t2Login: true, t2Password: true },
    });
    // Креды хранятся зашифрованными (AES-256-GCM) — расшифровываем для отправки;
    // легаси-plaintext (без префикса enc:v1:) проходит как есть
    login = decryptSecret(row?.t2Login ?? '').trim();
    password = decryptSecret(row?.t2Password ?? '').trim();
  } catch {
    // БД недоступна — fallback на env
    login = '';
    password = '';
  }
  if (login === '' || password === '') {
    login = (process.env.T2_LOGIN ?? '').trim();
    password = (process.env.T2_PASSWORD ?? '').trim();
  }
  credsCache = { login, password, at: Date.now() };
  return login === '' || password === '' ? null : { login, password };
}

/** Сброс кэша кредов — вызывается после сохранения/очистки из панели. */
export function invalidateT2CredentialsCache(): void {
  credsCache = null;
}

// ---------- Парсинг ответов ----------

/** JSON-ответ API Т2 с format=ext (раздел 4): {"code":0,"data":{"id":…}} | {"code":-1,"message":"…"}. */
interface T2ExtResponse {
  code?: number;
  message?: string;
  data?: { id?: number | string };
}

/** GET к API Т2 с таймаутом; возвращает HTTP-статус и тело (JSON или plain text). */
async function t2ApiGet(
  params: URLSearchParams,
): Promise<{ httpStatus: number; text: string; json: T2ExtResponse | null }> {
  const url = `${t2BaseUrl()}/api/?${params.toString()}`;
  const controller = new AbortController();
  // Таймаут 10 с покрывает ВЕСЬ обмен, включая чтение тела (fetch резолвится
  // на заголовках; «залипшее» тело подвешивало сериализованный тик воркера).
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json, text/plain' },
      signal: controller.signal,
    });
    let text = '';
    try {
      text = (await res.text()).trim();
    } catch {
      text = '';
    }
    if (res.status >= 500) {
      throw new TemporaryProviderError(`Т2 вернул HTTP ${res.status}`);
    }
    // 2xx/3xx с пустым телом или HTML-заглушкой прокси — ВРЕМЕННАЯ ошибка:
    // идемпотентный ext_id делает ретрай бесплатным и без дублей (раздел 4);
    // валидные ответы Т2 — JSON или короткий plain-text, но никогда не HTML.
    if (res.status < 400 && (text === '' || text.startsWith('<'))) {
      throw new TemporaryProviderError(
        `Т2 вернул некорректное тело ответа (HTTP ${res.status}, ${text === '' ? 'пусто' : 'HTML'})`,
      );
    }
    let json: T2ExtResponse | null = null;
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        json = JSON.parse(text) as T2ExtResponse;
      } catch {
        json = null;
      }
    }
    return { httpStatus: res.status, text, json };
  } catch (e) {
    if (e instanceof TemporaryProviderError) throw e;
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new TemporaryProviderError('Таймаут запроса к Т2 (10 с)');
    }
    // сетевые ошибки (DNS, соединение) — временные: движок ретраит с backoff
    throw new TemporaryProviderError(`Сеть недоступна: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Временные ошибки Т2 (раздел 6): ретраим, остальные — постоянные. */
function isTemporaryT2Error(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('system error') || m.includes('throttling error');
}

/** Идемпотентный ext_id (раздел 4): целое число из стабильного scope. */
export function t2ExtId(scope: string | null | undefined): number {
  if (!scope || scope.trim() === '') return 0;
  // 12 hex-символов sha256 → до ~2.8e14, безопасно для JSON-числа
  const n = Number.parseInt(createHash('sha256').update(scope).digest('hex').slice(0, 12), 16);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Маппинг статусов Т2 на статусы доставки (раздел 6):
 *   delivered → DELIVERED (финальный)
 *   accepted → SENT (успешно отправлено на СМСц и принято им)
 *   enrote/enroute, billed, not_sent, unknown → QUEUED (не финальные)
 *   expired, undeliverable, rejected → FAILED (финальные)
 * Единая функция для status()-поллинга и webhook-а.
 */
export function mapT2Status(status: string | undefined | null): DeliveryStatus {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'delivered':
      return 'DELIVERED';
    case 'accepted':
      return 'SENT';
    case 'enrote': // опечатка в документе Т2 (раздел 6)
    case 'enroute':
    case 'billed':
    case 'not_sent':
    case 'unknown':
      return 'QUEUED';
    case 'expired':
    case 'undeliverable':
    case 'rejected':
      return 'FAILED';
    default:
      return 'QUEUED';
  }
}

/**
 * Адаптер Т2 «Бизнес SMS» (прямой оператор). Отправка — GET /api/ с
 * operation=send&format=ext (JSON-ответ); статус — operation=status.
 * Креды в query каждого запроса; ext_id — идемпотентность повторов.
 * Особенности протокола и маппинг статусов — в шапке файла и JSDoc методов.
 */
export class T2Provider implements SmsProvider {
  readonly name = 't2';

  /**
   * Отправка сообщения. Протокол:
   * - нет логина/пароля/имени отправителя, некорректный msisdn (не 11 цифр
   *   7XXXXXXXXXX) → ok=false — перманентные локальные ошибки;
   * - code=0 + data.id → ok=true, providerMessageId = id транзакции;
   * - «system error» / «throttling error» (раздел 6) → TemporaryProviderError —
   *   ретрай с тем же ext_id не создаст дубля;
   * - прочие ERROR-ответы → ok=false (постоянные: неверные креды, биллинг...).
   */
  async send(req: SmsRequest): Promise<SendResult> {
    const creds = await t2Credentials();
    if (!creds) {
      return {
        ok: false,
        error: 'Т2: не заданы логин/пароль подключения — сохраните их на вкладке «Интеграции»',
      };
    }
    const sender = req.sender?.trim() ?? '';
    if (sender === '') {
      return {
        ok: false,
        error:
          'Т2: не задано имя отправителя (shortcode обязателен, раздел 4) — настройте «Имя отправителя SMS» или укажите в шаблоне/узле',
      };
    }
    // msisdn — строго 11 цифр (раздел 4): normalizePhone даёт +79…, снимаем «+»
    const msisdn = req.phone.replace(/^\+/, '');
    if (!/^7\d{10}$/.test(msisdn)) {
      return { ok: false, error: `Т2: некорректный msisdn «${req.phone}» — ожидается 11 цифр, например 79001234567` };
    }

    const params = new URLSearchParams({
      operation: 'send',
      login: creds.login,
      password: creds.password,
      msisdn,
      shortcode: sender, // ≤11 символов ASCII (раздел 4)
      text: req.body, // UTF-8 + URL-кодировка — делает URLSearchParams
      format: 'ext', // JSON-ответ (раздел 4)
      ptag: 'trigger', // идентификатор стороны клиента, до 63 симв. (раздел 4)
    });
    const extId = t2ExtId(req.idempotencyScope);
    if (extId > 0) params.set('ext_id', String(extId));

    const { httpStatus, text, json } = await t2ApiGet(params);

    if (json && json.code === 0 && json.data?.id !== undefined && json.data.id !== null && `${json.data.id}` !== '') {
      // Сообщение принято; статус доставки придёт webhook-ом / operation=status
      return {
        ok: true,
        providerMessageId: `${json.data.id}`,
        immediateDelivery: false,
      };
    }

    // Ошибки: JSON {"code":-1,"message":"ERROR: …"} либо plain text
    const message = json?.message?.trim() || text || `HTTP ${httpStatus}`;
    if (isTemporaryT2Error(message)) {
      // system error / throttling error (раздел 6) — повтор с тем же ext_id не создаст дубля
      throw new TemporaryProviderError(`Т2: ${message}`);
    }
    return { ok: false, error: `Т2 отклонил запрос: ${message}` };
  }

  /**
   * Статус транзакции (operation=status&format=ext). Разбирает документированный
   * плоский JSON {transaction_id, status, parts[]} (обёртки code/data нет —
   * см. комментарий ниже) и plain-text ответ («delivered» и т.п.);
   * временные ошибки → TemporaryProviderError, остальное → Error.
   */
  async status(providerMessageId: string): Promise<DeliveryStatus> {
    const creds = await t2Credentials();
    if (!creds) throw new Error('Т2: не заданы логин/пароль подключения');

    // Раздел 6: operation=status&id=<транзакция>[&format=ext]
    const params = new URLSearchParams({
      operation: 'status',
      login: creds.login,
      password: creds.password,
      id: providerMessageId,
      format: 'ext',
    });
    const { httpStatus, text, json } = await t2ApiGet(params);

    // Расширенный ответ (раздел 6): ПЛОСКИЙ JSON {"transaction_id":…,
    // "status":"delivered","parts":[…]} — обёртки code/data, как в ответе на
    // send, в нём НЕТ. Статус — строковое поле status верхнего уровня; на
    // случай обёрнутого ответа дополнительно принимаем json.data.status.
    if (json) {
      const wrapped = json as T2ExtResponse & {
        status?: unknown;
        data?: { id?: number | string; status?: unknown };
      };
      const statusStr =
        typeof wrapped.status === 'string'
          ? wrapped.status
          : typeof wrapped.data?.status === 'string'
            ? wrapped.data.status
            : null;
      if (wrapped.code === 0 || statusStr !== null) {
        return mapT2Status(statusStr ?? undefined);
      }
    }
    // Plain-text ответ: сам статус («delivered») либо ошибка
    const raw = text.toLowerCase();
    if (
      raw === 'delivered' ||
      raw === 'expired' ||
      raw === 'undeliverable' ||
      raw === 'rejected' ||
      raw === 'unknown' ||
      raw === 'billed' ||
      raw === 'not_sent' ||
      raw === 'accepted' ||
      raw === 'enrote' ||
      raw === 'enroute'
    ) {
      return mapT2Status(raw);
    }
    const message = json?.message?.trim() || text || `HTTP ${httpStatus}`;
    if (isTemporaryT2Error(message)) {
      throw new TemporaryProviderError(`Т2: ${message}`);
    }
    throw new Error(`Т2 status: ${message}`);
  }
}

/** Результат проверки подключения к Т2. */
export interface T2CheckResult {
  ok: boolean;
  detail: string;
}

/**
 * Проверка подключения БЕЗ отправки SMS: запрос operation=status по заведомо
 * несуществующей транзакции (id=1). Отличает «логин/пароль неверны»
 * («ERROR: login/password is incorrect») от «креды приняты»
 * («transaction not found» / «invalid ID») — бесплатная проверка кредов
 * для кнопки «Проверить подключение».
 */
export async function checkT2Connection(): Promise<T2CheckResult> {
  const creds = await t2Credentials();
  if (!creds) {
    return { ok: false, detail: 'Логин/пароль подключения не заданы — сохраните их на вкладке «Интеграции»' };
  }
  const params = new URLSearchParams({
    operation: 'status',
    login: creds.login,
    password: creds.password,
    id: '1', // несуществующая транзакция: важно НЕ существующее, но валидное число
    format: 'ext',
  });
  let out: { httpStatus: number; text: string; json: T2ExtResponse | null };
  try {
    out = await t2ApiGet(params);
  } catch (e) {
    if (e instanceof TemporaryProviderError) {
      return { ok: false, detail: `Шлюз Т2 недоступен: ${e.message}` };
    }
    throw e;
  }

  const message = (out.json?.message ?? out.text).trim().toLowerCase();
  if (message.includes('login/password is incorrect')) {
    return { ok: false, detail: 'Шлюз доступен, но логин/пароль отклонены (login/password is incorrect)' };
  }
  if (message.includes('transaction not found') || message.includes('invalid id')) {
    return { ok: true, detail: 'Подключение работает: шлюз доступен, логин/пароль приняты' };
  }
  if (out.json && out.json.code === 0) {
    // id=1 внезапно существует — креды точно приняты
    return { ok: true, detail: 'Подключение работает: шлюз доступен, логин/пароль приняты' };
  }
  if (message.includes('billing failed')) {
    return { ok: false, detail: 'Логин/пароль приняты, но недостаточно средств на счету Т2' };
  }
  return { ok: false, detail: `Шлюз Т2 ответил: ${(out.json?.message ?? out.text).trim() || `HTTP ${out.httpStatus}`}` };
}
