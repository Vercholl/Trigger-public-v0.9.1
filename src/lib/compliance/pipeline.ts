// Pre-send compliance pipeline (отписка блокирует ТОЛЬКО маркетинговые SMS).
// Проверки строго по порядку:
// 1) валидность телефона E.164 → INVALID_PHONE (любые сообщения)
// 2) МАРКЕТИНГОВЫЕ проверки — только для isMarketing:
//    2а) отписка (client.unsubscribedAt или список) → UNSUBSCRIBED
//    2б) client.notificationActive === false (аналог person_exclude) → ADVERT_OFF
//    2в) согласие != GRANTED → NO_CONSENT
// 3) дневной лимит клиента → LIMIT_CLIENT
// 4) системный дневной лимит → LIMIT_SYSTEM
// 5) тихие часы — ТОЛЬКО для маркетинговых шаблонов → RESCHEDULE
// Иначе — Allow. Сервисные SMS (напоминания об оплате, статусы, коды) проходят
// при любом статусе отписки/рекламного разрешения.
// Лимиты считаются по sms_messages за текущие сутки: клиентский — в ЛОКАЛЬНЫХ
// сутках клиента (client.timezone), системный — в корпоративной зоне
// (DEFAULT_TIMEZONE, по умолчанию Asia/Novosibirsk); «отправленными» считаются
// только фактически ушедшие/ожидающие (QUEUED/SENDING/SENT/DELIVERED): отменённые
// ({{#cancel}}, отмена рассылки) и провалившиеся сообщения лимит не расходуют.
import type { Client, SmsTemplate, AppSettings } from '@prisma/client';
import { db } from '@/lib/db';
import { isQuietHour, getLocalHour, nextAllowedTime } from '@/lib/compliance/quiet-hours';
import { wallPartsInZone, zonedTimeToUtc } from '@/lib/time';

export type RejectReason =
  | 'INVALID_PHONE'
  | 'UNSUBSCRIBED'
  | 'ADVERT_OFF'
  | 'NO_CONSENT'
  | 'LIMIT_CLIENT'
  | 'LIMIT_SYSTEM'
  | 'RENDER_ERROR'
  | 'SMS_TOO_LONG' // частей больше maxSegments шаблона — сообщение не отправляется
  | 'TEMPLATE_CANCEL'; // шаблон отменил отправку ({{#cancel}})

export type PipelineDecision =
  | { decision: 'ALLOW' }
  | { decision: 'REJECT'; reason: Exclude<RejectReason, 'RENDER_ERROR' | 'SMS_TOO_LONG' | 'TEMPLATE_CANCEL'> }
  | { decision: 'RESCHEDULE'; nextAllowedAt: Date };

/** Человекочитаемые тексты причин отказа (для sms_messages/таймлайна). */
export const REJECT_REASON_TEXT: Record<RejectReason, string> = {
  INVALID_PHONE: 'Недопустимый номер телефона',
  UNSUBSCRIBED: 'Клиент отписался',
  ADVERT_OFF: 'Клиент отключил рекламные SMS (notification_active=false)',
  NO_CONSENT: 'Нет согласия на рекламную рассылку',
  LIMIT_CLIENT: 'Превышен дневной лимит сообщений для клиента',
  LIMIT_SYSTEM: 'Превышен системный дневной лимит сообщений',
  RENDER_ERROR: 'Ошибка рендера шаблона',
  SMS_TOO_LONG: 'Превышен лимит частей SMS для шаблона',
  TEMPLATE_CANCEL: 'Отправка отменена шаблоном',
};

export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Начало «сегодняшних» суток в зоне (локальная полночь → UTC-момент).
 *  Некорректная зона → UTC-полночь (тот же фолбэк, что у тихих часов). */
function startOfLocalDay(timeZone: string, now: Date = new Date()): Date {
  const parts = wallPartsInZone(now, timeZone);
  if (!parts) return startOfUtcDay(now);
  return zonedTimeToUtc(parts.y, parts.m, parts.d, 0, 0, timeZone);
}

export interface PipelineInput {
  client: Client;
  template: Pick<SmsTemplate, 'isMarketing'>;
  settings: AppSettings;
  /** Сообщение, которое сейчас отправляется (рассылки): исключается из подсчёта
   * дневных лимитов — иначе при лимите N клиент фактически получал бы N−1. */
  excludeMessageId?: string;
}

export async function runCompliancePipeline(input: PipelineInput): Promise<PipelineDecision> {
  const { client, template, settings } = input;

  // 1. Валидность номера — для всех сообщений
  if (!isValidE164(client.phone)) {
    return { decision: 'REJECT', reason: 'INVALID_PHONE' };
  }

  // 2. Рекламные проверки — только для маркетинговых шаблонов:
  //    отписка, рекламное разрешение из карточки и согласие блокируют
  //    РЕКЛАМУ, но не сервисные сообщения (оплата/статусы/коды).
  if (template.isMarketing) {
    if (client.unsubscribedAt !== null) {
      return { decision: 'REJECT', reason: 'UNSUBSCRIBED' };
    }
    const inList = await db.unsubscribeList.findUnique({ where: { phone: client.phone } });
    if (inList) {
      return { decision: 'REJECT', reason: 'UNSUBSCRIBED' };
    }
    if (client.notificationActive === false) {
      return { decision: 'REJECT', reason: 'ADVERT_OFF' };
    }
    if (client.smsConsentStatus !== 'GRANTED') {
      return { decision: 'REJECT', reason: 'NO_CONSENT' };
    }
  }

  // 3/4. Дневные лимиты (только фактически ушедшие/ожидающие):
  //  - лимит КЛИЕНТА — по ЛОКАЛЬНЫМ суткам клиента (client.timezone): граница
  //    UTC-суток попадает серединой локального дня (03:00 МСК) — клиент мог
  //    получить 6 SMS за один календарный день при лимите 3 («03:00 МСК — новый
  //    день»); локальная полночь — естественная семантика комплаенс-лимита;
  //  - СИСТЕМНЫЙ лимит — по корпоративной зоне DEFAULT_TIMEZONE (единое окно
  //    бюджета на сутки для всей базы, utc-полночь была бы тем же сдвигом).
  const clientDayStart = startOfLocalDay(client.timezone);
  const systemDayStart = startOfLocalDay(
    process.env.DEFAULT_TIMEZONE?.trim() || 'Asia/Novosibirsk',
  );
  const selfExclude = input.excludeMessageId !== undefined ? { id: { not: input.excludeMessageId } } : {};
  if (settings.dailyClientLimit > 0) {
    const clientCount = await db.smsMessage.count({
      where: {
        clientId: client.id,
        createdAt: { gte: clientDayStart },
        status: { in: ['QUEUED', 'SENDING', 'SENT', 'DELIVERED'] },
        ...selfExclude,
      },
    });
    if (clientCount >= settings.dailyClientLimit) {
      return { decision: 'REJECT', reason: 'LIMIT_CLIENT' };
    }
  }
  if (settings.systemDailyLimit > 0) {
    const systemCount = await db.smsMessage.count({
      where: {
        createdAt: { gte: systemDayStart },
        status: { in: ['QUEUED', 'SENDING', 'SENT', 'DELIVERED'] },
        ...selfExclude,
      },
    });
    if (systemCount >= settings.systemDailyLimit) {
      return { decision: 'REJECT', reason: 'LIMIT_SYSTEM' };
    }
  }

  // 5. Тихие часы — только маркетинговые сообщения
  if (template.isMarketing) {
    const localHour = getLocalHour(new Date(), client.timezone);
    if (isQuietHour(localHour, settings.quietHoursStart, settings.quietHoursEnd)) {
      return {
        decision: 'RESCHEDULE',
        nextAllowedAt: nextAllowedTime(
          new Date(),
          client.timezone,
          settings.quietHoursStart,
          settings.quietHoursEnd,
        ),
      };
    }
  }

  return { decision: 'ALLOW' };
}
