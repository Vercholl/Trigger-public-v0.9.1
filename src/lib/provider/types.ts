// Интерфейс SMS-провайдера + реестр. Канал-агностичная архитектура:
// движок знает только SmsProvider, конкретные реализации — sandbox, smstech,
// t2 и mts (МТС OmniChannel). Отдельный адаптер smsru.ts (SMS.RU) в реестр
// НЕ подключён — заготовка. Выбор реализации — настройка панели
// (AppSettings.provider: sandbox|smstech|t2|mts); провайдер создаётся на
// каждую отправку (stateless, дорогая инициализация отсутствует).
import { SandboxProvider } from '@/lib/provider/sandbox';
import { SmsTechProvider } from '@/lib/provider/smstech';
import { T2Provider } from '@/lib/provider/t2';
import { MtsProvider } from '@/lib/provider/mts';

/**
 * Запрос отправки SMS. Клиентские/аналитические поля (clientId/instanceId/
 * sender/tags) нужны провайдеру для меток и журналов; идемпотентность —
 * через idempotencyScope (см. поле ниже).
 */
export interface SmsRequest {
  phone: string;
  body: string;
  clientId?: string | null;
  instanceId?: string | null;
  /** Имя отправителя (П6): узел воронки > шаблон > настройка по умолчанию. */
  sender?: string | null;
  /**
   * Стабильный контекст отправки для идемпотентности АГРЕГАТОРОВ (SMS.Tech,
   * раздел 6 документации): провайдер строит из него детерминированный
   * idempotency_key, поэтому ретраи после таймаутов/5xx не создают дублей.
   * Воронки: "funnel:<instanceId>:<nodeId>"; рассылки: "broadcast:<smsId>".
   */
  idempotencyScope?: string | null;
  /** Аналитические метки (SMS.Tech tags, раздел 7.1) — имя шаблона и т.п. */
  tags?: string[];
}

/**
 * Результат send(): ok=true — сообщение принято шлюзом (id для дальнейших
 * статусов); ok=false — постоянная ошибка (ретрай бессмысленен). Временные
 * сбои выражаются ИСКЛЮЧЕНИЕМ TemporaryProviderError, а не ok=false.
 */
export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  /** true — провайдер доставил мгновенно (sandbox): пишем DELIVERED + deliveredAt. */
  immediateDelivery?: boolean;
  /** Текст ошибки (ok=false). */
  error?: string;
  /** Фактическое число сегментов по данным шлюза (SMS.Tech segmentsCount). */
  segmentsCount?: number;
}

/**
 * Общие статусы доставки панели (маппинги из статусов конкретных провайдеров —
 * mapSmsTechStatus / mapT2Status / mapMtsStatus / mapSmsRuStatusCode):
 * QUEUED — принято шлюзом, ждёт отправки; SENT — передано оператору (в пути);
 * DELIVERED — доставлено (финальный успех); FAILED — не доставлено/ошибка
 * (финальный провал). Финализируют статусы webhook-уведомления и реконсиляция
 * воркера; гварды непонижения статуса живут в webhook-роутах.
 */
export type DeliveryStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED';

/**
 * Контракт адаптера SMS-канала. Методы:
 * - send: TemporaryProviderError → движок ретраит с backoff (executors.ts);
 *   ok=false → перманентный отказ (FAIL, без ретрая); токены/креды в логи не писать;
 * - status: поллинг статуса по providerMessageId из SendResult (реконсиляция
 *   воркера); бросает Error при сбое связи/кредов — вызывающий решает, что делать.
 */
export interface SmsProvider {
  readonly name: string;
  send(req: SmsRequest): Promise<SendResult>;
  status(providerMessageId: string): Promise<DeliveryStatus>;
}

/** Временная ошибка провайдера (таймаут, 5xx, сеть) — движок ретраит с backoff. */
export class TemporaryProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemporaryProviderError';
  }
}

/**
 * Реестр провайдеров по имени из настроек (sandbox/smstech/t2/mts).
 * Любое другое имя → SandboxProvider: безопасный дефолт — отправка
 * «в никуда» вместо падения живого сценария (тестовые установки и опечатки
 * в settings.provider не роняют боевые воронки).
 */
export function getProvider(name: string): SmsProvider {
  if (name === 'smstech') return new SmsTechProvider();
  if (name === 't2') return new T2Provider();
  if (name === 'mts') return new MtsProvider();
  return new SandboxProvider();
}
