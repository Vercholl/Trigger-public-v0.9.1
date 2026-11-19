// «Захват событий» — единый реестр «кому какие СМС отправили и что с ними
// стало». Шесть частей:
//  1) приёмник POST /api/v1/hooks/events — внешние события (JSON-батч);
//  2) append-only журнал MessageEvent (сырой payload + связка с SMS);
//  3) обработка: статусы наших SMS + отписка по unsub_sms;
//  4) журналирование событий из webhook-ов шлюзов и send-путей движка;
//  5) реконсиляция зависших статусов (status() провайдеров) — воркер;
//  6) карточка в «Интеграциях» (тумблер/токен/тест) и раздел «События доставки».
// Тумблер AppSettings.hooksEnabled: выключен → приёмник отвечает OK без записи,
// журналирование и реконсиляция не выполняются (статусы SMS-лога — как раньше).
// Вызывается из API-роутов: /api/v1/hooks (GET-конфиг/PUT-тумблер), /hooks/token
// (POST — ротация), /hooks/events (POST-приёмник), /hooks/test
// (POST — тест-кнопка), /api/v1/message-events (GET-журнал); journalSmsEvent
// вызывают webhook-роуты smstech/t2 и send-пути движка, реконсиляция — воркер.
// Таблицы Prisma: MessageEvent (журнал), AppSettings (hooksEnabled/hooksToken),
// SmsMessage (статусы), UnsubscribeList + Client (отписка), AuditLog.
import { z } from 'zod';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';
import { getSettings } from '@/lib/services/settings';
import { normalizePhone } from '@/lib/services/clients';
import { maskPhone } from '@/lib/compliance/disclaimer';

export const HOOKS_PATH = '/api/v1/hooks/events';

/** Типы событий, принимаемые приёмником (формат внешних событий). */
export const SMS_EVENT_TYPES = [
  'send_sms',
  'deliv_sms',
  'undeliv_sms',
  'click_sms',
  'uclick_sms',
  'unsub_sms',
] as const;

/** Проверка ошибки Prisma на нарушение уникальности (P2002) — дедуп-гонка. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/** Новый токен приёмника: 32 символа base64url (24 байта энтропии). */
function newToken(): string {
  // 32 символа base64url — безопасно для query-параметра URL
  return randomBytes(24).toString('base64url');
}

/** Timing-safe сверка токена приёмника: сравниваем sha256-хеши фиксированной
 *  длины — не раскрываются ни длина, ни содержимое токена. */
export function hooksTokenMatches(got: string, expected: string): boolean {
  const a = got.trim();
  const b = expected.trim();
  if (a === '' || b === '') return false;
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

// ---------- Слой 6а: конфигурация (тумблер + токен) ----------

/** Конфиг карточки «Захват событий» для UI: тумблер, токен (плейнтекстом —
 *  авторизованным ADMIN/MANAGER), URL приёмника и статистика журнала.
 *  Чтение — без побочных эффектов. */
export async function getHooksConfig(baseUrl: string): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  const [eventsTotal, lastEvent] = await Promise.all([
    db.messageEvent.count(),
    db.messageEvent.findFirst({ orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
  ]);
  return {
    enabled: settings.hooksEnabled,
    token: settings.hooksToken, // виден в URL приёмника — отдаём авторизованным
    tokenSet: settings.hooksToken.trim() !== '',
    path: HOOKS_PATH,
    url: `${baseUrl.replace(/\/$/, '')}${HOOKS_PATH}`,
    method: 'POST',
    eventsTotal,
    lastEventAt: lastEvent?.receivedAt ?? null,
  };
}

/** Схема переключения тумблера: одно булево поле enabled. */
export const setHooksEnabledSchema = z.object({
  enabled: z.boolean(),
});

/** Переключение захвата. Побочные эффекты: запись AppSettings.hooksEnabled;
 *  включение при пустом токене сразу генерирует новый (чтобы приёмник не остался
 *  без защиты), audit-лог UPDATE. */
export async function setHooksEnabled(
  dto: z.infer<typeof setHooksEnabledSchema>,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  await getSettings(); // гарантируем существование singleton-строки
  const data: Record<string, unknown> = { hooksEnabled: dto.enabled };
  // Включение без токена — генерируем сразу, чтобы приёмник не остался закрытым
  const current = await db.appSettings.findUnique({ where: { id: 'app' }, select: { hooksToken: true } });
  if (dto.enabled && (current?.hooksToken ?? '').trim() === '') {
    data.hooksToken = newToken();
  }
  await db.appSettings.update({ where: { id: 'app' }, data });
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.SETTINGS,
    entityId: 'app',
    details: { hooksEnabled: dto.enabled, tokenGenerated: data.hooksToken !== undefined },
    ip,
  });
  return { enabled: dto.enabled, tokenGenerated: data.hooksToken !== undefined };
}

/** Ротация токена приёмника: старый токен мгновенно перестаёт действовать
 *  (новый нужно обновить в настройках отправителя событий).
 *  Побочные эффекты: запись AppSettings.hooksToken, audit-лог UPDATE. */
export async function regenerateHooksToken(user: SessionUser, ip: string): Promise<Record<string, unknown>> {
  await getSettings();
  const token = newToken();
  await db.appSettings.update({ where: { id: 'app' }, data: { hooksToken: token } });
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.SETTINGS,
    entityId: 'app',
    details: { hooksTokenRotated: true },
    ip,
  });
  return { ok: true };
}

// ---------- Слой 2: журнал ----------

/** Вход журналирования события доставки: источник (panel/smstech/t2/mts), тип,
 *  связи с SMS/клиентом, телефон, провайдер, дата события, внешние id, сырой
 *  payload и обязательный dedupKey (уникальность — см. journalSmsEvent). */
export interface SmsEventInput {
  source: 'panel' | 'smstech' | 't2' | 'mts';
  eventType: string;
  smsMessageId?: string | null;
  clientId?: string | null;
  phone?: string | null;
  provider?: string | null;
  eventDate?: Date;
  externalIds?: Record<string, unknown> | null;
  payload: unknown;
  dedupKey: string;
  result?: Record<string, unknown> | null;
}

/**
 * Единая точка записи в журнал. Возвращает созданную строку или null (дубль).
 * Тумблер: выключенный захват → тихий no-op (статусы SMS обновляет вызывающий,
 * журнал — часть истории захвата).
 */
export async function journalSmsEvent(input: SmsEventInput): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.hooksEnabled) return false;
  // Pre-check дедуп-ключа: повторные уведомления шлюзов — частый случай,
  // дешевле SELECT по индексу, чем исключение уникальности в логах.
  const existing = await db.messageEvent.findUnique({
    where: { dedupKey: input.dedupKey },
    select: { id: true },
  });
  if (existing) return false;
  try {
    await db.messageEvent.create({
      data: {
        source: input.source,
        eventType: input.eventType,
        eventDate: input.eventDate ?? new Date(),
        phone: input.phone ?? null,
        provider: input.provider ?? null,
        smsMessageId: input.smsMessageId ?? null,
        clientId: input.clientId ?? null,
        externalIds: input.externalIds ? JSON.stringify(input.externalIds) : null,
        payload: JSON.stringify(input.payload ?? {}),
        dedupKey: input.dedupKey,
        status: 'PROCESSED',
        result: input.result ? JSON.stringify(input.result) : null,
      },
    });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false; // ретрай отправителя — уже записано
    console.error('[hooks] journalSmsEvent failed:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Журналирование успешной отправки из send-путей движка (воронки/рассылки). */
export async function journalSendOutcome(args: {
  smsId: string;
  clientId: string | null;
  phone: string;
  provider: string;
  providerMessageId: string | null;
  immediateDelivery: boolean;
  broadcastId?: string | null;
  broadcastName?: string | null;
  templateName?: string | null;
}): Promise<void> {
  const eventDate = new Date();
  const externalIds: Record<string, unknown> = {
    send_message_id: args.providerMessageId,
    ...(args.broadcastId ? { campaign_id: args.broadcastId } : {}),
  };
  const base = {
    source: 'panel' as const,
    smsMessageId: args.smsId,
    clientId: args.clientId,
    phone: args.phone,
    provider: args.provider,
    eventDate,
    externalIds,
  };
  // Событие отправки — всегда; мгновенная доставка (песочница) — вторым событием
  await journalSmsEvent({
    ...base,
    eventType: 'send_sms',
    dedupKey: `send:${args.smsId}`,
    payload: {
      sms_id: args.smsId,
      phone: maskPhone(args.phone),
      provider: args.provider,
      provider_message_id: args.providerMessageId,
      template: args.templateName ?? null,
      broadcast: args.broadcastName ?? null,
      at: eventDate.toISOString(),
    },
    result: { observed: 'engine-send' },
  });
  if (args.immediateDelivery) {
    await journalSmsEvent({
      ...base,
      eventType: 'deliv_sms',
      dedupKey: `deliver:${args.smsId}`,
      payload: {
        sms_id: args.smsId,
        phone: maskPhone(args.phone),
        provider: args.provider,
        immediate: true,
        at: eventDate.toISOString(),
      },
      result: { observed: 'engine-send', immediate: true },
    });
  }
}

// ---------- Приёмник внешних событий ----------

export interface HookProcessSummary {
  accepted: number; // валидных событий в батче
  created: number; // записано в журнал
  duplicates: number; // пропущено как дубли ретраев
  invalid: number; // мусорные элементы батча
  unsubscribed: number;
  smsUpdated: number;
}

/** Структура внешнего события после маппинга из сырого JSON отправителя
 *  (парсинг — parseExtEvent; поля externalIds соответствуют таблице
 *  external_message из контракта интеграции). */
interface ParsedExtEvent {
  eventType: string;
  eventDate: Date;
  eventDateRaw: string;
  accountId: string;
  profileId: string;
  phone: string | null;
  personId: string | null;
  externalIds: Record<string, unknown>;
  tgSmsId: string | null;
  /** true — событие помечено отправителем как тестовое (is_test). */
  isTest: boolean;
  raw: Record<string, unknown>;
}

function pickStr(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

// subscription приходит И объектом {channel:"sms", phone}, И массивом таких
// объектов. Берём запись SMS-канала, иначе первую с телефоном — телефон адресата
// нужен для реестра/отписки.
function subscriptionEntry(raw: Record<string, unknown>): Record<string, unknown> {
  const s = raw.subscription;
  if (Array.isArray(s)) {
    const items = s.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
    return (
      items.find((v) => pickStr(v.channel) === 'sms') ?? items.find((v) => pickStr(v.phone) !== null) ?? {}
    );
  }
  if (typeof s === 'object' && s !== null) return s as Record<string, unknown>;
  return {};
}

// content (текст SMS + имя отправителя) может лежать top-level ИЛИ внутри
// custom_data — проверяем оба места.
function contentEntry(raw: Record<string, unknown>, customData: Record<string, unknown>): Record<string, unknown> {
  const c = raw.content;
  if (typeof c === 'object' && c !== null && !Array.isArray(c)) return c as Record<string, unknown>;
  const cc = customData.content;
  if (typeof cc === 'object' && cc !== null && !Array.isArray(cc)) return cc as Record<string, unknown>;
  return {};
}

function parseExtEvent(item: unknown): ParsedExtEvent | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  const raw = item as Record<string, unknown>;
  const eventType = pickStr(raw.event_type);
  if (eventType === null) return null;

  const eventDateRaw = pickStr(raw.event_date) ?? '';
  let eventDate = new Date();
  if (eventDateRaw !== '') {
    const d = new Date(eventDateRaw);
    if (!Number.isNaN(d.getTime())) eventDate = d;
  }

  const subscription = subscriptionEntry(raw);
  const customData =
    typeof raw.custom_data === 'object' && raw.custom_data !== null && !Array.isArray(raw.custom_data)
      ? (raw.custom_data as Record<string, unknown>)
      : {};
  const eventData =
    typeof raw.event_data === 'object' && raw.event_data !== null && !Array.isArray(raw.event_data)
      ? (raw.event_data as Record<string, unknown>)
      : {};
  const content = contentEntry(raw, customData);

  const phoneRaw = pickStr(subscription.phone) ?? pickStr(customData.phone);
  const phone = phoneRaw !== null ? normalizePhone(phoneRaw) : null;
  // client_id в custom_data — ID клиента в системе данных (наш Client.externalId)
  const personId = pickStr(customData.client_id) ?? pickStr(customData.person_id);

  // Маппинг идентификаторов внешнего события (таблица external_message):
  // owner_message_id=message_id, campaign_id, provider_message_id=send_message_id,
  // provider_full_message_id=full_message_id (на практике часто не приходит),
  // error_code=undeliv_code, error_message=undeliv_message.
  const externalIds: Record<string, unknown> = {};
  for (
    const key of [
      'message_id',
      'campaign_id',
      'launch_id',
      'segment_id',
      'resource_id',
      'send_message_id',
      'full_message_id',
      'workflow_id',
      'undeliv_code',
      'undeliv_message',
    ]
  ) {
    const v = eventData[key];
    if (v !== undefined && v !== null) externalIds[key] = v;
  }
  // Тоже из external_message: campaign_name/template_name из custom_data-шаблонов
  // {{campaign_name}}/{{message_name}}, person_id=client_id, текст и отправитель — из content.
  const campaignName = pickStr(customData.campaign_name);
  const templateName = pickStr(customData.message_name);
  const messageText = pickStr(content.sms);
  const messageSender = pickStr(content.fromnamesms);
  if (campaignName !== null) externalIds.campaign_name = campaignName;
  if (personId !== null) externalIds.person_id = personId;
  if (templateName !== null) externalIds.template_name = templateName;
  if (messageText !== null) externalIds.message_text = messageText;
  if (messageSender !== null) externalIds.message_sender = messageSender;

  return {
    eventType,
    eventDate,
    eventDateRaw,
    accountId: pickStr(raw.account_id) ?? '-',
    profileId: pickStr(raw.profile_id) ?? '-',
    phone: phone ?? phoneRaw,
    personId,
    externalIds,
    tgSmsId: pickStr(customData.tg_sms_id),
    isTest: raw.is_test === true,
    raw,
  };
}

/** Обработка одного внешнего события: журнал + эффекты (статус/отписка).
 *  Побочные эффекты: запись MessageEvent, обновление статуса SmsMessage,
 *  upsert UnsubscribeList + Client.unsubscribedAt (unsub_sms), audit-лог
 *  отписки (user:null — системный). Дубликат по dedupKey — без эффектов. */
async function applyExtEvent(ev: ParsedExtEvent): Promise<{
  outcome: 'created' | 'duplicate';
  smsUpdated: boolean;
  unsubscribed: boolean;
}> {
  // Дедуп: event_date наносекундный — уникален в пределах события;
  // message_id/send_message_id стабилизируют ключ при секундной точности
  // event_date (разные события одного профиля в одну секунду не должны
  // склеиваться — иначе часть отправок молча терялась из реестра).
  // Нет event_date — хеш сырого payload: ретраи идентичного тела дедупятся,
  // разные события — нет. Проверка ДО эффектов: повторная доставка ретрая
  // не должна повторно трогать статус SMS/отписку.
  const msgTail = pickStr(ev.externalIds.message_id) ?? pickStr(ev.externalIds.send_message_id) ?? '';
  const dedupTail =
    ev.eventDateRaw !== ''
      ? ev.eventDateRaw
      : `hash:${createHash('sha256').update(JSON.stringify(ev.raw)).digest('hex').slice(0, 16)}`;
  const dedupKey = `ext:${ev.accountId}:${ev.eventType}:${ev.profileId !== '-' ? ev.profileId : ev.phone ?? '-'}:${msgTail}:${dedupTail}`;
  const alreadySeen = await db.messageEvent.findUnique({ where: { dedupKey }, select: { id: true } });
  if (alreadySeen) return { outcome: 'duplicate', smsUpdated: false, unsubscribed: false };

  // Тестовое событие внешней платформы (инструмент предтеста, is_test=true) —
  // журнал-онли: фиксируется в реестре, но отписка, статусы SMS и корреляция
  // НЕ применяются. Внутренняя кнопка панели шлёт событие БЕЗ is_test
  // (маркировка — в custom_data.note): её назначение — проверить ВЕСЬ
  // конвейер, включая эффекты.
  const result: Record<string, unknown> = {};
  if (ev.isTest) {
    result.test = true;
    result.note = 'Тестовое событие — побочные эффекты пропущены';
  }

  // Корреляция с нашей SMS: явный tg_sms_id в custom_data (тест-кнопка и
  // будущие интеграции). Телефонную корреляцию НЕ делаем: при параллельной
  // отправке через внешний сервис ложные совпадения портят статусы.
  let smsMessageId: string | null = null;
  let smsRow: { id: string; status: string; provider: string; phone: string; clientId: string | null } | null = null;
  if (!ev.isTest && ev.tgSmsId !== null) {
    smsRow = await db.smsMessage.findUnique({
      where: { id: ev.tgSmsId },
      select: { id: true, status: true, provider: true, phone: true, clientId: true },
    });
    if (smsRow) smsMessageId = smsRow.id;
  }

  // Клиент для аналитики внешних событий: приоритет — person_id (client_id из
  // custom_data = ID клиента в системе данных = наш Client.externalId), затем телефон.
  let client: { id: string } | null = null;
  if (!ev.isTest) {
    if (ev.personId !== null) {
      client = await db.client.findUnique({ where: { externalId: ev.personId }, select: { id: true } });
    }
    if (!client && ev.phone) {
      client = await db.client.findFirst({ where: { phone: ev.phone }, select: { id: true } });
    }
  }
  const clientId = smsRow?.clientId ?? client?.id ?? null;

  // Эффект 1: статус нашей SMS (только при явной корреляции)
  let smsUpdatedFlag = false;
  if (smsRow) {
    const data: Record<string, unknown> = {};
    // Гард: событие о доставке/недоставке по ещё не отправлявшейся SMS
    // (QUEUED — отложенная рассылка/в очереди, SENDING — claim в разгаре
    // отправки) — аномалия: статус не трогаем, причину честно пишем в журнал.
    const notSentYet = smsRow.status === 'QUEUED' || smsRow.status === 'SENDING';
    // neverSent: отклонённые комплаенсом/отменённые до отправки сообщения не
    // уходили оператору — внешнее событие не могло их отправить/доставить:
    // терминальный статус не переворачивается (раньше send_sms/deliv_sms
    // могли «воскресить» REJECTED/CANCELLED в SENT/DELIVERED).
    const neverSent = smsRow.status === 'REJECTED_BY_COMPLIANCE' || smsRow.status === 'CANCELLED';
    if (ev.eventType === 'send_sms' && !neverSent && !['DELIVERED', 'FAILED', 'SENT'].includes(smsRow.status)) {
      data.status = 'SENT';
      data.sentAt = ev.eventDate;
    } else if (ev.eventType === 'send_sms' && neverSent) {
      result.skipped = `SMS already ${smsRow.status}`;
    } else if (ev.eventType === 'deliv_sms') {
      if (notSentYet || neverSent) {
        result.skipped = `SMS not sent (status ${smsRow.status})`;
      } else {
        data.status = 'DELIVERED';
        data.deliveredAt = ev.eventDate;
        data.error = null;
      }
    } else if (ev.eventType === 'undeliv_sms') {
      if (notSentYet || neverSent) {
        result.skipped = `SMS not sent (status ${smsRow.status})`;
      } else {
        const code = ev.externalIds.undeliv_code ?? null;
        const message = pickStr(ev.externalIds.undeliv_message);
        data.status = 'FAILED';
        data.error =
          message !== null
            ? `Внешний захват: не доставлено${code !== null ? ` (код ${code})` : ''}: ${message}`
            : 'Внешний захват: не доставлено';
      }
    }
    if (Object.keys(data).length > 0) {
      await db.smsMessage.update({ where: { id: smsRow.id }, data });
      result.smsUpdated = data.status;
    } else {
      result.smsStatusUnchanged = smsRow.status;
    }
    smsUpdatedFlag = Object.keys(data).length > 0;
  }

  // Эффект 2: отписка (unsub_sms) — валидна независимо от того, кто отправлял SMS
  let unsubscribedFlag = false;
  if (!ev.isTest && (ev.eventType === 'unsub_sms' || ev.eventType === 'unsub') && ev.phone) {
    const existing = await db.unsubscribeList.findUnique({ where: { phone: ev.phone } });
    await db.unsubscribeList.upsert({
      where: { phone: ev.phone },
      create: { phone: ev.phone, source: 'HOOK', clientId },
      update: { clientId },
    });
    if (clientId) {
      const c = await db.client.findUnique({ where: { id: clientId }, select: { unsubscribedAt: true } });
      if (c && c.unsubscribedAt === null) {
        await db.client.update({ where: { id: clientId }, data: { unsubscribedAt: ev.eventDate } });
      }
    }
    result.unsubscribed = true;
    result.unsubCreated = existing === null;
    unsubscribedFlag = true;
    await logAudit({
      user: null,
      action: AuditAction.UNSUBSCRIBE,
      entityType: AuditEntity.CLIENT,
      entityId: clientId,
      details: { phone: maskPhone(ev.phone), source: 'HOOK' },
      ip: null,
    }).catch(() => undefined);
  }

  if (Object.keys(result).length === 0) result.registry = true;

  const existing = await db.messageEvent.findUnique({ where: { dedupKey }, select: { id: true } });
  if (existing) return { outcome: 'duplicate', smsUpdated: false, unsubscribed: false };

  try {
    await db.messageEvent.create({
      data: {
        source: 'external',
        eventType: ev.eventType,
        eventDate: ev.eventDate,
        phone: ev.phone,
        provider: smsRow?.provider ?? null,
        smsMessageId,
        clientId,
        externalIds: Object.keys(ev.externalIds).length > 0 ? JSON.stringify(ev.externalIds) : null,
        payload: JSON.stringify(ev.raw),
        dedupKey,
        status: 'PROCESSED',
        result: JSON.stringify(result),
      },
    });
    return { outcome: 'created', smsUpdated: smsUpdatedFlag, unsubscribed: unsubscribedFlag };
  } catch (e) {
    if (isUniqueViolation(e)) return { outcome: 'duplicate', smsUpdated: false, unsubscribed: false };
    throw e;
  }
}

/** Потолок батча: больше — 413 (ProblemDetails). Идемпотентность по dedupKey
 *  делает безопасной повторную отправку меньшими батчами — ретраи не дублируются. */
export const MAX_HOOK_BATCH = 5000;
/** Порция обработки: длинный батч не занимает цикл одним куском. */
const HOOK_CHUNK = 500;

/**
 * Ядро приёмника: батч (JSON-массив) или одиночное внешнее событие.
 * Используется HTTP-роутом и кнопкой «Отправить тестовое событие».
 * Тихого среза батча нет: либо обрабатываются все события, либо 413.
 */
export async function processHookEvents(body: unknown): Promise<HookProcessSummary> {
  const items = Array.isArray(body) ? body : [body];
  if (items.length > MAX_HOOK_BATCH) {
    throw new ApiError(
      413,
      'Батч слишком большой',
      `Событий в батче ${items.length} — максимум ${MAX_HOOK_BATCH}. Разбейте отправку на меньшие батчи: идемпотентность по dedupKey делает повтор безопасным`,
    );
  }
  const summary: HookProcessSummary = {
    accepted: 0,
    created: 0,
    duplicates: 0,
    invalid: 0,
    unsubscribed: 0,
    smsUpdated: 0,
  };

  for (let start = 0; start < items.length; start += HOOK_CHUNK) {
    for (const item of items.slice(start, start + HOOK_CHUNK)) {
      const parsed = parseExtEvent(item);
      if (parsed === null) {
        summary.invalid += 1;
        continue;
      }
      summary.accepted += 1;
      const applied = await applyExtEvent(parsed);
      if (applied.outcome === 'created') summary.created += 1;
      else summary.duplicates += 1;
      if (applied.smsUpdated) summary.smsUpdated += 1;
      if (applied.unsubscribed) summary.unsubscribed += 1;
    }
  }
  return summary;
}

// ---------- Тестовое событие (кнопка в «Интеграциях») ----------

/** Тестовое событие из панели («Отправить тестовое событие»): собирает
 *  полный формат deliv_sms для реальной SMS и прогоняет через тот же
 *  конвейер processHookEvents (эффекты применяются — проверка всего пути).
 *  Побочные эффекты: запись MessageEvent, обновление SmsMessage (DELIVERED),
 *  audit-лог RUN. Возвращает статус SMS после применения. */
export async function sendTestHookEvent(
  user: SessionUser,
  ip: string,
  opts: { smsId?: string | null } = {},
): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  if (!settings.hooksEnabled) {
    throw new ApiError(409, 'Захват событий выключен', 'Включите тумблер, чтобы проверить приёмник');
  }

  // Цель теста: указанная SMS (smsId из запроса) → свежая в полёте
  // (SENT/QUEUED/SENDING) → последняя уже отправлявшаяся (SENT/SENDING/FAILED).
  // Фолбэк ограничен отправлявшимися: тестовое deliv_sms не должно помечать
  // «доставленной» отменённую, отклонённую комплаенсом или ещё не отправленную
  // (отложенную) SMS — это искажало статистику доставляемости.
  const select = {
    id: true,
    phone: true,
    status: true,
    provider: true,
    providerMessageId: true,
    clientId: true,
  } as const;
  let target: {
    id: string;
    phone: string;
    status: string;
    provider: string;
    providerMessageId: string | null;
    clientId: string | null;
  } | null = null;
  const wantedSmsId = opts.smsId?.trim() ?? '';
  if (wantedSmsId !== '') {
    target = await db.smsMessage.findUnique({ where: { id: wantedSmsId }, select });
    if (!target) {
      throw new ApiError(422, 'SMS не найдена', `Сообщение ${wantedSmsId} не существует`);
    }
  } else {
    target = await db.smsMessage.findFirst({
      where: { status: { in: ['SENT', 'QUEUED', 'SENDING'] } },
      orderBy: { createdAt: 'desc' },
      select,
    });
    if (!target) {
      target = await db.smsMessage.findFirst({
        where: { status: { in: ['SENT', 'SENDING', 'FAILED'] } },
        orderBy: { createdAt: 'desc' },
        select,
      });
    }
  }
  if (!target) {
    throw new ApiError(
      422,
      'Нет SMS для теста',
      'Нет SMS в статусе SENT/FAILED — сначала отправьте тестовую SMS, либо укажите smsId',
    );
  }
  const phone = target.phone;

  // Событие — полный формат внешнего события (deliv_sms), корреляция через
  // custom_data. content + имена кампании/шаблона — как в реальном батче
  // с включённой опцией «Добавить содержимое сообщений» (проверяем полный маппинг).
  // is_test НЕ ставим: события с is_test=true от внешних систем идут
  // журнал-онли, а внутренняя кнопка обязана применять эффекты (проверка
  // конвейера) — маркировка внутреннего теста остаётся в custom_data.note.
  const event = {
    event_type: 'deliv_sms',
    event_date: new Date().toISOString(),
    account_id: 0,
    profile_id: null,
    list_id: null,
    subscription: { channel: 'sms', phone, status: 'subscribed', priority: 1, ccsub: null },
    event_data: {
      message_id: 0,
      segment_id: 0,
      campaign_id: 0,
      send_message_id: target.providerMessageId ?? null,
      full_message_id: target.providerMessageId ?? null,
    },
    custom_data: {
      tg_sms_id: target.id,
      campaign_name: 'Проверка приёмника',
      message_name: 'Тест захвата событий',
      note: 'Тест захвата событий из панели',
    },
    content: { sms: 'Тестовое событие захвата доставки (панель)', fromnamesms: 'DemoBrand' },
  };

  const summary = await processHookEvents([event]);
  await logAudit({
    user,
    action: AuditAction.RUN,
    entityType: AuditEntity.SETTINGS,
    entityId: 'app',
    details: { hookTest: true, smsId: target.id, created: summary.created },
    ip,
  });

  const smsAfter = await db.smsMessage.findUnique({
    where: { id: target.id },
    select: { id: true, status: true, deliveredAt: true },
  });

  return {
    ok: summary.created > 0,
    summary,
    smsId: target.id,
    sms: smsAfter,
    phone: maskPhone(phone),
  };
}

// ---------- Слой 6б: журнал для UI ----------

/** Журнал для UI «События доставки»: фильтры (телефон/тип/источник/период),
 *  пагинация, обогащение статусом связной SMS и ФИО клиента (порционными
 *  findMany-in — без N+1). Чтение — без побочных эффектов. */
export async function listMessageEvents(filters: {
  q?: string;
  type?: string;
  source?: string;
  periodDays?: number;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}): Promise<Record<string, unknown>> {
  const where: Record<string, unknown> = {};
  const q = filters.q?.trim();
  if (q && q !== '') where.phone = { contains: q };
  if (filters.type && filters.type !== 'ALL') where.eventType = filters.type;
  if (filters.source && filters.source !== 'ALL') where.source = filters.source;
  if (filters.periodDays && filters.periodDays > 0) {
    where.receivedAt = { gte: new Date(Date.now() - filters.periodDays * 24 * 60 * 60 * 1000) };
  }

  const [rows, total] = await Promise.all([
    db.messageEvent.findMany({ where, orderBy: { receivedAt: 'desc' }, skip: filters.skip, take: filters.take }),
    db.messageEvent.count({ where }),
  ]);

  // Обогащение: статус связанной SMS и externalId клиента — двумя порциями запросов
  const smsIds = [...new Set(rows.map((r) => r.smsMessageId).filter((v): v is string => v !== null))];
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((v): v is string => v !== null))];
  const smsById = new Map<
    string,
    { id: string; status: string; body: string; broadcastName: string | null; templateName: string | null }
  >();
  if (smsIds.length > 0) {
    const smsRows = await db.smsMessage.findMany({
      where: { id: { in: smsIds } },
      select: { id: true, status: true, body: true, broadcastName: true, templateName: true },
    });
    for (const s of smsRows) smsById.set(s.id, s);
  }
  const clientById = new Map<string, { id: string; externalId: string; firstName: string | null; lastName: string | null }>();
  if (clientIds.length > 0) {
    const clientRows = await db.client.findMany({
      where: { id: { in: clientIds } },
      select: { id: true, externalId: true, firstName: true, lastName: true },
    });
    for (const c of clientRows) clientById.set(c.id, c);
  }

  const items = rows.map((r) => {
    const sms = r.smsMessageId ? smsById.get(r.smsMessageId) ?? null : null;
    const client = r.clientId ? clientById.get(r.clientId) ?? null : null;
    // Поля внешнего события (маппинг external_message) — для UI
    let ext: Record<string, unknown> = {};
    if (r.externalIds) {
      try {
        ext = JSON.parse(r.externalIds) as Record<string, unknown>;
      } catch {
        ext = {};
      }
    }
    const extStr = (key: string): string | null => {
      const v = ext[key];
      return typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null;
    };
    return {
      id: r.id,
      source: r.source,
      eventType: r.eventType,
      eventDate: r.eventDate,
      receivedAt: r.receivedAt,
      phone: r.phone,
      provider: r.provider,
      smsMessageId: r.smsMessageId,
      smsStatus: sms?.status ?? null,
      smsBody: sms?.body ?? extStr('message_text'),
      broadcastName: sms?.broadcastName ?? extStr('campaign_name'),
      templateName: sms?.templateName ?? extStr('template_name'),
      campaignName: extStr('campaign_name'),
      messageSender: extStr('message_sender'),
      personId: extStr('person_id'),
      undelivCode: extStr('undeliv_code'),
      undelivMessage: extStr('undeliv_message'),
      clientId: r.clientId,
      clientExternalId: client?.externalId ?? null,
      clientName:
        client && (client.firstName || client.lastName)
          ? `${client.lastName ?? ''} ${client.firstName ?? ''}`.trim()
          : null,
      status: r.status,
      result: r.result,
      externalIds: r.externalIds,
      payload: r.payload,
    };
  });

  return { items, total, page: filters.page, pageSize: filters.pageSize };
}

/** Статистика доставляемости для раздела «События доставки».
 *  Данные: счётчики журнала MessageEvent (всего/24ч/по типам/источникам),
 *  последняя запись и delivery-блок за 30 дней по SmsMessage (sent/delivered/
 *  failed/inFlight + deliverability%). Чтение — без побочных эффектов. */
export async function messageEventStats(): Promise<Record<string, unknown>> {
  const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const cutoff24 = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [total, last24h, byTypeAll, bySourceAll, lastEvent, sent30, delivered30, failed30, inFlight30] =
    await Promise.all([
      db.messageEvent.count(),
      db.messageEvent.count({ where: { receivedAt: { gte: cutoff24 } } }),
      db.messageEvent.groupBy({ by: ['eventType'], _count: { _all: true } }),
      db.messageEvent.groupBy({ by: ['source'], _count: { _all: true } }),
      db.messageEvent.findFirst({ orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
      db.smsMessage.count({ where: { sentAt: { gte: cutoff30 }, status: { in: ['SENT', 'DELIVERED', 'FAILED'] } } }),
      db.smsMessage.count({ where: { sentAt: { gte: cutoff30 }, status: 'DELIVERED' } }),
      db.smsMessage.count({ where: { sentAt: { gte: cutoff30 }, status: 'FAILED' } }),
      db.smsMessage.count({ where: { sentAt: { gte: cutoff30 }, status: 'SENT' } }),
    ]);

  const byType: Record<string, number> = {};
  for (const g of byTypeAll) byType[g.eventType] = g._count._all;
  const bySource: Record<string, number> = {};
  for (const g of bySourceAll) bySource[g.source] = g._count._all;

  const deliverability = sent30 > 0 ? Math.round((delivered30 / sent30) * 100) : null;

  return {
    total,
    last24h,
    byType,
    bySource,
    lastEventAt: lastEvent?.receivedAt ?? null,
    delivery: { sent30, delivered30, failed30, inFlight30, deliverability },
  };
}
