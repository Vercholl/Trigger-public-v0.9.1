// Фоновый воркер: цикл раз в 5 секунд.
//  1) Обработка NEW-событий из events_inbox (старт воронок).
//  2) Claim due-задач scheduled_jobs (атомарно через updateMany со статусом PENDING).
//  3) Requeue зависших RUNNING-задач (рестарт-устойчивость).
//  4) Запуск due-рассылок по сегментам и отправка отложенных сообщений (П4).
//  5) Периодическая чистка истёкших сессий и записей rate-limiter'а.
//  6) Периодический снапшот БД и .env в /home/sync/db-backup (db-backup.ts) —
//     канал сохранности данных между сбросами песочницы платформой.
// Воркер никогда не роняет процесс: каждый тик и каждое событие/задача — в try/catch.
//
// Модель конкурентности: единственный экземпляр в процессе + мьютекс тика
// (state.ticking) + атомарные claim'ы строк через updateMany с гардом статуса
// (SQLite сериализует записи) — параллельные тики/процессы не заберут одно и
// то же. Идемпотентность ключевых шагов: повторный запуск воронки по событию
// отсекается idempotencyKey, повторный claim — гардом статуса в updateMany.
import { db } from '@/lib/db';
import type { Client, EventsInbox, Funnel } from '@prisma/client';
import { startInstance, continueInstance, logInstanceEvent } from '@/lib/engine/engine';
import { cleanupRateLimitEntries } from '@/lib/security/rate-limiter';
import { idleCutoffDate } from '@/lib/security/session';
import { cleanupExpiredShortLinks } from '@/lib/compliance/short-links';
import { clientCardSchema, cardFieldsToDb, cardVarsFromClient } from '@/lib/services/client-card';
import { applyCfFromEventCard, cfVarsForClient, type CfApplyResult } from '@/lib/services/custom-fields';
import { normalizePhone } from '@/lib/services/clients';
import { processDueBroadcasts, processScheduledBroadcastSms } from '@/lib/services/broadcasts';
import { processDueMassUpdates } from '@/lib/services/mass-update';
import {
  cleanupProfileHistory,
  diffProfileUpdates,
  recordProfileChanges,
  recordProfileCreated,
} from '@/lib/services/profile-history';
import { getSettings } from '@/lib/services/settings';
import { backupDatabase, backupEveryTicks } from '@/lib/db-backup';
import { journalSmsEvent } from '@/lib/services/message-events';
import {
  birthdayChanged,
  repairBirthdayCalendar,
  syncBirthdayCalendar,
} from '@/lib/services/birthday-calendar';
import { runMessageEventRetention } from '@/lib/services/message-event-retention';
import { processForwardTick } from '@/lib/services/forwarder';
import { getProvider } from '@/lib/provider/types';

/** Метрики единственного воркера (для /api/health: worker ok по свежести lastTickAt). */
export interface WorkerState {
  lastTickAt: number;
  startedAt: number;
  tickCount: number;
  /** true — тик сейчас выполняется (анти-наложение setInterval). */
  ticking: boolean;
}

const TICK_INTERVAL_MS = 5000;
const INBOX_BATCH = 50;
const JOBS_BATCH = 20;
const STALE_RUNNING_MS = 5 * 60 * 1000;
/** Зависший claim события (PROCESSING) — рестарт-восстановление через 5 минут. */
const STALE_INBOX_MS = 5 * 60 * 1000;
/** Обратный поток (форвардер): тик доставки каждые 3 тика = 15 с (близко к
 *  ретраям legacy 4×15 с; очередь сглаживает пики, гонки исключает мьютекс). */
const FORWARD_EVERY_TICKS = 3;
/** Зависший claim сообщения рассылки (SENDING) — возврат в очередь через 5 минут. */
const STALE_SENDING_MS = 5 * 60 * 1000;
const CLEANUP_EVERY_TICKS = 60;
/** Починка календаря ДР (Task 63): раз в час + первый запуск через минуту
 *  после старта (построение календаря на существующей БД после обновления). */
const BIRTHDAY_REPAIR_EVERY_TICKS = 720;
/** «Захват событий»: реконсиляция зависших статусов каждые 3 минуты. */
const RECONCILE_EVERY_TICKS = 36;
/** Статусы старше 2 часов без webhook-уведомления — опрос status() провайдера. */
const RECONCILE_AFTER_MS = 2 * 60 * 60 * 1000;
const RECONCILE_BATCH = 10;
/** Предел возраста реконсиляции: SENT старше — больше НЕ опрашиваем (остаётся
 *  SENT — честное «неизвестно», а не выдуманный FAILED). Причины: события МТС
 *  хранятся платформой 3 суток (TTL протокола) — опрос бессмыслен; без предела
 *  «вечные» SENT-головы батча (orderBy asc) голодали бы свежие зависшие статусы. */
const RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Ретеншн таймлайнов инстансов: события терминальных экземпляров старше N дней.
 *  Как у истории профиля (180) — таблица InstanceEvent растёт быстрее всех
 *  (2+ записи на каждый узел), без чистки она стала бы крупнейшей в БД. */
const INSTANCE_EVENT_RETENTION_DAYS = 180;

const g = globalThis as unknown as {
  __triggerWorkerState?: WorkerState;
  __triggerWorkerStarted?: boolean;
};

/** Состояние воркера для наружных потребителей (health); null — воркер не запускался. */
export function getWorkerState(): WorkerState | null {
  return g.__triggerWorkerState ?? null;
}

/**
 * Запуск цикла: один setInterval(TICK_INTERVAL_MS) + немедленный первый тик.
 * Идемпотентен в рамках процесса: флаг __triggerWorkerStarted в globalThis — Next.js
 * может инициализировать модуль повторно (HMR/роуты), дубль таймера исключён.
 * interval.unref() — таймер не держит процесс от выхода.
 */
export function startWorker(): void {
  if (g.__triggerWorkerStarted) return;
  g.__triggerWorkerStarted = true;
  const workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  g.__triggerWorkerState = { lastTickAt: 0, startedAt: Date.now(), tickCount: 0, ticking: false };
  console.log(`[worker] started (${workerId})`);
  const interval = setInterval(() => {
    void tick(workerId);
  }, TICK_INTERVAL_MS);
  interval.unref?.();
  // ДО первого тика — восстановление операций массового обновления,
  // зависших в RUNNING после краха процесса (claim без завершения): их не
  // подхватывает ни один путь (воркер берёт только PENDING). Возврат в PENDING
  // безопасен: применение диффовое — уже обработанные клиенты на повторном
  // проходе не изменяются (значения совпадают), история пишет только реальные
  // изменения. В живом процессе рестарта нет (флаг __triggerWorkerStarted),
  // HMR-перезагрузку модуля переживает globalThis-флаг — двойного requeue нет.
  void requeueInterruptedMassUpdates().then(() => tick(workerId));
}

/** Рестарт-восстановление: RUNNING-операции массового обновления → PENDING. */
async function requeueInterruptedMassUpdates(): Promise<void> {
  try {
    const res = await db.massUpdateJob.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'PENDING' },
    });
    if (res.count > 0) {
      console.warn(
        `[worker] восстановлено после рестарта операций массового обновления: ${res.count}`,
      );
    }
  } catch (e) {
    console.warn(
      '[worker] requeue mass-update не удался (продолжаем):',
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Один тик — постоянный порядок шагов: события (новые воронки) → задачи
 * (продолжение WAITING) → requeue зависших → рассылки/отложенные SMS →
 * снапшот БД (раз в 5 мин) → реконсиляция статусов (раз в 3 мин) → чистка
 * (раз в ~5 мин). События идут раньше задач: при гонке «событие пришло ≈
 * истёк таймаут waitEvent» побеждает пробуждение по событию.
 */
async function tick(workerId: string): Promise<void> {
  const state = g.__triggerWorkerState;
  if (!state) return;
  // Анти-наложение тиков: send() провайдера может длиться дольше 5 секунд —
  // без мьютекса параллельный тик увидит те же QUEUED/NEW строки и отправит дубли.
  if (state.ticking) return;
  state.ticking = true;
  try {
    state.tickCount += 1;
    await processInboxEvents();
    // Батч-импорт — отдельным ускоренным потоком (после триггерных: запуск
    // воронок важнее массового upsert карточек, но голода нет —
    // processImportEvents забирает до 2000 строк за тик).
    await processImportEvents();
    await processDueJobs(workerId);
    await requeueStaleJobs();
    await processDueBroadcasts();
    await processScheduledBroadcastSms();
    // Массовое обновление (P4): одна PENDING-операция за тик — не конкурирует
    // с событиями/рассылками за время тика (последовательность как у рассылок)
    await processDueMassUpdates();
    // Снапшот БД в /home/sync/db-backup: первый тик + адаптивный интервал
    // (backupEveryTicks: 5 мин на маленькой БД, 30 мин на много-гигабайтной)
    if (state.tickCount === 1 || state.tickCount % backupEveryTicks() === 0) {
      await backupDatabase();
    }
    if (state.tickCount % RECONCILE_EVERY_TICKS === 0) {
      await reconcileDeliveryStatuses();
    }
    // Обратный поток (форвардер во внешний приёмник): тихий no-op при выключенном
    // тумблере/пустой очереди — чтение настроек кэшировано одним SELECT.
    if (state.tickCount % FORWARD_EVERY_TICKS === 0) {
      try {
        await processForwardTick();
      } catch (e) {
        console.error('[worker] forwarder tick failed:', e instanceof Error ? e.message : String(e));
      }
    }
    if (state.tickCount % CLEANUP_EVERY_TICKS === 0) {
      await cleanup();
      // Ретеншн журнала MessageEvent (Task 63): окно в настройках, выгрузка
      // в gz-архив перед удалением, ≤ 50 тыс. строк за прогон — мягкий дренаж
      try {
        await runMessageEventRetention();
      } catch (e) {
        console.error('[worker] message-event retention failed:', e instanceof Error ? e.message : String(e));
      }
    }
    // Починка календаря ДР (Task 63): глубокая — через минуту после старта
    // (построение на существующей БД) и раз в сутки; ежечасно — быстрый
    // паритет-путь (миллисекунды); ленивый запуск при рассинхроне — из
    // classifyRules (segments.ts)
    if (
      state.tickCount === 12 ||
      state.tickCount % BIRTHDAY_REPAIR_EVERY_TICKS === 0 ||
      state.tickCount % (BIRTHDAY_REPAIR_EVERY_TICKS * 24) === 0
    ) {
      const deep =
        state.tickCount === 12 || state.tickCount % (BIRTHDAY_REPAIR_EVERY_TICKS * 24) === 0;
      await repairBirthdayCalendar({ deep });
    }
  } catch (e) {
    console.error('[worker] tick failed:', e instanceof Error ? e.message : String(e));
  } finally {
    state.ticking = false;
    state.lastTickAt = Date.now();
  }
}

// ---------- 1. События ----------

function parseJsonSafe(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Обработка событий инбокса (экспортируется для сценарных прогонов/проверок
 * ингеста; сама тик-обёртка остаётся приватной). Порядок внутри события —
 * см. processOneEvent. Батч INBOX_BATCH=50, старейшие первыми (createdAt asc).
 */
export async function processInboxEvents(): Promise<void> {
  // NEW — новые события; PROCESSING старше STALE_INBOX_MS — зависший claim после краша
  // (claim перед обработкой исключает повторный запуск воронок параллельным тиком).
  const events = await db.eventsInbox.findMany({
    where: {
      OR: [
        { status: 'NEW', skipTriggers: false },
        { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - STALE_INBOX_MS) }, skipTriggers: false },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: INBOX_BATCH,
  });
  for (const ev of events) {
    // Атомарный claim: статус меняется только у того, кто успел (SQLite сериализует записи)
    const claimed = await db.eventsInbox.updateMany({
      where: { id: ev.id, status: ev.status },
      data: { status: 'PROCESSING' },
    });
    if (claimed.count !== 1) continue;
    try {
      await processOneEvent(ev);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[worker] event ${ev.id} failed: ${message}`);
      try {
        await db.eventsInbox.update({
          where: { id: ev.id },
          data: { status: 'FAILED', error: message },
        });
      } catch {
        // ignore
      }
    }
  }
}

/** Батч строк батч-импорта (skip_triggers=true): больше триггерного — это
 *  чистые upsert карточек без запуска воронок (processOneEvent завершается
 *  сразу после применения карточки/cf). 2000 строк × 5 с ≈ 24 тыс. строк/мин —
 *  стартовая загрузка 3 млн ≈ 1–2 часа; ЧДП-джоб (тысячи строк) — минуты. */
const IMPORT_BATCH = 2000;

/**
 * Ускоренный поток импорта: строки skip_triggers=true обрабатываются батчем
 * 2000 за тик. Claim — чанками по 500 одним updateMany (id IN …, статус NEW):
 * атомарно и без 2000 одиночных UPDATE. Зависший PROCESSING (крах посреди
 * батча) подбирается тем же запросом через 5 минут — upsert карточки
 * идемпотентен, повторное применение ничего не меняет.
 */
export async function processImportEvents(): Promise<number> {
  const events = await db.eventsInbox.findMany({
    where: {
      OR: [
        { status: 'NEW', skipTriggers: true },
        { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - STALE_INBOX_MS) }, skipTriggers: true },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: IMPORT_BATCH,
    select: { id: true },
  });
  if (events.length === 0) return 0;
  for (let c = 0; c < events.length; c += 500) {
    const ids = events.slice(c, c + 500).map((e) => e.id);
    // Атомарный чанк-claim: статус меняется только у NEW-строк (зависшие
    // PROCESSING из этого же списка подберутся повторно — идемпотентно).
    await db.eventsInbox.updateMany({
      where: { id: { in: ids }, status: 'NEW' },
      data: { status: 'PROCESSING' },
    });
  }
  let processed = 0;
  const claimed = await db.eventsInbox.findMany({
    where: { id: { in: events.map((e) => e.id) }, status: 'PROCESSING' },
    orderBy: { createdAt: 'asc' },
  });
  for (const ev of claimed) {
    try {
      await processOneEvent(ev);
      processed += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[worker] import ${ev.id} failed: ${message}`);
      try {
        await db.eventsInbox.update({
          where: { id: ev.id },
          data: { status: 'FAILED', error: message },
        });
      } catch {
        // ignore
      }
    }
  }
  return processed;
}

/**
 * Событие с client_card ОБНОВЛЯЕТ карточку клиента (upsert по external_id)
 * ДО поиска воронок, затем запускает воронки. Флаги clientCreated/clientUpdated
 * пишутся в result события. Событие хранится в payload как есть (client_card внутри).
 * История профиля (P5): фактические диффы «было → стало» пишутся в
 * ProfileChangeLog с источником EVENT и контекстом события; создание клиента —
 * спец-строка __created__.
 */
async function upsertClientFromCard(
  ev: { id: string; externalId: string; event: string },
  cardRaw: unknown,
): Promise<{ client: ClientRow | null; clientCreated: boolean; clientUpdated: boolean }> {
  const parsed = clientCardSchema.safeParse(cardRaw);
  if (!parsed.success) {
    // Ингест уже валидирует ту же схему; сюда попадают только повреждённые строки.
    const issue = parsed.error.issues[0];
    throw new Error(
      `некорректная карточка клиента (client_card): ${issue ? `${issue.path.join('.') || 'поле'}: ${issue.message}` : 'ошибка валидации'}`,
    );
  }
  const card = parsed.data;
  const cardData = cardFieldsToDb(card);

  // Телефон: валидируется через normalizePhone; невалидный — не трогаем и не падаем.
  const phone = card.phone !== undefined && card.phone !== null ? normalizePhone(card.phone) : null;
  // Пояс: схема нормализует IANA/цифровое UTC (внешняя система) в IANA-зону; null — не распознан → игнор.
  const timezone = card.timezone ?? null;

  const existing = await db.client.findUnique({ where: { externalId: ev.externalId } });
  if (existing) {
    // Частичное обновление всех переданных полей карточки.
    const row = await db.client.update({
      where: { id: existing.id },
      data: {
        ...cardData,
        ...(phone !== null ? { phone } : {}),
        ...(timezone !== null ? { timezone } : {}),
        // profileUpdatedAt = date_update из карточки, иначе now()
        profileUpdatedAt: card.date_update ?? new Date(),
      },
    });
    // История профиля (P5): только фактические изменения (события шлют карточку
    // целиком, меняется 1–2 поля — без диффа журнал захламлялся бы no-op'ами).
    // НЮАНС: у clientCardSchema ключ timezone материализуется как null даже при
    // отсутствии в сырой карточке (внешний .transform() на nullish-поле) —
    // спред card целиком дал бы ложную строку «timezone → пусто»; контакты
    // передаём только фактами: phone — если валиден, timezone — если распознан.
    const { phone: _cardPhone, timezone: _cardTz, ...cardFields } = card as unknown as Record<string, unknown>;
    const changes = diffProfileUpdates(existing, {
      ...cardFields,
      ...(phone !== null ? { phone } : {}),
      ...(timezone !== null ? { timezone } : {}),
    });
    await recordProfileChanges(row.id, changes, 'EVENT', { eventId: ev.id, event: ev.event });
    // Календарь ДР (Task 63): пересинхронизация ТОЛЬКО при изменении birthday —
    // на потоке карточек (события шлют её целиком) это редкость, лишних upsert нет
    if (birthdayChanged(existing.birthday, row.birthday)) {
      await syncBirthdayCalendar(row.id, row.birthday);
    }
    return { client: row, clientCreated: false, clientUpdated: true };
  }

  // Клиента нет: создаём, только если в карточке есть ВАЛИДНЫЙ телефон.
  if (phone === null) {
    return { client: null, clientCreated: false, clientUpdated: false };
  }
  const row = await db.client.create({
    data: {
      externalId: ev.externalId,
      phone,
      timezone: timezone ?? (process.env.DEFAULT_TIMEZONE?.trim() || 'Asia/Novosibirsk'),
      ...cardData,
      profileUpdatedAt: card.date_update ?? new Date(),
      data: '{}',
      smsConsentStatus: 'NONE',
    },
  });
  await recordProfileCreated(row.id, 'EVENT', { eventId: ev.id, event: ev.event });
  // Календарь ДР (Task 63): строка создаётся вместе с клиентом (если ДР задан)
  if (row.birthday) {
    await syncBirthdayCalendar(row.id, row.birthday);
  }
  return { client: row, clientCreated: true, clientUpdated: false };
}

type ClientRow = Client;

/**
 * Обработка одного события (вызывается после атомарного claim NEW→PROCESSING):
 * 1) upsert карточки клиента из payload.client_card (до воронок — свежие данные);
 * 2) пробуждение WAITING-экземпляров, ждущих это событие (waitEvent-узлы);
 * 3) запуск всех активных воронок триггера с учётом entryMode
 *    (PARALLEL/REPLACE/SKIP/SKIP_ACTIVE) и идемпотентности idempotencyKey;
 * 4) итог — всегда PROCESSED (даже при нуле воронок) с result-JSON для UI:
 *    clientCreated/clientUpdated, instances[{funnelId, instanceId, skipped}],
 *    wokenEvents. Исключение наверх → статус FAILED с текстом ошибки
 *    (ретрай — только вручную оператором).
 */
async function processOneEvent(ev: EventsInbox): Promise<void> {
  const payload = parseJsonSafe(ev.payload);

  // До поиска воронок — upsert карточки клиента из client_card (если есть).
  let client: Client | null = await db.client.findUnique({ where: { externalId: ev.externalId } });
  const cardFlags: { clientCreated?: boolean; clientUpdated?: boolean } = {};
  // Кастомные поля события (cf_*): ingest нормализовал и вшил их в
  // payload.client_card; применяются к профилю ЗДЕСЬ — до запуска воронок,
  // чтобы переменные {{cf_*}} видели свежие значения. Итог — в result события.
  let cfResult: CfApplyResult | null = null;
  if (
    payload.client_card !== undefined &&
    payload.client_card !== null &&
    typeof payload.client_card === 'object' &&
    !Array.isArray(payload.client_card)
  ) {
    const upserted = await upsertClientFromCard(
      { id: ev.id, externalId: ev.externalId, event: ev.event },
      payload.client_card,
    );
    client = upserted.client;
    if (upserted.clientCreated) cardFlags.clientCreated = true;
    if (upserted.clientUpdated) cardFlags.clientUpdated = true;
    // cf-значения — только для существующего профиля (клиент без телефона не создан)
    if (client) {
      cfResult = await applyCfFromEventCard(client.id, payload.client_card as Record<string, unknown>, {
        eventId: ev.id,
        eventName: ev.event,
      });
    }
  }

  if (!client) {
    // Неизвестный external_id (карточки нет или без валидного телефона) → PROCESSED
    await db.eventsInbox.update({
      where: { id: ev.id },
      data: { status: 'PROCESSED', result: JSON.stringify({ ...cardFlags, ...(cfResult ? cfSummary(cfResult) : {}), clientNotFound: true }) },
    });
    return;
  }

  // Батч-импорт (skip_triggers): карточка обновлена — на этом всё. Воронки НЕ
  // запускаются, waitEvent-экземпляры НЕ будятся (семантика profiles/import
  // legacy-платформы — «только upsert профиля»). Триггерные события
  // (skip_triggers=false) проходят дальше как обычно.
  if (ev.skipTriggers) {
    await db.eventsInbox.update({
      where: { id: ev.id },
      data: {
        status: 'PROCESSED',
        result: JSON.stringify({ skipTriggers: true, ...cardFlags, ...(cfResult ? cfSummary(cfResult) : {}) }),
      },
    });
    return;
  }

  // ДО запуска воронок — пробуждаем экземпляры, ожидающие это событие (waitEvent-узлы).
  const woken = await wakeWaitingInstances(client, ev);

  const funnels: Funnel[] = await db.funnel.findMany({
    where: { triggerEvent: ev.event, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (funnels.length === 0 && woken.length === 0) {
    await db.eventsInbox.update({
      where: { id: ev.id },
      data: { status: 'PROCESSED', result: JSON.stringify({ ...cardFlags, ...(cfResult ? cfSummary(cfResult) : {}), funnelsFound: 0 }) },
    });
    return;
  }

  const instances: Array<{ funnelId: string; instanceId: string; skipped?: string }> = [];
  for (const funnel of funnels) {
    // Краш-устойчивость: если экземпляр этой воронки по ЭТОМУ событию уже создавался
    // (событие зависло в PROCESSING и обрабатывается повторно через 5 минут),
    // повторный запуск не нужен — для PARALLEL это дубль SMS, для REPLACE
    // перезапуск поверх. Идемпотентность по ключу события (idempotencyKey).
    if (ev.idempotencyKey) {
      const alreadyStarted = await db.workflowInstance.findFirst({
        where: { idempotencyKey: ev.idempotencyKey, funnelId: funnel.id },
        select: { id: true },
      });
      if (alreadyStarted) {
        instances.push({ funnelId: funnel.id, instanceId: alreadyStarted.id, skipped: 'SKIPPED_ALREADY_STARTED' });
        continue;
      }
    }
    // Режим повторного входа при новом событии.
    const existing = await db.workflowInstance.findFirst({
      where: {
        funnelId: funnel.id,
        clientId: client.id,
        status: { in: ['RUNNING', 'WAITING'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (funnel.entryMode === 'PARALLEL') {
      // параллельный запуск — без проверок
    } else if (funnel.entryMode === 'REPLACE') {
      if (existing) {
        await cancelInstance(existing.id, 'Перезапуск по новому событию (режим «заменять»)');
      }
    } else if (funnel.entryMode === 'SKIP') {
      // «один раз навсегда»: любой экземпляр (включая завершённые) блокирует запуск
      const everCount = await db.workflowInstance.count({
        where: { funnelId: funnel.id, clientId: client.id },
      });
      if (everCount > 0) {
        instances.push({ funnelId: funnel.id, instanceId: '-', skipped: 'SKIPPED_ALREADY_PASSED' });
        continue;
      }
    } else {
      // SKIP_ACTIVE (по умолчанию): пропустить, пока экземпляр выполняется/ждёт
      if (existing) {
        // Пропуск фиксируется в result события, не ошибкой
        instances.push({ funnelId: funnel.id, instanceId: existing.id, skipped: 'SKIPPED_ACTIVE_EXISTS' });
        continue;
      }
    }
    const instance = await startInstance(funnel, client, ev);
    instances.push({ funnelId: funnel.id, instanceId: instance.id });
  }

  await db.eventsInbox.update({
    where: { id: ev.id },
    data: {
      status: 'PROCESSED',
      result: JSON.stringify({ ...cardFlags, ...(cfResult ? cfSummary(cfResult) : {}), instances, wokenEvents: woken }),
    },
  });
}

/** Компактная сводка применения cf-значений для result-JSON события:
 *  cfApplied N (записей) и cfSkipped [ключи] — только при непустом результате. */
function cfSummary(r: CfApplyResult): Record<string, unknown> {
  if (r.applied === 0 && r.skipped.length === 0) return {};
  return {
    cfApplied: r.applied,
    ...(r.skipped.length > 0 ? { cfSkipped: r.skipped } : {}),
  };
}

/** Мягкая отмена экземпляра (режим REPLACE): статус + отмена задач (в т.ч. RUNNING —
 * исполняющаяся задача не должна «воскрешать» отменённый экземпляр) + таймлайн. */
async function cancelInstance(instanceId: string, reason: string): Promise<void> {
  await db.scheduledJob.updateMany({
    where: { instanceId, status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'CANCELLED' },
  });
  await db.workflowInstance.update({ where: { id: instanceId }, data: { status: 'CANCELLED' } });
  await logInstanceEvent(instanceId, 'STATUS_CHANGE', { message: 'CANCELLED' });
  await logInstanceEvent(instanceId, 'INFO', { message: reason });
}

/** Пробуждение экземпляров, ожидающих событие ev (waitEvent-узлы) — до запуска воронок. */
async function wakeWaitingInstances(
  client: ClientRow,
  ev: Pick<EventsInbox, 'id' | 'event' | 'baseUrl' | 'payload'>,
): Promise<Array<{ instanceId: string; funnelId: string }>> {
  const waiting = await db.workflowInstance.findMany({
    where: { clientId: client.id, status: 'WAITING' },
    orderBy: { createdAt: 'asc' },
  });
  const woken: Array<{ instanceId: string; funnelId: string }> = [];
  // Кастомные поля (cf_*) — один запрос на клиента (до цикла): карточка и cf уже
  // применены выше; порядок слоёв vars — 1:1 как в startInstance
  // (карточка < client.data < payload < cf_*).
  const cfVars = await cfVarsForClient(client.id);
  for (const inst of waiting) {
    const ctx = parseJsonSafe(inst.context);
    const marker = ctx.waitEvent as { event: string; nodeId: string } | null | undefined;
    if (!marker || marker.event !== ev.event) continue;

    // Идемпотентность пробуждения: ретрай события (зависший PROCESSING-claim
    // после краша / ручной retry оператором) не должен будить экземпляр этим ЖЕ
    // событием повторно. Сценарий без маркера: инстанс прошёл onEvent-ветку и
    // встал в СЛЕДУЮЩИЙ waitEvent на то же событие («ждём следующий платёж») —
    // повторное пробуждение дублировало бы onEvent-цепочку (второе SMS).
    if ((ctx.lastWakeEventId as string | undefined) === ev.id) continue;

    // Определение воронки нужно дважды: REPLACE-гвард ниже и ветка onEvent.
    const funnel = await db.funnel.findUnique({ where: { id: inst.funnelId } });

    // REPLACE + waitEvent на ТРИГГЕРНОЕ событие этой же воронки: пробуждение
    // исполнило бы onEvent-ветку ДО отмены экземпляра циклом воронок ниже —
    // два SMS на одно событие (старая ветка + новый инстанс). Не будим: REPLACE
    // ниже сам отменит экземпляр (вместе с задачами) и запустит новый.
    if (
      funnel?.isActive === true &&
      funnel.entryMode === 'REPLACE' &&
      funnel.triggerEvent === ev.event
    ) {
      continue;
    }

    // Таймаут-задача больше не нужна. Гасим и PENDING, и RUNNING: тики сериализованы
    // мьютексом (state.ticking), поэтому во время обработки инбокса RUNNING-задача
    // бывает ТОЛЬКО у рухнувшего процесса (claim без завершения). Без отмены такая
    // задача вернётся requeue'ем в PENDING и преждевременно «таймаутнет» СЛЕДУЮЩЕЕ
    // ожидание этого же узла (маркер совпадает по nodeId) — вплоть до лишней ветки
    // onTimeout и повторной отправки SMS.
    await db.scheduledJob.updateMany({
      where: { instanceId: inst.id, status: { in: ['PENDING', 'RUNNING'] }, reason: 'WAIT_EVENT' },
      data: { status: 'CANCELLED' },
    });

    // Свежий контекст: payload нового события (карточка уже обновлена выше) +
    // ПОЛНОСТЬЮ пересобранный слой client — 1:1 как в startInstance (внешние
    // поля + cardVars + cf); без пересборки вложенный client.X оставался бы
    // снапшотом старта воронки и расходился с голым X из vars.
    const payload = parseJsonSafe(ev.payload);
    const clientData = parseJsonSafe(client.data);
    const cardVars = cardVarsFromClient(client);
    const newCtx = {
      ...ctx,
      event: ev.event,
      payload,
      client: {
        externalId: client.externalId,
        phone: client.phone,
        timezone: client.timezone,
        data: clientData,
        ...cardVars,
        ...cfVars,
      },
      vars: { ...cardVars, ...clientData, ...payload, ...cfVars },
      baseUrl: ev.baseUrl ?? ctx.baseUrl,
      waitEvent: null,
      lastWakeEventId: ev.id,
    };
    const contextJson = JSON.stringify(newCtx);
    // Атомарный claim статуса: между findMany(WAITING) и этим апдейтом есть
    // await-точки — экземпляр мог получить HTTP-отмену / отмену REPLACE другой
    // воронки. Безусловный update перезаписал бы CANCELLED → RUNNING и
    // «воскресил» бы отменённую воронку (SMS после отмены). Не застали WAITING — не будим.
    const claimed = await db.workflowInstance.updateMany({
      where: { id: inst.id, status: 'WAITING' },
      data: { context: contextJson, status: 'RUNNING' },
    });
    if (claimed.count !== 1) continue;
    await logInstanceEvent(inst.id, 'STATUS_CHANGE', { message: 'RUNNING' });
    await logInstanceEvent(inst.id, 'WAIT_EVENT_RECEIVED', {
      nodeId: marker.nodeId,
      nodeType: 'waitEvent',
      message: `Дождались событие ${ev.event} — ветка «событие»`,
    });

    // Ветка onEvent из определения воронки (узел могли переименовать/удалить — тогда завершение)
    let onEvent: string | null = null;
    if (funnel) {
      try {
        const def = JSON.parse(funnel.definition) as { nodes?: Array<{ id: string; onEvent?: string | null }> };
        const node = (def.nodes ?? []).find((n) => n.id === marker.nodeId);
        onEvent = node?.onEvent ?? null;
      } catch {
        onEvent = null;
      }
    }
    if (onEvent === null) {
      // Гвард: только что переведённый в RUNNING экземпляр мог получить
      // HTTP-отмену — не перекрываем её статусом COMPLETED.
      await db.workflowInstance.updateMany({
        where: { id: inst.id, status: 'RUNNING' },
        data: { status: 'COMPLETED' },
      });
      await logInstanceEvent(inst.id, 'STATUS_CHANGE', { message: 'COMPLETED' });
    } else {
      await continueInstance({ ...inst, context: contextJson }, onEvent);
    }
    woken.push({ instanceId: inst.id, funnelId: inst.funnelId });
  }
  return woken;
}

// ---------- 2. Отложенные задачи ----------

/**
 * Claim due-задач scheduled_jobs и продолжение воронок. Для каждой задачи:
 * атомарный claim PENDING→RUNNING (lockedBy/lockedUntil 60 с); затем гарды
 * (экземпляр удалён/отменён/уже завершён — задача закрывается DONE/CANCELLED);
 * ветка WAIT_EVENT — таймаут ожидания (снятие маркера + ветка onTimeout);
 * обычная задача — continueInstance от job.nodeId с attempts из задачи.
 * Задача всегда получает терминальный статус (DONE/FAILED/CANCELLED);
 * при исключении FAILED получают И задача, И экземпляр (ошибка выполнения).
 */
async function processDueJobs(workerId: string): Promise<void> {
  const now = new Date();
  const jobs = await db.scheduledJob.findMany({
    where: { status: 'PENDING', runAt: { lte: now } },
    orderBy: { runAt: 'asc' },
    take: JOBS_BATCH,
  });

  for (const job of jobs) {
    // Атомарный claim: updateMany со статусом PENDING (SQLite сериализует записи).
    const claimed = await db.scheduledJob.updateMany({
      where: { id: job.id, status: 'PENDING' },
      data: {
        status: 'RUNNING',
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60_000),
      },
    });
    if (claimed.count !== 1) continue;

    try {
      const instance = await db.workflowInstance.findUnique({ where: { id: job.instanceId } });
      if (!instance) {
        await db.scheduledJob.update({ where: { id: job.id }, data: { status: 'FAILED' } });
        continue;
      }
      if (instance.status === 'CANCELLED') {
        await db.scheduledJob.update({ where: { id: job.id }, data: { status: 'CANCELLED' } });
        continue;
      }
      if (instance.status === 'COMPLETED' || instance.status === 'FAILED') {
        await db.scheduledJob.update({ where: { id: job.id }, data: { status: 'DONE' } });
        continue;
      }

      // Таймаут waitEvent-узла — снимаем маркер ожидания и берём ветку onTimeout.
      // Гонка с пробуждением: если маркер уже снят (событие пришло) или относится к другому
      // узлу — таймаут недействителен, задача просто закрывается.
      if (job.reason === 'WAIT_EVENT') {
        const ctx = parseJsonSafe(instance.context);
        const marker = ctx.waitEvent as { event: string; nodeId: string } | null | undefined;
        if (!marker || marker.nodeId !== job.nodeId) {
          await db.scheduledJob.update({ where: { id: job.id }, data: { status: 'DONE' } });
          continue;
        }
        ctx.waitEvent = null;
        await db.workflowInstance.update({
          where: { id: instance.id },
          data: { context: JSON.stringify(ctx) },
        });
        await logInstanceEvent(instance.id, 'WAIT_EVENT_TIMEOUT', {
          nodeId: job.nodeId,
          nodeType: 'waitEvent',
          message: 'Таймаут ожидания события — ветка «таймаут»',
        });
        let onTimeout: string | null = null;
        const funnelRow = await db.funnel.findUnique({ where: { id: instance.funnelId } });
        if (funnelRow) {
          try {
            const def = JSON.parse(funnelRow.definition) as {
              nodes?: Array<{ id: string; onTimeout?: string | null }>;
            };
            const node = (def.nodes ?? []).find((n) => n.id === job.nodeId);
            onTimeout = node?.onTimeout ?? null;
          } catch {
            onTimeout = null;
          }
        }
        if (onTimeout === null) {
          // Ветки нет — тихо завершаем. Гвард отмены (как в wakeWaitingInstances):
          // между снятием маркера и этой точкой есть await-точки (лог, чтение
          // воронки), в которых оператор мог отменить экземпляр — безусловный
          // update перезаписал бы CANCELLED → COMPLETED (неверный финальный
          // статус в UI и аудите). Не застали WAITING/RUNNING — только закрываем задачу.
          const completed = await db.workflowInstance.updateMany({
            where: { id: instance.id, status: { in: ['WAITING', 'RUNNING'] } },
            data: { status: 'COMPLETED' },
          });
          if (completed.count === 1) {
            await logInstanceEvent(instance.id, 'STATUS_CHANGE', { message: 'COMPLETED' });
          }
          await db.scheduledJob.update({ where: { id: job.id }, data: { status: 'DONE' } });
          continue;
        }
        // Гвард отмены: статус меняется на RUNNING только из WAITING/RUNNING —
        // между снятием маркера и этим апдейтом есть await-точки (лог, чтение
        // воронки), в которых оператор мог отменить инстанс; безусловный update
        // перезаписал бы CANCELLED → RUNNING — отменённая воронка продолжила бы
        // исполняться (SMS после отмены).
        const claimedToRunning = await db.workflowInstance.updateMany({
          where: { id: instance.id, status: { in: ['WAITING', 'RUNNING'] } },
          data: { status: 'RUNNING' },
        });
        if (claimedToRunning.count !== 1) {
          await db.scheduledJob.update({ where: { id: job.id }, data: { status: 'CANCELLED' } });
          continue;
        }
        await logInstanceEvent(instance.id, 'STATUS_CHANGE', { message: 'RUNNING' });
        await continueInstance(
          { ...instance, context: JSON.stringify(ctx) },
          onTimeout,
        );
        await db.scheduledJob.update({ where: { id: job.id }, data: { status: 'DONE' } });
        continue;
      }

      // Гвард отмены — как в ветке WAIT_EVENT выше: не перезаписываем CANCELLED.
      const claimedToRunning = await db.workflowInstance.updateMany({
        where: { id: instance.id, status: { in: ['WAITING', 'RUNNING'] } },
        data: { status: 'RUNNING' },
      });
      if (claimedToRunning.count !== 1) {
        await db.scheduledJob.update({ where: { id: job.id }, data: { status: 'CANCELLED' } });
        continue;
      }
      await logInstanceEvent(instance.id, 'STATUS_CHANGE', { message: 'RUNNING' });
      await continueInstance(instance, job.nodeId, { attempts: job.attempts });
      await db.scheduledJob.update({ where: { id: job.id }, data: { status: 'DONE' } });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[worker] job ${job.id} failed: ${message}`);
      try {
        await db.scheduledJob.update({ where: { id: job.id }, data: { status: 'FAILED' } });
        // Гвард отмены: сбой возможен как до, так и после claimToRunning —
        // экземпляр в этой точке WAITING или RUNNING (терминальные отсечены
        // проверками выше), но HTTP-отмена могла сработать в любом await —
        // CANCELLED терминален и «чище» (оператор уже принял решение),
        // FAILED не должен его перезаписывать.
        await db.workflowInstance.updateMany({
          where: { id: job.instanceId, status: { in: ['WAITING', 'RUNNING'] } },
          data: { status: 'FAILED', error: `Ошибка выполнения задачи: ${message}` },
        });
        await logInstanceEvent(job.instanceId, 'ERROR', {
          nodeId: job.nodeId,
          message: `Ошибка выполнения задачи: ${message}`,
        });
      } catch {
        // ignore
      }
    }
  }
}

// ---------- 3. Requeue зависших задач ----------

/**
 * Requeue задач, застрявших в RUNNING (краш воркера посреди исполнения):
 * lock протух дольше STALE_RUNNING_MS → назад в PENDING, следующий тик
 * заберёт повторно. Повторное исполнение узла безопасно: проверки узлов
 * идемпотентны, повторная отправка SMS отсекается idempotencyScope провайдера.
 */
async function requeueStaleJobs(): Promise<void> {
  await db.scheduledJob.updateMany({
    where: { status: 'RUNNING', lockedUntil: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
    data: { status: 'PENDING', lockedBy: null, lockedUntil: null },
  });
}

// ---------- Реконсиляция статусов доставки ----------

/** SMS в SENT дольше RECONCILE_AFTER_MS без уведомления шлюза (webhook потерян /
 * не настроен) — опрашиваем status() провайдера и применяем финальный статус.
 * Страховка от потерянных событий. Работает только при включённом тумблере
 * «Захвата событий». */
async function reconcileDeliveryStatuses(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.hooksEnabled) return;

    const cutoff = new Date(Date.now() - RECONCILE_AFTER_MS);
    const ageLimit = new Date(Date.now() - RECONCILE_MAX_AGE_MS);
    const stuck = await db.smsMessage.findMany({
      where: {
        status: 'SENT',
        provider: { in: ['smstech', 't2', 'mts'] },
        providerMessageId: { not: null },
        // окно опроса: зависшие дольше RECONCILE_AFTER_MS, но моложе предела
        // возраста (старше — события шлюза уже не существуют/не изменятся)
        sentAt: { lt: cutoff, gt: ageLimit },
      },
      orderBy: { sentAt: 'asc' },
      take: RECONCILE_BATCH,
      select: { id: true, provider: true, providerMessageId: true, phone: true, clientId: true },
    });

    for (const m of stuck) {
      if (m.providerMessageId === null) continue;
      try {
        const provider = getProvider(m.provider);
        const status = await provider.status(m.providerMessageId);
        if (status === 'DELIVERED') {
          const deliveredAt = new Date();
          await db.smsMessage.update({
            where: { id: m.id },
            data: { status: 'DELIVERED', deliveredAt, error: null },
          });
          await journalSmsEvent({
            source: m.provider as 'smstech' | 't2' | 'mts',
            eventType: 'deliv_sms',
            smsMessageId: m.id,
            clientId: m.clientId,
            phone: m.phone,
            provider: m.provider,
            externalIds: { send_message_id: m.providerMessageId },
            payload: { reconciled: true, provider: m.provider, send_message_id: m.providerMessageId },
            dedupKey: `reconcile:${m.provider}:${m.providerMessageId}:deliv`,
            result: { smsStatus: 'DELIVERED', via: 'reconciliation' },
          });
          console.log(`[worker] reconciled ${m.provider}:${m.providerMessageId} → DELIVERED`);
        } else if (status === 'FAILED') {
          await db.smsMessage.update({
            where: { id: m.id },
            data: { status: 'FAILED', error: 'Реконсиляция: сообщение не доставлено' },
          });
          await journalSmsEvent({
            source: m.provider as 'smstech' | 't2' | 'mts',
            eventType: 'undeliv_sms',
            smsMessageId: m.id,
            clientId: m.clientId,
            phone: m.phone,
            provider: m.provider,
            externalIds: { send_message_id: m.providerMessageId },
            payload: { reconciled: true, provider: m.provider, send_message_id: m.providerMessageId },
            dedupKey: `reconcile:${m.provider}:${m.providerMessageId}:undeliv`,
            result: { smsStatus: 'FAILED', via: 'reconciliation' },
          });
          console.log(`[worker] reconciled ${m.provider}:${m.providerMessageId} → FAILED`);
        }
        // SENT/QUEUED — ещё в полёте, ничего не делаем (и не журналируем)
      } catch (e) {
        // Креды не заданы / сеть — тихо ждём следующего такта
        console.warn(
          `[worker] reconcile ${m.provider}:${m.providerMessageId} skipped:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  } catch (e) {
    console.error('[worker] reconcile failed:', e instanceof Error ? e.message : String(e));
  }
}

// ---------- 4. Чистка ----------

/**
 * Раз в CLEANUP_EVERY_TICKS (~5 мин): истёкшие сессии, старые записи
 * rate-limiter'а, протухшие короткие ссылки; авто-архивация обработанных
 * событий/задач старше inboxRetentionDays (0 = выключена; FAILED-события —
 * только вручную); возврат зависших SENDING в очередь; «пожиратель зомби» —
 * RUNNING-экземпляры без PENDING-задач (краш между шагами) → FAILED.
 * Вся чистка в try/catch — сбой одного шага не отменяет остальные.
 */
async function cleanup(): Promise<void> {
  try {
    await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    // Idle-таймаут: сессии без активности дольше SESSION_IDLE_HOURS (см.
    // security/session.ts) — чистятся и здесь, а не только при попытке входа
    // по ним (cookie может больше никогда не прийти).
    const idleCutoff = idleCutoffDate();
    if (idleCutoff) {
      await db.session.deleteMany({ where: { updatedAt: { lt: idleCutoff } } });
    }
    await cleanupRateLimitEntries(60 * 60 * 1000);
    // Протухшие короткие ссылки — через 30 дней после истечения (статистика живёт)
    await cleanupExpiredShortLinks();
    // Авто-архивация — обработанные события и завершённые задачи старше N дней
    // (0 = не удалять). FAILED-события НЕ удаляются автоматически: только ручной
    // ретрай оператором (журнал падений не должен молча исчезать).
    try {
      const settings = await getSettings();
      const days = settings.inboxRetentionDays;
      if (days > 0) {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        await db.eventsInbox.deleteMany({
          where: { status: { in: ['PROCESSED', 'DUPLICATE'] }, createdAt: { lt: cutoff } },
        });
        // updatedAt = момент перехода задачи в терминальный статус
        await db.scheduledJob.deleteMany({
          where: { status: { in: ['DONE', 'CANCELLED', 'FAILED'] }, updatedAt: { lt: cutoff } },
        });
      }
    } catch {
      // настройки недоступны — архивация пропускает такт, остальная чистка важнее
    }
    // Ретеншн истории профиля (P5): записи старше 180 дней (диффы журнала
    // накапливаются с каждым событием ядра — без чистки таблица росла бы
    // бесконечно; 180 дней покрывают любые разборы «кто поменял поле»)
    const removedHistory = await cleanupProfileHistory();
    if (removedHistory > 0) {
      console.log(`[worker] profile history cleanup: removed ${removedHistory} rows`);
    }
    // Ретеншн таймлайнов инстансов: события ТЕРМИНАЛЬНЫХ экземпляров старше
    // INSTANCE_EVENT_RETENTION_DAYS (активные не трогаем). Каждый узел пишет
    // NODE_START/NODE_DONE — на боевых объёмах это крупнейший потребитель БД;
    // 180 дней согласованы с ретеншном истории профиля.
    try {
      const removedTimelines = await db.instanceEvent.deleteMany({
        where: {
          instance: {
            status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
            updatedAt: { lt: new Date(Date.now() - INSTANCE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000) },
          },
        },
      });
      if (removedTimelines.count > 0) {
        console.log(`[worker] instance timeline cleanup: removed ${removedTimelines.count} rows`);
      }
    } catch {
      //Relation-фильтр не поддержан/БД занята — пропускаем такт
    }
    // Зависшие SENDING-сообщения рассылок (краш посреди отправки) — назад в очередь
    await db.smsMessage
      .updateMany({
        where: { status: 'SENDING', updatedAt: { lt: new Date(Date.now() - STALE_SENDING_MS) } },
        data: { status: 'QUEUED' },
      })
      .catch(() => undefined);
    // «Пожиратель зомби»: экземпляры в RUNNING/WAITING без единой PENDING/RUNNING-задачи
    // — FAILED, иначе они навсегда блокируют повторный вход SKIP_ACTIVE. RUNNING без задач
    // — краш между шагами цикла; WAITING без задач — нарушение инварианта «пауза ВСЕГДА
    // подкреплена задачей» (краш посреди отмены/таймаута, битый контекст).
    // Гард по RUNNING-задачам обязателен: после краша процесса задача в RUNNING станет
    // PENDING не раньше claim+60с(лок)+STALE_RUNNING_MS, а чистка ходит каждые ~5 мин —
    // без гарда пожиратель убивал бы живой экземпляр ДО requeue (ложный FAILED, потеря
    // отправки) — requeue в том же тике выполняется раньше чистки, PENDING-задачу гард
    // уже видит. RUNNING-задача при сериализованных тиках = только наследие краха.
    const zombies = await db.workflowInstance.findMany({
      where: {
        status: { in: ['RUNNING', 'WAITING'] },
        createdAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) },
        NOT: { jobs: { some: { status: { in: ['PENDING', 'RUNNING'] } } } },
      },
      select: { id: true },
      take: 20,
    });
    for (const z of zombies) {
      await db.workflowInstance
        .update({
          where: { id: z.id },
          data: { status: 'FAILED', error: 'Восстановление: экземпляр завис без отложенных задач' },
        })
        .catch(() => undefined);
      await logInstanceEvent(z.id, 'ERROR', {
        message: 'Восстановление: экземпляр завис без отложенных задач',
      }).catch(() => undefined);
      console.warn(`[worker] zombie instance ${z.id} recovered → FAILED`);
    }
  } catch (e) {
    console.error('[worker] cleanup failed:', e instanceof Error ? e.message : String(e));
  }
}
