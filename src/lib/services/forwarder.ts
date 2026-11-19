// Обратный поток событий «Trigger → внешний приёмник (messenger)» — outbound-форвардер (G3,
// формат обмена событиями 1:1). Три части:
//  1) конфигурация (AppSettings.forwarder*: тумблер/URL/токен/batchSize,
//     токен — AES-256-GCM enc:v1:, в API отдаётся только факт наличия);
//  2) очередь доставки at-least-once: колонки MessageEvent.forwardedAt/
//     forwardAttempts/forwardError/nextForwardAt/forwardSkip; тик воркера
//     (каждые 15 с) собирает due-батч, POST-ит на endpoint приёмника и
//     маркирует строки; 2xx — успех, иначе бэкофф-ретраи 15с×4 → 5м → 15м → 1ч
//     (кап) — событие не теряется НИКОГДА (at-least-once), их приёмник
//     дедуплицирует по event_type+message_id (требование формата обмена событиями);
//  3) статистика для карточки UI «Интеграции» + тест-кнопка (синпетическое
//     send_sms напрямую в настроенный URL — проверка связности/токена).
//
// ЧТО форвардится: события наших РЕАЛЬНЫХ отправок — source panel/mts/t2/
// smstech, провайдер НЕ sandbox, типы send_sms/deliv_sms/undeliv_sms. Внешние
// события (source=external, «Захват событий» от legacy) НЕ форвардятся — они
// пришли ИЗ внешнего контура; sandbox-отправки не форвардятся — «сухой»
// период не должен наполнять боевой BI песочными данными. Включение тумблера
// помечает уже накопленные события forwardSkip=true — полёт начинается с
// чистого момента включения («обратный поток включается с первой боевой
// отправки», фаза 3 плана интеграции).
//
// Маппинг в формат обмена событиями (контракт приёма):
//   event_type/event_date — из MessageEvent;
//   custom_data.{client_id,campaign_name,message_name} — externalId клиента,
//   имя рассылки/воронки, имя шаблона (снимки из SmsMessage);
//   event_data.{message_id,campaign_id,send_message_id,full_message_id} — наши
//   id (smsMessageId/campaign-uuid/providerMessageId); undeliv-события
//   дополняются undeliv_code/undeliv_message из externalIds/ошибки SMS;
//   subscription.phone; content.{sms,fromnamesms}.
// ⚠ id — строки UUID (не числовые id legacy-платформы): приёмник событий
//   хранит их как owner_message_id — при стыковке сверить, что формат принят
//   (иначе — переход на числовой seq).
// Вызывается из: воркер (processForwardTick), API-роуты
// /api/v1/integrations/forwarder (GET/PUT) и /forwarder/test (POST).
// Таблицы Prisma: MessageEvent (колонки очереди), AppSettings, AuditLog.
import { z } from 'zod';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import { decryptSecret, encryptSecret, maskSecret } from '@/lib/security/secrets';
import type { SessionUser } from '@/lib/security/session';
import { getSettings } from '@/lib/services/settings';

/** Форвардим только эти типы (send/deliv/undeliv — контракт обмена событиями;
 *  click/unsub — события внешних систем, нам не принадлежат).
 *  ВАЖНО: undeliv_sms (не «undel_sms») — в точности как eventType журнала
 *  MessageEvent и внешний контракт; опечатка здесь молча выкидывала бы
 *  недоставки из очереди обратного потока. */
const FORWARD_EVENT_TYPES = ['send_sms', 'deliv_sms', 'undeliv_sms'] as const;
/** Источники наших отправок (external — чужой поток «Захват событий»). */
const FORWARD_SOURCES = ['panel', 'mts', 't2', 'smstech'] as const;
/** Реальные провайдеры (sandbox — «сухой» период, в BI не летит). */
const FORWARD_PROVIDERS = ['mts', 't2', 'smstech'] as const;

/** Бэкофф ретраев: 4 попытки с шагом 15с (как ретраи legacy 4×15с), далее
 *  5м → 15м → 1ч (кап) — доставка возобновляется сама при восстановлении
 *  endpoint, не заваливая его повторами. */
const RETRY_DELAYS_MS = [15_000, 15_000, 15_000, 15_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const RETRY_CAP_MS = 60 * 60_000;

/** Таймаут HTTP-вызова приёмника событий. */
const FORWARD_TIMEOUT_MS = 15_000;

/** Конфиг форвардера (расшифрованный) — внутреннее потребление. */
interface ForwarderRuntimeConfig {
  enabled: boolean;
  url: string;
  token: string;
  batchSize: number;
}

/** Чтение конфига (расшифровка токена; пустой enc — токен не задан). */
async function forwarderRuntimeConfig(): Promise<ForwarderRuntimeConfig> {
  const settings = await getSettings();
  return {
    enabled: settings.forwarderEnabled,
    url: settings.forwarderUrl.trim(),
    token: decryptSecret(settings.forwarderToken).trim(),
    batchSize: settings.forwarderBatchSize,
  };
}

// ---------- Конфигурация: карточка UI + сохранение ----------

/** Конфиг для карточки «Обратный поток» (GET): токен — только маска/факт. */
export async function getForwarderConfig(): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  const tokenPlain = decryptSecret(settings.forwarderToken).trim();
  const stats = await forwarderStats();
  return {
    enabled: settings.forwarderEnabled,
    url: settings.forwarderUrl.trim(),
    tokenSet: tokenPlain !== '',
    tokenHint: tokenPlain !== '' ? maskSecret(tokenPlain) : null,
    batchSize: settings.forwarderBatchSize,
    eventTypes: FORWARD_EVENT_TYPES,
    authHeader: 'Authorization: Bearer <токен>',
    ...stats,
  };
}

/** Схема сохранения: URL https/http (допустим и http для тестовых приёмников
 *  внутри контура), токен (пустая строка — не менять; null — удалить),
 *  batchSize 10..2000, enabled — отдельно (см. setForwarderEnabled). */
export const saveForwarderSchema = z.object({
  url: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\//i.test(v), 'URL должен начинаться с http:// или https://'),
  token: z.string().max(500).nullish(), // пустая строка = не менять, null = удалить
  batchSize: z.number().int().min(10).max(2000).optional(),
});

export type SaveForwarderDto = z.infer<typeof saveForwarderSchema>;

/** Сохранение URL/токена/размера батча (ADMIN; лимит секретов — в роуте).
 *  Тумблер — отдельным вызовом setForwarderEnabled (там семантика forwardSkip).
 *  Побочные эффекты: запись AppSettings (токен — AES-256-GCM), audit-лог
 *  UPDATE/SETTINGS (только факт/длина, не значение). */
export async function saveForwarderConfig(
  dto: SaveForwarderDto,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  await getSettings(); // singleton-строка существует
  const data: Record<string, unknown> = { forwarderUrl: dto.url.trim() };
  let tokenChanged = false;
  if (dto.token === null) {
    data.forwarderToken = '';
    tokenChanged = true;
  } else if (typeof dto.token === 'string' && dto.token.trim() !== '') {
    data.forwarderToken = encryptSecret(dto.token.trim());
    tokenChanged = true;
  }
  if (dto.batchSize !== undefined) data.forwarderBatchSize = dto.batchSize;
  await db.appSettings.update({ where: { id: 'app' }, data });
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.SETTINGS,
    entityId: 'app',
    details: {
      forwarder: true,
      url: dto.url.trim() !== '' ? dto.url.trim() : null,
      tokenChanged,
      ...(typeof dto.token === 'string' && dto.token.trim() !== ''
        ? { tokenLength: dto.token.trim().length }
        : {}),
      ...(dto.batchSize !== undefined ? { batchSize: dto.batchSize } : {}),
    },
    ip,
  });
  return getForwarderConfig();
}

/** Схема тумблера. */
export const setForwarderEnabledSchema = z.object({ enabled: z.boolean() });

/** Тумблер обратного потока. ВКЛЮЧЕНИЕ:
 *  1) требует URL и токен (иначе 422 — приёмник без адреса не имеет смысла);
 *  2) помечает ВСЕ накопленные неотправленные события forwardSkip=true —
 *     в BI летят только события С МОМЕНТА включения (накопленное за «сухой»
 *     период/выключенный период задним числом не нужно: это песочница или
 *     уже учтённое legacy). Выключение: очередь замирает (строки ждут
 *     следующего включения; повторное включение снова чистит хвост — так
 *     «мёртвых» строк не копится).
 *  Побочные эффекты: записи AppSettings + MessageEvent (forwardSkip), audit. */
export async function setForwarderEnabled(
  dto: z.infer<typeof setForwarderEnabledSchema>,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  await getSettings();
  if (dto.enabled) {
    const current = await forwarderRuntimeConfig();
    if (current.url === '') {
      throw new ApiError(422, 'Не задан URL приёмника', 'Сначала укажите endpoint приёмника (URL и токен), затем включайте обратный поток');
    }
    // Чистим хвост: накопленные неотправленные события не летят в BI.
    const skipped = await db.messageEvent.updateMany({
      where: { forwardedAt: null, forwardSkip: false },
      data: { forwardSkip: true, forwardError: null, nextForwardAt: null },
    });
    await db.appSettings.update({ where: { id: 'app' }, data: { forwarderEnabled: true } });
    await logAudit({
      user,
      action: AuditAction.UPDATE,
      entityType: AuditEntity.SETTINGS,
      entityId: 'app',
      details: { forwarderEnabled: true, skippedBacklog: skipped.count },
      ip,
    });
    return { enabled: true, skippedBacklog: skipped.count };
  }
  await db.appSettings.update({ where: { id: 'app' }, data: { forwarderEnabled: false } });
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.SETTINGS,
    entityId: 'app',
    details: { forwarderEnabled: false },
    ip,
  });
  return { enabled: false };
}

// ---------- Статистика очереди ----------

/** Статистика доставки обратного потока (карточка UI + метрики G7).
 *  pending считается по ФИЛЬТРУ ОЧЕРЕДИ (реальные провайдеры, наши типы/источники) —
 *  накопленные sandbox/внешние события в «очереди» не числятся (они уйдут в
 *  skipped при включении тумблера). */
export async function forwarderStats(): Promise<Record<string, unknown>> {
  const cutoff24 = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const queueFilter = {
    forwardedAt: null,
    forwardSkip: false,
    eventType: { in: [...FORWARD_EVENT_TYPES] },
    source: { in: [...FORWARD_SOURCES] },
    provider: { in: [...FORWARD_PROVIDERS] },
  };
  const [pending, skipped, inRetry, forwarded24h, lastForwarded, lastErrorRow] = await Promise.all([
    db.messageEvent.count({ where: queueFilter }),
    db.messageEvent.count({ where: { forwardSkip: true } }),
    db.messageEvent.count({
      where: { ...queueFilter, nextForwardAt: { gt: new Date() } },
    }),
    db.messageEvent.count({ where: { forwardedAt: { gte: cutoff24 } } }),
    db.messageEvent.findFirst({
      where: { forwardedAt: { not: null } },
      orderBy: { forwardedAt: 'desc' },
      select: { forwardedAt: true },
    }),
    db.messageEvent.findFirst({
      where: { forwardError: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { forwardError: true, updatedAt: true },
    }),
  ]);
  return {
    pending,
    skipped,
    inRetry,
    forwarded24h,
    lastSuccessAt: lastForwarded?.forwardedAt ?? null,
    lastErrorAt: lastErrorRow?.updatedAt ?? null,
    lastError: lastErrorRow?.forwardError ?? null,
  };
}

// ---------- Маппинг в формат обмена событиями ----------

/** pickStr-аналог приёмника: строка/число → строка, прочее — null. */
function pickStr(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Enrichment-контекст строки журнала: связная SMS + клиент + имена. */
interface ForwardEnrichment {
  sms: {
    id: string;
    body: string;
    clientId: string | null;
    phone: string;
    provider: string;
    providerMessageId: string | null;
    templateId: string | null;
    templateName: string | null;
    broadcastId: string | null;
    broadcastName: string | null;
    instanceId: string | null;
    error: string | null;
  } | null;
  clientExternalId: string | null;
  funnelName: string | null;
  templateSenderName: string | null;
}

/** MessageEvent → событие формата обмена (контракт приёма). */
function buildForwardEvent(
  row: {
    id: string;
    eventType: string;
    eventDate: Date;
    phone: string | null;
    provider: string | null;
    smsMessageId: string | null;
    clientId: string | null;
    externalIds: string | null;
  },
  enrich: ForwardEnrichment,
): Record<string, unknown> {
  // externalIds журнала (webhook-и кладут туда undeliv_code/undeliv_message).
  let ext: Record<string, unknown> = {};
  if (row.externalIds) {
    try {
      ext = JSON.parse(row.externalIds) as Record<string, unknown>;
    } catch {
      ext = {};
    }
  }
  const sms = enrich.sms;
  const customData: Record<string, unknown> = {
    // client_id — ID клиента в ядре (наш Client.externalId; null для SMS
    // без клиента — приёмник оставит person_id пустым).
    ...(enrich.clientExternalId !== null ? { client_id: enrich.clientExternalId } : {}),
    // campaign_name: имя рассылки (снимок) либо имя воронки (для SMS из воронок).
    campaign_name: sms?.broadcastName ?? enrich.funnelName ?? null,
    message_name: sms?.templateName ?? null,
  };
  const eventData: Record<string, unknown> = {
    message_id: sms?.id ?? row.smsMessageId ?? row.id, // дедуп приёмника: event_type+message_id
    campaign_id: sms?.broadcastId ?? null,
    send_message_id: sms?.providerMessageId ?? pickStr(ext.send_message_id),
    full_message_id: pickStr(ext.full_message_id) ?? sms?.providerMessageId ?? null,
  };
  const event: Record<string, unknown> = {
    event_type: row.eventType,
    event_date: row.eventDate.toISOString(),
    custom_data: customData,
    event_data: eventData,
    subscription: { phone: row.phone ?? sms?.phone ?? null },
    content: {
      sms: sms?.body ?? pickStr(ext.message_text) ?? null,
      // Имя отправителя: шаблон SMS (senderName) либо из внешнего события.
      fromnamesms: enrich.templateSenderName ?? pickStr(ext.message_sender) ?? null,
    },
  };
  // undeliv: код/текст ошибки (webhook externalIds → ошибка SMS-строки).
  if (row.eventType === 'undeliv_sms') {
    const code = pickStr(ext.undeliv_code);
    const message = pickStr(ext.undeliv_message) ?? sms?.error ?? null;
    if (code !== null) event.undeliv_code = code;
    if (message !== null) event.undeliv_message = message;
  }
  return event;
}

// ---------- Тик доставки (воркер, каждые 15 с) ----------

/** Успех/провал HTTP-вызова приёмника. */
interface DeliveryOutcome {
  ok: boolean;
  error: string | null; // «HTTP 502: …» либо «network: …»
}

/** POST батча JSON в приёмник событий: Bearer-токен, таймаут 15 с, успех — 2xx. */
async function postBatch(
  url: string,
  token: string,
  batch: Record<string, unknown>[],
): Promise<DeliveryOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token !== '' ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, error: null };
    let snippet = '';
    try {
      snippet = (await res.text()).slice(0, 300);
    } catch {
      snippet = '';
    }
    return { ok: false, error: `HTTP ${res.status}${snippet !== '' ? `: ${snippet}` : ''}` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `network: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Экспорт для тестов/диагностики: собрать due-батч (без отправки). */
export async function collectDueBatch(batchSize: number): Promise<{
  rows: Awaited<ReturnType<typeof db.messageEvent.findMany>>;
  enrichments: Map<string, ForwardEnrichment>;
}> {
  const rows = await db.messageEvent.findMany({
    where: {
      forwardedAt: null,
      forwardSkip: false,
      // ВАЖНО: свежие события создаются с nextForwardAt = NULL («ещё не было
      // неудачных попыток»), а в SQL NULL <= дата НЕ истинно — без ветки
      // OR: null батч состоял бы только из строк ретраев, и обратный поток
      // не отправлял бы ни одного события (баг v0.8.7, найден аудитом).
      OR: [{ nextForwardAt: null }, { nextForwardAt: { lte: new Date() } }],
      eventType: { in: [...FORWARD_EVENT_TYPES] },
      source: { in: [...FORWARD_SOURCES] },
      provider: { in: [...FORWARD_PROVIDERS] },
    },
    orderBy: { receivedAt: 'asc' },
    take: batchSize,
  });
  const enrichments = new Map<string, ForwardEnrichment>();
  // Обогащение: SMS-строки, клиенты (externalId), имена воронок — порционными
  // findMany-in (без N+1).
  const smsIds = [...new Set(rows.map((r) => r.smsMessageId).filter((v): v is string => v !== null))];
  const clientIds = [...new Set(rows.map((r) => r.clientId).filter((v): v is string => v !== null))];
  const smsById = new Map<string, NonNullable<ForwardEnrichment['sms']>>();
  if (smsIds.length > 0) {
    const smsRows = await db.smsMessage.findMany({
      where: { id: { in: smsIds } },
      select: {
        id: true, body: true, clientId: true, phone: true, provider: true,
        providerMessageId: true, templateId: true, templateName: true,
        broadcastId: true, broadcastName: true, instanceId: true, error: true,
      },
    });
    for (const s of smsRows) smsById.set(s.id, s);
  }
  const extById = new Map<string, string>();
  if (clientIds.length > 0) {
    const clientRows = await db.client.findMany({
      where: { id: { in: clientIds } },
      select: { id: true, externalId: true },
    });
    for (const c of clientRows) extById.set(c.id, c.externalId);
  }
  const instanceIds = [...new Set([...smsById.values()].map((s) => s.instanceId).filter((v): v is string => v !== null))];
  const funnelNameByInstance = new Map<string, string>();
  if (instanceIds.length > 0) {
    const instRows = await db.workflowInstance.findMany({
      where: { id: { in: instanceIds } },
      select: { id: true, funnelName: true },
    });
    for (const i of instRows) funnelNameByInstance.set(i.id, i.funnelName);
  }
  // Имена отправителей из шаблонов (content.fromnamesms) — templatesById.
  const templateIds = [...new Set([...smsById.values()].map((s) => s.templateId).filter((v): v is string => v !== null))];
  const senderByTemplate = new Map<string, string>();
  if (templateIds.length > 0) {
    const tplRows = await db.smsTemplate.findMany({
      where: { id: { in: templateIds } },
      select: { id: true, senderName: true },
    });
    for (const t of tplRows) if (t.senderName) senderByTemplate.set(t.id, t.senderName);
  }
  for (const r of rows) {
    const sms = r.smsMessageId ? smsById.get(r.smsMessageId) ?? null : null;
    const clientId = r.clientId ?? sms?.clientId ?? null;
    enrichments.set(r.id, {
      sms,
      clientExternalId: clientId ? extById.get(clientId) ?? null : null,
      funnelName: sms?.instanceId ? funnelNameByInstance.get(sms.instanceId) ?? null : null,
      templateSenderName: sms?.templateId ? senderByTemplate.get(sms.templateId) ?? null : null,
    });
  }
  return { rows, enrichments };
}

/**
 * Один тик доставки: собрать due-батч ≤ batchSize, POST, замаркировать строки.
 * Вызывается воркером каждые 3 тика (15 с). Очередь пуста/выключен тумблер/
 * URL не задан — тихий no-op. Ошибка сети/5xx — бэкофф на строках (см.
 * RETRY_DELAYS_MS), следующий тик попробует снова. Атомарность: строки
 * выбираются только по nextForwardAt (спящие не трогаются), двойной тик
 * исключён мьютексом воркера.
 */
export async function processForwardTick(): Promise<number> {
  const config = await forwarderRuntimeConfig();
  if (!config.enabled || config.url === '') return 0;
  const { rows, enrichments } = await collectDueBatch(config.batchSize);
  if (rows.length === 0) return 0;

  const batch = rows.map((row) =>
    buildForwardEvent(row, enrichments.get(row.id) ?? { sms: null, clientExternalId: null, funnelName: null, templateSenderName: null }),
  );
  const outcome = await postBatch(config.url, config.token, batch);

  const now = new Date();
  if (outcome.ok) {
    await db.messageEvent.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { forwardedAt: now, forwardError: null, nextForwardAt: null },
    });
    return rows.length;
  }
  // Провал батча: попытка+1, бэкофф-план на строках; «network:» в forwardError.
  for (const row of rows) {
    const attempts = row.forwardAttempts + 1;
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? RETRY_CAP_MS;
    await db.messageEvent.update({
      where: { id: row.id },
      data: {
        forwardAttempts: attempts,
        forwardError: outcome.error,
        nextForwardAt: new Date(now.getTime() + delay),
      },
    });
  }
  console.error(`[forwarder] батч ${rows.length} событий не доставлен (${outcome.error}); ретраи по бэкоффу`);
  return 0;
}

// ---------- Тест связности ----------

/** Тест-кнопка «Проверить»: синпетическое событие send_sms прямо в URL
 *  (мимо очереди — не журналируется и не считается в статистике доставки).
 *  Приёмник событий дедуплицирует по event_type+message_id — уникальный
 *  test-<timestamp> не collide с реальными. Побочные эффекты: audit-лог RUN. */
export async function testForwarder(user: SessionUser, ip: string): Promise<Record<string, unknown>> {
  const config = await forwarderRuntimeConfig();
  if (config.url === '') {
    throw new ApiError(422, 'URL приёмника не задан', 'Сначала сохраните endpoint приёмника на карточке обратного потока');
  }
  const now = new Date();
  const testEvent = {
    event_type: 'send_sms',
    event_date: now.toISOString(),
    custom_data: {
      campaign_name: 'Проверка обратного потока',
      message_name: 'Тест форвардера',
      note: 'Тестовое событие из панели Trigger',
    },
    event_data: {
      message_id: `test-${now.getTime()}`,
      campaign_id: null,
      send_message_id: null,
      full_message_id: null,
    },
    subscription: { phone: '+70000000000' },
    content: { sms: 'Тестовое событие обратного потока (панель Trigger)', fromnamesms: null },
  };
  const outcome = await postBatch(config.url, config.token, [testEvent]);
  await logAudit({
    user,
    action: AuditAction.RUN,
    entityType: AuditEntity.SETTINGS,
    entityId: 'app',
    details: { forwarderTest: true, url: config.url, ok: outcome.ok, error: outcome.error },
    ip,
  });
  return {
    ok: outcome.ok,
    url: config.url,
    tokenAttached: config.token !== '',
    error: outcome.error,
    sentAt: now.toISOString(),
  };
}
