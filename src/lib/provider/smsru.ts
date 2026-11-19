// SMS.RU-провайдер (боевой). Все параметры/форматы, требующие сверки с документацией,
// помечены комментарием «ПРОВЕРИТЬ ПО ДОКУМЕНТАЦИИ SMS.RU». api_id в логи не пишется.
//
// ВАЖНО: адаптер НЕ ПОДКЛЮЧЁН к системе — getProvider() (provider/types.ts) его
// не возвращает, а настройка панели AppSettings.provider допускает только
// sandbox|smstech|t2 (z.enum в services/settings.ts). Это заготовка на будущее:
// для включения добавить case в getProvider, значение в enum настроек и поля
// кредов на вкладке «Интеграции» (сейчас api_id берётся только из env SMSRU_API_ID).
import type { SmsProvider, SmsRequest, SendResult, DeliveryStatus } from '@/lib/provider/types';
import { TemporaryProviderError } from '@/lib/provider/types';

const SEND_URL = 'https://sms.ru/sms/send';
const STATUS_URL = 'https://sms.ru/sms/status';
const TIMEOUT_MS = 10_000;

// ПРОВЕРИТЬ ПО ДОКУМЕНТАЦИИ SMS.RU: формат ответа POST /sms/send (json=1).
// Ожидаем: { status: "OK"|"ERROR", status_code: number, status_text: string,
//            sms: { "<phone>": { status: "OK"|"ERROR", status_code: number, sms_id: string } } }
interface SmsRuSendResponse {
  status?: string;
  status_code?: number;
  status_text?: string;
  sms?: Record<
    string,
    { status?: string; status_code?: number; sms_id?: string; status_text?: string }
  >;
}

// ПРОВЕРИТЬ ПО ДОКУМЕНТАЦИИ SMS.RU: формат ответа /sms/status и коды статусов.
interface SmsRuStatusResponse {
  status?: string;
  status_code?: number;
}

/**
 * Адаптер SMS.RU (api_id из env). Отправка — POST /sms/send с json=1;
 * статус — POST /sms/status по числовым кодам (mapSmsRuStatusCode).
 * Протокол отправки:
 * - таймаут/сеть/HTTP 5xx → TemporaryProviderError (движок ретраит);
 * - status=OK + sms.<phone>.sms_id → ok=true, providerMessageId=sms_id;
 * - некорректный JSON → ok=false (описание в тексте ошибки);
 * - status=ERROR (4xx-семантика, код в status_code) → ok=false, без ретрая.
 */
export class SmsRuProvider implements SmsProvider {
  readonly name = 'smsru';

  /** Отправка SMS; test=1 (env SMSRU_TEST_MODE) — тестовый режим шлюза без тарификации. */
  async send(req: SmsRequest): Promise<SendResult> {
    const apiId = process.env.SMSRU_API_ID ?? '';
    // ПРОВЕРИТЬ ПО ДОКУМЕНТАЦИИ SMS.RU: параметр тестового режима (test=1).
    const params = new URLSearchParams({
      api_id: apiId,
      to: req.phone,
      msg: req.body,
      json: '1',
    });
    if (process.env.SMSRU_TEST_MODE === '1') {
      params.set('test', '1');
    }
    // П6: имя отправителя (должно быть согласовано с SMS.RU; ПРОВЕРИТЬ ПО ДОКУМЕНТАЦИИ SMS.RU)
    if (req.sender && req.sender.trim().length > 0) {
      params.set('from', req.sender.trim());
    }

    const controller = new AbortController();
    // Таймаут покрывает ВЕСЬ обмен, включая чтение тела (fetch резолвится на
    // заголовках; «залипшее» тело подвешивало сериализованный тик воркера).
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let data: SmsRuSendResponse;
    let httpStatus = 0;
    try {
      const res = await fetch(SEND_URL, {
        method: 'POST',
        body: params,
        signal: controller.signal,
      });
      httpStatus = res.status;
      if (res.status >= 500) {
        throw new TemporaryProviderError(`SMS.RU недоступен (HTTP ${res.status})`);
      }
      data = (await res.json()) as SmsRuSendResponse;
    } catch (e) {
      if (e instanceof TemporaryProviderError) throw e;
      if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
        throw new TemporaryProviderError('Таймаут запроса к SMS.RU');
      }
      // Некорректный JSON при 2xx/4xx — постоянный отказ: у SMS.RU нет
      // идемпотентности (см. шапку status()), ретрай мог бы создать дубль SMS.
      if (e instanceof SyntaxError) {
        return { ok: false, error: `SMS.RU вернул некорректный JSON (HTTP ${httpStatus})` };
      }
      // сетевые ошибки (DNS, соединение) — временные
      throw new TemporaryProviderError(`Сеть недоступна: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }

    if (data.status === 'OK') {
      // ПРОВЕРИТЬ ПО ДОКУМЕНТАЦИИ SMS.RU: ключ объекта sms — номер телефона получателя.
      const smsInfo = data.sms?.[req.phone];
      if (smsInfo?.sms_id) {
        return { ok: true, providerMessageId: smsInfo.sms_id, immediateDelivery: false };
      }
      return { ok: false, error: 'SMS.RU не вернул идентификатор сообщения' };
    }

    // 4xx / статус ERROR — постоянная ошибка, ретрай не выполняется
    const code = data.status_code !== undefined ? ` (код ${data.status_code})` : '';
    return { ok: false, error: `SMS.RU отклонил запрос${code}: ${data.status_text ?? data.status ?? 'нет описания'}` };
  }

  /**
   * Статус по sms_id. Ошибки сети/HTTP бросаются исключением (реконсиляция
   * воркера пропустит такт); код ответа маппится в mapSmsRuStatusCode.
   * Замечание: идемпотентности ключей (как ext_id/idempotency_key у Т2/SMS.Tech)
   * у SMS.RU нет — ретраи после таймаутов МОГУТ создать дубль.
   */
  async status(providerMessageId: string): Promise<DeliveryStatus> {
    const apiId = process.env.SMSRU_API_ID ?? '';
    const params = new URLSearchParams({
      api_id: apiId,
      id: providerMessageId,
      json: '1',
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(STATUS_URL, { method: 'POST', body: params, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SmsRuStatusResponse;
      return mapSmsRuStatusCode(data.status_code ?? -1);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Маппинг кодов статусов SMS.RU на статусы доставки — по официальной таблице
 * https://sms.ru/api/status (сверено 21.10.2026):
 *   100 «в очереди», 101 «передаётся оператору», 102 «отправлено (в пути)»,
 *   103 «доставлено», 110 «прочитано» (Viber), 104-108/150 «не может быть доставлено»,
 *   200+ и -1/-2 — ошибки. Важно: 102 — это НЕ доставка, а 200 — «ошибка отправки».
 * Единая функция для поллинга провайдера и webhook-а. */
export function mapSmsRuStatusCode(code: number): DeliveryStatus {
  if (code === 103 || code === 110) return 'DELIVERED';
  if (code === 100 || code === 101 || code === 102) return 'SENT';
  return 'FAILED'; // 104-108, 150, 200+, -1, -2 и неизвестные коды
}
