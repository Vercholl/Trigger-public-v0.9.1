// Сид dev/песочницы: ТОЛЬКО синтетические данные (152-ФЗ). Запуск: bun run db:seed.
// Администратор — из env (ADMIN_EMAIL/ADMIN_PASSWORD, обязательны);
// менеджер/вьюер — из env (пусто → пропускаются). mustChangePassword=false (демо без принудительной смены).
// Клиенты — ПОЛНЫЕ карточки клиента: ФИО по частям, заявки/договоры, преапрувы.
import { PrismaClient, type Client } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { extractVariables, renderTemplate } from '../src/lib/sms/render';
import { generateUnsubscribeToken, UNSUBSCRIBE_TOKEN_TTL_MS } from '../src/lib/compliance/disclaimer';

const db = new PrismaClient();

// Детерминированный ГПСЧ — воспроизводимый сид.
let seedState = 20250101;
function rand(): number {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
}
function randInt(min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

function daysAgo(days: number, hour = 12, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, minute, randInt(0, 59), 0);
  return d;
}
function inDays(days: number, hour = 12, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}
function birthdayIn(days: number, year: number): Date {
  const d = inDays(days, 9, 0);
  d.setUTCFullYear(year);
  return d;
}

async function main(): Promise<void> {
  const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD ?? '';
  if (!adminEmail || !adminPassword) {
    console.error('[seed] Обязательны ADMIN_EMAIL и ADMIN_PASSWORD в .env — сид прерван');
    process.exit(1);
  }

  // ---------- 1. Очистка (FK-безопасный порядок) ----------
  await db.scheduledJob.deleteMany();
  await db.instanceEvent.deleteMany();
  await db.smsMessage.deleteMany();
  await db.workflowInstance.deleteMany();
  await db.eventsInbox.deleteMany();
  await db.unsubscribeList.deleteMany();
  await db.shortLinkVisit.deleteMany();
  await db.shortLink.deleteMany();
  await db.funnel.deleteMany();
  await db.segment.deleteMany();
  await db.broadcastRun.deleteMany();
  await db.broadcast.deleteMany();
  await db.smsTemplate.deleteMany();
  await db.client.deleteMany();
  await db.session.deleteMany();
  await db.apiKey.deleteMany();
  await db.auditLog.deleteMany();
  await db.rateLimitEntry.deleteMany();
  await db.user.deleteMany({ where: { email: { not: adminEmail } } });

  // ---------- 2. Пользователи ----------
  const adminHash = await bcrypt.hash(adminPassword, 12);
  const admin = await db.user.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail,
      name: 'Администратор Демо',
      role: 'ADMIN',
      passwordHash: adminHash,
      mustChangePassword: false, // sandbox-демо без принудительной смены
    },
    update: {
      passwordHash: adminHash,
      role: 'ADMIN',
      isActive: true,
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  const demoUsers: Array<{ email: string; password: string; name: string; role: string }> = [];
  const managerEmail = (process.env.MANAGER_EMAIL ?? '').trim().toLowerCase();
  const managerPassword = process.env.MANAGER_PASSWORD ?? '';
  if (managerEmail && managerPassword) {
    demoUsers.push({ email: managerEmail, password: managerPassword, name: 'Менеджер Демо', role: 'MANAGER' });
  }
  const viewerEmail = (process.env.VIEWER_EMAIL ?? '').trim().toLowerCase();
  const viewerPassword = process.env.VIEWER_PASSWORD ?? '';
  if (viewerEmail && viewerPassword) {
    demoUsers.push({ email: viewerEmail, password: viewerPassword, name: 'Наблюдатель Демо', role: 'VIEWER' });
  }
  for (const u of demoUsers) {
    await db.user.upsert({
      where: { email: u.email },
      create: {
        email: u.email,
        name: u.name,
        role: u.role,
        passwordHash: await bcrypt.hash(u.password, 12),
        mustChangePassword: false,
      },
      update: { passwordHash: await bcrypt.hash(u.password, 12), role: u.role, isActive: true },
    });
  }

  // ---------- 3. Клиенты: ПОЛНЫЕ карточки клиента (П1) ----------
  // Статусы: договор 16=действующий, 17=пролонгирован, 19=закрыт; заявка 9=отказ.
  interface ClientSeed {
    first: string;
    last: string;
    middle: string;
    email: string;
    tz: string;
    consent: string;
    consentSource?: string;
    product: 'PDL' | 'IL';
    agreement: { id: number; status: number; prev: number; amount: number; period: number; closedAt?: Date } | null;
    application: { id: number; status: number; prev: number };
    offer: {
      money: number;
      days: number;
      start: Date;
      expired: Date;
      available: boolean;
    } | null;
    birthday: Date | null;
    lastYear: number;
    lifetime: number;
    banDays: number;
    notificationActive: boolean;
    unsubscribed?: boolean;
  }
  const clientSeeds: ClientSeed[] = [
    // 0 CLI-0001 Иван Тестов — действующий PDL, день рождения не скоро
    {
      first: 'Иван', last: 'Тестов', middle: 'Иванович', email: 'ivan.testov@example.com',
      tz: 'Asia/Novosibirsk', consent: 'GRANTED', consentSource: 'site', product: 'PDL',
      agreement: { id: 101001, status: 16, prev: 15, amount: 24000, period: 21 },
      application: { id: 551001, status: 4, prev: 1 },
      offer: null, birthday: birthdayIn(120, 1985), lastYear: 1, lifetime: 4, banDays: 0, notificationActive: true,
    },
    // 1 CLI-0002 Мария Примерова — закрытый договор, просрочка (демо-история)
    {
      first: 'Мария', last: 'Примерова', middle: 'Сергеевна', email: 'maria.primerva@example.com',
      tz: 'Asia/Novosibirsk', consent: 'GRANTED', consentSource: 'site', product: 'PDL',
      agreement: { id: 101002, status: 19, prev: 16, amount: 15000, period: 14, closedAt: daysAgo(30) },
      application: { id: 551002, status: 4, prev: 2 },
      offer: { money: 25000, days: 21, start: daysAgo(2), expired: inDays(12), available: true },
      birthday: birthdayIn(200, 1990), lastYear: 1, lifetime: 2, banDays: 0, notificationActive: true,
    },
    // 2 CLI-0003 Пётр Демо — пролонгированный
    {
      first: 'Пётр', last: 'Демо', middle: 'Петрович', email: 'pyotr.demo@example.com',
      tz: 'Asia/Novosibirsk', consent: 'GRANTED', consentSource: 'site', product: 'PDL',
      agreement: { id: 101003, status: 17, prev: 16, amount: 32000, period: 30 },
      application: { id: 551003, status: 4, prev: 3 },
      offer: null, birthday: birthdayIn(60, 1982), lastYear: 0, lifetime: 5, banDays: 0, notificationActive: true,
    },
    // 3 CLI-0004 Анна Синтетикова — действующий, ДР через 5 дней
    {
      first: 'Анна', last: 'Синтетикова', middle: 'Александровна', email: 'anna.sintetikova@example.com',
      tz: 'Asia/Novosibirsk', consent: 'GRANTED', consentSource: 'site', product: 'PDL',
      agreement: { id: 101004, status: 16, prev: 16, amount: 9000, period: 10 },
      application: { id: 551004, status: 4, prev: 1 },
      offer: { money: 18000, days: 14, start: daysAgo(1), expired: inDays(10), available: true },
      birthday: birthdayIn(5, 1993), lastYear: 2, lifetime: 3, banDays: 0, notificationActive: true,
    },
    // 4 CLI-0005 Сергей Макет — закрытый, ban 30, ДР через 10 дней, преапрув истекает
    {
      first: 'Сергей', last: 'Макет', middle: 'Олегович', email: 'sergey.maket@example.com',
      tz: 'Asia/Novosibirsk', consent: 'GRANTED', consentSource: 'site', product: 'PDL',
      agreement: { id: 101005, status: 19, prev: 17, amount: 21000, period: 21, closedAt: daysAgo(5) },
      application: { id: 551005, status: 4, prev: 2 },
      offer: { money: 30000, days: 30, start: daysAgo(5), expired: inDays(6), available: true },
      birthday: birthdayIn(10, 1987), lastYear: 1, lifetime: 6, banDays: 30, notificationActive: true,
    },
    // 5 CLI-0006 Ольга Образецова — IL, без согласия
    {
      first: 'Ольга', last: 'Образецова', middle: 'Дмитриевна', email: 'olga.obrztsova@example.com',
      tz: 'Asia/Novosibirsk', consent: 'NONE', product: 'IL',
      agreement: { id: 101006, status: 16, prev: 15, amount: 60000, period: 180 },
      application: { id: 551006, status: 4, prev: 1 },
      offer: null, birthday: birthdayIn(90, 1980), lastYear: 0, lifetime: 1, banDays: 0, notificationActive: true,
    },
    // 6 CLI-0007 Дмитрий Фиктив — действующий, напоминание о платеже
    {
      first: 'Дмитрий', last: 'Фиктив', middle: 'Андреевич', email: 'dmitry.fiktiv@example.com',
      tz: 'Europe/Moscow', consent: 'NONE', product: 'PDL',
      agreement: { id: 101007, status: 16, prev: 16, amount: 12000, period: 12 },
      application: { id: 551007, status: 4, prev: 2 },
      offer: null, birthday: birthdayIn(45, 1991), lastYear: 0, lifetime: 2, banDays: 0, notificationActive: true,
    },
    // 7 CLI-0008 Елена Условная — IL закрытый, преапрув, notification_active=false
    {
      first: 'Елена', last: 'Условная', middle: 'Игоревна', email: 'elena.uslovnaya@example.com',
      tz: 'Europe/Moscow', consent: 'NONE', product: 'IL',
      agreement: { id: 101008, status: 19, prev: 17, amount: 45000, period: 365, closedAt: daysAgo(90) },
      application: { id: 551008, status: 4, prev: 1 },
      offer: { money: 15000, days: 14, start: daysAgo(1), expired: inDays(9), available: true },
      birthday: birthdayIn(150, 1988), lastYear: 1, lifetime: 3, banDays: 0, notificationActive: false,
    },
    // 8 CLI-0009 Александр Вымышленный — заявка отклонена (статус 9), ban 90
    {
      first: 'Александр', last: 'Вымышленный', middle: 'Борисович', email: 'alexandr.vymyshlenny@example.com',
      tz: 'Europe/Moscow', consent: 'NONE', product: 'PDL',
      agreement: null,
      application: { id: 551009, status: 9, prev: 4 },
      offer: null, birthday: birthdayIn(300, 1979), lastYear: 0, lifetime: 0, banDays: 90, notificationActive: true,
    },
    // 9 CLI-0010 Наталья Пробная — закрытый, преапрув недоступен
    {
      first: 'Наталья', last: 'Пробная', middle: 'Викторовна', email: 'natalya.probnaya@example.com',
      tz: 'Europe/Moscow', consent: 'NONE', product: 'PDL',
      agreement: { id: 101010, status: 19, prev: 16, amount: 8000, period: 7, closedAt: daysAgo(14) },
      application: { id: 551010, status: 4, prev: 1 },
      offer: { money: 12000, days: 10, start: daysAgo(10), expired: daysAgo(1), available: false },
      birthday: birthdayIn(75, 1995), lastYear: 1, lifetime: 1, banDays: 0, notificationActive: true,
    },
    // 10 CLI-0011 Виктор Трениров — пролонгированный, согласие отозвано
    {
      first: 'Виктор', last: 'Трениров', middle: 'Семёнович', email: 'viktor.trenirov@example.com',
      tz: 'Asia/Yekaterinburg', consent: 'REVOKED', product: 'PDL',
      agreement: { id: 101011, status: 17, prev: 16, amount: 27000, period: 24 },
      application: { id: 551011, status: 4, prev: 3 },
      offer: null, birthday: birthdayIn(250, 1984), lastYear: 0, lifetime: 4, banDays: 0, notificationActive: true,
    },
    // 11 CLI-0012 Людмила Пилот — закрытый, отписка (демо отписавшихся)
    {
      first: 'Людмила', last: 'Пилот', middle: 'Павловна', email: 'lyudmila.pilot@example.com',
      tz: 'Asia/Yekaterinburg', consent: 'REVOKED', product: 'PDL',
      agreement: { id: 101012, status: 19, prev: 16, amount: 11000, period: 14, closedAt: daysAgo(60) },
      application: { id: 551012, status: 4, prev: 2 },
      offer: null, birthday: birthdayIn(320, 1986), lastYear: 1, lifetime: 2, banDays: 0, notificationActive: false,
      unsubscribed: true,
    },
  ];

  const clients: Client[] = [];
  for (let i = 0; i < clientSeeds.length; i++) {
    const s = clientSeeds[i];
    const fullName = [s.last, s.first, s.middle].join(' ');
    clients.push(
      await db.client.create({
        data: {
          externalId: `CLI-${String(i + 1).padStart(4, '0')}`,
          phone: `+790000000${String(i + 1).padStart(2, '0')}`,
          timezone: s.tz,
          // Легаси-данные: name (полное ФИО) — чтобы старые шаблоны с {{name}} работали
          data: JSON.stringify({
            name: fullName,
            loan_number: `LN-${String(i + 1).padStart(4, '0')}`,
            loan_amount: s.agreement ? s.agreement.amount : randInt(8000, 45000),
            overdue_days: randInt(0, 12),
          }),
          smsConsentStatus: s.consent,
          smsConsentSource: s.consentSource ?? null,
          smsConsentAt: s.consent === 'GRANTED' ? daysAgo(30) : null,
          ...(s.unsubscribed ? { unsubscribedAt: daysAgo(1) } : {}),
          // Карточка клиента (П1)
          firstName: s.first,
          lastName: s.last,
          middleName: s.middle,
          email: s.email,
          applicationId: s.application.id,
          applicationStatus: s.application.status,
          applicationPrevStatus: s.application.prev,
          agreementId: s.agreement ? s.agreement.id : null,
          agreementStatus: s.agreement ? s.agreement.status : null,
          agreementPrevStatus: s.agreement ? s.agreement.prev : null,
          loanAmount: s.agreement ? s.agreement.amount : null,
          loanPeriod: s.agreement ? s.agreement.period : null,
          loanClosedAt: s.agreement?.closedAt ?? null,
          notificationActive: s.notificationActive,
          offerDateStart: s.offer ? s.offer.start : null,
          offerDateExpired: s.offer ? s.offer.expired : null,
          offerApproveMoney: s.offer ? s.offer.money : null,
          offerApproveDays: s.offer ? s.offer.days : null,
          offerAvailable: s.offer ? s.offer.available : null,
          birthday: s.birthday,
          lastProductType: s.product,
          agreementsLastYear: s.lastYear,
          agreementsLifetime: s.lifetime,
          banDays: s.banDays,
          profileUpdatedAt: daysAgo(randInt(0, 2)),
        },
      }),
    );
  }

  // ---------- 4. Шаблоны (новый синтаксис — условия/дефолты/фильтры/варианты) ----------
  // База языка шаблонов: только подстановка переменных карточки ({{var}}) — без фильтров и условий.
  const tReminder = await db.smsTemplate.create({
    data: {
      name: 'Напоминание о платеже',
      body: 'Уважаемый(ая) {{client_first_name}}! Платёж по займу {{loan_number}} — до {{due_date}}. ДемоКомпания',
      isMarketing: false,
      description: 'Сервисное: напоминание о плановом платеже (воронка «Напоминание до платежа»)',
      maxSegments: 2,
    },
  });
  // Цепочка фильтров |default → |ucfirst: имени нет/пустое — подставляем «клиент» и капитализируем.
  const tOverdue1 = await db.smsTemplate.create({
    data: {
      name: 'Просрочка D+1',
      body: '{{client_first_name|default:клиент|ucfirst}}, платёж по займу {{loan_number}} просрочен на {{overdue_days}} дн. Просим погасить задолженность. ДемоКомпания',
      isMarketing: false,
      description: 'Сервисное: мягкое напоминание на первый день просрочки',
      maxSegments: 2,
    },
  });
  // Условный блок {{#if overdue_days >= 5}}/{{#else}}/{{#end}}: тон сообщения зависит от глубины просрочки.
  const tOverdue5 = await db.smsTemplate.create({
    data: {
      name: 'Просрочка D+5',
      body: '{{#if overdue_days >= 5}}{{client_first_name}}! Задолженность {{overdue_days}} дней — срочно погасите, иначе возможны штрафы и передача на взыскание.{{#else}}{{client_first_name}}, не затягивайте с погашением — долг растёт.{{#end}} ДемоКомпания',
      isMarketing: false,
      description: 'Сервисное: жёсткий тон при глубокой просрочке ({{#if}} по числу дней)',
      maxSegments: 2,
    },
  });
  // Фильтр |number: сумма с разрядами (25000 → «25 000») — без групп цифры в SMS читаются плохо.
  const tPayment = await db.smsTemplate.create({
    data: {
      name: 'Платёж получен',
      body: '{{client_first_name}}, платёж {{payment_amount|number}} руб. по займу {{loan_number}} получен. Спасибо! ДемоКомпания',
      isMarketing: false,
      description: 'Сервисное: подтверждение платежа (фильтр |number — разряды)',
      maxSegments: 2,
    },
  });
  // Плоская подстановка переменных; финальное SMS ветки onEvent воронки «Преапрув: ждём заявку».
  const tAppApproved = await db.smsTemplate.create({
    data: {
      name: 'Заявка одобрена',
      body: '{{client_first_name}}, ваша заявка одобрена! Деньги будут зачислены в течение часа. ДемоКомпания',
      isMarketing: false,
      description: 'Сервисное: финал воронки «Преапрув: ждём заявку» (waitEvent APPLICATION_APPROVED)',
      maxSegments: 2,
    },
  });
  // Варианты {{#variant}}/{{#or}}/{{#end}} — случайный выбор из 3 текстов против «приедания» поздравлений.
  const tBirthday = await db.smsTemplate.create({
    data: {
      name: 'С Днём рождения',
      body: '{{client_first_name|default:клиент|ucfirst}}, с Днём рождения! {{#variant}}Подарок — промо-код {{promo_code|default:HBD26}} на новый заём.{{#or}}В честь праздника дарим промо-код {{promo_code|default:HBD26}}.{{#or}}Празднуйте с выгодой: промо-код {{promo_code|default:HBD26}}.{{#end}} ДемоКомпания',
      isMarketing: true,
      description: 'Маркетинговое: 3 варианта текста ({{#variant}}) — «крутилка» против приедания',
      senderName: 'DemoBrand',
      maxSegments: 4,
    },
  });
  // Комбо: {{#if}} по числовой переменной карточки (лояльность) + фильтр |money (сумма).
  const tOffer = await db.smsTemplate.create({
    data: {
      name: 'Предложение нового займа',
      body: '{{#if agreements_for_lifetime >= 3}}{{client_first_name}}, как постоянному клиенту —{{#else}}{{client_first_name|default:клиент|ucfirst}}, вам —{{#end}} заём до {{person_offer_approve_money|money}} на {{person_offer_approve_days}} дней! Оформите за 5 минут. ДемоКомпания',
      isMarketing: true,
      description: 'Маркетинговое: повторный заём; лояльным (3+ закрытых договоров) — свой тон ({{#if}} + |money)',
      senderName: 'DemoBrand',
      maxSegments: 4,
    },
  });
  // {{#cancel}} в пустой ветке {{#if}}: имени в карточке нет — SMS не отправляется вовсе (узел гасится),
  // плюс фильтры |money/|date.
  const tPreapprove = await db.smsTemplate.create({
    data: {
      name: 'Преапрув',
      body: '{{#if client_first_name}}{{client_first_name}}, вам одобрен заём {{person_offer_approve_money|money}} на {{person_offer_approve_days}} дней до {{person_offer_date_expired|date}}.{{#else}}{{#cancel}}{{#end}} Оформите за 5 минут на сайте. ДемоКомпания',
      isMarketing: true,
      description: 'Маркетинговое: без имени в карточке — не отправляем вовсе ({{#cancel}}), фильтры |money/|date',
      senderName: 'DemoBrand',
      maxSegments: 4,
    },
  });
  // Ветвление по наличию значения (даты) + фильтр |date: ISO-поле карточки → человеческая дата.
  const tLoyal = await db.smsTemplate.create({
    data: {
      name: 'Преапрув: финальное напоминание',
      body: '{{#if person_offer_date_expired}}Последний шанс: заём {{person_offer_approve_money|money}} доступен до {{person_offer_date_expired|date}}.{{#else}}Заём {{person_offer_approve_money|money}} ждёт вас на сайте.{{#end}} ДемоКомпания',
      isMarketing: true,
      description: 'Маркетинговое: конец действия преапрува (рассылка «Финальное напоминание»); даты фильтром |date',
      senderName: 'DemoBrand',
      maxSegments: 4,
    },
  });

  // ---------- 5. Воронки (все активны; 4-я — PREAPPROVE_ISSUED, П2) ----------
  // Сценарий: LOAN_OVERDUE → мягкое SMS (D+1) → сутки тишины → condition «долг вырос?»:
  // да → жёсткое SMS (D+5), нет → стоп (onFalse=null). Демонстрирует condition-узел посреди цепочки.
  const funnelOverdue = await db.funnel.create({
    data: {
      name: 'Просрочка: мягкое взыскание',
      triggerEvent: 'LOAN_OVERDUE',
      isActive: true,
      definition: JSON.stringify({
        start_node: 'n1',
        nodes: [
          { id: 'n1', type: 'sms', name: 'SMS: просрочка D+1', templateId: tOverdue1.id, next: 'n2' },
          { id: 'n2', type: 'delay', name: 'Сутки ожидания', hours: 24, minutes: 0, next: 'n3' },
          {
            id: 'n3',
            type: 'condition',
            name: 'Просрочка выросла?',
            expression: 'payload.overdue_days >= 5',
            onTrue: 'n4',
            onFalse: null,
          },
          { id: 'n4', type: 'sms', name: 'SMS: просрочка D+5', templateId: tOverdue5.id, next: null },
        ],
      }),
      description: 'D+1 напоминание → сутки → при просрочке ≥5 дней строгий тон',
    },
  });
  // Сценарий: PAYMENT_DUE_SOON → одно сервисное SMS до даты платежа. Минимальная воронка «один узел».
  const funnelReminder = await db.funnel.create({
    data: {
      name: 'Напоминание о платеже',
      triggerEvent: 'PAYMENT_DUE_SOON',
      isActive: true,
      definition: JSON.stringify({
        start_node: 'n1',
        nodes: [
          { id: 'n1', type: 'sms', name: 'SMS: напоминание', templateId: tReminder.id, next: null },
        ],
      }),
      description: 'Одно информационное SMS до даты платежа',
    },
  });
  // Сценарий: BIRTHDAY → поздравление с промо-кодом; маркетинговое — гейт согласия применяется движком.
  const funnelBirthday = await db.funnel.create({
    data: {
      name: 'День рождения',
      triggerEvent: 'BIRTHDAY',
      isActive: true,
      definition: JSON.stringify({
        start_node: 'n1',
        nodes: [
          { id: 'n1', type: 'sms', name: 'SMS: поздравление', templateId: tBirthday.id, next: null },
        ],
      }),
      description: 'Поздравление с промо-кодом (маркетинг, только с согласием)',
    },
  });
  // Сценарий (П2): PREAPPROVE_ISSUED → condition по переменной карточки person_offer_available:
  // доступен → SMS с суммой/сроком; нет → завершение без отправки.
  const funnelPreapprove = await db.funnel.create({
    data: {
      name: 'Преапрув выдан',
      triggerEvent: 'PREAPPROVE_ISSUED',
      isActive: true,
      definition: JSON.stringify({
        start_node: 'n1',
        nodes: [
          {
            id: 'n1',
            type: 'condition',
            name: 'Преапрув доступен?',
            // Голое имя — переменная карточки клиента (видна условиям как в шаблонах)
            expression: 'person_offer_available',
            onTrue: 'n2',
            onFalse: null,
          },
          { id: 'n2', type: 'sms', name: 'SMS: преапрув', templateId: tPreapprove.id, next: null },
        ],
      }),
      description: 'При выдаче преапрува: доступен → SMS с суммой и сроком (маркетинг)',
    },
  });
  // Воронка с waitEvent («ждать заявку 3 дня») и абсолютной паузой («до 10:00»).
  // Сценарий: PREAPPROVE_ISSUED → SMS → до 72 ч ждём APPLICATION_APPROVED: заявка →
  // подтверждение; тишина → пауза до 10:00 → повторное предложение (tOffer).
  const funnelWait = await db.funnel.create({
    data: {
      name: 'Преапрув: ждём заявку',
      triggerEvent: 'PREAPPROVE_ISSUED',
      isActive: true,
      definition: JSON.stringify({
        start_node: 'n1',
        nodes: [
          { id: 'n1', type: 'sms', name: 'SMS: преапрув', templateId: tPreapprove.id, next: 'n2' },
          {
            id: 'n2',
            type: 'waitEvent',
            name: 'Ждём заявку 3 дня',
            event: 'APPLICATION_APPROVED',
            timeoutHours: 72,
            timeoutMinutes: 0,
            onEvent: 'n3',
            onTimeout: 'n5',
          },
          { id: 'n3', type: 'sms', name: 'SMS: заявка одобрена', templateId: tAppApproved.id, next: null },
          {
            id: 'n5',
            type: 'delay',
            name: 'До 10:00 следующего дня',
            hours: 0,
            minutes: 0,
            mode: 'until_time',
            atHour: 10,
            atMinute: 0,
            next: 'n6',
          },
          { id: 'n6', type: 'sms', name: 'SMS: не упустите преапрув', templateId: tOffer.id, next: null },
        ],
      }),
      entryMode: 'SKIP_ACTIVE',
      description:
        'SMS о преапруве → ждём одобрение заявки до 3 дней: заявка → сервисное подтверждение; тишина → утром в 10:00 напоминание (по местному времени клиента)',
    },
  });

  // ---------- 6. События inbox (все PROCESSED — без side-effects воркера при старте) ----------
  const evOverdue2 = await db.eventsInbox.create({
    data: {
      event: 'LOAN_OVERDUE',
      externalId: clients[1].externalId,
      payload: JSON.stringify({ overdue_days: 3, loan_number: 'LN-0002' }),
      idempotencyKey: 'seed-ev-0001',
      status: 'PROCESSED',
      result: JSON.stringify({ instances: [{ funnelId: funnelOverdue.id, instanceId: 'seed' }] }),
      source: 'API',
      ip: '10.0.0.10',
      baseUrl: 'http://localhost:3000',
      createdAt: daysAgo(6, 9),
    },
  });
  const evReminder7 = await db.eventsInbox.create({
    data: {
      event: 'PAYMENT_DUE_SOON',
      externalId: clients[6].externalId,
      payload: JSON.stringify({ due_date: '05.03.2025', loan_number: 'LN-0007' }),
      idempotencyKey: 'seed-ev-0002',
      status: 'PROCESSED',
      result: JSON.stringify({ instances: [{ funnelId: funnelReminder.id, instanceId: 'seed' }] }),
      source: 'PANEL',
      ip: '10.0.0.5',
      baseUrl: 'http://localhost:3000',
      createdAt: daysAgo(3, 10),
    },
  });
  const evOverdue4 = await db.eventsInbox.create({
    data: {
      event: 'LOAN_OVERDUE',
      externalId: clients[3].externalId,
      payload: JSON.stringify({ overdue_days: 2, loan_number: 'LN-0004' }),
      idempotencyKey: 'seed-ev-0003',
      status: 'PROCESSED',
      result: JSON.stringify({ instances: [{ funnelId: funnelOverdue.id, instanceId: 'seed' }] }),
      source: 'API',
      ip: '10.0.0.10',
      baseUrl: 'http://localhost:3000',
      createdAt: daysAgo(0, 10),
    },
  });
  const evBirthday12 = await db.eventsInbox.create({
    data: {
      event: 'BIRTHDAY',
      externalId: clients[11].externalId,
      payload: JSON.stringify({ promo_code: 'HBD2025' }),
      idempotencyKey: 'seed-ev-0004',
      status: 'PROCESSED',
      result: JSON.stringify({ instances: [{ funnelId: funnelBirthday.id, instanceId: 'seed' }] }),
      source: 'API',
      ip: '10.0.0.10',
      baseUrl: 'http://localhost:3000',
      createdAt: daysAgo(1, 8),
    },
  });
  await db.eventsInbox.create({
    data: {
      event: 'LOAN_OVERDUE',
      externalId: 'GHOST-404',
      payload: JSON.stringify({ overdue_days: 1 }),
      idempotencyKey: 'seed-ev-0005',
      status: 'PROCESSED',
      result: JSON.stringify({ clientNotFound: true }),
      source: 'API',
      ip: '10.0.0.10',
      baseUrl: 'http://localhost:3000',
      createdAt: daysAgo(2, 11),
    },
  });
  // Упавшее событие — демонстрация ретрая (кнопка «Повторить» в журнале).
  // История: на момент падения была активна воронка на LOAN_CLOSED, чей шаблон
  // требовал {{closed_date}}, которой не было в payload. Воронку починили —
  // ретрай обработает событие заново без side-эффектов (клиент существует,
  // активных воронок на LOAN_CLOSED нет → PROCESSED, funnelsFound: 0).
  await db.eventsInbox.create({
    data: {
      event: 'LOAN_CLOSED',
      externalId: clients[2].externalId,
      payload: JSON.stringify({ loan_number: 'LN-0003', agreement_id: 101003 }),
      idempotencyKey: 'seed-ev-failed-1',
      status: 'FAILED',
      error: 'Рендер шаблона: Не заполнена переменная: {{closed_date}}',
      source: 'API',
      ip: '10.0.0.10',
      baseUrl: 'http://localhost:3000',
      createdAt: daysAgo(1, 16),
    },
  });
  await db.eventsInbox.create({
    data: {
      event: 'PAYMENT_RECEIVED',
      externalId: clients[2].externalId,
      payload: JSON.stringify({ payment_amount: '12500' }),
      idempotencyKey: 'seed-ev-0006',
      status: 'PROCESSED',
      result: JSON.stringify({ funnelsFound: 0 }),
      source: 'PANEL',
      ip: '10.0.0.5',
      baseUrl: 'http://localhost:3000',
      createdAt: daysAgo(4, 15),
    },
  });
  // Событие с client_card — обновляет карточку И запускает воронки
  await db.eventsInbox.create({
    data: {
      event: 'APPLICATION_APPROVED',
      externalId: clients[4].externalId,
      payload: JSON.stringify({
        client_card: {
          client_first_name: 'Сергей',
          client_last_name: 'Макет',
          client_middle_name: 'Олегович',
          email: 'sergey.maket@example.com',
          phone: '+79000000050',
          application_id: 551005,
          application_actual_status: 4,
          application_previous_status: 2,
          agreement_id: 101005,
          agreement_actual_status: 19,
          agreement_previous_status: 17,
          loan_amount: 21000,
          loan_period: 21,
          last_product_type: 'PDL',
          person_offer_approve_money: 30000,
          person_offer_approve_days: 30,
          person_offer_available: true,
        },
      }),
      idempotencyKey: 'seed-ev-0007',
      status: 'PROCESSED',
      result: JSON.stringify({ clientUpdated: true, funnelsFound: 0 }),
      source: 'API',
      ip: '10.0.0.10',
      baseUrl: 'http://localhost:3000',
      createdAt: daysAgo(1, 14),
    },
  });
  const evPreapprove5 = await db.eventsInbox.create({
    data: {
      event: 'PREAPPROVE_ISSUED',
      externalId: clients[4].externalId,
      payload: JSON.stringify({
        client_card: {
          client_first_name: 'Сергей',
          client_last_name: 'Макет',
          phone: '+79000000050',
          timezone: 'Asia/Novosibirsk',
          person_offer_approve_money: 30000,
          person_offer_approve_days: 30,
          person_offer_date_start: daysAgo(5).toISOString(),
          person_offer_date_expired: inDays(6).toISOString(),
          person_offer_available: true,
          last_product_type: 'PDL',
          date_update: daysAgo(0).toISOString(),
        },
      }),
      idempotencyKey: 'seed-ev-0008',
      status: 'PROCESSED',
      result: JSON.stringify({
        clientUpdated: true,
        instances: [{ funnelId: funnelPreapprove.id, instanceId: 'seed' }],
      }),
      source: 'API',
      ip: '10.0.0.10',
      baseUrl: 'http://localhost:3000',
      createdAt: daysAgo(0, 11),
    },
  });

  // ---------- 7. Экземпляры воронок ----------
  async function addTimeline(
    instanceId: string,
    events: Array<{ type: string; nodeId?: string; nodeType?: string; message?: string; at: Date }>,
  ): Promise<void> {
    let seq = 0;
    for (const e of events) {
      seq += 1;
      await db.instanceEvent.create({
        data: {
          instanceId,
          type: e.type,
          nodeId: e.nodeId ?? null,
          nodeType: e.nodeType ?? null,
          message: e.message ?? null,
          createdAt: new Date(e.at.getTime() + seq * 1000),
        },
      });
    }
  }

  /** Контекст экземпляра в форме движка (карточка клиента + data + payload). */
  function buildContext(
    clientIdx: number,
    event: string,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const c = clients[clientIdx];
    const data = JSON.parse(c.data) as Record<string, unknown>;
    const dOnly = (d: Date | null): string | null =>
      d ? `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}` : null;
    const cardVars: Record<string, unknown> = {};
    const put = (k: string, v: unknown): void => {
      if (v !== null && v !== undefined) cardVars[k] = v;
    };
    put('client_first_name', c.firstName);
    put('client_last_name', c.lastName);
    put('agreement_actual_status', c.agreementStatus);
    put('loan_amount', c.loanAmount);
    put('person_offer_approve_money', c.offerApproveMoney);
    put('person_offer_approve_days', c.offerApproveDays);
    put('person_offer_available', c.offerAvailable);
    put('person_offer_date_expired', dOnly(c.offerDateExpired));
    put('last_product_type', c.lastProductType);
    return {
      event,
      payload,
      client: {
        externalId: c.externalId,
        phone: c.phone,
        timezone: c.timezone,
        data,
        ...cardVars,
      },
      vars: { ...cardVars, ...data, ...payload },
      baseUrl: 'http://localhost:3000',
    };
  }

  // 7.1 COMPLETED: напоминание о платеже (клиент 7, 3 дня назад)
  const instA = await db.workflowInstance.create({
    data: {
      funnelId: funnelReminder.id,
      funnelVersion: 1,
      funnelName: funnelReminder.name,
      clientId: clients[6].id,
      currentNodeId: 'n1',
      status: 'COMPLETED',
      context: JSON.stringify(
        buildContext(6, 'PAYMENT_DUE_SOON', { due_date: '05.03.2025', loan_number: 'LN-0007' }),
      ),
      eventId: evReminder7.id,
      idempotencyKey: 'seed-ev-0002',
      createdAt: daysAgo(3, 10),
    },
  });
  await addTimeline(instA.id, [
    { type: 'STATUS_CHANGE', message: 'RUNNING', at: daysAgo(3, 10) },
    { type: 'NODE_START', nodeId: 'n1', nodeType: 'sms', message: 'SMS: напоминание', at: daysAgo(3, 10) },
    { type: 'NODE_DONE', nodeId: 'n1', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(3, 10) },
    { type: 'SMS_SENT', nodeId: 'n1', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(3, 10) },
    { type: 'STATUS_CHANGE', message: 'COMPLETED', at: daysAgo(3, 10) },
  ]);

  // 7.2 COMPLETED: просрочка с условием (клиент 2, 6 дней назад — D+1, пауза, условие false)
  const instB = await db.workflowInstance.create({
    data: {
      funnelId: funnelOverdue.id,
      funnelVersion: 1,
      funnelName: funnelOverdue.name,
      clientId: clients[1].id,
      currentNodeId: 'n3',
      status: 'COMPLETED',
      context: JSON.stringify(
        buildContext(1, 'LOAN_OVERDUE', { overdue_days: 3, loan_number: 'LN-0002' }),
      ),
      eventId: evOverdue2.id,
      idempotencyKey: 'seed-ev-0001',
      createdAt: daysAgo(6, 9),
    },
  });
  await addTimeline(instB.id, [
    { type: 'STATUS_CHANGE', message: 'RUNNING', at: daysAgo(6, 9) },
    { type: 'NODE_START', nodeId: 'n1', nodeType: 'sms', message: 'SMS: просрочка D+1', at: daysAgo(6, 9) },
    { type: 'NODE_DONE', nodeId: 'n1', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(6, 9) },
    { type: 'SMS_SENT', nodeId: 'n1', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(6, 9) },
    { type: 'NODE_START', nodeId: 'n2', nodeType: 'delay', message: 'Сутки ожидания', at: daysAgo(6, 9) },
    { type: 'NODE_DONE', nodeId: 'n2', nodeType: 'delay', message: 'Задержка до 06.02.2025 10:00', at: daysAgo(6, 9) },
    { type: 'STATUS_CHANGE', message: 'WAITING', at: daysAgo(6, 9) },
    { type: 'STATUS_CHANGE', message: 'RUNNING', at: daysAgo(5, 9) },
    { type: 'NODE_START', nodeId: 'n3', nodeType: 'condition', message: 'Просрочка выросла?', at: daysAgo(5, 9) },
    { type: 'NODE_DONE', nodeId: 'n3', nodeType: 'condition', message: 'Условие: false → завершение', at: daysAgo(5, 9) },
    { type: 'STATUS_CHANGE', message: 'COMPLETED', at: daysAgo(5, 9) },
  ]);

  // 7.3 WAITING: просрочка в паузе (клиент 4, задача PENDING +2ч)
  const instC = await db.workflowInstance.create({
    data: {
      funnelId: funnelOverdue.id,
      funnelVersion: 1,
      funnelName: funnelOverdue.name,
      clientId: clients[3].id,
      currentNodeId: 'n2',
      status: 'WAITING',
      context: JSON.stringify(
        buildContext(3, 'LOAN_OVERDUE', { overdue_days: 2, loan_number: 'LN-0004' }),
      ),
      eventId: evOverdue4.id,
      idempotencyKey: 'seed-ev-0003',
      createdAt: daysAgo(0, 10),
    },
  });
  await addTimeline(instC.id, [
    { type: 'STATUS_CHANGE', message: 'RUNNING', at: daysAgo(0, 10) },
    { type: 'NODE_START', nodeId: 'n1', nodeType: 'sms', message: 'SMS: просрочка D+1', at: daysAgo(0, 10) },
    { type: 'NODE_DONE', nodeId: 'n1', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(0, 10) },
    { type: 'SMS_SENT', nodeId: 'n1', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(0, 10) },
    { type: 'NODE_START', nodeId: 'n2', nodeType: 'delay', message: 'Сутки ожидания', at: daysAgo(0, 10) },
    { type: 'NODE_DONE', nodeId: 'n2', nodeType: 'delay', message: 'Задержка до завтра', at: daysAgo(0, 10) },
    { type: 'STATUS_CHANGE', message: 'WAITING', at: daysAgo(0, 10) },
  ]);
  await db.scheduledJob.create({
    data: {
      instanceId: instC.id,
      nodeId: 'n3',
      reason: 'NODE_DELAY',
      runAt: new Date(Date.now() + 2 * 3600_000),
      status: 'PENDING',
      createdAt: daysAgo(0, 10),
    },
  });

  // 7.4 CANCELLED: клиент 12 отписался во время паузы (вчера)
  const instD = await db.workflowInstance.create({
    data: {
      funnelId: funnelOverdue.id,
      funnelVersion: 1,
      funnelName: funnelOverdue.name,
      clientId: clients[11].id,
      currentNodeId: 'n2',
      status: 'CANCELLED',
      context: JSON.stringify(
        buildContext(11, 'LOAN_OVERDUE', { overdue_days: 7, loan_number: 'LN-0012' }),
      ),
      eventId: evBirthday12.id,
      idempotencyKey: 'seed-ev-0004',
      createdAt: daysAgo(1, 8),
    },
  });
  await addTimeline(instD.id, [
    { type: 'STATUS_CHANGE', message: 'RUNNING', at: daysAgo(1, 8) },
    { type: 'NODE_START', nodeId: 'n1', nodeType: 'sms', message: 'SMS: просрочка D+1', at: daysAgo(1, 8) },
    { type: 'NODE_DONE', nodeId: 'n1', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(1, 8) },
    { type: 'SMS_SENT', nodeId: 'n1', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(1, 8) },
    { type: 'NODE_START', nodeId: 'n2', nodeType: 'delay', message: 'Сутки ожидания', at: daysAgo(1, 8) },
    { type: 'NODE_DONE', nodeId: 'n2', nodeType: 'delay', message: 'Задержка до завтра', at: daysAgo(1, 8) },
    { type: 'STATUS_CHANGE', message: 'WAITING', at: daysAgo(1, 8) },
    { type: 'INFO', message: 'Отменено: клиент отписался', at: daysAgo(1, 12) },
    { type: 'STATUS_CHANGE', message: 'CANCELLED', at: daysAgo(1, 12) },
  ]);
  await db.scheduledJob.create({
    data: {
      instanceId: instD.id,
      nodeId: 'n3',
      reason: 'NODE_DELAY',
      runAt: new Date(Date.now() - 3600_000),
      status: 'CANCELLED',
      createdAt: daysAgo(1, 8),
    },
  });

  // 7.5 COMPLETED: преапрув (клиент 5, сегодня — событие с карточкой запустило воронку)
  const instE = await db.workflowInstance.create({
    data: {
      funnelId: funnelPreapprove.id,
      funnelVersion: 1,
      funnelName: funnelPreapprove.name,
      clientId: clients[4].id,
      currentNodeId: 'n2',
      status: 'COMPLETED',
      context: JSON.stringify(
        buildContext(4, 'PREAPPROVE_ISSUED', {
          client_card: {
            client_first_name: 'Сергей',
            person_offer_approve_money: 30000,
            person_offer_approve_days: 30,
            person_offer_available: true,
          },
        }),
      ),
      eventId: evPreapprove5.id,
      idempotencyKey: 'seed-ev-0008',
      createdAt: daysAgo(0, 11),
    },
  });
  await addTimeline(instE.id, [
    { type: 'STATUS_CHANGE', message: 'RUNNING', at: daysAgo(0, 11) },
    { type: 'NODE_START', nodeId: 'n1', nodeType: 'condition', message: 'Преапрув доступен?', at: daysAgo(0, 11) },
    { type: 'NODE_DONE', nodeId: 'n1', nodeType: 'condition', message: 'Условие: true → n2', at: daysAgo(0, 11) },
    { type: 'NODE_START', nodeId: 'n2', nodeType: 'sms', message: 'SMS: преапрув', at: daysAgo(0, 11) },
    { type: 'NODE_DONE', nodeId: 'n2', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(0, 11) },
    { type: 'SMS_SENT', nodeId: 'n2', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(0, 11) },
    { type: 'STATUS_CHANGE', message: 'COMPLETED', at: daysAgo(0, 11) },
  ]);

  // ---------- 7.6 WAITING на waitEvent-узле (П5): Анна ждёт одобрение заявки ----------
  const evPreapprove3 = await db.eventsInbox.create({
    data: {
      event: 'PREAPPROVE_ISSUED',
      externalId: clients[3].externalId,
      payload: JSON.stringify({
        client_card: {
          client_first_name: 'Анна',
          person_offer_approve_money: 18000,
          person_offer_approve_days: 14,
          person_offer_available: true,
        },
      }),
      idempotencyKey: 'seed-ev-0009',
      status: 'PROCESSED',
      result: JSON.stringify({
        clientUpdated: true,
        instances: [{ funnelId: funnelPreapprove.id, instanceId: 'seed-completed' }],
      }),
      source: 'API',
      ip: '10.0.0.10',
      baseUrl: 'http://localhost:3000',
      createdAt: daysAgo(2, 7),
    },
  });
  const instF = await db.workflowInstance.create({
    data: {
      funnelId: funnelWait.id,
      funnelVersion: 1,
      funnelName: funnelWait.name,
      clientId: clients[3].id,
      currentNodeId: 'n2',
      status: 'WAITING',
      context: JSON.stringify({
        ...buildContext(3, 'PREAPPROVE_ISSUED', {
          client_card: {
            client_first_name: 'Анна',
            person_offer_approve_money: 18000,
            person_offer_approve_days: 14,
            person_offer_available: true,
          },
        }),
        waitEvent: { event: 'APPLICATION_APPROVED', nodeId: 'n2' },
      }),
      eventId: evPreapprove3.id,
      idempotencyKey: 'seed-ev-0009',
      createdAt: daysAgo(2, 7),
    },
  });
  await addTimeline(instF.id, [
    { type: 'STATUS_CHANGE', message: 'RUNNING', at: daysAgo(2, 7) },
    { type: 'NODE_START', nodeId: 'n1', nodeType: 'sms', message: 'SMS: преапрув', at: daysAgo(2, 7) },
    { type: 'NODE_DONE', nodeId: 'n1', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(2, 7) },
    { type: 'SMS_SENT', nodeId: 'n1', nodeType: 'sms', message: 'SMS отправлено', at: daysAgo(2, 7) },
    {
      type: 'NODE_START',
      nodeId: 'n2',
      nodeType: 'waitEvent',
      message: 'Ждём заявку 3 дня',
      at: daysAgo(2, 7),
    },
    {
      type: 'NODE_DONE',
      nodeId: 'n2',
      nodeType: 'waitEvent',
      message: 'Ожидание события APPLICATION_APPROVED (таймаут 72 ч)',
      at: daysAgo(2, 7),
    },
    { type: 'STATUS_CHANGE', message: 'WAITING', at: daysAgo(2, 7) },
  ]);
  // Таймаут-задача: старт 2 дня назад + 72 ч = завтра
  await db.scheduledJob.create({
    data: {
      instanceId: instF.id,
      nodeId: 'n2',
      reason: 'WAIT_EVENT',
      runAt: new Date(Date.now() + 24 * 3600_000),
      status: 'PENDING',
      createdAt: daysAgo(2, 7),
    },
  });

  // ---------- 8. Список отписавшихся ----------
  await db.unsubscribeList.create({
    data: {
      phone: clients[11].phone,
      source: 'LINK',
      clientId: clients[11].id,
      createdAt: daysAgo(1, 12),
    },
  });
  await db.unsubscribeList.create({
    data: {
      phone: '+79009990000',
      source: 'MANUAL',
      createdAt: daysAgo(5, 14),
    },
  });

  // ---------- 8а. Сегменты (П3) ----------
  // Условия под именами полей карточки — как в конструкторе панели.
  const segSegments: Array<{
    name: string;
    description: string;
    conditions: unknown;
  }> = [
    {
      name: 'Действующие договоры PDL',
      description: 'Займы до зарплаты в статусе «действующий» — база для сервисных и мягких рекламных сценариев',
      conditions: {
        match: 'all',
        rules: [
          { field: 'agreement_actual_status', op: 'eq', value: 16 },
          { field: 'last_product_type', op: 'eq', value: 'PDL' },
        ],
      },
    },
    {
      name: 'Преапрув истекает в течение 2 недель',
      description: 'Доступный преапрув скоро сгорит — кандидаты для догоняющей кампании',
      conditions: {
        match: 'all',
        rules: [
          { field: 'person_offer_available', op: 'eq', value: true },
          { field: 'person_offer_date_expired', op: 'within_next_days', value: 14 },
        ],
      },
    },
    {
      name: 'Лояльные — закрытые договоры',
      description: 'Закрытый договор и ≥3 закрытых договоров за всё время — тёплая аудитория повторных займов',
      conditions: {
        match: 'all',
        rules: [
          { field: 'agreement_actual_status', op: 'eq', value: 19 },
          { field: 'agreements_for_lifetime', op: 'gte', value: 3 },
        ],
      },
    },
    {
      name: 'ДР в ближайшие 2 недели + есть согласие',
      description: 'Поздравления с днём рождения (сравнение по месяцу и дню, без года)',
      conditions: {
        match: 'all',
        rules: [
          { field: 'person_birthday', op: 'birthday_within_next_days', value: 14 },
          { field: 'sms_consent_status', op: 'eq', value: 'GRANTED' },
        ],
      },
    },
    {
      name: 'Реклама запрещена',
      description: 'Отписан или отключил рекламу в ядре — исключать из рекламных рассылок',
      conditions: {
        match: 'any',
        rules: [
          { field: 'unsubscribed', op: 'eq', value: true },
          { field: 'notification_active', op: 'eq', value: false },
        ],
      },
    },
  ];
  const segmentRows: Array<{ id: string; name: string }> = [];
  for (const s of segSegments) {
    const row = await db.segment.create({
      data: {
        name: s.name,
        description: s.description,
        conditions: JSON.stringify(s.conditions),
      },
    });
    segmentRows.push({ id: row.id, name: row.name });
  }

  // ---------- 9. История SMS (~140 строк за 14 дней) ----------
  // Рендер настоящим движком ({{#if}}/{{#variant}}/фильтры); незаполненные
  // обязательные переменные остаются как {{var}} — как в живом предпросмотре.
  function render(body: string, vars: Record<string, string>): string {
    const filled: Record<string, unknown> = { ...vars };
    for (const n of extractVariables(body)) {
      if (filled[n] === undefined || filled[n] === '') filled[n] = `\u0001${n}\u0001`;
    }
    try {
      const r = renderTemplate(body, filled);
      const text = r.cancelled ? body : r.text;
      return text.replace(/\u0001(.+?)\u0001/g, (_m, name: string) => `{{${name}}}`);
    } catch {
      return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => vars[k] ?? `{{${k}}}`);
    }
  }
  function fmtD(d: Date): string {
    return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
  }

  /** Переменные карточки клиента для истории SMS (карточка + легаси data). */
  function historyVars(clientIdx: number): Record<string, string> {
    const c = clients[clientIdx];
    const data = JSON.parse(c.data) as { name: string; loan_number: string };
    const vars: Record<string, string> = {
      name: data.name,
      client_first_name: c.firstName ?? data.name,
      client_last_name: c.lastName ?? '',
      loan_number: data.loan_number,
    };
    if (c.offerApproveMoney !== null) vars.person_offer_approve_money = String(c.offerApproveMoney);
    if (c.offerApproveDays !== null) vars.person_offer_approve_days = String(c.offerApproveDays);
    if (c.offerDateExpired) vars.person_offer_date_expired = fmtD(c.offerDateExpired);
    return vars;
  }

  const infoTemplates = [
    { name: tReminder.name, body: tReminder.body, vars: () => ({ due_date: '05.03.2025' }) },
    { name: tOverdue1.name, body: tOverdue1.body, vars: () => ({ overdue_days: String(randInt(1, 12)) }) },
    { name: tPayment.name, body: tPayment.body, vars: () => ({ payment_amount: String(randInt(1000, 30000)) }) },
  ];
  const marketingTemplates = [
    { name: tBirthday.name, body: tBirthday.body, vars: () => ({ promo_code: 'HBD2025' }) },
    { name: tOffer.name, body: tOffer.body, vars: () => ({}) },
    { name: tPreapprove.name, body: tPreapprove.body, vars: () => ({}) },
  ];
  // Отписка/notification_active=false блокируют только рекламу; сервисные идут всем
  const rejectReasons = ['UNSUBSCRIBED', 'ADVERT_OFF', 'NO_CONSENT', 'LIMIT_CLIENT', 'INVALID_PHONE'];
  const failErrors = [
    'Превышено число попыток отправки: шлюз провайдера недоступен (HTTP 503)',
    'Ошибка провайдера: шлюз отклонил запрос (код 202)',
  ];
  // Приписка с КОРОТКОЙ ссылкой отписки (код 7 симв. без похожих глифов)
  // вместо ~86-символьного HMAC-токена — экономия ~80 символов на SMS.
  const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  function fakeCode(): string {
    let code = '';
    for (let i = 0; i < 7; i++) code += CODE_CHARS[randInt(0, CODE_CHARS.length - 1)];
    return code;
  }
  const disclaimerWith = (code: string): string =>
    `Реклама. ДемоКомпания. Отказаться: http://localhost:3000/?u=${code}`;

  // ---------- 9.4а. Именные короткие ссылки ----------
  // Целевые URL — example.com (зарезервирован IANA для демо): клик из панели
  // реально открывает страницу Example Domain с UTM-хвостом в адресе.
  const namedLinkSpecs: Array<{
    name: string;
    url: string;
    utm: Record<string, string>;
    visits: number;
    ageDays: number;
  }> = [
    {
      name: 'Лендинг «Займ до зарплаты»',
      url: 'https://example.com/promo/zaimy',
      utm: { utm_source: 'sms', utm_medium: 'cpc', utm_campaign: 'zaimy_feb' },
      visits: 23,
      ageDays: 13,
    },
    {
      name: 'Акция «Зарплатный заём 0%»',
      url: 'https://example.com/promo/zarpay',
      utm: { utm_source: 'sms', utm_medium: 'banner', utm_campaign: 'zarpay_2026', utm_content: 'variant_a' },
      visits: 11,
      ageDays: 6,
    },
    {
      name: 'Калькулятор платежей',
      url: 'https://example.com/calc',
      utm: { utm_source: 'sms', utm_medium: 'tool' },
      visits: 0,
      ageDays: 2,
    },
  ];
  const namedLinkCode = new Map<string, string>(); // name → код (для истории SMS)
  const namedLinkRows: Array<{ id: string; visits: number; ageDays: number }> = [];
  for (const spec of namedLinkSpecs) {
    let code = fakeCode();
    while ([...namedLinkCode.values()].includes(code)) code = fakeCode();
    namedLinkCode.set(spec.name, code);
    const target = new URL(spec.url);
    for (const [k, v] of Object.entries(spec.utm)) target.searchParams.set(k, v);
    const row = await db.shortLink.create({
      data: {
        code,
        kind: 'LINK',
        token: null,
        name: spec.name,
        targetUrl: target.toString(),
        visits: spec.visits,
        lastVisitAt: spec.visits > 0 ? daysAgo(randInt(0, 1), randInt(9, 21)) : null,
        expiresAt: null,
        createdAt: daysAgo(spec.ageDays, 10),
      },
    });
    namedLinkRows.push({ id: row.id, visits: spec.visits, ageDays: spec.ageDays });
  }

  const HISTORY_COUNT = 140;
  for (let i = 0; i < HISTORY_COUNT; i++) {
    const daysBack = randInt(0, 13);
    const hour = randInt(8, 20);
    const minute = randInt(0, 59);
    const createdAt = daysAgo(daysBack, hour, minute);
    const clientIdx = randInt(0, clients.length - 1);
    const client = clients[clientIdx];
    // Реклама не уходит отписавшимся и выключившим рекламу (в логе видна причина),
    // сервисные сообщения доставляются всем.
    const adsBlocked =
      client.unsubscribedAt !== null || client.notificationActive === false;
    const marketingRejected = adsBlocked && rand() < 0.45;
    const isMarketingRow =
      !adsBlocked && client.smsConsentStatus === 'GRANTED' && rand() < 0.25;
    // Шаблоны преапрува/оффера отправляем только клиентам с преапрувом
    const hasOffer = client.offerApproveMoney !== null;
    const pool = isMarketingRow || marketingRejected
      ? hasOffer
        ? marketingTemplates
        : [marketingTemplates[0]]
      : infoTemplates;
    const tpl = pool[randInt(0, pool.length - 1)];
    const vars = { ...tpl.vars(), ...historyVars(clientIdx) };
    let body = render(tpl.body, vars);
    if (isMarketingRow && rand() < 0.8) {
      // у каждого SMS — свой персональный код ссылки (как в жизни)
      body = `${body} ${disclaimerWith(fakeCode())}`;
    }
    if (isMarketingRow && rand() < 0.5) {
      // Часть рекламных SMS ведёт на именную короткую ссылку (переходы считаются)
      const spec = namedLinkSpecs[randInt(0, namedLinkSpecs.length - 1)];
      const linkCode = namedLinkCode.get(spec.name);
      if (linkCode) {
        body = `${body} Подробнее: http://localhost:3000/r?c=${linkCode}`;
      }
    }

    const r = rand();
    let status: string;
    if (marketingRejected) status = 'REJECTED_BY_COMPLIANCE';
    else if (r < 0.7) status = 'DELIVERED';
    else if (r < 0.85) status = 'SENT';
    else if (r < 0.93) status = 'FAILED';
    else status = 'REJECTED_BY_COMPLIANCE';

    const sentAt = status === 'REJECTED_BY_COMPLIANCE' ? null : createdAt;
    const deliveredAt =
      status === 'DELIVERED' ? new Date(createdAt.getTime() + randInt(5, 120) * 1000) : null;
    const rejectReason = marketingRejected
      ? client.unsubscribedAt !== null
        ? 'UNSUBSCRIBED'
        : 'ADVERT_OFF'
      : status === 'REJECTED_BY_COMPLIANCE'
        ? rejectReasons[randInt(0, rejectReasons.length - 1)]
        : null;

    await db.smsMessage.create({
      data: {
        clientId: client.id,
        phone: client.phone,
        body,
        segments: body.length > 70 ? Math.ceil(body.length / 67) : 1,
        provider: 'sandbox',
        providerMessageId: status === 'SENT' || status === 'DELIVERED' ? `sbx-${crypto.randomUUID()}` : null,
        templateName: tpl.name,
        status,
        rejectReason,
        error: status === 'FAILED' ? failErrors[randInt(0, failErrors.length - 1)] : null,
        sentAt,
        deliveredAt,
        createdAt,
      },
    });
  }

  // ---------- 9.5. Короткие ссылки отписки (П7) ----------
  // Настоящие HMAC-токены: код из SMS-лога (сообщения ниже) открывает РЕАЛЬНУЮ
  // страницу отписки — /?u={код}. У части ссылок есть переходы (статистика в
  // настройках), одна — протухшая (срок 180 дней истёк).
  const shortLinkByClient = new Map<number, string>();
  const unsubLinkRows: Array<{ id: string; visits: number; ageDays: number }> = [];
  const shortLinkSpecs: Array<{
    clientIdx: number;
    visits: number;
    ageDays: number;
    expired?: boolean;
  }> = [
    { clientIdx: 1, visits: 3, ageDays: 3 }, // Мария — перешла по ссылке из рассылки
    { clientIdx: 3, visits: 1, ageDays: 3 }, // Анна
    { clientIdx: 4, visits: 0, ageDays: 3 }, // Сергей — не переходил
    { clientIdx: 7, visits: 2, ageDays: 12 }, // Елена
    { clientIdx: 2, visits: 4, ageDays: 8 }, // активный читатель SMS
    { clientIdx: 9, visits: 1, ageDays: 40, expired: true }, // протухшая ссылка
  ];
  for (const spec of shortLinkSpecs) {
    const client = clients[spec.clientIdx];
    // протухшая: токен выпущен 220 дней назад (TTL — 180)
    const issuedAt = spec.expired
      ? Date.now() - 220 * 24 * 3600 * 1000
      : daysAgo(spec.ageDays, 10).getTime();
    const token = generateUnsubscribeToken(client.id, issuedAt);
    let code = fakeCode();
    while ([...shortLinkByClient.values()].includes(code) || [...namedLinkCode.values()].includes(code)) {
      code = fakeCode();
    }
    shortLinkByClient.set(spec.clientIdx, code);
    const unsubRow = await db.shortLink.create({
      data: {
        code,
        kind: 'UNSUBSCRIBE',
        token,
        clientId: client.id,
        visits: spec.visits,
        lastVisitAt: spec.visits > 0 ? daysAgo(Math.max(0, spec.ageDays - 1), 21) : null,
        expiresAt: new Date(issuedAt + UNSUBSCRIBE_TOKEN_TTL_MS),
        createdAt: daysAgo(spec.ageDays, 10),
      },
    });
    unsubLinkRows.push({ id: unsubRow.id, visits: spec.visits, ageDays: spec.ageDays });
  }

  // ---------- 9.5а. Редирект-лог переходов ----------
  // По строке на переход: дашборд строит «Переходы по ссылкам» по дням и
  // различает именные ссылки (LINK) и отписочные (UNSUBSCRIBE).
  const visitRows: Array<{ linkId: string; kind: string; createdAt: Date }> = [];
  const spreadVisits = (rows: Array<{ id: string; visits: number; ageDays: number }>, kind: string): void => {
    for (const row of rows) {
      for (let v = 0; v < row.visits; v++) {
        visitRows.push({
          linkId: row.id,
          kind,
          createdAt: daysAgo(randInt(0, Math.min(13, Math.max(0, row.ageDays - 1))), randInt(8, 22)),
        });
      }
    }
  };
  spreadVisits(namedLinkRows, 'LINK');
  spreadVisits(unsubLinkRows, 'UNSUBSCRIBE');
  if (visitRows.length > 0) {
    await db.shortLinkVisit.createMany({ data: visitRows });
  }

  // SMS-преапрув из waitEvent-воронки (маркетинговое — с припиской и кодом Анны)
  const preapproveBody = `${render(tPreapprove.body, historyVars(3))} ${disclaimerWith(
    shortLinkByClient.get(3) ?? fakeCode(),
  )}`;
  await db.smsMessage.create({
    data: {
      instanceId: instF.id,
      clientId: clients[3].id,
      phone: clients[3].phone,
      body: preapproveBody,
      segments: preapproveBody.length > 70 ? Math.ceil(preapproveBody.length / 67) : 1,
      provider: 'sandbox',
      providerMessageId: `sbx-${crypto.randomUUID()}`,
      templateId: tPreapprove.id,
      templateName: tPreapprove.name,
      status: 'DELIVERED',
      sentAt: daysAgo(2, 7),
      deliveredAt: new Date(daysAgo(2, 7).getTime() + 30_000),
      createdAt: daysAgo(2, 7),
    },
  });

  // Сообщения, связанные с экземплярами (таймлайны выше)
  const instanceMessages: Array<{
    instanceId: string;
    clientId: string;
    phone: string;
    body: string;
    templateName: string;
    at: Date;
    delivered: boolean;
  }> = [
    {
      instanceId: instA.id,
      clientId: clients[6].id,
      phone: clients[6].phone,
      body: render(tReminder.body, {
        ...historyVars(6),
        due_date: '05.03.2025',
      }),
      templateName: tReminder.name,
      at: daysAgo(3, 10),
      delivered: true,
    },
    {
      instanceId: instB.id,
      clientId: clients[1].id,
      phone: clients[1].phone,
      body: render(tOverdue1.body, { ...historyVars(1), overdue_days: '3' }),
      templateName: tOverdue1.name,
      at: daysAgo(6, 9),
      delivered: true,
    },
    {
      instanceId: instC.id,
      clientId: clients[3].id,
      phone: clients[3].phone,
      body: render(tOverdue1.body, { ...historyVars(3), overdue_days: '2' }),
      templateName: tOverdue1.name,
      at: daysAgo(0, 10),
      delivered: true,
    },
    {
      instanceId: instD.id,
      clientId: clients[11].id,
      phone: clients[11].phone,
      body: render(tOverdue1.body, { ...historyVars(11), overdue_days: '7' }),
      templateName: tOverdue1.name,
      at: daysAgo(1, 8),
      delivered: true,
    },
    {
      instanceId: instE.id,
      clientId: clients[4].id,
      phone: clients[4].phone,
      body: render(tPreapprove.body, historyVars(4)),
      templateName: tPreapprove.name,
      at: daysAgo(0, 11),
      delivered: true,
    },
  ];
  for (const m of instanceMessages) {
    await db.smsMessage.create({
      data: {
        instanceId: m.instanceId,
        clientId: m.clientId,
        phone: m.phone,
        body: m.body,
        segments: m.body.length > 70 ? Math.ceil(m.body.length / 67) : 1,
        provider: 'sandbox',
        providerMessageId: `sbx-${crypto.randomUUID()}`,
        templateName: m.templateName,
        status: 'DELIVERED',
        sentAt: m.at,
        deliveredAt: new Date(m.at.getTime() + 30_000),
        createdAt: m.at,
      },
    });
  }

  // ---------- 10. Рассылки по сегментам (П4) ----------
  // Стеночное время триггера регулярных запусков — в самом раннем поясе РФ
  // (Europe/Kaliningrad, UTC+2, РФ без DST — фиксированного смещения достаточно).
  function nextWeekdayAt(from: Date, weekday: number, hour: number, minute: number): Date {
    const TZ = 2;
    const local = new Date(from.getTime() + TZ * 3600_000);
    const targetWd = weekday % 7; // 1..7 (Пн..Вс) → 0..6 (Вс..Сб)
    const diff = (targetWd - local.getUTCDay() + 7) % 7;
    const candidate = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + diff, hour, minute, 0),
    );
    const shifted =
      candidate.getTime() <= local.getTime()
        ? new Date(candidate.getTime() + 7 * 24 * 3600_000)
        : candidate;
    return new Date(shifted.getTime() - TZ * 3600_000);
  }
  const segByName = (n: string): string => {
    const found = segmentRows.find((s) => s.name === n);
    if (!found) throw new Error(`[seed] сегмент «${n}» не найден`);
    return found.id;
  };

  // 1) Завершённая разовая: финальное напоминание о преапруве (3 дня назад)
  const bcDone = await db.broadcast.create({
    data: {
      name: 'Финальное напоминание о преапруве',
      description: 'Разовая догоняющая кампания: преапрув сгорает в ближайшие дни',
      segmentId: segByName('Преапрув истекает в течение 2 недель'),
      templateId: tLoyal.id,
      kind: 'ONCE',
      runAt: daysAgo(3, 4),
      minDaysBetween: 7,
      maxRecipients: 1000,
      status: 'DONE',
      lastRunAt: daysAgo(3, 4),
      nextRunAt: null,
    },
  });
  const runDone = await db.broadcastRun.create({
    data: {
      broadcastId: bcDone.id,
      status: 'DONE',
      planned: 4,
      recipients: 4,
      skippedGuard: 0,
      cappedBy: 0,
      startedAt: daysAgo(3, 4),
      finishedAt: daysAgo(3, 4),
    },
  });
  // Сообщения запуска: Мария/Анна — доставлено, Сергей — отправлено,
  // Елена — отказ ADVERT_OFF (реклама отключена, согласия нет)
  const broadcastHistory: Array<{
    clientIdx: number;
    status: string;
    rejectReason: string | null;
    delivered: boolean;
  }> = [
    { clientIdx: 1, status: 'DELIVERED', rejectReason: null, delivered: true },
    { clientIdx: 3, status: 'DELIVERED', rejectReason: null, delivered: true },
    { clientIdx: 4, status: 'SENT', rejectReason: null, delivered: false },
    { clientIdx: 7, status: 'REJECTED_BY_COMPLIANCE', rejectReason: 'ADVERT_OFF', delivered: false },
  ];
  for (const h of broadcastHistory) {
    const c = clients[h.clientIdx];
    // приписка с НАСТОЯЩИМ персональным кодом — ссылка из лога работает
    const body = `${render(tLoyal.body, historyVars(h.clientIdx))} ${disclaimerWith(
      shortLinkByClient.get(h.clientIdx) ?? fakeCode(),
    )}`;
    const at = daysAgo(3, 4);
    await db.smsMessage.create({
      data: {
        clientId: c.id,
        phone: c.phone,
        body,
        segments: body.length > 70 ? Math.ceil(body.length / 67) : 1,
        provider: 'sandbox',
        providerMessageId: h.status === 'SENT' || h.status === 'DELIVERED' ? `sbx-${crypto.randomUUID()}` : null,
        templateId: tLoyal.id,
        templateName: tLoyal.name,
        status: h.status,
        rejectReason: h.rejectReason,
        sentAt: h.status === 'REJECTED_BY_COMPLIANCE' ? null : at,
        deliveredAt: h.delivered ? new Date(at.getTime() + 45_000) : null,
        broadcastId: bcDone.id,
        runId: runDone.id,
        scheduledFor: at,
        createdAt: at,
      },
    });
  }

  // 2) Активная регулярная: преапрув недели — каждый понедельник в 10:00
  await db.broadcast.create({
    data: {
      name: 'Преапрув недели',
      description: 'Каждый понедельник в 10:00 — всем с живым преапрувом (по местному времени клиента)',
      segmentId: segByName('Преапрув истекает в течение 2 недель'),
      templateId: tOffer.id,
      kind: 'RECURRING',
      weekday: 1,
      hour: 10,
      minute: 0,
      minDaysBetween: 7,
      maxRecipients: 1000,
      status: 'ACTIVE',
      nextRunAt: nextWeekdayAt(new Date(), 1, 10, 0),
    },
  });

  // 3) Регулярная на паузе: лояльным — повторный заём
  await db.broadcast.create({
    data: {
      name: 'Лояльным — повторный заём',
      description: 'Каждую среду в 12:00 — тёплой аудитории закрытых договоров; на паузе до согласования',
      segmentId: segByName('Лояльные — закрытые договоры'),
      templateId: tOffer.id,
      kind: 'RECURRING',
      weekday: 3,
      hour: 12,
      minute: 0,
      minDaysBetween: 14,
      maxRecipients: 500,
      status: 'PAUSED',
      nextRunAt: nextWeekdayAt(new Date(), 3, 12, 0),
    },
  });

  console.log('[seed] Синтетические данные созданы:');
  console.log(`  Пользователи: 1 admin (${admin.email}) + ${demoUsers.length} демо`);
  console.log('  Клиенты: 12 с ПОЛНЫМИ карточками клиента (заявки/договоры/преапрувы/ДР)');
  console.log('  Шаблоны: 9 (5 инфо + 4 маркетинг; условия/дефолты/фильтры/варианты, отправитель и лимит частей)');
  console.log('  Воронки: 5 активных (включая «Преапрув: ждём заявку» с waitEvent и паузой «до 10:00»)');
  console.log('  События inbox: 9 (8 PROCESSED, 1 FAILED — демонстрация ретрая; 2 с client_card)');
  console.log('  Экземпляры: 3 COMPLETED, 2 WAITING (задержка +2ч; ожидание заявки +24ч), 1 CANCELLED');
  console.log(`  SMS-история: ${HISTORY_COUNT + instanceMessages.length + 1} строк за 14 дней (+1 преапрув из waitEvent-воронки)`);
  console.log(
    `  Именные ссылки: ${namedLinkRows.length} шт · переходов ${visitRows.length} (редирект-лог)`,
  );
  console.log('  Отписки: 2 (LINK + MANUAL)');
  console.log('  Короткие ссылки: 6 (с переходами и одной протухшей — П7)');
  console.log(`  Сегменты: ${segSegments.length} (действующие PDL, преапрув 2 недели, лояльные, ДР, реклама запрещена)`);
  console.log('  Рассылки: 3 (разовая завершённая с историей, активная еженедельная, регулярная на паузе)');
}

main()
  .catch((e) => {
    console.error('[seed] Ошибка:', e);
    process.exit(1);
  })
  .finally(() => {
    void db.$disconnect();
  });
