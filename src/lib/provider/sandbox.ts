// Sandbox-провайдер: имитирует отправку — мгновенно «доставляет» сообщение
// и возвращает сгенерированный идентификатор. Реальной отправки нет (dev/приёмка).
//
// Когда используется: settings.provider = 'sandbox' (значение по умолчанию в
// свежей установке, задаётся env SMS_PROVIDER при первом чтении настроек) и
// ЛЮБОЕ неизвестное имя провайдера в getProvider() — безопасный дефолт,
// исключающий реальную отправку из тестовых/случайно сконфигурированных систем.
//
// Что делает с данными: send всегда возвращает ok=true с id вида sbx-<uuid> и
// immediateDelivery=true — движок (executors.ts) запишет в SmsMessage статус
// DELIVERED + deliveredAt «сейчас» и событие доставки в журнал «захвата событий»
// (journalSendOutcome). Т.е. полный конвейер (комплаенс → рендер → журнал →
// статусы) отрабатывает как у боевого провайдера — меняется только последний шаг.
// Параметры запроса игнорируются (никаких проверок номера/текста/отправителя).
import { randomUUID } from 'crypto';
import type { SmsProvider, SmsRequest, SendResult, DeliveryStatus } from '@/lib/provider/types';

/** Тестовый провайдер-имитатор: успех + мгновенная «доставка» любой отправки. */
export class SandboxProvider implements SmsProvider {
  readonly name = 'sandbox';

  /** Имитация: ok=true, sbx-<uuid> как providerMessageId, immediateDelivery=true
   * (см. шапку файла — журнал и статусы пишутся как для реальной доставки). */
  async send(req: SmsRequest): Promise<SendResult> {
    void req; // параметры не используются: песочница не отправляет ничего
    return {
      ok: true,
      providerMessageId: `sbx-${randomUUID()}`,
      immediateDelivery: true,
    };
  }

  /** Статус «сообщения» песочницы — всегда DELIVERED (реконсиляция ничего не меняет). */
  async status(_providerMessageId: string): Promise<DeliveryStatus> {
    void _providerMessageId;
    return 'DELIVERED';
  }
}
