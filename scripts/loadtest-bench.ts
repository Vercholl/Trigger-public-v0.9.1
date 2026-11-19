// Нагрузочный бенчмарк: РЕАЛЬНЫЕ сервисные функции панели/воркера против
// синтетической БД боевого масштаба (объёмы задаёт loadtest-seed.ts — см. его
// env-параметры; имена кейсов ниже подставляют фактические счётчики из БД).
//
// Запуск: bun scripts/loadtest-bench.ts [путь-к-БД]
//   по умолчанию /tmp/trigger-loadtest/loadtest.db
//
// Режимы BENCH_MODE:
//   full      — полный прогон: чтение + воркер + деградация + запись (по умолчанию);
//   broadcast — только сквозной запуск рассылки с лимитом BENCH_BROADCAST_LIMIT
//               (по умолчанию 1000): «писатель» для параллельного стресса (рядом
//               запускается второй процесс в режиме reader); итог — JSON в
//               /tmp/trigger-loadtest/broadcast-run.json;
//   reader    — цикл чтения BENCH_READER_SECONDS секунд (по умолчанию 180):
//               «панель во время записи» — p50/p95/max по экранам + счётчик ошибок
//               (в т.ч. SQLITE_BUSY); отчёт — /tmp/trigger-loadtest/reader-report.md.
//
// Группы замеров:
//   ЧТЕНИЕ  — экраны панели (клиенты/SMS-лог/дашборд/сегменты/экземпляры/
//             события доставки) + выборки воркера (инбокс, due-задачи,
//             due-очередь рассылок);
//   ПАМЯТЬ  — деградационные сценарии (evaluateSegment рассылки: материализация
//             строк в память) на уменьшенной выборке с экстраполяцией;
//   ЗАПИСЬ  — на отдельной копии БД (loadtest-write.db): построчное создание
//             SMS запуска рассылки, журналирование событий, upsert клиентов.
//
// Каждый кейс: 1 прогрев + 3 прогона; в отчёт — медиана/мин/макс в мс.
// Отчёт: stdout + /tmp/trigger-loadtest/bench-report.md (перезаписывается).
// export {} — файл модуль (top-level await), см. bun-sqlite.d.ts для типов.
export {};
process.env.DATABASE_URL = `file:${process.argv[2] ?? '/tmp/trigger-loadtest/loadtest.db'}`;

const { db } = await import('@/lib/db');
const stats = await import('@/lib/services/stats');
const segments = await import('@/lib/services/segments');
const smsLog = await import('@/lib/services/sms-log');
const clients = await import('@/lib/services/clients');
const instances = await import('@/lib/services/instances');
const messageEvents = await import('@/lib/services/message-events');
const broadcasts = await import('@/lib/services/broadcasts');

/* ============ Режимы и фактический масштаб ============ */

const MODE = process.env.BENCH_MODE ?? 'full';
const BROADCAST_LIMIT = Number(process.env.BENCH_BROADCAST_LIMIT ?? 1000);
const READER_SECONDS = Number(process.env.BENCH_READER_SECONDS ?? 180);

/** Счётчики БД для честных имён кейсов и расчёта ёмкости (объём задаёт сид).
 *  Prisma возвращает COUNT(*) как BigInt — сразу приводим к Number: дальше по
 *  скрипту значения участвуют в обычной арифметике (fmt, SEG_APPROX, ёмкость). */
const cntRaw = await db.$queryRawUnsafe<{ clients: number | bigint; sms: number | bigint; events: number | bigint; smsHot30: number | bigint }[]>(
  'SELECT (SELECT COUNT(*) FROM Client) clients, (SELECT COUNT(*) FROM SmsMessage) sms, (SELECT COUNT(*) FROM MessageEvent) events, (SELECT COUNT(*) FROM SmsMessage WHERE createdAt >= ?) smsHot30',
  Date.now() - 30 * 86400000,
);
const cnt = [
  {
    clients: Number(cntRaw[0].clients),
    sms: Number(cntRaw[0].sms),
    events: Number(cntRaw[0].events),
    smsHot30: Number(cntRaw[0].smsHot30),
  },
];

/** 4 123 456 → «4,1 млн»; 123 456 → «123 тыс.» */
const fmt = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс.` : String(n);

/** Оценка размера сегмента agreementStatus=16 (~55% базы по распределению сида). */
const SEG_APPROX = Math.round(cnt[0].clients * 0.55);

/** Замеры для расчёта ёмкости (заполняет benchWrites). */
const measured: {
  perSmsMs?: number;
  perEventMs?: number;
  perUpsertMs?: number;
  broadcastRunMs?: number;
  broadcastRecipients?: number;
} = {};

/* ============ Рассылка для сквозных кейсов (режимы full/broadcast) ============ */

const BENCH_BROADCAST_ID = 'aaaaaaa1-bench-4000-8000-000000000001';
// Шаблон без переменных события: в рассылках доступны только переменные
// карточки ({{first_name}} — переменная событий, воркер её отвергает)
const BENCH_TEMPLATE_ID = 'aaaaaaa2-bench-4000-8000-000000000002';

/** Создать/пересоздать шаблон бенчмарка (идемпотентно). */
async function ensureBenchTemplate(): Promise<void> {
  await db.smsTemplate.deleteMany({ where: { id: BENCH_TEMPLATE_ID } });
  await db.smsTemplate.create({
    data: {
      id: BENCH_TEMPLATE_ID,
      name: 'Бенчмарк: шаблон',
      body: 'Уважаемый клиент! Персональное предложение по займу до зарплаты. DemoBrand',
      isMarketing: true,
    },
  });
}

/** Пересоздать бенчмарк-рассылку с чистой историей сообщений (гвард видит
 *  только то, что создал этот прогон; сообщения прошлого прогона удаляются). */
async function createBenchBroadcast(minDaysBetween: number, maxRecipients: number): Promise<void> {
  await db.broadcast.deleteMany({ where: { id: BENCH_BROADCAST_ID } });
  await db.smsMessage.deleteMany({ where: { broadcastId: BENCH_BROADCAST_ID } });
  await db.broadcast.create({
    data: {
      id: BENCH_BROADCAST_ID,
      name: 'Бенчмарк: запуск',
      segmentId: 'seed-seg-1',
      templateId: BENCH_TEMPLATE_ID,
      kind: 'ONCE',
      minute: 0,
      minDaysBetween,
      maxRecipients,
      status: 'ACTIVE',
    },
  });
}

/* ============ Хронометраж ============ */

interface CaseResult {
  group: string;
  name: string;
  median: number;
  min: number;
  max: number;
  note?: string;
}

const results: CaseResult[] = [];

/** Замер кейса: прогрев (отключается warmup=false) + N прогонов; ошибка кейса —
 * фиксируется в отчёт как FAILED, бенчмарк продолжает работу. */
async function bench(
  group: string,
  name: string,
  fn: () => Promise<unknown>,
  runs = 3,
  warmup = true,
): Promise<void> {
  try {
    if (warmup) await fn(); // прогрев (кэш страниц БД — как второй визит экрана)
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      await fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    results.push({ group, name, median, min: times[0], max: times[times.length - 1] });
    console.log(`  ${name.padEnd(46)} ${median.toFixed(0).padStart(7)} мс  (min ${times[0].toFixed(0)} / max ${times[times.length - 1].toFixed(0)})`);
  } catch (e) {
    results.push({ group, name, median: -1, min: -1, max: -1, note: `FAILED: ${e instanceof Error ? e.message : String(e)}` });
    console.log(`  ${name.padEnd(46)}   FAILED: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
  }
}

/* ============ Чтение: экраны панели ============ */

async function benchReads(): Promise<void> {
  console.log('\n=== ЧТЕНИЕ: экраны панели ===');

  await bench('Чтение', 'Клиенты: страница 1 (20 строк)', () =>
    clients.listClients({ page: 1, pageSize: 20, skip: 0, take: 20 }));

  await bench('Чтение', 'Клиенты: страница 100 (offset 1980)', () =>
    clients.listClients({ page: 100, pageSize: 20, skip: 1980, take: 20 }));

  await bench('Чтение', 'Клиенты: страница 10000 (offset 199980)', () =>
    clients.listClients({ page: 10000, pageSize: 20, skip: 199980, take: 20 }));

  await bench('Чтение', 'Клиенты: поиск «Иванов» (4 поля + JSON)', () =>
    clients.listClients({ search: 'Иванов', page: 1, pageSize: 20, skip: 0, take: 20 }));

  await bench('Чтение', 'Клиенты: поиск по префиксу телефона «+7999»', () =>
    clients.listClients({ search: '+7999', page: 1, pageSize: 20, skip: 0, take: 20 }));

  await bench('Чтение', 'SMS-лог: страница 1 без фильтров', () =>
    smsLog.listSms({}, { skip: 0, take: 20 }));

  await bench('Чтение', 'SMS-лог: страница 1000 (offset 19980)', () =>
    smsLog.listSms({}, { skip: 19980, take: 20 }));

  await bench('Чтение', 'SMS-лог: фильтр статус DELIVERED, стр. 1', () =>
    smsLog.listSms({ status: 'DELIVERED' }, { skip: 0, take: 20 }));

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  await bench('Чтение', 'SMS-лог: фильтр за 7 дней, стр. 1', () =>
    smsLog.listSms({ from: weekAgo }, { skip: 0, take: 20 }));

  await bench('Чтение', `Дашборд: getStats(30) — ${fmt(cnt[0].smsHot30)} SMS в окне`, () => stats.getStats(30));
  await bench('Чтение', 'Дашборд: getStats(7)', () => stats.getStats(7));

  // Карточка клиента: первый клиент из базы
  const someClient = await db.client.findFirst({ select: { id: true } });
  if (someClient) {
    await bench('Чтение', 'Карточка клиента: история SMS + статы', () =>
      smsLog.getClientSmsHistory(someClient.id, { skip: 0, take: 20 }));
  }

  // Сегменты: стандартное правило (SQL-путь) и спец-правило ДР (JS-курсор)
  await bench('Чтение', `Сегмент: счёт agreementStatus=16 (~${fmt(SEG_APPROX)})`, () =>
    segments.previewSegment({
      conditions: { match: 'all', rules: [{ field: 'agreement_actual_status', op: 'eq', value: 16 }] },
      sampleSize: 5,
    }));

  await bench('Чтение', 'Сегмент: превью 20 строк (SQL-путь)', () =>
    segments.previewSegment({
      conditions: { match: 'all', rules: [{ field: 'agreement_actual_status', op: 'eq', value: 16 }] },
      sampleSize: 20,
    }));

  // JS-курсор по всей базе (~2 мин на 4 млн): 1 прогон без прогрева — цена
  // стабильна (полный скан), экономим ~6 минут цикла на разогревах.
  await bench(
    'Чтение',
    `Сегмент: ДР в ближайшие 7 дней (JS-курсор по ${fmt(cnt[0].clients)})`,
    () =>
      segments.previewSegment({
        conditions: { match: 'all', rules: [{ field: 'person_birthday', op: 'birthday_within_next_days', value: 7 }] },
        sampleSize: 5,
      }),
    1,
    false,
  );

  await bench('Чтение', 'Экземпляры: страница 1', () =>
    instances.listInstances({ page: 1, pageSize: 20, skip: 0, take: 20 }));

  await bench('Чтение', 'Событ. доставки: стр. 1 + фильтр source', () =>
    messageEvents.listMessageEvents({ source: 'smstech', page: 1, pageSize: 20, skip: 0, take: 20 }));

  await bench('Чтение', 'Событ. доставки: стр. 1, период 7 дней', () =>
    messageEvents.listMessageEvents({ periodDays: 7, page: 1, pageSize: 20, skip: 0, take: 20 }));

  // Статистика запуска рассылки (агрегация по SmsMessage)
  const someBroadcast = await db.smsMessage.findFirst({ where: { broadcastId: { not: null } }, select: { broadcastId: true } });
  if (someBroadcast?.broadcastId) {
    await bench('Чтение', `Статистика рассылки: groupBy по ${fmt(Math.round(cnt[0].sms * 0.12))} SMS`, () =>
      db.smsMessage.groupBy({
        by: ['status'],
        _count: { _all: true },
        where: { broadcastId: someBroadcast.broadcastId },
      }));
  }
}

/* ============ Чтение: выборки воркера (каждые 5 с) ============ */

async function benchWorkerReads(): Promise<void> {
  console.log('\n=== ЧТЕНИЕ: выборки воркера (каждый тик 5 с) ===');

  await bench('Воркер', 'Инбокс: батч NEW/зависших (take 50)', () =>
    db.eventsInbox.findMany({
      where: {
        OR: [
          { status: 'NEW' },
          { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - 5 * 60000) } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }));

  await bench('Воркер', 'Задачи: claim due PENDING (take 20)', () =>
    db.scheduledJob.findMany({
      where: { status: 'PENDING', runAt: { lte: new Date() } },
      orderBy: { runAt: 'asc' },
      take: 20,
    }));

  await bench('Воркер', 'Очередь рассылок: due-страница (take 50)', () =>
    db.smsMessage.findMany({
      where: {
        status: 'QUEUED',
        scheduledFor: { not: null, lte: new Date() },
        broadcastId: { not: null },
      },
      orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
      take: 50,
    }));

  await bench('Воркер', 'Рассылки: due ACTIVE (take 5)', () =>
    db.broadcast.findMany({
      where: { status: 'ACTIVE', nextRunAt: { lte: new Date() } },
      orderBy: { nextRunAt: 'asc' },
      take: 5,
    }));

  await bench('Воркер', 'Реконсиляция: SENT без статуса 2ч (take 10)', () =>
    db.smsMessage.findMany({
      where: {
        status: 'SENT',
        provider: { in: ['smstech', 't2'] },
        providerMessageId: { not: null },
        sentAt: { lt: new Date(Date.now() - 2 * 3600000) },
      },
      orderBy: { sentAt: 'asc' },
      take: 10,
      select: { id: true, provider: true, providerMessageId: true, phone: true, clientId: true },
    }));
}

/* ============ Деградационные сценарии (память/время) ============ */

async function benchDegradation(): Promise<void> {
  console.log('\n=== ДЕГРАДАЦИЯ: executeBroadcastRun на больших сегментах ===');

  // Шаг 1 «получатели» СТАРОГО executeBroadcastRun: evaluateSegment материализует
  // ВСЕ строки. На этой машине (4 ГБ RAM) полный прогон умер в OOM уже на 500 тыс.
  // строк, повторно — на 250 тыс. (см. bench-before.log / dmesg): материализация
  // сегмента 2,2 млн в памяти НЕВЫПОЛНИМА В ПРИНЦИПЕ — не «медленно», а убивает
  // процесс. Здесь — выживаемый размер 100 тыс. + экстраполяция; новый потоковый
  // путь (executeBroadcastRun) меряется сквозным кейсом ниже и держит в памяти
  // не больше порции (1000 строк).
  const t0 = performance.now();
  const rssBefore = process.memoryUsage().rss;
  const rows = await db.client.findMany({
    where: { agreementStatus: 16 }, // ~55% базы ≈ 2,2 млн строк
    take: 100000,
  });
  const loadMs = performance.now() - t0;
  const rssAfter = process.memoryUsage().rss;
  const perRow = (rssAfter - rssBefore) / rows.length;
  results.push({
    group: 'Деградация',
    name: 'Материализация 100 тыс. полных строк (аналог evaluateSegment)',
    median: loadMs,
    min: loadMs,
    max: loadMs,
    note: `RSS +${((rssAfter - rssBefore) / 1048576).toFixed(0)} МБ (~${(perRow / 1024).toFixed(1)} КБ/строка); 250 тыс. и 500 тыс. — OOM-kill процесса (4 ГБ RAM, dmesg); полный сегмент 2,2 млн ≈ ${(perRow * 2200000 / 1048576).toFixed(0)} МБ RAM — НЕВЫПОЛНИМО на этом сервере`,
  });
  console.log(`  материализация 100 тыс. строк: ${loadMs.toFixed(0)} мс, RSS +${((rssAfter - rssBefore) / 1048576).toFixed(0)} МБ (${(perRow / 1024).toFixed(1)} КБ/строка; строк в памяти: ${rows.length})`);

  // Шаг 2 «гвард minDaysBetween»: по одному запросу на клиента.
  const c = await db.client.findFirst({ select: { id: true } });
  if (c) {
    const g0 = performance.now();
    const N = 200;
    for (let i = 0; i < N; i++) {
      await db.smsMessage.findMany({
        where: {
          broadcastId: '11111111-aaaa-4000-8000-000000000001',
          clientId: c.id,
          status: { in: ['QUEUED', 'SENDING', 'SENT', 'DELIVERED'] },
          OR: [
            { sentAt: { gte: new Date(Date.now() - 8 * 86400000) } },
            { AND: [{ sentAt: null }, { scheduledFor: { gte: new Date(Date.now() - 8 * 86400000) } }] },
            { AND: [{ sentAt: null }, { scheduledFor: null }, { createdAt: { gte: new Date(Date.now() - 8 * 86400000) } }] },
          ],
        },
        select: { sentAt: true, scheduledFor: true, createdAt: true },
      });
    }
    const perClient = (performance.now() - g0) / N;
    results.push({
      group: 'Деградация',
      name: 'Гвард minDaysBetween: 1 запрос на клиента',
      median: perClient,
      min: perClient,
      max: perClient,
      note: `×1 клиент = ${perClient.toFixed(2)} мс → 2,2 млн клиентов ≈ ${(perClient * 2200000 / 1000 / 60).toFixed(0)} мин чистых запросов (внутри тика воркера)`,
    });
    console.log(`  гвард на клиента: ${perClient.toFixed(2)} мс → на 2,2 млн ≈ ${(perClient * 2200000 / 1000 / 60).toFixed(0)} мин`);
  }
}

/* ============ Запись ============ */

/** Стоимость построчной вставки в зависимости от режима журнала SQLite:
 *  DELETE (по умолчанию у приложения без прагм) vs WAL+synchronous=NORMAL
 *  (рекомендуемый боевой режим) — на отдельной маленькой копии dev-БД. */
async function benchJournalModes(): Promise<void> {
  console.log('\n=== ЗАПИСЬ: режимы журнала SQLite (микро-тест на копии dev-БД) ===');
  const { copyFileSync, rmSync } = await import('node:fs');
  const { Database } = await import('bun:sqlite');
  const { PrismaClient } = await import('@prisma/client');

  const scratch = '/tmp/trigger-loadtest/journal-scratch.db';
  for (const mode of ['DELETE', 'WAL']) {
    rmSync(scratch, { force: true });
    copyFileSync('/home/z/my-project/db/custom.db', scratch);
    const ctl = new Database(scratch);
    ctl.exec(`PRAGMA journal_mode=${mode}`);
    if (mode === 'WAL') ctl.exec('PRAGMA synchronous=NORMAL');
    ctl.close();
    process.env.DATABASE_URL = `file:${scratch}`;
    const pdb = new PrismaClient({ log: ['error'] });
    const t0 = performance.now();
    const N = 200;
    for (let i = 0; i < N; i++) {
      await pdb.smsMessage.create({
        data: { phone: '+79990000000', body: 'замер режима журнала', provider: 'sandbox', status: 'QUEUED' },
      });
    }
    const per = (performance.now() - t0) / N;
    results.push({
      group: 'Запись',
      name: `Режим журнала ${mode}: построчных create × ${N}`,
      median: per * 1000,
      min: per * 1000,
      max: per * 1000,
      note: `${per.toFixed(2)} мс/строка — ${mode === 'DELETE' ? 'текущий режим приложения (без прагм): fsync на каждом коммите' : 'WAL + synchronous=NORMAL: групповой коммит'}; воркер пишет именно так`,
    });
    console.log(`  журнал ${mode}: ${per.toFixed(2)} мс/строка`);
    await pdb.$disconnect();
  }
  rmSync(scratch, { force: true });
}

async function benchWrites(): Promise<void> {
  console.log('\n=== ЗАПИСЬ: на нагрузочной БД (режим WAL от сида) ===');

  // СКВОЗНОЙ кейс: реальный запуск рассылки целиком (потоковый путь) на
  // сегменте seed-seg-1 (agreementStatus=16 ≈ SEG_APPROX) с лимитом
  // BENCH_BROADCAST_LIMIT (для профиля 6 млн/мес — 50 тыс.) и гвардом 7 дней.
  // Один прогон (без прогрева): анти-дубль lastRunAt 60 с + гвард видит созданные
  // предыдущим прогоном сообщения — повторы исказили бы цифры.
  await ensureBenchTemplate();
  // Прогрев кэша страниц ОС (БД много-гигабайтная на машине 4 ГБ RAM — без
  // прогона все цифры «холодные» и отражают диск, а не код): полный проход с
  // лимитом 1000 без замера; сообщения прогрева удаляются пересозданием ниже.
  await createBenchBroadcast(0, 1000);
  await broadcasts.executeBroadcastRun(BENCH_BROADCAST_ID);
  // Замер: свежая рассылка (анти-дубль lastRunAt 60 с + чистая история сообщений
  // для гварда 7 дней), один прогон без повторного прогрева. RSS до/после —
  // контроль потоковой памяти (O(порция), не O(сегмент)).
  await createBenchBroadcast(7, BROADCAST_LIMIT);
  const rssBefore = process.memoryUsage().rss;
  const tRun = performance.now();
  const runRes = await broadcasts.executeBroadcastRun(BENCH_BROADCAST_ID);
  const runMs = performance.now() - tRun;
  const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / 1048576;
  measured.broadcastRunMs = runMs;
  measured.broadcastRecipients = runRes.recipients;
  results.push({
    group: 'Запуск',
    name: `executeBroadcastRun: сегмент ${fmt(SEG_APPROX)}, лимит ${fmt(BROADCAST_LIMIT)}`,
    median: runMs,
    min: runMs,
    max: runMs,
    note: `planned=${runRes.planned}, recipients=${runRes.recipients}, skippedGuard=${runRes.skippedGuard}, cappedBy=${runRes.cappedBy}; RSS +${rssDeltaMb.toFixed(0)} МБ; ${runRes.recipients > 0 ? (runMs / runRes.recipients).toFixed(2) : '—'} мс/получатель (вкл. проход всего сегмента и батч-гвард)`,
  });
  console.log(
    `  запуск рассылки: ${runMs.toFixed(0)} мс (planned=${runRes.planned}, recipients=${runRes.recipients}, guard=${runRes.skippedGuard}), RSS +${rssDeltaMb.toFixed(0)} МБ`,
  );

  // Построчное создание SMS — как createBroadcastMessage в executeBroadcastRun.
  // scheduledFor = +365 дней, чтобы строки не попадали в due-очередь замеров воркера.
  const t0 = performance.now();
  const N = 1000;
  for (let i = 0; i < N; i++) {
    await db.smsMessage.create({
      data: {
        phone: '+79990000000',
        body: 'Нагрузочный замер построчной вставки SMS-сообщения',
        provider: 'sandbox',
        status: 'QUEUED',
        broadcastId: '11111111-aaaa-4000-8000-000000000001',
        broadcastName: 'Нагрузочная рассылка №1',
        scheduledFor: new Date(Date.now() + 365 * 86400000),
      },
    });
  }
  const perSms = (performance.now() - t0) / N;
  results.push({
    group: 'Запись',
    name: 'Запуск рассылки: построчных create × 1000',
    median: perSms * 1000,
    min: perSms * 1000,
    max: perSms * 1000,
    note: `${perSms.toFixed(2)} мс/строка (WAL) → 1000 получателей ≈ ${(perSms * 1000 / 1000).toFixed(1)} с; 50 тыс. ≈ ${(perSms * 50000 / 1000 / 60).toFixed(1)} мин`,
  });
  console.log(`  построчный create SMS: ${perSms.toFixed(2)} мс/строка (1000 шт. за ${(perSms * 1000 / 1000).toFixed(1)} с)`);
  measured.perSmsMs = perSms;

  // Журналирование события отправки — как journalSendOutcome после каждого send
  const j0 = performance.now();
  const J = 200;
  for (let i = 0; i < J; i++) {
    await messageEvents.journalSmsEvent({
      source: 'panel',
      eventType: 'send_sms',
      phone: '+79990000000',
      provider: 'sandbox',
      payload: { bench: true, seq: i },
      dedupKey: `bench-journal-${Date.now()}-${i}`,
      result: { bench: true },
    });
  }
  const perEvent = (performance.now() - j0) / J;
  results.push({
    group: 'Запись',
    name: 'Журнал событий: journalSmsEvent × 200',
    median: perEvent * 1000,
    min: perEvent * 1000,
    max: perEvent * 1000,
    note: `${perEvent.toFixed(2)} мс/событие (вкл. дедуп-поиск по UNIQUE-индексу на 1 млн строк)`,
  });
  console.log(`  journalSmsEvent: ${perEvent.toFixed(2)} мс/событие`);
  measured.perEventMs = perEvent;

  // Upsert клиента — путь ингеста событий (upsertClientFromCard)
  const u0 = performance.now();
  const U = 300;
  for (let i = 0; i < U; i++) {
    const ext = `bench-upsert-${i}`;
    const existing = await db.client.findUnique({ where: { externalId: ext } });
    if (existing) {
      await db.client.update({ where: { id: existing.id }, data: { profileUpdatedAt: new Date() } });
    } else {
      await db.client.create({
        data: { externalId: ext, phone: '+79990001122', data: '{}', smsConsentStatus: 'NONE' },
      });
    }
  }
  const perUpsert = (performance.now() - u0) / U;
  results.push({
    group: 'Запись',
    name: 'Ингест карточек: upsert клиента × 300',
    median: perUpsert * 1000,
    min: perUpsert * 1000,
    max: perUpsert * 1000,
    note: `${perUpsert.toFixed(2)} мс/карточка; первичная синхронизация 4 млн карточек через events-API ≈ ${(perUpsert * 4000000 / 1000 / 3600).toFixed(0)} ч чистой записи (воркер: 50 событий/тик → ~4,6 суток)`,
  });
  console.log(`  upsert клиента: ${perUpsert.toFixed(2)} мс/карточка → 4 млн ≈ ${(perUpsert * 4000000 / 1000 / 3600).toFixed(0)} ч`);
  measured.perUpsertMs = perUpsert;
}

/* ============ Режим broadcast: «писатель» параллельного стресса ============ */

/** Сквозной запуск большой рассылки (лимит BENCH_BROADCAST_LIMIT): время,
 *  счётчики, RSS и темп на получателя; итог — JSON в /tmp/trigger-loadtest/broadcast-run.json.
 *  Запускается вторым процессом рядом с режимом reader — эмулирует «воркер
 *  гонит большую рассылку, пока операторы работают в панели». */
async function runBroadcastMode(): Promise<void> {
  await ensureBenchTemplate();
  // гвард 0: без пропусков (чистая история сообщений); замеряем полную мощность
  await createBenchBroadcast(0, BROADCAST_LIMIT);
  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const res = await broadcasts.executeBroadcastRun(BENCH_BROADCAST_ID);
  const ms = performance.now() - t0;
  const payload = {
    mode: 'broadcast',
    broadcastLimit: BROADCAST_LIMIT,
    clients: cnt[0].clients,
    segmentApprox: SEG_APPROX,
    ms: Math.round(ms),
    planned: res.planned,
    recipients: res.recipients,
    skippedGuard: res.skippedGuard,
    cappedBy: res.cappedBy,
    perRecipientMs: res.recipients > 0 ? +(ms / res.recipients).toFixed(2) : null,
    rssDeltaMb: +((process.memoryUsage().rss - rssBefore) / 1048576).toFixed(0),
  };
  console.log(JSON.stringify(payload, null, 2));
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/trigger-loadtest/broadcast-run.json', JSON.stringify(payload, null, 2) + '\n');
}

/* ============ Режим reader: «панель во время записи» ============ */

interface ReaderCase {
  name: string;
  fn: () => Promise<unknown>;
}

/** Цикл чтения READER_SECONDS секунд: p50/p95/max по экранам панели и счётчик
 *  ошибок (в т.ч. SQLITE_BUSY — единственный источник отказов чтения при
 *  параллельном писателе в WAL). Отчёт — /tmp/trigger-loadtest/reader-report.md. */
async function runReaderMode(): Promise<void> {
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const cases: ReaderCase[] = [
    { name: 'Клиенты: страница 1', fn: () => clients.listClients({ page: 1, pageSize: 20, skip: 0, take: 20 }) },
    {
      name: 'Клиенты: страница 10000 (offset 200 тыс.)',
      fn: () => clients.listClients({ page: 10000, pageSize: 20, skip: 199980, take: 20 }),
    },
    { name: 'SMS-лог: страница 1', fn: () => smsLog.listSms({}, { skip: 0, take: 20 }) },
    { name: 'SMS-лог: фильтр за 7 дней', fn: () => smsLog.listSms({ from: weekAgo }, { skip: 0, take: 20 }) },
    { name: 'Дашборд: getStats(30)', fn: () => stats.getStats(30) },
    {
      name: 'Сегмент: счёт (SQL-путь)',
      fn: () =>
        segments.previewSegment({
          conditions: { match: 'all', rules: [{ field: 'agreement_actual_status', op: 'eq', value: 16 }] },
          sampleSize: 5,
        }),
    },
  ];
  const samples = new Map<string, number[]>();
  const errors: Array<{ c: string; message: string }> = [];
  const deadline = Date.now() + READER_SECONDS * 1000;
  let iterations = 0;
  while (Date.now() < deadline) {
    for (const c of cases) {
      const t0 = performance.now();
      try {
        await c.fn();
      } catch (e) {
        errors.push({ c: c.name, message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      }
      const arr = samples.get(c.name) ?? [];
      arr.push(performance.now() - t0);
      samples.set(c.name, arr);
    }
    iterations += 1;
  }
  const pct = (arr: number[], p: number): number => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const lines: string[] = [
    `# Reader-режим: панель во время большой рассылки (${READER_SECONDS} с)`,
    '',
    `Полных проходов по 6 экранам: ${iterations}; ошибок: ${errors.length}`,
    '',
    '| Экран | p50 | p95 | max | замеров |',
    '|---|---|---|---|---|',
  ];
  for (const c of cases) {
    const arr = (samples.get(c.name) ?? []).slice().sort((a, b) => a - b);
    if (arr.length === 0) {
      lines.push(`| ${c.name} | — (все попытки упали) | — | — | 0 |`);
      continue;
    }
    lines.push(`| ${c.name} | ${pct(arr, 0.5).toFixed(0)} мс | ${pct(arr, 0.95).toFixed(0)} мс | ${arr[arr.length - 1].toFixed(0)} мс | ${arr.length} |`);
  }
  if (errors.length > 0) {
    lines.push('', '## Ошибки', '');
    for (const e of errors.slice(0, 20)) lines.push(`- ${e.c}: ${e.message}`);
  }
  const report = lines.join('\n');
  console.log('\n' + report);
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/trigger-loadtest/reader-report.md', report + '\n');
}

/* ============ Отчёт ============ */

function renderReport(): string {
  const lines: string[] = [];
  lines.push(`# Нагрузочный бенчмарк trigger`);
  lines.push('');
  lines.push(`Дата: ${new Date().toISOString()}`);
  lines.push(`БД: ${process.argv[2] ?? '/tmp/trigger-loadtest/loadtest.db'} (клиентов ${fmt(cnt[0].clients)}, SMS ${fmt(cnt[0].sms)} — в окне 30 дней ${fmt(cnt[0].smsHot30)}, событий ${fmt(cnt[0].events)})`);
  lines.push('');
  let group = '';
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      lines.push(`## ${group}`);
      lines.push('');
      lines.push('| Кейс | Медиана | Мин | Макс | Примечание |');
      lines.push('|---|---|---|---|---|');
    }
    lines.push(
      `| ${r.name} | ${r.median < 1 ? (r.median * 1000).toFixed(0) + ' мкс' : r.median.toFixed(1) + ' мс'} | ${r.min < 1 ? (r.min * 1000).toFixed(0) + ' мкс' : r.min.toFixed(1) + ' мс'} | ${r.max < 1 ? (r.max * 1000).toFixed(0) + ' мкс' : r.max.toFixed(1) + ' мс'} | ${r.note ?? ''} |`,
    );
  }
  return lines.join('\n');
}

/* ============ Расчёт ёмкости под месячный профиль ============ */

/** Расчёт пропускной способности под профиль «N млн SMS/мес» (N = горячему
 *  окну сида) из фактических замеров этого прогона. Константы воркера — из
 *  scheduler/worker.ts и broadcasts.ts (тик 5 с; SCHEDULED_SMS_BATCH=50,
 *  INBOX_BATCH=50, JOBS_BATCH=20). */
function renderCapacity(): string {
  const smsPerMonth = cnt[0].smsHot30;
  if (smsPerMonth <= 0) return '';
  const avgPerSec = smsPerMonth / 30.4 / 86400;
  const lines: string[] = ['', '## Ёмкость (расчёт по замерам)', ''];
  lines.push(
    `- Профиль: ${fmt(smsPerMonth)} SMS/мес = **${avgPerSec.toFixed(1)} SMS/сек** в среднем (пиковый день ×5 ≈ ${(avgPerSec * 5).toFixed(1)}/сек).`,
  );
  if (measured.perSmsMs) {
    const rowsPerSec = 1000 / measured.perSmsMs;
    lines.push(
      `- Один писатель SQLite (WAL): ${measured.perSmsMs.toFixed(2)} мс/строка → **${rowsPerSec.toFixed(0)} строк/сек** ≈ ${fmt(Math.round(rowsPerSec * 2626560))} строк/мес теоретически.`,
    );
    lines.push(
      `- Создание всего месячного объёма сообщений одним непрерывным писателем: ≈ ${(smsPerMonth * measured.perSmsMs / 1000 / 60).toFixed(0)} мин чистой записи.`,
    );
  }
  if (measured.broadcastRunMs && measured.broadcastRecipients) {
    const per = measured.broadcastRunMs / measured.broadcastRecipients;
    lines.push(
      `- Сквозной запуск рассылки: ${per.toFixed(2)} мс/получатель (проход сегмента + гвард + вставка) → прогон на 1 млн ≈ ${(per * 1e6 / 1000 / 3600).toFixed(1)} ч.`,
    );
  }
  lines.push(
    '- Воркер (тик 5 с): отправка очереди рассылок — 50 SMS/тик = 10/сек = 25,9 млн/мес потолок; ингест событий — 50/тик = 10/сек; задачи воронок — 20/тик = 4/сек.',
  );
  if (measured.perEventMs) {
    lines.push(
      `- Журналирование вебхука доставки: ${measured.perEventMs.toFixed(2)} мс → при ${avgPerSec.toFixed(1)}/сек запас ×${(1000 / measured.perEventMs / avgPerSec).toFixed(0)}.`,
    );
  }
  if (measured.perUpsertMs) {
    lines.push(`- Ингест карточек (upsert): ${measured.perUpsertMs.toFixed(2)} мс/карточка.`);
  }
  lines.push(
    `- Рост БД при профиле: SmsMessage +${(smsPerMonth * 280 / 1e9).toFixed(1)} ГБ/мес; MessageEvent (≈1 вебхук на SMS) +${(smsPerMonth * 500 / 1e9).toFixed(1)} ГБ/мес → стратегия ретеншна обязательна (см. рекомендации).`,
  );
  return lines.join('\n');
}

/* ============ main ============ */

console.log(
  `БД: клиентов ${cnt[0].clients}, SMS ${cnt[0].sms} (в окне 30 дней: ${cnt[0].smsHot30}), событий ${cnt[0].events}; режим ${MODE}`,
);

if (MODE === 'broadcast') {
  await runBroadcastMode();
  await db.$disconnect();
  process.exit(0);
}
if (MODE === 'reader') {
  await runReaderMode();
  await db.$disconnect();
  process.exit(0);
}

// Выбор секций: BENCH_SKIP_READS=1 — только деградация/запись (для быстрых
// перезапусков после правок; чтение и ДР-кейс занимают ~10 мин).
if (process.env.BENCH_SKIP_READS !== '1') {
  await benchReads();
  await benchWorkerReads();
}
await benchDegradation();
await benchJournalModes();
await benchWrites();

const report = renderReport() + '\n' + renderCapacity();
console.log('\n' + report);

const { writeFileSync } = await import('node:fs');
writeFileSync('/tmp/trigger-loadtest/bench-report.md', report + '\n');
console.log('\nОтчёт сохранён: /tmp/trigger-loadtest/bench-report.md');

await db.$disconnect();
process.exit(0);
