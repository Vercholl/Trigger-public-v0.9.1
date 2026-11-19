// Сервис рассылок по сегментам.
//
// Рассылка = сегмент + МАРКЕТИНГОВЫЙ шаблон + расписание:
//   • ONCE — «сейчас» или в указанное стеночное время (по местному поясу клиента);
//   • RECURRING — «каждый <день недели> в ЧЧ:ММ» по местному поясу клиента.
// Воркер триггерится в самом раннем поясе РФ (Europe/Kaliningrad) и создаёт
// сообщения с scheduledFor = местное время КАЖДОГО клиента (тихие часы сдвигают
// на конец окна). Отправка — через общий комплаенс-пайплайн в момент фактической
// отправки: отписка/согласие/лимиты могли измениться между планированием и отправкой.
//
// Защита от спама: minDaysBetween — клиент не получит ОДНУ И ТУ ЖЕ рассылку чаще,
// чем раз в N дней (учитываются отправленные и ещё висящие в очереди).
// Порционный лимит: maxRecipients — максимум получателей на один запуск
// (отсечение детерминированное, по externalId по возрастанию).
// Вызывается из API-роутов: /api/v1/broadcasts (GET/POST), /broadcasts/{id}
// (GET/PUT/DELETE), /broadcasts/{id}/run | restart | pause | resume | cancel
// (POST); processDueBroadcasts и processScheduledBroadcastSms — тики воркера
// (scheduler/worker), journalSendOutcome — сообщение-события «захвата».
// Таблицы Prisma: Broadcast, BroadcastRun (история запусков), SmsMessage
// (очередь/статусы), Segment/SegmentMember + SmsTemplate (через сервисы),
// ShortLink (ссылки отписки), AppSettings, AuditLog.
import { z } from 'zod';
import type { AppSettings, Broadcast, BroadcastRun, Client, Segment, SmsMessage, SmsTemplate } from '@prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';
import { getSettings } from '@/lib/services/settings';
import { iterateSegmentClients, iterateStaticSegmentClients, segmentConditionsSchema, type SegmentConditions } from '@/lib/services/segments';
import { cardVarsFromClient, CARD_VAR_NAMES } from '@/lib/services/client-card';
import { cfVarName, cfVarsForClient, loadCustomFields } from '@/lib/services/custom-fields';
import { renderTemplate, requiredVariables, RenderError, snapshotVars } from '@/lib/sms/render';
import { countSegments } from '@/lib/sms/segments';
import { runCompliancePipeline, REJECT_REASON_TEXT } from '@/lib/compliance/pipeline';
import { isQuietHour, nextAllowedTime, getLocalHour } from '@/lib/compliance/quiet-hours';
import {
  resolveUnsubscribeBaseUrl,
} from '@/lib/compliance/disclaimer';
import { buildMarketingSmsBody } from '@/lib/compliance/short-links';
import { getProvider, TemporaryProviderError } from '@/lib/provider/types';
import { journalSendOutcome } from '@/lib/services/message-events';
import { nextWallClockOccurrence, zonedTimeToUtc, wallPartsInZone } from '@/lib/time';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Самый ранний пояс РФ — момент триггера регулярных запусков. */
export const EARLIEST_RU_TZ = 'Europe/Kaliningrad';

/** Анти-дубль: минимум секунд между запусками одной рассылки (claim через lastRunAt). */
const RUN_DEBOUNCE_MS = 60_000;

/** In-process мьютекс запусков: id рассылок, чей executeBroadcastRun выполняется
 *  ПРЯМО СЕЙЧАС (глобальный — переживает hot-reload dev). Зачем: claim через
 *  lastRunAt защищает только 60 секунд, а прогон большого сегмента идёт минуты/
 *  часы (nextRunAt пересчитывается лишь в КОНЦЕ прогона). Без мьютекса воркер
 *  и кнопка «Запустить» подхватили бы «due»-рассылку повторно → два конкурентных
 *  прогона → двойные SMS при minDaysBetween=0 (баг v0.8.7, найден аудитом).
 *  Воркер и API живут в одном процессе — поэтому одного Set достаточно (при
 *  кластеризации PM2 потребуется claim в БД). */
const RUNS_IN_FLIGHT: Set<string> = (() => {
  const g = globalThis as unknown as { __triggerBroadcastRuns?: Set<string> };
  if (!g.__triggerBroadcastRuns) g.__triggerBroadcastRuns = new Set<string>();
  return g.__triggerBroadcastRuns;
})();

/** Порция отправки отложенных сообщений за один тик воркера. */
const SCHEDULED_SMS_BATCH = 50;
/** Максимум ретраев временных ошибок провайдера для сообщения рассылки. */
const MAX_BROADCAST_SEND_ATTEMPTS = 5;

export const WEEKDAY_LABELS = [
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье',
] as const; // index = weekday - 1

// ---------- Схемы ----------

const localTimeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Схема создания: имя ≤120, сегмент/шаблон, kind ONCE/RECURRING + расписание
 *  (superRefine: RECURRING — обязателен weekday+hour; ONCE — ровно одно из
 *  runNow/runAtLocal), minDaysBetween 0–365 (по умолчанию 7),
 *  maxRecipients 1–100000 (по умолчанию 1000). */
export const createBroadcastSchema = z
  .object({
    name: z.string().trim().min(1, 'Название обязательно').max(120),
    description: z.string().trim().max(500).nullish(),
    segmentId: z.string().min(1),
    templateId: z.string().min(1),
    kind: z.enum(['ONCE', 'RECURRING']),
    /** ONCE: true → отправить немедленно (при создании). */
    runNow: z.boolean().default(false),
    /** ONCE: стеночное время «ГГГГ-ММ-ДДTЧЧ:ММ» — по местному поясу каждого клиента. */
    runAtLocal: z.string().regex(localTimeRe, 'Формат ГГГГ-ММ-ДДTЧЧ:ММ').nullish(),
    weekday: z.number().int().min(1).max(7).nullish(),
    hour: z.number().int().min(0).max(23).nullish(),
    minute: z.number().int().min(0).max(59).default(0),
    minDaysBetween: z.number().int().min(0).max(365).default(7),
    maxRecipients: z.number().int().min(1).max(100_000).default(1000),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'RECURRING') {
      if (v.weekday === null || v.weekday === undefined) {
        ctx.addIssue({ code: 'custom', message: 'Укажите день недели', path: ['weekday'] });
      }
      if (v.hour === null || v.hour === undefined) {
        ctx.addIssue({ code: 'custom', message: 'Укажите час отправки', path: ['hour'] });
      }
    } else {
      if (v.runNow && v.runAtLocal) {
        ctx.addIssue({
          code: 'custom',
          message: 'Выберите либо «сейчас», либо конкретное время',
          path: ['runAtLocal'],
        });
      }
      if (!v.runNow && !v.runAtLocal) {
        ctx.addIssue({
          code: 'custom',
          message: 'Укажите время отправки или выберите «сейчас»',
          path: ['runAtLocal'],
        });
      }
    }
  });

/** Редактирование: kind и расписание ONCE не меняются. */
export const updateBroadcastSchema = z.object({
  name: z.string().trim().min(1, 'Название обязательно').max(120),
  description: z.string().trim().max(500).nullish(),
  segmentId: z.string().min(1),
  templateId: z.string().min(1),
  weekday: z.number().int().min(1).max(7).nullish(),
  hour: z.number().int().min(0).max(23).nullish(),
  minute: z.number().int().min(0).max(59),
  minDaysBetween: z.number().int().min(0).max(365),
  maxRecipients: z.number().int().min(1).max(100_000),
});

export type CreateBroadcastDto = z.infer<typeof createBroadcastSchema>;
export type UpdateBroadcastDto = z.infer<typeof updateBroadcastSchema>;

// ---------- Валидация ссылок ----------

/** Проверка ссылок рассылки: сегмент существует, шаблон активен и маркетинговый,
 *  обязательные переменные тела покрыты карточкой клиента ({{var|default:…}} —
 *  допустимы). Несоблюдение — 422 с детализацией. */
async function validateRefs(
  segmentId: string,
  templateId: string,
): Promise<{ segment: Segment; template: SmsTemplate }> {
  const segment = await db.segment.findUnique({ where: { id: segmentId } });
  if (!segment) throw new ApiError(422, 'Сегмент не найден', 'Выберите существующий сегмент');
  const template = await db.smsTemplate.findUnique({ where: { id: templateId } });
  if (!template || !template.isActive) {
    throw new ApiError(422, 'Шаблон не найден или отключён');
  }
  if (!template.isMarketing) {
    throw new ApiError(
      422,
      'Для рассылок доступны только маркетинговые шаблоны',
      'Сервисные сообщения отправляются воронками по событиям',
    );
  }
  // Обязательны только переменные БЕЗ дефолта ({{var|default:…}} допустимы —
  // при отсутствии значения подставится дефолт). Доступны: поля карточки
  // (CARD_VAR_NAMES) и кастомные поля профиля {{cf_*}} (реестр custom-fields,
  // включая деактивированные — значения могли сохраниться раньше).
  const cfVarNames = new Set((await loadCustomFields()).map((d) => cfVarName(d.key)));
  const unknownVars = requiredVariables(template.body).filter(
    (v) => !CARD_VAR_NAMES.has(v) && !cfVarNames.has(v),
  );
  if (unknownVars.length > 0) {
    throw new ApiError(
      422,
      'В шаблоне есть переменные вне карточки клиента',
      `Недоступны в рассылках: ${unknownVars.map((v) => `{{${v}}}`).join(', ')} — у рассылки нет payload событий (доступны поля карточки и кастомные поля {{cf_*}})`,
    );
  }
  return { segment, template };
}

/** Условия сегмента из строки БД (Zod-парсинг; битая строка — 422 «пересоздайте»). */
function parseConditions(segment: Segment): SegmentConditions {
  try {
    return segmentConditionsSchema.parse(JSON.parse(segment.conditions));
  } catch {
    throw new ApiError(422, 'У сегмента некорректные условия', 'Пересоздайте сегмент в конструкторе');
  }
}

// ---------- Расписание ----------

/** Следующий момент триггера (в самом раннем поясе РФ) для рассылки. */
function computeNextRunAt(b: Pick<Broadcast, 'kind' | 'weekday' | 'hour' | 'minute' | 'runAt'>, from: Date): Date | null {
  if (b.kind === 'RECURRING') {
    return nextWallClockOccurrence(from, EARLIEST_RU_TZ, b.hour ?? 10, b.minute, b.weekday ?? 1);
  }
  return b.runAt ?? from; // ONCE: запланированный момент либо «сейчас»
}

/** Стеночное время отправки для клиента (без учёта тихих часов). */
function clientSendAt(
  b: Pick<Broadcast, 'kind' | 'weekday' | 'hour' | 'minute' | 'runAt'>,
  client: Pick<Client, 'timezone'>,
  trigger: Date,
): Date {
  if (b.kind === 'RECURRING') {
    // «эта неделя»: отступ 60с назад, чтобы клиент из пояса триггера не уехал на следующую неделю
    return nextWallClockOccurrence(
      new Date(trigger.getTime() - 60_000),
      client.timezone,
      b.hour ?? 10,
      b.minute,
      b.weekday ?? 1,
    );
  }
  if (b.runAt === null) return trigger; // «сейчас»
  // Запланированное стеночное время: восстановлено в поясе триггера → в пояс клиента
  const wall = wallPartsInZone(b.runAt, EARLIEST_RU_TZ);
  if (!wall) return trigger;
  const at = zonedTimeToUtc(wall.y, wall.m, wall.d, wall.h, wall.min, client.timezone);
  return at.getTime() < trigger.getTime() ? trigger : at;
}

/** Плановое время отправки клиенту: стеночное время его пояса + сдвиг тихих часов.
 * Единая точка расчёта — и для scheduledFor сообщения, и для якоря защиты
 * minDaysBetween (окно защиты обязано отсчитываться от того же момента). */
function plannedSendAt(
  b: Pick<Broadcast, 'kind' | 'weekday' | 'hour' | 'minute' | 'runAt'>,
  client: Pick<Client, 'timezone'>,
  trigger: Date,
  settings: Pick<AppSettings, 'quietHoursStart' | 'quietHoursEnd'>,
): Date {
  let sendAt = clientSendAt(b, client, trigger);
  const localHour = getLocalHour(sendAt, client.timezone);
  if (isQuietHour(localHour, settings.quietHoursStart, settings.quietHoursEnd)) {
    sendAt = nextAllowedTime(sendAt, client.timezone, settings.quietHoursStart, settings.quietHoursEnd);
  }
  return sendAt;
}

// ---------- Выполнение запуска ----------

/** Итог запуска: id прогона, кандидатов/получателей, пропущено защитой N-дней,
 *  отсечено лимитом maxRecipients. */
export interface RunResult {
  runId: string;
  planned: number;
  recipients: number;
  skippedGuard: number;
  cappedBy: number;
}

/** Создание одного сообщения запуска: рендер по карточке (ошибка/{{#cancel}}
 *  → FAILED/CANCELLED-строка), маркетинговая приписка с ссылкой отписки, лимит
 *  частей, плановое время scheduledFor = пояс клиента + тихие часы.
 *  Побочные эффекты: запись SmsMessage. */
async function createBroadcastMessage(
  b: Broadcast,
  runId: string,
  client: Client,
  template: SmsTemplate,
  trigger: Date,
  settings: AppSettings,
): Promise<void> {

  // Рендер по переменным карточки + кастомных полей {{cf_*}} (профиль — источник
  // истины, формат дат дд.мм.гггг); ошибка рендера → FAILED (как в воронках).
  // Движок с дефолтами/условиями/вариантами; {{#cancel}} → CANCELLED (TEMPLATE_CANCEL).
  // Реестр кастомных полей пуст → cfVarsForClient не делает ни одного запроса.
  // Снимок переменных (P6) — во ВСЕ исходы (и отказы): «что подставилось/чего не
  // было» видно и для отправленных, и для отменённых/упавших сообщений.
  const cardVars = cardVarsFromClient(client);
  const cfVars = await cfVarsForClient(client.id);
  const templateVars = { ...cardVars, ...cfVars };
  const varsSnapshot = snapshotVars(template.body, templateVars);
  let rendered: string;
  try {
    const renderResult = renderTemplate(template.body, templateVars, { variantSeed: client.id });
    if (renderResult.cancelled) {
      const why = renderResult.cancelReason === 'empty' ? 'Пустой результат рендера' : null;
      await db.smsMessage.create({
        data: {
          clientId: client.id,
          phone: client.phone,
          body: '',
          segments: 0,
          provider: settings.provider,
          templateId: template.id,
          templateName: template.name,
          status: 'CANCELLED',
          rejectReason: 'TEMPLATE_CANCEL',
          error: why,
          varsSnapshot,
          broadcastId: b.id,
          broadcastName: b.name,
          runId,
        },
      });
      return;
    }
    rendered = renderResult.text;
  } catch (e) {
    const message = e instanceof RenderError ? e.message : 'Неизвестная ошибка рендера';
    await db.smsMessage.create({
      data: {
        clientId: client.id,
        phone: client.phone,
        body: template.body,
        segments: countSegments(template.body).segments,
        provider: settings.provider,
        templateId: template.id,
        templateName: template.name,
        status: 'FAILED',
        rejectReason: 'RENDER_ERROR',
        error: message,
        varsSnapshot,
        broadcastId: b.id,
        broadcastName: b.name,
        runId,
      },
    });
    return;
  }

  // Маркетинговая приписка (редактируемый шаблон {link}/{advertiser})
  // со ссылкой отписки — короткой (таблица ShortLink) или полной.
  // База — Origin создания рассылки из панели (b.baseUrl, как у событий),
  // затем настройки/env; "localhost"-фолбэк остаётся только для локальной разработки.
  const baseUrl = resolveUnsubscribeBaseUrl(b.baseUrl, settings);
  const finalBody = await buildMarketingSmsBody(rendered, settings, baseUrl, client.id);
  const seg = countSegments(finalBody);

  // Лимит частей шаблона — сообщение не отправляется вообще.
  if (template.maxSegments > 0 && seg.segments > template.maxSegments) {
    await db.smsMessage.create({
      data: {
        clientId: client.id,
        phone: client.phone,
        body: finalBody,
        segments: seg.segments,
        provider: settings.provider,
        templateId: template.id,
        templateName: template.name,
        status: 'REJECTED_BY_COMPLIANCE',
        rejectReason: 'SMS_TOO_LONG',
        error: `Частей ${seg.segments} > лимита ${template.maxSegments}`,
        varsSnapshot,
        broadcastId: b.id,
        broadcastName: b.name,
        runId,
      },
    });
    return;
  }

  // Время отправки: местное стеночное время клиента + сдвиг тихих часов
  const sendAt = plannedSendAt(b, client, trigger, settings);

  await db.smsMessage.create({
    data: {
      clientId: client.id,
      phone: client.phone,
      body: finalBody,
      segments: seg.segments,
      provider: settings.provider,
      templateId: template.id,
      templateName: template.name,
      status: 'QUEUED',
      varsSnapshot,
      broadcastId: b.id,
      broadcastName: b.name,
      runId,
      scheduledFor: sendAt,
    },
  });
}

/** Выполнить запуск рассылки: оценить сегмент, создать очередь сообщений.
 *  Атомарный claim по lastRunAt (анти-дубль 60с); recipients — после фильтра
 *  minDaysBetween и лимита; ошибки финализуют BroadcastRun=FAILED и статус
 *  рассылки (ONCE → DONE без зомби). Побочные эффекты: запись BroadcastRun,
 *  массовая вставка SmsMessage, запись Broadcast.
 *
 *  МАСШТАБ (базы в миллионы строк): получатели обрабатываются ПОТОЧНО —
 *  порциями по SEGMENT_ITERATE_CHUNK строк в порядке externalId ASC (память
 *  ограничена порцией; детерминированный порционный лимит — первые N по
 *  externalId, эквивалент прежней сортировки+slice для ASCII-ключей), гвард
 *  «не чаще 1 раза в N дней» — ОДИН батч-запрос на порцию вместо запроса на
 *  каждого клиента (2,2 млн клиентов — часы запросов → секунды), сообщения
 *  создаются на лету до исчерпания лимита, свыше — только счётчики. */
export async function executeBroadcastRun(broadcastId: string): Promise<RunResult> {
  // Гвард одновременного запуска (см. RUNS_IN_FLIGHT): пока прогон идёт,
  // повторный запуск (воркером или кнопкой) получает 409 — не создаётся
  // второй BroadcastRun и не дублируются SMS. Воркер молча пропускает 409.
  if (RUNS_IN_FLIGHT.has(broadcastId)) {
    throw new ApiError(409, 'Запуск этой рассылки уже выполняется', 'Дождитесь завершения текущего прогона');
  }
  RUNS_IN_FLIGHT.add(broadcastId);
  try {
    return await executeBroadcastRunInner(broadcastId);
  } finally {
    RUNS_IN_FLIGHT.delete(broadcastId);
  }
}

/** Реализация запуска (см. контракт executeBroadcastRun выше). */
async function executeBroadcastRunInner(broadcastId: string): Promise<RunResult> {
  const b = await db.broadcast.findUnique({ where: { id: broadcastId } });
  if (!b) throw new ApiError(404, 'Рассылка не найдена');
  if (b.status === 'DONE' || b.status === 'CANCELLED') {
    throw new ApiError(409, 'Рассылка завершена или отменена');
  }

  // Атомарный claim: lastRunAt свежее RUN_DEBOUNCE_MS → запуск уже был (анти-дубль)
  const claimed = await db.broadcast.updateMany({
    where: {
      id: b.id,
      OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(Date.now() - RUN_DEBOUNCE_MS) } }],
    },
    data: { lastRunAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw new ApiError(409, 'Запуск уже выполнялся менее минуты назад');
  }

  const trigger = new Date();
  const run = await db.broadcastRun.create({
    data: { broadcastId: b.id, status: 'RUNNING', startedAt: trigger },
  });

  try {
    const { segment, template } = await validateRefs(b.segmentId, b.templateId);
    const settings = await getSettings();

    // Счётчики запуска (заполняются потоково, по порциям сегмента)
    let planned = 0; // подходящих по сегменту (до гварда и лимита)
    let skippedGuard = 0; // пропущено по «не чаще 1 раза в N дней»
    let accepted = 0; // прошедших гвард (до порционного лимита)
    let createdCount = 0; // создано сообщений (после лимита)

    // Защита «не чаще 1 раза в N дней» (в рамках этой рассылки). Окно отсчитывается
    // от ПЛАНОВОГО времени отправки ЭТОГО клиента (его пояс + сдвиг тихих часов):
    // якорь на момент триггера занижал окно на часы/сутки — еженедельная RECURRING
    // при minDaysBetween=7 фактически ходила раз в две недели. Учитываются
    // отправленные и ещё висящие в очереди сообщения: фактическая отправка
    // (sentAt), плановое время неотправленной очереди (scheduledFor), для старых
    // строк без того и другого — момент создания (createdAt).
    /** Гвард для ПОРЦИИ клиентов: ОДИН батч-запрос (МИНИМАЛЬНАЯ граница порции —
     * грубый пре-фильтр; минутный допуск и точная проверка — как раньше на клиента).
     * Возвращает Set clientId, отправлявшихся слишком недавно. */
    const guardChunk = async (chunk: Client[]): Promise<Set<string>> => {
      if (b.minDaysBetween <= 0 || chunk.length === 0) return new Set<string>();
      const boundaries = chunk.map((c) => {
        const sendAt = plannedSendAt(b, c, trigger, settings);
        return { id: c.id, cutoffMs: sendAt.getTime() - b.minDaysBetween * DAY_MS };
      });
      // Грубый пре-фильтр по минимальной границе порции (− минута): одна выборка
      // вместо выборки на клиента; лишние строки отсеет точная проверка ниже
      const minBoundary = new Date(Math.min(...boundaries.map((x) => x.cutoffMs)) - 60_000);
      const candidates = await db.smsMessage.findMany({
        where: {
          broadcastId: b.id,
          clientId: { in: chunk.map((c) => c.id) },
          status: { in: ['QUEUED', 'SENDING', 'SENT', 'DELIVERED'] },
          OR: [
            { sentAt: { gte: minBoundary } },
            { AND: [{ sentAt: null }, { scheduledFor: { gte: minBoundary } }] },
            { AND: [{ sentAt: null }, { scheduledFor: null }, { createdAt: { gte: minBoundary } }] },
          ],
        },
        select: { clientId: true, sentAt: true, scheduledFor: true, createdAt: true },
      });
      const byClient = new Map<
        string,
        Array<{ sentAt: Date | null; scheduledFor: Date | null; createdAt: Date }>
      >();
      for (const row of candidates) {
        // where clientId IN (...) исключает null, но тип Prisma допускает его
        if (row.clientId === null) continue;
        const arr = byClient.get(row.clientId);
        if (arr) arr.push(row);
        else byClient.set(row.clientId, [row]);
      }
      const tooRecent = new Set<string>();
      // Минутный допуск: воркер отправляет на секунды позже планового момента —
      // «ровно раз в N дней» не должен превращаться в «раз в N дней + пропуск».
      for (const { id, cutoffMs } of boundaries) {
        const rows = byClient.get(id);
        if (
          rows?.some((row) => {
            const ref = row.sentAt ?? row.scheduledFor ?? row.createdAt;
            return ref !== null && ref.getTime() > cutoffMs + 60_000;
          })
        ) {
          tooRecent.add(id);
        }
      }
      return tooRecent;
    };

    /** Обработка порции сегмента: гвард батчем + создание сообщений до лимита. */
    const handleChunk = async (chunk: Client[]): Promise<void> => {
      planned += chunk.length;
      const tooRecent = await guardChunk(chunk);
      for (const c of chunk) {
        if (tooRecent.has(c.id)) {
          skippedGuard += 1;
          continue;
        }
        accepted += 1;
        // Порционный лимит: создание — только первым maxRecipients по порядку,
        // остальным — плюс к cappedBy (посчитается точно в конце)
        if (accepted <= b.maxRecipients) {
          await createBroadcastMessage(b, run.id, c, template, trigger, settings);
          createdCount += 1;
        }
      }
    };

    // Получатели: динамический сегмент — живой пересчёт по условиям в момент
    // запуска (потоково); фиксированный — РОВНО тот состав, что в срезе,
    // потоково порциями (память O(порция), порядок externalId — детерминизм
    // лимита, как в динамическом пути).
    if (segment.mode === 'static') {
      for await (const chunk of iterateStaticSegmentClients(segment.id)) {
        await handleChunk(chunk);
      }
    } else {
      const conditions = parseConditions(segment);
      for await (const chunk of iterateSegmentClients(conditions)) {
        await handleChunk(chunk);
      }
    }
    const cappedBy = Math.max(0, accepted - b.maxRecipients);

    await db.broadcastRun.update({
      where: { id: run.id },
      data: {
        status: 'DONE',
        planned,
        recipients: createdCount,
        skippedGuard,
        cappedBy,
        finishedAt: new Date(),
      },
    });
    // Финальный статус: перечитываем — пауза/отмена, выставленная API ВО ВРЕМЯ выполнения
    // запуска, не должна «воскрешаться» этим апдейтом (иначе отмена тихо пропадает).
    const fresh = await db.broadcast.findUnique({ where: { id: b.id }, select: { status: true } });
    const finalStatus =
      b.kind === 'ONCE'
        ? fresh?.status === 'PAUSED' || fresh?.status === 'CANCELLED'
          ? fresh.status
          : 'DONE'
        : (fresh?.status ?? b.status);
    await db.broadcast.update({
      where: { id: b.id },
      data: {
        lastRunAt: trigger,
        nextRunAt: b.kind === 'RECURRING' ? computeNextRunAt(b, trigger) : null,
        status: finalStatus,
      },
    });
    return {
      runId: run.id,
      planned,
      recipients: createdCount,
      skippedGuard,
      cappedBy,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.broadcastRun
      .update({ where: { id: run.id }, data: { status: 'FAILED', error: message, finishedAt: new Date() } })
      .catch(() => undefined);
    // ONCE с упавшим запуском — терминальный DONE (не «зомби» ACTIVE с nextRunAt=null);
    // PAUSED/CANCELLED, выставленные пользователем во время запуска, не перезаписываем.
    // RECURRING — попытка на следующей неделе.
    const fresh = await db.broadcast
      .findUnique({ where: { id: b.id }, select: { status: true } })
      .catch(() => null);
    const safeStatus =
      b.kind === 'ONCE' && fresh?.status !== 'PAUSED' && fresh?.status !== 'CANCELLED'
        ? 'DONE'
        : undefined;
    await db.broadcast
      .update({
        where: { id: b.id },
        data: {
          nextRunAt: b.kind === 'RECURRING' ? computeNextRunAt(b, trigger) : null,
          ...(safeStatus ? { status: safeStatus } : {}),
        },
      })
      .catch(() => undefined);
    throw e;
  }
}

// ---------- Функции воркера ----------

/** Тик 1: запуск due-рассылок (ACTIVE + nextRunAt <= now). */
export async function processDueBroadcasts(): Promise<void> {
  try {
    const now = new Date();
    const due = await db.broadcast.findMany({
      where: { status: 'ACTIVE', nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
      take: 5,
    });
    for (const b of due) {
      try {
        await executeBroadcastRun(b.id);
      } catch (e) {
        // 409 — анти-дубль (недавний запуск), это не ошибка
        if (e instanceof ApiError && e.status === 409) continue;
        console.error(
          `[worker] broadcast ${b.id} run failed:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  } catch (e) {
    console.error('[worker] processDueBroadcasts failed:', e instanceof Error ? e.message : String(e));
  }
}

/** Отправка одного отложенного сообщения (комплаенс в момент отправки).
 * Сообщение захвачено атомарным claim QUEUED→SENDING: все выходы обязаны перевести
 * его из SENDING в терминальный статус (или вернуть в QUEUED). */
async function sendScheduledMessage(m: {
  id: string;
  broadcastId: string | null;
  clientId: string | null;
  templateId: string | null;
  body: string;
  phone: string;
  attempts: number;
}): Promise<void> {
  if (!m.broadcastId) {
    await db.smsMessage.update({ where: { id: m.id }, data: { status: 'FAILED', error: 'Сообщение без рассылки' } });
    return;
  }
  const broadcast = await db.broadcast.findUnique({ where: { id: m.broadcastId } });
  if (!broadcast) {
    await db.smsMessage.update({ where: { id: m.id }, data: { status: 'FAILED', error: 'Рассылка не найдена' } });
    return;
  }
  // Пауза = заморозка: возвращаем в очередь до возобновления
  if (broadcast.status === 'PAUSED') {
    await db.smsMessage.update({ where: { id: m.id }, data: { status: 'QUEUED' } });
    return;
  }
  if (broadcast.status === 'CANCELLED') {
    await db.smsMessage.update({ where: { id: m.id }, data: { status: 'CANCELLED' } });
    return;
  }

  const client = m.clientId ? await db.client.findUnique({ where: { id: m.clientId } }) : null;
  if (!client) {
    await db.smsMessage.update({ where: { id: m.id }, data: { status: 'FAILED', error: 'Клиент не найден' } });
    return;
  }
  const settings = await getSettings();
  // Рассылки всегда маркетинговые (создание это гарантирует); шаблон мог удалиться —
  // флаг берём из шаблона при наличии, иначе маркетинг.
  const template = m.templateId ? await db.smsTemplate.findUnique({ where: { id: m.templateId } }) : null;
  const isMarketing = template?.isMarketing ?? true;

  const pipeline = await runCompliancePipeline({ client, template: { isMarketing }, settings, excludeMessageId: m.id });
  if (pipeline.decision === 'REJECT') {
    await db.smsMessage.update({
      where: { id: m.id },
      data: { status: 'REJECTED_BY_COMPLIANCE', rejectReason: pipeline.reason, error: null },
    });
    return;
  }
  if (pipeline.decision === 'RESCHEDULE') {
    // Местное время клиента снова в тихих часах — откладываем до конца окна
    await db.smsMessage.update({
      where: { id: m.id },
      data: { status: 'QUEUED', scheduledFor: pipeline.nextAllowedAt },
    });
    return;
  }

  // Имя отправителя: шаблон > настройка по умолчанию (у рассылки нет SMS-узла)
  const senderName = template?.senderName?.trim() || settings.defaultSenderName?.trim() || null;
  const provider = getProvider(settings.provider);
  let result;
  try {
    result = await provider.send({
      phone: client.phone,
      body: m.body,
      clientId: client.id,
      instanceId: null,
      sender: senderName,
      // id строки SMS стабилен между ретраями рассылки — идемпотентность SMS.Tech
      idempotencyScope: `broadcast:${m.id}`,
      tags: ['trigger', ...(template?.name ? [template.name] : []), 'broadcast'],
    });
  } catch (e) {
    if (e instanceof TemporaryProviderError) {
      // Ретраи с счётчиком: после MAX_BROADCAST_SEND_ATTEMPTS — FAILED (симметрично воронкам)
      const attempts = m.attempts + 1;
      if (attempts >= MAX_BROADCAST_SEND_ATTEMPTS) {
        await db.smsMessage.update({
          where: { id: m.id },
          data: { status: 'FAILED', error: `Превышено число попыток отправки: ${e.message}`, attempts },
        });
        return;
      }
      await db.smsMessage.update({
        where: { id: m.id },
        data: { status: 'QUEUED', scheduledFor: new Date(Date.now() + 2 * 60_000), error: e.message, attempts },
      });
      return;
    }
    throw e;
  }

  if (result.ok) {
    const now = new Date();
    await db.smsMessage.update({
      where: { id: m.id },
      data: {
        status: result.immediateDelivery ? 'DELIVERED' : 'SENT',
        sentAt: now,
        deliveredAt: result.immediateDelivery ? now : null,
        providerMessageId: result.providerMessageId ?? null,
        provider: provider.name,
        // Биллинговые сегменты шлюза точнее локального расчёта (SMS.Tech)
        ...(result.segmentsCount && result.segmentsCount > 0 ? { segments: result.segmentsCount } : {}),
        error: null,
      },
    });
    // «Захват событий»: отправка рассылки — событие журнала (тумблер внутри)
    await journalSendOutcome({
      smsId: m.id,
      clientId: m.clientId,
      phone: client.phone,
      provider: provider.name,
      providerMessageId: result.providerMessageId ?? null,
      immediateDelivery: result.immediateDelivery === true,
      broadcastId: m.broadcastId,
      broadcastName: broadcast.name,
      templateName: template?.name ?? null,
    });
  } else {
    await db.smsMessage.update({
      where: { id: m.id },
      data: { status: 'FAILED', error: result.error ?? 'Ошибка провайдера', provider: provider.name },
    });
  }
}

/** Сколько строк due-очереди максимально просмотреть за один тик: сообщения
 * «замороженных» (PAUSED/CANCELLED) рассылок сидят в голове очереди с прошедшим
 * scheduledFor — проход обязан продолжаться мимо них, но не бесконечно. */
const MAX_SCAN_ROWS = 2000;

/** Тик 2: отправка отложенных сообщений рассылок (QUEUED + scheduledFor <= now).
 * Атомарный claim QUEUED→SENDING исключает двойную отправку при наложении тиков
 * (send() провайдера может длиться дольше интервала тика).
 * Сообщения PAUSED/CANCELLED-рассылок отфильтровываются ДО claim'а: раньше они
 * каждые 5 с клаймились и возвращались в QUEUED (churn записей), а при ≥50 таких
 * монопольно занимали батч — сообщения чужих активных рассылок голодали
 * (head-of-line blocking). Теперь они «пропускаются» без единой записи в БД,
 * а курсорный проход добирает страницу до полных SCHEDULED_SMS_BATCH отправляемых. */
export async function processScheduledBroadcastSms(): Promise<void> {
  try {
    const now = new Date();
    const sendable: SmsMessage[] = [];
    let scanned = 0;
    let cursorId: string | null = null;
    while (sendable.length < SCHEDULED_SMS_BATCH && scanned < MAX_SCAN_ROWS) {
      const page: SmsMessage[] = await db.smsMessage.findMany({
        where: {
          status: 'QUEUED',
          scheduledFor: { not: null, lte: now },
          broadcastId: { not: null },
        },
        orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
        take: SCHEDULED_SMS_BATCH,
        ...(cursorId !== null ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });
      if (page.length === 0) break;
      cursorId = page[page.length - 1].id;
      scanned += page.length;

      // Статусы рассылок этой страницы: замороженные сообщения не выбираем вовсе.
      const broadcastIds: string[] = [...new Set(page.map((m) => m.broadcastId as string))];
      const rows =
        broadcastIds.length > 0
          ? await db.broadcast.findMany({ where: { id: { in: broadcastIds } }, select: { id: true, status: true } })
          : [];
      const frozen = new Set(
        rows.filter((r) => r.status === 'PAUSED' || r.status === 'CANCELLED').map((r) => r.id),
      );
      for (const m of page) {
        if (m.broadcastId !== null && frozen.has(m.broadcastId)) continue;
        sendable.push(m);
        if (sendable.length >= SCHEDULED_SMS_BATCH) break;
      }
      if (page.length < SCHEDULED_SMS_BATCH) break; // due-очередь исчерпана
    }

    for (const m of sendable) {
      const claimed = await db.smsMessage.updateMany({
        where: { id: m.id, status: 'QUEUED' },
        data: { status: 'SENDING' },
      });
      if (claimed.count !== 1) continue; // параллельный тик уже взял сообщение
      try {
        await sendScheduledMessage(m);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Симметрично Temporary-пути: счётчик попыток + backoff, после
        // MAX_BROADCAST_SEND_ATTEMPTS — FAILED. Иначе неожиданная ошибка
        // (не-Temporary) ретраилась бы каждые 5 секунд бесконечно.
        const attempts = m.attempts + 1;
        const data =
          attempts >= MAX_BROADCAST_SEND_ATTEMPTS
            ? { status: 'FAILED', error: `Неожиданная ошибка отправки: ${message}`, attempts }
            : {
                status: 'QUEUED',
                scheduledFor: new Date(Date.now() + 2 * 60_000),
                error: message,
                attempts,
              };
        await db.smsMessage
          .updateMany({ where: { id: m.id, status: 'SENDING' }, data })
          .catch(() => undefined);
        console.error(`[worker] broadcast sms ${m.id} failed:`, message);
      }
    }
  } catch (e) {
    console.error(
      '[worker] processScheduledBroadcastSms failed:',
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ---------- Статистика и сериализация ----------

/** Статусы одного запуска (агрегация по SmsMessage через groupBy). Транзиентный
 *  SENDING (claim на секунды во время активной отправки тика) в корзины не
 *  попадает: в разгар отправки сумма корзин временно меньше recipients —
 *  финализация отправки относит сообщение в sent/failed и выравнивает картину. */
export interface BroadcastRunStats {
  queued: number;
  sent: number;
  delivered: number;
  rejected: number;
  failed: number;
  cancelled: number;
}

/** Статистика запусков одним groupBy (runId × status) — без N+1. Чтение. */
async function runsStats(runIds: string[]): Promise<Map<string, BroadcastRunStats>> {
  const map = new Map<string, BroadcastRunStats>();
  if (runIds.length === 0) return map;
  const grouped = await db.smsMessage.groupBy({
    by: ['runId', 'status'],
    where: { runId: { in: runIds } },
    _count: { _all: true },
  });
  for (const g of grouped) {
    if (!g.runId) continue;
    const s = map.get(g.runId) ?? { queued: 0, sent: 0, delivered: 0, rejected: 0, failed: 0, cancelled: 0 };
    const n = g._count._all;
    switch (g.status) {
      case 'QUEUED':
        s.queued += n;
        break;
      case 'SENT':
        s.sent += n;
        break;
      case 'DELIVERED':
        s.delivered += n;
        break;
      case 'REJECTED_BY_COMPLIANCE':
        s.rejected += n;
        break;
      case 'FAILED':
        s.failed += n;
        break;
      case 'CANCELLED':
        s.cancelled += n;
        break;
    }
    map.set(g.runId, s);
  }
  return map;
}

/** Разбивка отказов запуска по причинам: [{reason, count}] (для UI «Запуски»). */
async function runsRejectReasons(
  runIds: string[],
): Promise<Map<string, Array<{ reason: string; count: number }>>> {
  const map = new Map<string, Array<{ reason: string; count: number }>>();
  if (runIds.length === 0) return map;
  const grouped = await db.smsMessage.groupBy({
    by: ['runId', 'rejectReason'],
    where: { runId: { in: runIds }, status: 'REJECTED_BY_COMPLIANCE' },
    _count: { _all: true },
  });
  for (const g of grouped) {
    if (!g.runId || !g.rejectReason) continue;
    const list = map.get(g.runId) ?? [];
    list.push({ reason: g.rejectReason, count: g._count._all });
    map.set(g.runId, list);
  }
  for (const list of map.values()) list.sort((a, b) => b.count - a.count);
  return map;
}

/** Строка BroadcastRun → JSON API (со статами и причинами отказов). */
function serializeRun(
  row: BroadcastRun,
  stats: BroadcastRunStats,
  rejectReasons: Array<{ reason: string; count: number }> = [],
): Record<string, unknown> {
  return {
    id: row.id,
    broadcastId: row.broadcastId,
    status: row.status,
    planned: row.planned,
    recipients: row.recipients,
    skippedGuard: row.skippedGuard,
    cappedBy: row.cappedBy,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    stats,
    rejectReasons,
  };
}

/** Строка Broadcast → JSON API карточки: имена сегмента/шаблона, расписание,
 *  статус, nextRunAt/lastRunAt + последний запуск со статами. */
function serializeBroadcast(
  row: Broadcast,
  names: { segmentName: string | null; templateName: string | null },
  lastRun: BroadcastRun | null,
  lastRunStats: BroadcastRunStats | null,
): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    segmentId: row.segmentId,
    segmentName: names.segmentName,
    templateId: row.templateId,
    templateName: names.templateName,
    runAt: row.runAt,
    weekday: row.weekday,
    hour: row.hour,
    minute: row.minute,
    minDaysBetween: row.minDaysBetween,
    maxRecipients: row.maxRecipients,
    status: row.status,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRun: lastRun ? serializeRun(lastRun, lastRunStats ?? { queued: 0, sent: 0, delivered: 0, rejected: 0, failed: 0, cancelled: 0 }) : null,
  };
}

/** Имена сегментов/шаблонов пачкой (in-запрос) для списка рассылок. Чтение. */
async function refNames(rows: Array<Pick<Broadcast, 'segmentId' | 'templateId'>>): Promise<{
  segmentNames: Map<string, string>;
  templateNames: Map<string, string>;
}> {
  const segmentIds = [...new Set(rows.map((r) => r.segmentId))];
  const templateIds = [...new Set(rows.map((r) => r.templateId))];
  const segments = segmentIds.length > 0 ? await db.segment.findMany({ where: { id: { in: segmentIds } } }) : [];
  const templates =
    templateIds.length > 0 ? await db.smsTemplate.findMany({ where: { id: { in: templateIds } } }) : [];
  return {
    segmentNames: new Map(segments.map((s) => [s.id, s.name])),
    templateNames: new Map(templates.map((t) => [t.id, t.name])),
  };
}

// ---------- CRUD ----------

/** Список всех рассылок с именами ссылок и последним запуском (groupBy —
 *  без N+1). Чтение — без побочных эффектов. */
export async function listBroadcasts(): Promise<{ items: unknown[]; total: number }> {
  const rows = await db.broadcast.findMany({ orderBy: { createdAt: 'asc' } });
  const names = await refNames(rows);
  // Последний запуск каждой рассылки без N+1: groupBy max(startedAt) по broadcastId
  // + один точечный fetch этих строк (было findFirst на каждую рассылку).
  const lastRuns = new Map<string, BroadcastRun>();
  if (rows.length > 0) {
    const grouped = await db.broadcastRun.groupBy({
      by: ['broadcastId'],
      where: { broadcastId: { in: rows.map((r) => r.id) } },
      _max: { startedAt: true },
    });
    const pairs = grouped
      .map((g) => ({ broadcastId: g.broadcastId, startedAt: g._max.startedAt }))
      .filter((p): p is { broadcastId: string; startedAt: Date } => p.startedAt !== null);
    if (pairs.length > 0) {
      const lastRunRows = await db.broadcastRun.findMany({
        where: { OR: pairs },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      });
      for (const run of lastRunRows) {
        if (!lastRuns.has(run.broadcastId)) lastRuns.set(run.broadcastId, run);
      }
    }
  }
  const stats = await runsStats([...lastRuns.values()].map((r) => r.id));
  return {
    items: rows.map((r) =>
      serializeBroadcast(
        r,
        { segmentName: names.segmentNames.get(r.segmentId) ?? null, templateName: names.templateNames.get(r.templateId) ?? null },
        lastRuns.get(r.id) ?? null,
        stats.get(lastRuns.get(r.id)?.id ?? '') ?? null,
      ),
    ),
    total: rows.length,
  };
}

/** Карточка рассылки: последние 20 запусков со статами и причинами отказов.
 *  Чтение — без побочных эффектов. */
export async function getBroadcast(id: string): Promise<Record<string, unknown>> {
  const row = await db.broadcast.findUnique({
    where: { id } ,
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 20 } },
  });
  if (!row) throw new ApiError(404, 'Рассылка не найдена');
  const names = await refNames([row]);
  const stats = await runsStats(row.runs.map((r) => r.id));
  const reasons = await runsRejectReasons(row.runs.map((r) => r.id));
  const lastRun = row.runs[0] ?? null;
  return {
    ...serializeBroadcast(
      row,
      { segmentName: names.segmentNames.get(row.segmentId) ?? null, templateName: names.templateNames.get(row.templateId) ?? null },
      lastRun,
      stats.get(lastRun?.id ?? '') ?? null,
    ),
    runs: row.runs.map((r) =>
      serializeRun(
        r,
        stats.get(r.id) ?? { queued: 0, sent: 0, delivered: 0, rejected: 0, failed: 0, cancelled: 0 },
        reasons.get(r.id) ?? [],
      )),
  };
}

/** Создание рассылки: валидация ссылок, расписание переводится в UTC пояса
 *  триггера (Europe/Kaliningrad), статус ACTIVE + nextRunAt (воркер подхватит).
 *  Побочные эффекты: запись Broadcast (baseUrl — Origin для ссылок отписки),
 *  audit-лог CREATE. */
export async function createBroadcast(
  dto: CreateBroadcastDto,
  user: SessionUser,
  ip: string,
  baseUrl: string | null = null, // Origin запроса из панели — для ссылки отписки
): Promise<Record<string, unknown>> {
  await validateRefs(dto.segmentId, dto.templateId);
  let runAt: Date | null = null;
  if (dto.kind === 'ONCE' && !dto.runNow && dto.runAtLocal) {
    const [y, m, d, hh, mm] = dto.runAtLocal.split(/[-T:]/).map((x) => Number.parseInt(x, 10));
    runAt = zonedTimeToUtc(y, m, d, hh, mm, EARLIEST_RU_TZ);
  }
  const now = new Date();
  const row = await db.broadcast.create({
    data: {
      name: dto.name,
      description: dto.description ?? null,
      segmentId: dto.segmentId,
      templateId: dto.templateId,
      baseUrl: baseUrl && baseUrl.trim() !== '' ? baseUrl.trim() : null,
      kind: dto.kind,
      runAt,
      weekday: dto.kind === 'RECURRING' ? dto.weekday ?? null : null,
      hour: dto.kind === 'RECURRING' ? dto.hour ?? null : null,
      minute: dto.minute,
      minDaysBetween: dto.minDaysBetween,
      maxRecipients: dto.maxRecipients,
      status: 'ACTIVE',
      nextRunAt:
        dto.kind === 'RECURRING'
          ? nextWallClockOccurrence(now, EARLIEST_RU_TZ, dto.hour ?? 10, dto.minute, dto.weekday ?? 1)
          : (runAt ?? now), // «сейчас» → воркер подхватит в ближайший тик
    },
  });
  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.BROADCAST,
    entityId: row.id,
    details: { broadcast: row.name, kind: row.kind, segmentId: row.segmentId },
    ip,
  });
  return serializeBroadcast(row, { segmentName: null, templateName: null }, null, null);
}

/** Рассылка по id; 404 через ApiError, если не найдена. */
async function getBroadcastRow(id: string): Promise<Broadcast> {
  const row = await db.broadcast.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Рассылка не найдена');
  return row;
}

/** Редактирование: DONE можно (правки применятся при перезапуске), CANCELLED —
 *  нельзя (409); для RECURRING пересчитывается nextRunAt от нового расписания.
 *  Побочные эффекты: запись Broadcast, audit-лог UPDATE. */
export async function updateBroadcast(
  id: string,
  dto: UpdateBroadcastDto,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const row = await getBroadcastRow(id);
  // DONE редактировать МОЖНО: правки (сегмент/шаблон/лимиты) применятся при
  // перезапуске (POST /restart) — «завершённая» не значит «замороженная».
  // CANCELLED — терминальная (отменена пользователем): только удаление/пересоздание.
  if (row.status === 'CANCELLED') {
    throw new ApiError(409, 'Рассылка отменена', 'Редактирование недоступно');
  }
  if (row.kind === 'RECURRING' && (dto.weekday === null || dto.hour === null)) {
    throw new ApiError(422, 'Для регулярной рассылки укажите день недели и час');
  }
  await validateRefs(dto.segmentId, dto.templateId);
  const updated = await db.broadcast.update({
    where: { id },
    data: {
      name: dto.name,
      description: dto.description ?? null,
      segmentId: dto.segmentId,
      templateId: dto.templateId,
      ...(row.kind === 'RECURRING'
        ? {
            weekday: dto.weekday ?? null,
            hour: dto.hour ?? null,
            minute: dto.minute,
            nextRunAt: nextWallClockOccurrence(
              new Date(),
              EARLIEST_RU_TZ,
              dto.hour ?? 10,
              dto.minute,
              dto.weekday ?? 1,
            ),
          }
        : {}),
      minDaysBetween: dto.minDaysBetween,
      maxRecipients: dto.maxRecipients,
    },
  });
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.BROADCAST,
    entityId: id,
    details: { broadcast: updated.name },
    ip,
  });
  return getBroadcast(id);
}

/** Ручной запуск «сейчас» (кнопка «Запустить»; воркер-логика та же).
 *  Побочные эффекты: как executeBroadcastRun + audit-лог RUN. */
export async function runBroadcastNow(
  id: string,
  user: SessionUser,
  ip: string,
): Promise<{ result: RunResult; broadcast: Record<string, unknown> }> {
  const row = await getBroadcastRow(id);
  const result = await executeBroadcastRun(row.id);
  await logAudit({
    user,
    action: AuditAction.RUN,
    entityType: AuditEntity.BROADCAST,
    entityId: id,
    details: { broadcast: row.name, runId: result.runId, recipients: result.recipients },
    ip,
  });
  return { result, broadcast: await getBroadcast(id) };
}

/**
 * Перезапуск завершённой рассылки: реактивация + немедленный новый запуск.
 * В истории «Запуски» остаётся каждый запуск (прежние не затираются). Защита
 * «не чаще 1 раза в N дней» действует — недавно получавшие пропускаются.
 * RECURRING после перезапуска снова живёт по расписанию (nextRunAt пересчитан).
 */
export async function restartBroadcast(
  id: string,
  user: SessionUser,
  ip: string,
): Promise<{ result: RunResult; broadcast: Record<string, unknown> }> {
  const row = await getBroadcastRow(id);
  if (row.status !== 'DONE') {
    throw new ApiError(
      409,
      'Перезапустить можно только завершённую рассылку',
      'Активная запускается кнопкой «Запустить», отменённая — только пересоздаётся',
    );
  }
  // Дебаунс проверяем ДО мутаций: не оставить рассылку в ACTIVE с зависшим nextRunAt
  if (row.lastRunAt && row.lastRunAt.getTime() > Date.now() - RUN_DEBOUNCE_MS) {
    throw new ApiError(409, 'Последний запуск был менее минуты назад', 'Повторите перезапуск через минуту');
  }

  // Реактивация: ACTIVE + «due». executeBroadcastRun по финалу сам выставит
  // DONE (ONCE) либо сохранит ACTIVE и пересчитает nextRunAt (RECURRING).
  await db.broadcast.update({ where: { id }, data: { status: 'ACTIVE', nextRunAt: new Date() } });
  const result = await executeBroadcastRun(id);

  await logAudit({
    user,
    action: AuditAction.RUN,
    entityType: AuditEntity.BROADCAST,
    entityId: id,
    details: {
      broadcast: row.name,
      runId: result.runId,
      recipients: result.recipients,
      restarted: true,
    },
    ip,
  });
  return { result, broadcast: await getBroadcast(id) };
}

/** Пауза: статус PAUSED — воркер не выбирает очередь рассылки (пре-фильтр до
 *  claim'а), сообщения остаются QUEUED. Побочные эффекты: запись Broadcast,
 *  audit-лог PAUSE. */
export async function pauseBroadcast(id: string, user: SessionUser, ip: string): Promise<Record<string, unknown>> {
  const row = await getBroadcastRow(id);
  if (row.status !== 'ACTIVE') {
    throw new ApiError(409, 'На паузу можно поставить только активную рассылку');
  }
  await db.broadcast.update({ where: { id }, data: { status: 'PAUSED' } });
  await logAudit({
    user,
    action: AuditAction.PAUSE,
    entityType: AuditEntity.BROADCAST,
    entityId: id,
    details: { broadcast: row.name },
    ip,
  });
  return getBroadcast(id);
}

/** Возобновление: см. инлайн-комментарии — ONCE после запуска финализируется
 *  в DONE (нет «зомби»), иначе ACTIVE с восстановленным расписанием.
 *  Побочные эффекты: запись Broadcast, audit-лог RESUME. */
export async function resumeBroadcast(id: string, user: SessionUser, ip: string): Promise<Record<string, unknown>> {
  const row = await getBroadcastRow(id);
  if (row.status !== 'PAUSED') {
    throw new ApiError(409, 'Возобновить можно только рассылку на паузе');
  }
  // ONCE, запуск которой уже был (lastRunAt): её очередь продолжает отправляться
  // и без статуса ACTIVE — финализируем в DONE. Иначе после «запустить → пауза →
  // возобновить» рассылка навсегда оставалась бы ACTIVE с nextRunAt=null
  // («зомби», который воркер никогда не подхватит и не финализирует).
  if (row.kind === 'ONCE' && row.lastRunAt !== null) {
    await db.broadcast.update({ where: { id }, data: { status: 'DONE', nextRunAt: null } });
    await logAudit({
      user,
      action: AuditAction.RESUME,
      entityType: AuditEntity.BROADCAST,
      entityId: id,
      details: { broadcast: row.name, finalized: 'DONE' },
      ip,
    });
    return getBroadcast(id);
  }
  const now = new Date();
  // Просроченный во время паузы момент запуска сработает сразу (nextRunAt в прошлом);
  // ни разу не запускавшаяся ONCE — по расписанию (runAt) либо немедленно.
  const nextRunAt =
    row.kind === 'RECURRING' ? (row.nextRunAt ?? computeNextRunAt(row, now)) : (row.runAt ?? now);
  await db.broadcast.update({ where: { id }, data: { status: 'ACTIVE', nextRunAt } });
  await logAudit({
    user,
    action: AuditAction.RESUME,
    entityType: AuditEntity.BROADCAST,
    entityId: id,
    details: { broadcast: row.name },
    ip,
  });
  return getBroadcast(id);
}

/** Отмена рассылки (терминальная): будущие запуски прекращаются, запланированные
 * QUEUED-сообщения переводятся в CANCELLED; карточка и история запусков остаются.
 * Доступна для ACTIVE/PAUSED (DONE можно перезапустить, CANCELLED уже необратим). */
export async function cancelBroadcast(id: string, user: SessionUser, ip: string): Promise<Record<string, unknown>> {
  const row = await getBroadcastRow(id);
  if (row.status !== 'ACTIVE' && row.status !== 'PAUSED') {
    throw new ApiError(
      409,
      'Отменить можно только активную или приостановленную рассылку',
      'Завершённую можно перезапустить, отменённая — необратима',
    );
  }
  // Отмена: будущие запуски прекращаются, запланированные сообщения — тоже
  await db.smsMessage.updateMany({
    where: { broadcastId: id, status: 'QUEUED' },
    data: { status: 'CANCELLED' },
  });
  await db.broadcast.update({ where: { id }, data: { status: 'CANCELLED', nextRunAt: null } });
  await logAudit({
    user,
    action: AuditAction.CANCEL,
    entityType: AuditEntity.BROADCAST,
    entityId: id,
    details: { broadcast: row.name },
    ip,
  });
  return getBroadcast(id);
}

/**
 * Удаление рассылки: строка и запуски исчезают из панели, SMS-история остаётся
 * (имя рассылки отштамповано в сообщения при создании; для старых записей — здесь).
 */
export async function deleteBroadcast(id: string, user: SessionUser, ip: string): Promise<void> {
  const row = await getBroadcastRow(id);
  await db.smsMessage.updateMany({
    where: { broadcastId: id, status: 'QUEUED' },
    data: { status: 'CANCELLED' },
  });
  await db.smsMessage.updateMany({
    where: { broadcastId: id, broadcastName: null },
    data: { broadcastName: row.name },
  });
  await db.broadcast.delete({ where: { id } }); // запуски удаляются каскадом
  await logAudit({
    user,
    action: AuditAction.DELETE,
    entityType: AuditEntity.BROADCAST,
    entityId: id,
    details: { broadcast: row.name },
    ip,
  });
}

/** Тексты причин отказа (переиспользуются в UI запусков). */
export { REJECT_REASON_TEXT };
