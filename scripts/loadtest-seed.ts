// Нагрузочный стенд: генерация синтетической базы боевого масштаба.
// Запуск: bun scripts/loadtest-seed.ts [путь-к-БД]
//   по умолчанию /tmp/trigger-loadtest/loadtest.db (КОПИЯ dev-БД — боевые данные не трогаем;
//   сначала: mkdir -p /tmp/trigger-loadtest && cp db/custom.db* /tmp/trigger-loadtest/loadtest.db*).
//
// Объёмы задаются переменными окружения (по умолчанию — профиль Task 30):
//   N_CLIENTS — клиенты (по умолчанию 4 000 000)
//   N_SMS     — всего SMS (по умолчанию 2 000 000)
//   SMS_HOT   — из них «горячие» за последние 30 дней (по умолчанию 500 000)
//   N_EVENTS  — события доставки (по умолчанию 1 000 000)
// Профиль «6 млн SMS/мес» (Task 62): N_SMS=6_500_000 SMS_HOT=6_000_000 N_EVENTS=2_000_000 —
// месячное окно дашборда видит ~6 млн строк, +0,5 млн ретро для глубины пагинации.
// ВНИМАНИЕ (Task 62, факт): этот профиль даёт БД ~8,9 ГБ и НЕ влезает в диск песочницы
// 9,9 ГБ вместе с node_modules — фактически выполнен профиль N_SMS=3_500_000
// SMS_HOT=3_500_000 N_EVENTS=1_000_000 (БД 5,72 ГБ): окно 30 дней ×7 к прошлому прогону;
// пропускная способность «6 млн/мес» подтверждена прямыми замерами записи
// (см. docs/loadtest-report.md §3–4, §7).
//
// Детерминизм: id/телефоны/ФИО генерируются из номера строки (без PRNG-реплея),
// поэтому соседние скрипты (loadtest-bench.ts) могут восстанавливать любые
// id/клиента/сообщения по номеру без обращения к БД.
//
// Техника: bun:sqlite (нативный драйвер), prepared-инсерты, транзакции по
// 10 000 строк, WAL + synchronous=OFF на время сида (в конце — ANALYZE,
// чтобы планировщик запросов видел реальную статистику). На каждом этапе
// логируется размер файла БД — контроль дискового бюджета песочницы.
import { Database } from 'bun:sqlite';

const DB_PATH = process.argv[2] ?? '/tmp/trigger-loadtest/loadtest.db';
const N_CLIENTS = Number(process.env.N_CLIENTS ?? 4_000_000);
const N_SMS = Number(process.env.N_SMS ?? 2_000_000);
const SMS_HOT = Number(process.env.SMS_HOT ?? 500_000); // «горячие» — за последние 30 дней
const N_EVENTS = Number(process.env.N_EVENTS ?? 1_000_000);
const N_VISITS = 200_000;
const N_UNSUB = 30_000;
const BATCH = 10_000;

// ---------- Детерминированные генераторы (без состояния) ----------

/** Число → 8 hex-символов (левый паддинг нулями). */
const hex8 = (n: number): string => n.toString(16).padStart(8, '0');
/** Число → 12 hex-символов. */
const hex12 = (n: number): string => (n % 0x100000000000).toString(16).padStart(12, '0');
/** Номер клиента → детерминированный uuid-подобный id. */
const clientId = (n: number): string => `${hex8(n)}-0001-4000-8000-${hex12(n)}`;
/** Номер сообщения → id. */
const smsId = (n: number): string => `${hex8(0x1000000 + n)}-0002-4000-8000-${hex12(n)}`;
/** Номер клиента → телефон +79XXXXXXXXX (детерминированный). */
const phone = (n: number): string => `+7${(900000000 + (n * 48271) % 99999999).toString().padStart(9, '0')}`;
/** Линейный конгруэнтный ГПСЧ по номеру строки (детерминированный «случай»). */
const rnd = (n: number, salt = 0): number => {
  let x = (n * 1664525 + 1013904223 + salt * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = (x * 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 0x100000000;
};
const pick = <T,>(arr: readonly T[], n: number, salt = 0): T => arr[Math.floor(rnd(n, salt) * arr.length) % arr.length];
const intBetween = (n: number, salt: number, lo: number, hi: number): number => lo + Math.floor(rnd(n, salt) * (hi - lo + 1));

const SURNAMES = ['Иванов', 'Петров', 'Сидоров', 'Кузнецов', 'Смирнов', 'Волков', 'Соколов', 'Михайлов', 'Новиков', 'Фёдоров', 'Морозов', 'Волкова', 'Козлова', 'Лебедева', 'Соколова', 'Попова', 'Лебедев', 'Козлов', 'Новикова', 'Зайцев', 'Зайцева', 'Соловьёв', 'Васильев', 'Васильева', 'Панова', 'Панов', 'Мельникова', 'Мельник', 'Егорова', 'Егоров'] as const;
const FIRSTNAMES = ['Анна', 'Мария', 'Ольга', 'Наталья', 'Елена', 'Татьяна', 'Ирина', 'Светлана', 'Юлия', 'Ксения', 'Александр', 'Дмитрий', 'Сергей', 'Андрей', 'Алексей', 'Михаил', 'Николай', 'Павел', 'Виктор', 'Олег'] as const;
const MIDNAMES = ['Иванович', 'Ивановна', 'Петрович', 'Петровна', 'Сергеевич', 'Сергеевна', 'Дмитриевич', 'Дмитриевна', 'Александрович', 'Александровна', 'Николаевич', 'Николаевна', 'Олегович', 'Олеговна', 'Викторович'] as const;
const TIMEZONES = ['Asia/Novosibirsk', 'Asia/Novosibirsk', 'Asia/Novosibirsk', 'Europe/Moscow', 'Europe/Moscow', 'Asia/Yekaterinburg', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Vladivostok', 'Europe/Kaliningrad'] as const;
const SMS_BODIES = [
  'Анна, платёж 2 226 руб. по займу LN-0004 получен. Спасибо! ДемоКомпания',
  'Ваш платёж по договору Z-10234 поступил. Остаток долга: 8 450 руб. ДемоКомпания',
  'Напоминаем: завтра срок платежа 3 120 руб. по займу LN-2210. Оплатите в приложении DemoBrand',
  'Займ одобрен! 15 000 руб. уже на вашей карте. До 30 дней под 0%. DemoBrand',
  'Ваша персональная скидка 50% на следующий займ до конца недели. DemoBrand',
  'Поздравляем с днём рождения! Подарок: займ под 0% на 5 дней. DemoBrand',
  'Договор закрыт полностью. Спасибо за оперативность! ДемоКомпания',
  'Осталось 2 дня до продления займа LN-778. Не забудьте внести платёж. DemoBrand',
  'Пролонгация одобрена на 14 дней. Новый платёж 2 400 руб. 12 числа. DemoBrand',
  'Ваша заявка рассмотрена — ждём вас в приложении DemoBrand для подписания',
] as const;
const TEMPLATE_NAMES = ['Платёж получен', 'Напоминание о платеже', 'Одобрение займа', 'Скидка на займ', 'День рождения', 'Договор закрыт', 'Продление займа', 'Пролонгация', 'Заявка рассмотрена', 'Преапрув недели'] as const;
const PROVIDERS = ['smstech', 'smstech', 'smstech', 't2', 't2', 'sandbox'] as const;

const now = Date.now();
const DAY = 86_400_000;
/** Диапазон «горячих» 30 дней. */
const hotLo = now - 30 * DAY;

function log(msg: string): void {
  console.log(`[seed ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

/** Размер файла БД (МБ) — контроль дискового бюджета на каждом этапе. */
function dbSizeMb(): number {
  const r = db.query('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get() as { bytes: number };
  return r.bytes / 1048576;
}

// ---------- Сид ----------

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous=OFF'); // только на время сида
db.exec('PRAGMA cache_size=-262144'); // 256 МБ кэша страниц
db.exec('PRAGMA temp_store=MEMORY');

// -- Справочные строки (рассылки/запуски/шаблоны/воронки/экземпляры/ссылки) --
const BC_IDS = ['11111111-aaaa-4000-8000-000000000001', '11111111-aaaa-4000-8000-000000000002', '11111111-aaaa-4000-8000-000000000003', '11111111-aaaa-4000-8000-000000000004', '11111111-aaaa-4000-8000-000000000005'];
const RUN_IDS = Array.from({ length: 10 }, (_, i) => `22222222-bbbb-4000-8000-${hex12(i + 1)}`);
const TPL_IDS = Array.from({ length: 10 }, (_, i) => `33333333-cccc-4000-8000-${hex12(i + 1)}`);
const FUNNEL_IDS = ['44444444-dddd-4000-8000-000000000001', '44444444-dddd-4000-8000-000000000002'];

const tx = db.transaction(() => {
  // Шаблоны
  for (let i = 0; i < 10; i++) {
    db
      .prepare(
        `INSERT OR IGNORE INTO SmsTemplate (id, name, body, isMarketing, version, isActive, tenantId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, 1, 1, 'trigger', ?, ?)`,
      )
      .run(TPL_IDS[i], TEMPLATE_NAMES[i], 'Уважаемый клиент, {{first_name}}! ' + SMS_BODIES[i], i < 6 ? 1 : 0, now - 200 * DAY, now - 200 * DAY);
  }
  // Воронки + 1000 экземпляров (для FK instanceId у сообщений)
  for (let i = 0; i < 2; i++) {
    db
      .prepare(
        `INSERT OR IGNORE INTO Funnel (id, name, triggerEvent, isActive, version, definition, entryMode, tenantId, createdAt, updatedAt)
         VALUES (?, ?, 'LOAN_OVERDUE', 1, 1, '{}', 'SKIP_ACTIVE', 'trigger', ?, ?)`,
      )
      .run(FUNNEL_IDS[i], i === 0 ? 'Просрочка — 3 шага' : 'Платёж получен', now - 200 * DAY, now - 200 * DAY);
  }
  const insInst = db.prepare(
    `INSERT OR IGNORE INTO WorkflowInstance (id, funnelId, funnelVersion, funnelName, clientId, currentNodeId, status, context, eventId, idempotencyKey, tenantId, createdAt, updatedAt)
     VALUES (?, ?, 1, ?, ?, NULL, 'COMPLETED', '{}', NULL, ?, 'trigger', ?, ?)`,
  );
  for (let i = 0; i < 1000; i++) {
    const cli = Math.floor(rnd(i, 77) * N_CLIENTS);
    const created = now - intBetween(i, 5, 1, 360) * DAY;
    insInst.run(`${hex8(0x2000000 + i)}-0003-4000-8000-${hex12(i)}`, FUNNEL_IDS[i % 2], i % 2 === 0 ? 'Просрочка — 3 шага' : 'Платёж получен', clientId(cli), `seed-inst-${i}`, created, created + 3_600_000);
  }
  // Рассылки + запуски
  const insB = db.prepare(
    `INSERT OR IGNORE INTO Broadcast (id, name, description, segmentId, templateId, baseUrl, kind, weekday, hour, minute, minDaysBetween, maxRecipients, status, nextRunAt, lastRunAt, tenantId, createdAt, updatedAt)
     VALUES (?, ?, NULL, 'seed-seg-1', ?, NULL, 'ONCE', NULL, NULL, 0, 7, 1000, 'DONE', NULL, ?, 'trigger', ?, ?)`,
  );
  for (let i = 0; i < 5; i++) {
    insB.run(BC_IDS[i], `Нагрузочная рассылка №${i + 1}`, TPL_IDS[i], now - (5 - i) * DAY, now - 30 * DAY, now - (5 - i) * DAY);
  }
  const insRun = db.prepare(
    `INSERT OR IGNORE INTO BroadcastRun (id, broadcastId, status, planned, recipients, skippedGuard, cappedBy, error, startedAt, finishedAt, tenantId, createdAt, updatedAt)
     VALUES (?, ?, 'DONE', 1000, 1000, 0, 0, NULL, ?, ?, 'trigger', ?, ?)`,
  );
  for (let i = 0; i < 10; i++) {
    const t = now - intBetween(i, 9, 1, 25) * DAY;
    insRun.run(RUN_IDS[i], BC_IDS[i % 5], t, t + 3_600_000, t, t + 3_600_000);
  }
  // Короткие ссылки (для FK редирект-лога)
  const insLink = db.prepare(
    `INSERT OR IGNORE INTO ShortLink (id, code, kind, token, name, targetUrl, clientId, visits, lastVisitAt, expiresAt, tenantId, createdAt, updatedAt)
     VALUES (?, ?, 'LINK', NULL, ?, 'https://example.com/offer?utm_source=sms', NULL, 0, NULL, NULL, 'trigger', ?, ?)`,
  );
  for (let i = 0; i < 100; i++) {
    insLink.run(`55555555-eeee-4000-8000-${hex12(i + 1)}`, `Lcode${hex8(i + 1)}`.slice(0, 10), `Ссылка №${i + 1}`, now - 60 * DAY, now - 60 * DAY);
  }
  // Сегмент для замера запуска рассылки (agreementStatus=16 → ~55% базы).
  // op: 'eq' — валидный оператор конструктора (app-валидатор режет «equals»;
  // сид пишет напрямую, поэтому важно не расхолаживать форматы).
  db
    .prepare(
      `INSERT OR IGNORE INTO Segment (id, name, description, conditions, mode, tenantId, createdAt, updatedAt)
       VALUES ('seed-seg-1', 'Нагрузочный: действующие договоры', 'seed', '{"match":"all","rules":[{"field":"agreement_actual_status","op":"eq","value":16}]}', 'dynamic', 'trigger', ?, ?)`,
    )
    .run(now - 40 * DAY, now - 40 * DAY);
});
tx();
log('справочные строки готовы');

// -- Клиенты: 4 млн --
const CLIENT_COLS = [
  'id', 'externalId', 'phone', 'timezone', 'data', 'smsConsentStatus', 'smsConsentSource', 'smsConsentAt', 'unsubscribedAt',
  'firstName', 'lastName', 'middleName', 'email', 'applicationId', 'applicationStatus', 'applicationPrevStatus',
  'agreementId', 'agreementStatus', 'agreementPrevStatus', 'loanAmount', 'loanPeriod', 'notificationActive',
  'offerDateStart', 'offerDateExpired', 'offerApproveMoney', 'offerApproveDays', 'offerAvailable', 'birthday',
  'lastProductType', 'agreementsLastYear', 'agreementsLifetime', 'banDays', 'profileUpdatedAt', 'tenantId', 'createdAt', 'updatedAt',
] as const;
const insCli = db.prepare(
  `INSERT INTO Client (${CLIENT_COLS.join(',')}) VALUES (${CLIENT_COLS.map(() => '?').join(',')})`,
);
let t0 = Date.now();
for (let base = 0; base < N_CLIENTS; base += BATCH) {
  const btx = db.transaction(() => {
    for (let n = base; n < Math.min(base + BATCH, N_CLIENTS); n++) {
      const first = pick(FIRSTNAMES, n, 1);
      const last = pick(SURNAMES, n, 2);
      const mid = pick(MIDNAMES, n, 3);
      const consentR = rnd(n, 4);
      const consent = consentR < 0.8 ? 'GRANTED' : consentR < 0.95 ? 'NONE' : 'REVOKED';
      const agreeR = rnd(n, 5);
      const agree = agreeR < 0.55 ? 16 : agreeR < 0.6 ? 17 : agreeR < 0.95 ? 19 : null;
      const appR = rnd(n, 6);
      const app = appR < 0.4 ? 4 : appR < 0.7 ? 7 : appR < 0.9 ? 9 : null;
      const unsubscribed = rnd(n, 7) < 0.02 ? now - intBetween(n, 8, 1, 90) * DAY : null;
      const created = now - intBetween(n, 9, 5, 1095) * DAY; // 3 года ретро
      const bday = new Date(now - intBetween(n, 10, 18 * 365, 65 * 365) * DAY);
      // ~1/365 клиентов — «день рождения сегодня» (для спец-правила ДР)
      if (rnd(n, 11) < 1 / 365) bday.setTime(hotLo + intBetween(n, 12, 0, 29) * DAY);
      const offerExp = rnd(n, 13) < 0.5 ? now - intBetween(n, 14, 1, 90) * DAY : now + intBetween(n, 15, 1, 60) * DAY;
      insCli.run(
        clientId(n),
        `J${(1000000 + n).toString()}`,
        phone(n),
        pick(TIMEZONES, n, 16),
        `{"name":"${last} ${first} ${mid}","loan_number":"LN-${1000000 + n}","loan_amount":${intBetween(n, 17, 3000, 90000)},"overdue_days":${intBetween(n, 18, 0, 30)}}`,
        consent,
        consent === 'NONE' ? null : 'SYSTEM',
        consent === 'NONE' ? null : created,
        unsubscribed,
        first,
        last,
        mid,
        rnd(n, 19) < 0.3 ? `client${1000000 + n}@mail.ru` : null,
        intBetween(n, 20, 100000, 999999),
        app,
        app === null ? null : Math.max(1, app - 1),
        intBetween(n, 21, 200000, 899999),
        agree,
        agree === null ? null : 16,
        intBetween(n, 22, 3000, 90000) + 0.5,
        intBetween(n, 23, 7, 365),
        rnd(n, 24) < 0.85 ? 1 : 0,
        now - intBetween(n, 25, 10, 300) * DAY,
        offerExp,
        intBetween(n, 26, 1000, 50000) + 0.5,
        intBetween(n, 27, 3, 30),
        rnd(n, 28) < 0.6 ? 1 : rnd(n, 29) < 0.5 ? 0 : null,
        bday.getTime(),
        rnd(n, 30) < 0.6 ? 'PDL' : rnd(n, 31) < 0.75 ? 'IL' : null,
        intBetween(n, 32, 0, 5),
        intBetween(n, 33, 0, 40),
        rnd(n, 34) < 0.05 ? intBetween(n, 35, 7, 90) : 0,
        now - intBetween(n, 36, 0, 14) * DAY,
        'trigger',
        created,
        created + intBetween(n, 37, 0, 30) * DAY,
      );
    }
  });
  btx();
  if ((base / BATCH) % 25 === 24) log(`клиенты ${base + BATCH}/${N_CLIENTS} (+${((Date.now() - t0) / 1000).toFixed(0)}с)`);
}
log(`клиенты готовы: ${N_CLIENTS} за ${((Date.now() - t0) / 1000).toFixed(0)}с; БД ${dbSizeMb().toFixed(0)} МБ`);

// -- SMS: горячие за 30 дней + ретро (объёмы — см. env-параметры в шапке) --
const SMS_COLS = [
  'id', 'instanceId', 'clientId', 'phone', 'body', 'segments', 'provider', 'providerMessageId', 'providerVersion',
  'priceKopecks', 'operatorCode', 'templateId', 'templateName', 'status', 'rejectReason', 'error', 'sentAt', 'deliveredAt', 'attempts',
  'broadcastId', 'broadcastName', 'runId', 'scheduledFor', 'tenantId', 'createdAt', 'updatedAt',
] as const;
const insSms = db.prepare(
  `INSERT INTO SmsMessage (${SMS_COLS.join(',')}) VALUES (${SMS_COLS.map(() => '?').join(',')})`,
);
const statusPick = (n: number): string => {
  const r = rnd(n, 40);
  if (r < 0.7) return 'DELIVERED';
  if (r < 0.74) return 'SENT';
  if (r < 0.81) return 'FAILED';
  if (r < 0.87) return 'REJECTED_BY_COMPLIANCE';
  if (r < 0.88) return 'SENDING';
  if (r < 0.95) return 'CANCELLED';
  return 'QUEUED';
};
t0 = Date.now();
// Транзакции по BATCH:
for (let base = 0; base < N_SMS; base += BATCH) {
  const btx = db.transaction(() => {
    for (let seq = base; seq < Math.min(base + BATCH, N_SMS); seq++) {
      const hot = seq < SMS_HOT; // первая часть — «последние 30 дней»
      const createdAt = hot
        ? hotLo + Math.floor(rnd(seq, 41) * 30 * DAY)
        : now - (30 + Math.floor(rnd(seq, 42) * 330)) * DAY; // ретро: 1..11 месяцев назад
      const status = statusPick(seq);
      const isBroadcast = rnd(seq, 43) < 0.6;
      const cli = Math.floor(rnd(seq, 44) * N_CLIENTS);
      const sentAt = status === 'SENT' || status === 'DELIVERED' || status === 'FAILED' ? createdAt + 5000 : null;
      const deliveredAt = status === 'DELIVERED' ? createdAt + 30_000 : null;
      const dueQueued = status === 'QUEUED' && rnd(seq, 45) < 0.5;
      insSms.run(
        smsId(seq),
        isBroadcast ? null : `${hex8(0x2000000 + (seq % 1000))}-0003-4000-8000-${hex12(seq % 1000)}`,
        clientId(cli),
        phone(cli),
        SMS_BODIES[seq % 10],
        rnd(seq, 46) < 0.8 ? 1 : 2,
        pick(PROVIDERS, seq, 47),
        status === 'SENT' || status === 'DELIVERED' || status === 'FAILED' ? `smstech-${8000000 + seq}` : null,
        status === 'DELIVERED' ? intBetween(seq, 48, 1, 3) : null,
        status === 'DELIVERED' ? intBetween(seq, 49, 80, 250) : null,
        status === 'DELIVERED' ? pick(['25001', '25002', '25099', '25020'], seq, 50) : null,
        TPL_IDS[seq % 10],
        TEMPLATE_NAMES[seq % 10],
        status,
        status === 'REJECTED_BY_COMPLIANCE' ? pick(['NO_CONSENT', 'UNSUBSCRIBED', 'ADVERT_OFF', 'LIMIT_CLIENT'], seq, 51) : null,
        status === 'FAILED' ? 'Оператор вернул ошибку доставки' : null,
        sentAt,
        deliveredAt,
        0,
        isBroadcast ? BC_IDS[seq % 5] : null,
        isBroadcast ? `Нагрузочная рассылка №${(seq % 5) + 1}` : null,
        isBroadcast ? RUN_IDS[seq % 10] : null,
        status === 'QUEUED' ? (dueQueued ? createdAt - 60_000 : createdAt + intBetween(seq, 52, 1, 48) * 3_600_000) : null,
        'trigger',
        createdAt,
        deliveredAt ?? sentAt ?? createdAt,
      );
    }
  });
  btx();
  if ((base / BATCH) % 50 === 49) log(`sms ${base + BATCH}/${N_SMS} (+${((Date.now() - t0) / 1000).toFixed(0)}с)`);
}
log(`sms готовы: ${N_SMS} за ${((Date.now() - t0) / 1000).toFixed(0)}с; БД ${dbSizeMb().toFixed(0)} МБ`);

// -- События доставки: 1 млн (70% горячие) --
const EVENT_COLS = [
  'id', 'source', 'eventType', 'eventDate', 'receivedAt', 'phone', 'provider', 'smsMessageId', 'clientId',
  'externalIds', 'payload', 'dedupKey', 'createdAt', 'updatedAt',
] as const;
const insEv = db.prepare(
  `INSERT INTO MessageEvent (${EVENT_COLS.join(',')}, status, result, tenantId) VALUES (${EVENT_COLS.map(() => '?').join(',')}, 'PROCESSED', NULL, 'trigger')`,
);
t0 = Date.now();
for (let base = 0; base < N_EVENTS; base += BATCH) {
  const btx = db.transaction(() => {
    for (let seq = base; seq < Math.min(base + BATCH, N_EVENTS); seq++) {
      const hot = rnd(seq, 60) < 0.7;
      const evDate = hot ? hotLo + Math.floor(rnd(seq, 61) * 30 * DAY) : now - (30 + Math.floor(rnd(seq, 62) * 300)) * DAY;
      const srcR = rnd(seq, 63);
      const source = srcR < 0.5 ? 'smstech' : srcR < 0.8 ? 'external' : 'panel';
      const typeR = rnd(seq, 64);
      const eventType = typeR < 0.5 ? 'send_sms' : typeR < 0.85 ? 'deliv_sms' : typeR < 0.93 ? 'undeliv_sms' : typeR < 0.98 ? 'click_sms' : 'unsub_sms';
      const cli = Math.floor(rnd(seq, 65) * N_CLIENTS);
      const linked = rnd(seq, 66) < 0.5 && eventType !== 'unsub_sms';
      const sms = linked ? smsId(Math.floor(rnd(seq, 67) * N_SMS)) : null;
      insEv.run(
        `${hex8(0x3000000 + seq)}-0004-4000-8000-${hex12(seq)}`,
        source,
        eventType,
        evDate,
        evDate + 2000,
        phone(cli),
        pick(PROVIDERS, seq, 68),
        sms,
        rnd(seq, 69) < 0.3 ? clientId(cli) : null,
        `{"message_id":"${100000 + seq}","campaign_id":"${seq % 20}","launch_id":"${seq % 50}","full_message_id":"f${seq}"}`,
        `{"event_data":{"message_id":${100000 + seq},"profile_id":"p${cli}","content":{"sms":"${SMS_BODIES[seq % 10]}","fromnamesms":"DemoBrand"},"channel":"sms","custom_data":{"client_id":"J${1000000 + cli}"}}}`,
        `seed-ev-${seq}`,
        evDate + 2000,
        evDate + 2000,
      );
    }
  });
  btx();
}
log(`события готовы: ${N_EVENTS} за ${((Date.now() - t0) / 1000).toFixed(0)}с; БД ${dbSizeMb().toFixed(0)} МБ`);

// -- Переходы по ссылкам: 200 тыс. за 30 дней --
const insVisit = db.prepare(
  `INSERT INTO ShortLinkVisit (id, linkId, kind, tenantId, createdAt) VALUES (?, ?, ?, 'trigger', ?)`,
);
t0 = Date.now();
for (let base = 0; base < N_VISITS; base += BATCH) {
  const btx = db.transaction(() => {
    for (let seq = base; seq < Math.min(base + BATCH, N_VISITS); seq++) {
      insVisit.run(
        `${hex8(0x4000000 + seq)}-0005-4000-8000-${hex12(seq)}`,
        `55555555-eeee-4000-8000-${hex12(1 + (seq % 100))}`,
        rnd(seq, 70) < 0.6 ? 'LINK' : 'UNSUBSCRIBE',
        hotLo + Math.floor(rnd(seq, 71) * 30 * DAY),
      );
    }
  });
  btx();
}
// -- Стоп-лист: 30 тыс. --
const insUnsub = db.prepare(
  `INSERT INTO UnsubscribeList (id, phone, source, clientId, tenantId, createdAt) VALUES (?, ?, ?, NULL, 'trigger', ?)`,
);
for (let base = 0; base < N_UNSUB; base += BATCH) {
  const btx = db.transaction(() => {
    for (let seq = base; seq < Math.min(base + BATCH, N_UNSUB); seq++) {
      insUnsub.run(
        `${hex8(0x5000000 + seq)}-0006-4000-8000-${hex12(seq)}`,
        phone((seq * 137) % N_CLIENTS),
        pick(['LINK', 'MANUAL', 'IMPORT', 'HOOK'], seq, 72),
        now - intBetween(seq, 73, 1, 200) * DAY,
      );
    }
  });
  btx();
}
log(`переходы и стоп-лист готовы (+${((Date.now() - t0) / 1000).toFixed(0)}с)`);

// -- Финализация: статистика планировщика, синхронный режим --
log('ANALYZE (может занять до минуты)...');
db.exec('ANALYZE');
db.exec('PRAGMA synchronous=NORMAL');
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

const counts = db
  .query(
    `SELECT (SELECT count(*) FROM Client) clients, (SELECT count(*) FROM SmsMessage) sms,
            (SELECT count(*) FROM MessageEvent) events, (SELECT count(*) FROM ShortLinkVisit) visits,
            (SELECT count(*) FROM UnsubscribeList) unsub`,
  )
  .get() as Record<string, number>;
const size = db.query('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get() as { bytes: number };
log(`ИТОГО: ${JSON.stringify(counts)}; размер БД: ${(size.bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`);
db.close();
log('готово');
