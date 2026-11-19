// Расширение ДЕМО-данных dev-песочницы в 20 раз (Task 32).
//
// ЗАЧЕМ: живая демонстрация панели на объёме, приближенном к реальной работе
// компании — сотни клиентов, тысячи SMS с историей за год, события доставки,
// переходы по ссылкам, отписки, триггерные события. Боевые объекты (админ,
// шаблоны, воронки, сегменты, рассылки, настройки) НЕ трогаются — только
// добавляются строки журналов/карточек.
//
// Запуск (dev-сервер может быть запущен — WAL и busy_timeout позволяют
// писать параллельно): bun scripts/expand-demo-data.ts [фактор]
//   фактор по умолчанию 20 — целевые объёмы: 20→400 клиентов, 178→~3560 SMS.
//
// БЕЗОПАСНОСТЬ: генерируются ТОЛЬКО терминальные сущности (COMPLETED/FAILED/
// CANCELLED экземпляры, доставленные/отклонённые SMS) — воркер ничего из
// этого не подхватит и не начнёт отправлять; SENT-строки создаются моложе
// окна реконсиляции (2 ч) и доводятся воркером штатно.
// Идемпотентность повторного запуска: добор до целевых объёмов по счётчикам
// существующих строк (дубликаты ключей исключены генераторами: UUID/new seed)
// добавит только недостающие строки.
export {};

// ---------- утилиты ----------
let seed = 42; // фиксированный seed — воспроизводимые демо-данные
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}
const ri = (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const chance = (p: number) => rnd() < p;
const DAY = 86_400_000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
/** Дата за последние days дней с весом к «свежему» хвосту (для живых графиков). */
function recentMs(days: number): number {
  const r = rnd();
  const back = r < 0.55 ? r / 0.55 * (days * 0.25) : 0.25 * days + (r - 0.55) / 0.45 * (days * 0.75);
  return now - back * DAY;
}

// ---------- ФИО / телефоны ----------
const SURNAMES = ['Иванов', 'Петров', 'Сидоров', 'Кузнецов', 'Смирнов', 'Волков', 'Соколов', 'Михайлов', 'Новиков', 'Фёдоров', 'Морозов', 'Козлов', 'Лебедев', 'Попов', 'Зайцев', 'Соловьёв', 'Васильев', 'Панов', 'Мельник', 'Егоров'] as const;
const MALE = ['Александр', 'Дмитрий', 'Сергей', 'Андрей', 'Алексей', 'Михаил', 'Николай', 'Павел', 'Виктор', 'Олег'] as const;
const FEMALE = ['Анна', 'Мария', 'Ольга', 'Наталья', 'Елена', 'Татьяна', 'Ирина', 'Светлана', 'Юлия', 'Ксения'] as const;
const PATR_M = ['Иванович', 'Сергеевич', 'Александрович', 'Дмитриевич', 'Петрович', 'Николаевич'] as const;
const PATR_F = ['Ивановна', 'Сергеевна', 'Александровна', 'Дмитриевна', 'Петровна', 'Николаевна'] as const;
const TIMEZONES = ['Asia/Novosibirsk', 'Europe/Moscow', 'Asia/Yekaterinburg', 'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Europe/Samara', 'Asia/Vladivostok', 'Asia/Omsk', 'Asia/Barnaul', 'Europe/Kaliningrad'] as const;
const usedPhones = new Set<string>();
function genPhone(): string {
  for (;;) {
    const p = `+79${ri(0, 9)}${String(ri(0, 9999999)).padStart(7, '0')}`;
    if (!usedPhones.has(p)) { usedPhones.add(p); return p; }
  }
}

const { db } = await import('@/lib/db');

// ---------- привязка к живым объектам (не создаём конфигурацию) ----------
const templates = await db.smsTemplate.findMany({ where: { name: { notIn: ['Тест SMS.TECH', 'E2E-Шаблон-Инфо', 'E2E-Шаблон-Марк', 'E2E-Шаблон-БэдВар', 'x'] } }, select: { id: true, name: true, isMarketing: true } });
const funnels = await db.funnel.findMany({ where: { isActive: true }, select: { id: true, name: true, triggerEvent: true, version: true } });
const broadcasts = await db.broadcast.findMany({ select: { id: true, name: true } });
if (templates.length === 0 || funnels.length === 0) {
  console.error('Нет живых шаблонов/воронок — сначала prisma/seed.ts');
  await db.$disconnect();
  process.exit(1) as never;
}
const mkT = templates.filter(t => !t.isMarketing);
const advT = templates.filter(t => t.isMarketing);

// короткие отписочные коды (7 символов как в продукте: base62)
const CODE_AB = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function genCode(): string { let s = ''; for (let i = 0; i < 7; i++) s += CODE_AB[ri(0, CODE_AB.length - 1)]; return s; }

// ---------- тела SMS по шаблонам (в духе боевых текстов панели) ----------
function money(n: number): string { return n.toLocaleString('ru-RU').replace(/,/g, ' '); }
const BASE_URL = 'http://localhost:3000';
function smsBody(templateName: string, name: string, marketing: boolean, code: string | null): string {
  const first = name.split(' ')[0];
  const amount = money(ri(3, 90) * 1000);
  const days = ri(5, 30);
  const ln = `LN-${String(ri(1, 9999)).padStart(4, '0')}`;
  let core: string;
  switch (templateName) {
    case 'Напоминание о платеже': core = `${first}, платёж ${money(ri(15, 80) * 100)} руб. по займу ${ln} — через ${ri(1, 3)} дн. ДемоКомпания`; break;
    case 'Просрочка D+1': core = `${first}, платёж по займу ${ln} просрочен на 1 дн. Просим погасить задолженность. ДемоКомпания`; break;
    case 'Просрочка D+5': core = `${first}, задолженность ${amount} руб. по займу ${ln} просрочена на 5 дн. Во избежание пеней погасите сегодня. ДемоКомпания`; break;
    case 'Платёж получен': core = `${first}, платёж ${money(ri(10, 90) * 100)} руб. по займу ${ln} получен. Спасибо! ДемоКомпания`; break;
    case 'Заявка одобрена': core = `${first}, заявка одобрена: заём ${amount} ₽ на ${days} дней. Оформите в личном кабинете. ДемоКомпания`; break;
    case 'С Днём рождения': core = `${first}, с Днём рождения! Подарок — заём ${amount} ₽ на ${days} дней со скидкой 50%. ДемоКомпания`; break;
    case 'Предложение нового займа': core = `${first}, вам — заём до ${amount} ₽ на ${days} дней! Оформите за 5 минут. ДемоКомпания`; break;
    case 'Преапрув': core = `${first}, одобрено ${amount} ₽ на ${days} дней по ставке 0,9%/дн. Заявка действует 3 дня. ДемоКомпания`; break;
    case 'Преапрув: финальное напоминание': core = `${first}, до конца преапрува ${amount} ₽ осталось ${ri(3, 12)} ч. Успейте оформить. ДемоКомпания`; break;
    default: core = `${first}, обновление по вашему займу ${ln}. ДемоКомпания`; break;
  }
  if (marketing) {
    const tail = code ? `Отказаться: ${BASE_URL}/u?c=${code}` : 'Отказаться: ссылка в SMS';
    return `${core} Реклама. ДемоКомпания. ${tail}`;
  }
  return core;
}

// ---------- 1. Клиенты: 20 → 400 ----------
const TARGET_CLIENTS = 400;
const existingClients = await db.client.findMany({ select: { id: true, externalId: true } });
const existingExternal = new Set(existingClients.map(c => c.externalId));
const clientsToCreate: Record<string, unknown>[] = [];
const newClientMeta: { id: string; externalId: string; phone: string; name: string; marketing: boolean }[] = [];
for (let i = 0; existingClients.length + clientsToCreate.length < TARGET_CLIENTS; i++) {
  const externalId = `CLI-${9100 + i}`;
  if (existingExternal.has(externalId)) continue;
  const female = chance(0.55);
  const last = female ? pick(SURNAMES) + 'а' : pick(SURNAMES);
  const first = female ? pick(FEMALE) : pick(MALE);
  const middle = female ? pick(PATR_F) : pick(PATR_M);
  const phone = genPhone();
  const created = now - (chance(0.7) ? ri(1, 365) : ri(365, 1095)) * DAY - ri(0, DAY - 1);
  const agr = chance(0.6) ? 16 : chance(0.375) ? 17 : 19; // 60% действующий / 15% пролонг / 25% закрыт
  const marketing = chance(0.93); // notificationActive
  const id = crypto.randomUUID();
  const bday = new Date(now - ri(19, 65) * 365 * DAY - ri(0, 364) * DAY);
  const offerActive = agr === 16 && chance(0.35);
  clientsToCreate.push({
    id, externalId, phone,
    timezone: chance(0.6) ? 'Asia/Novosibirsk' : chance(0.63) ? 'Europe/Moscow' : pick(TIMEZONES),
    data: JSON.stringify({ name: `${last} ${first} ${middle}`, loan_number: `LN-${String(ri(1, 9999)).padStart(4, '0')}`, loan_amount: ri(3, 90) * 1000, overdue_days: agr === 19 ? 0 : ri(0, 12) }),
    smsConsentStatus: chance(0.85) ? 'GRANTED' : chance(0.8) ? 'NONE' : 'REVOKED',
    smsConsentAt: new Date(created + ri(1, 30) * DAY),
    firstName: first, lastName: last, middleName: middle,
    email: chance(0.8) ? `client${9100 + i}@example.ru` : null,
    applicationId: ri(100000, 999999), applicationStatus: chance(0.5) ? 4 : chance(0.5) ? 12 : 2,
    agreementId: ri(100000, 999999), agreementStatus: agr, agreementPrevStatus: chance(0.4) ? 12 : agr,
    loanAmount: ri(3, 90) * 1000, loanPeriod: pick([7, 10, 14, 21, 30] as const),
    loanClosedAt: agr === 19 ? new Date(now - ri(1, 120) * DAY) : null,
    notificationActive: marketing,
    offerDateStart: offerActive ? new Date(now - ri(1, 20) * DAY) : null,
    offerDateExpired: offerActive ? new Date(now + ri(1, 15) * DAY) : null,
    offerApproveMoney: offerActive ? ri(3, 60) * 1000 : null,
    offerApproveDays: offerActive ? pick([7, 10, 14] as const) : null,
    offerAvailable: offerActive ? true : null,
    birthday: bday,
    lastProductType: chance(0.7) ? 'PDL' : 'IL',
    agreementsLastYear: ri(0, 6), agreementsLifetime: ri(1, 20),
    banDays: chance(0.1) ? ri(7, 90) : null,
    profileUpdatedAt: new Date(now - ri(0, 14) * DAY),
    createdAt: new Date(created),
  });
  newClientMeta.push({ id, externalId, phone, name: `${last} ${first} ${middle}`, marketing });
}
for (let i = 0; i < clientsToCreate.length; i += 500) {
  await db.client.createMany({ data: clientsToCreate.slice(i, i + 500) as never });
}
console.log(`Клиенты: +${clientsToCreate.length} (всего ${existingClients.length + clientsToCreate.length})`);

// Повторный запуск без добора: секции ниже (ссылки/события/переходы/отписки)
// опираются на мету клиентов — заполняем её существующими (дубли исключены
// целевыми счётчиками секций; только для демо-генерации журналов).
if (newClientMeta.length === 0) {
  const rows = await db.client.findMany({
    select: { id: true, phone: true, firstName: true, lastName: true, notificationActive: true },
    take: 400,
  });
  for (const c of rows) {
    newClientMeta.push({ id: c.id, externalId: '', phone: c.phone, name: `${c.lastName} ${c.firstName}`, marketing: c.notificationActive });
  }
  console.log('Добор клиентов не требуется — мета секций заполнена существующими');
}

// ---------- 2. Терминальные экземпляры воронок: 13 → 260 ----------
const allClients = [...existingClients.map(c => c.id), ...newClientMeta.map(c => c.id)];
const TARGET_INSTANCES = 260;
const existingInst = await db.workflowInstance.count();
const instancesToCreate: Record<string, unknown>[] = [];
const newInstances: { id: string; clientId: string; createdAt: number }[] = [];
for (let i = 0; existingInst + instancesToCreate.length < TARGET_INSTANCES; i++) {
  const f = pick(funnels);
  const cl = pick(newClientMeta);
  const started = recentMs(90);
  const status = chance(0.78) ? 'COMPLETED' : chance(0.4) ? 'CANCELLED' : 'FAILED';
  const id = crypto.randomUUID();
  instancesToCreate.push({
    id, funnelId: f.id, funnelVersion: f.version ?? 1, funnelName: f.name,
    clientId: cl.id, currentNodeId: null, status,
    context: JSON.stringify({ event: f.triggerEvent, payload: { agreement_id: ri(100000, 999999), amount: ri(3, 90) * 1000 }, vars: {} }),
    error: status === 'FAILED' ? 'Временная ошибка провайдера (демо)' : null,
    createdAt: new Date(started), updatedAt: new Date(started + ri(5, 90) * 60000),
  });
  newInstances.push({ id, clientId: cl.id, createdAt: started });
}
if (instancesToCreate.length) await db.workflowInstance.createMany({ data: instancesToCreate as never });
console.log(`Экземпляры (терминальные): +${instancesToCreate.length}`);

// ---------- 3. История узлов экземпляров ----------
const instEvents: Record<string, unknown>[] = [];
for (const inst of newInstances) {
  const seq = ['NODE_START', 'SMS_SENT', 'NODE_DONE'];
  const t = inst.createdAt;
  let off = 0;
  for (const type of seq) {
    off += ri(2, 25) * 60000;
    instEvents.push({
      instanceId: inst.id, type, nodeId: 'n1', nodeType: 'sendSms',
      message: type === 'SMS_SENT' ? 'SMS отправлено (демо)' : type === 'NODE_DONE' ? 'Узел завершён' : 'Узел запущен',
      payload: null, createdAt: new Date(t + off),
    });
  }
}
for (let i = 0; i < instEvents.length; i += 500) {
  await db.instanceEvent.createMany({ data: instEvents.slice(i, i + 500) as never });
}
console.log(`События экземпляров: +${instEvents.length}`);

// ---------- 4. Короткие ссылки (отписочные/маркетинговые): добор до 500 ----------
const links: { id: string; code: string; kind: string; clientId: string | null; createdAt: number }[] = [];
const linksToCreate: Record<string, unknown>[] = [];
const TARGET_LINKS = 500;
const existingLinks = await db.shortLink.count();
for (let i = 0; existingLinks + linksToCreate.length < TARGET_LINKS; i++) {
  const id = crypto.randomUUID();
  const kind = chance(0.85) ? 'UNSUBSCRIBE' : 'LINK';
  const cl = chance(0.8) ? pick(newClientMeta) : null;
  const created = recentMs(30);
  const code = genCode();
  links.push({ id, code, kind, clientId: cl?.id ?? null, createdAt: created });
  linksToCreate.push({
    id, code, kind,
    name: kind === 'LINK' ? `Промо-страница ${i + 1}` : null,
    targetUrl: kind === 'LINK' ? `https://example.com/promo?utm_source=sms&utm_campaign=demo${i}` : null,
    clientId: cl?.id ?? null,
    visits: 0,
    expiresAt: new Date(created + 180 * DAY),
    createdAt: new Date(created),
  });
}
await db.shortLink.createMany({ data: linksToCreate as never });
console.log(`Короткие ссылки: +${linksToCreate.length} (всего ${existingLinks + linksToCreate.length})`);

// ---------- 5. SMS-лог: 178 → ~3560 ----------
const TARGET_SMS = 3560;
const existingSms = await db.smsMessage.count();
const smsToCreate: Record<string, unknown>[] = [];
let sentFresh = 0;
for (let i = 0; existingSms + smsToCreate.length < TARGET_SMS; i++) {
  const marketing = chance(0.42);
  const tpl = marketing ? pick(advT) : pick(mkT);
  const cl = pick(newClientMeta);
  const createdAt = recentMs(365);
  const fresh = createdAt > now - 30 * DAY;
  // статус: SENT — только свежее окна реконсиляции (2 ч), остальное — история
  let status: string;
  const r = rnd();
  if (createdAt > now - 25 * 60000 && r < 0.5) { status = 'SENT'; sentFresh++; }
  else if (r < 0.70) status = 'DELIVERED';
  else if (r < 0.80) status = 'FAILED';
  else if (r < 0.92) status = 'REJECTED_BY_COMPLIANCE';
  else status = 'CANCELLED';

  const link = marketing && chance(0.85) ? pick(links) : null;
  const body = smsBody(tpl.name, cl.name, marketing, link?.code ?? null);
  const segments = marketing ? (chance(0.5) ? 2 : 3) : chance(0.75) ? 1 : 2;
  const sentAt = status === 'REJECTED_BY_COMPLIANCE' || status === 'CANCELLED' ? null : new Date(createdAt + ri(1, 5) * 1000);
  const deliveredAt = status === 'DELIVERED' && sentAt ? new Date(sentAt.getTime() + ri(3, 120) * 1000) : null;

  // привязка: 30% триггерные (экземпляр), 25% рассылки, остальное — прямые
  const bind = rnd();
  const inst = bind < 0.3 ? pick(newInstances) : null;
  const bc = bind >= 0.3 && bind < 0.55 ? pick(broadcasts) : null;

  smsToCreate.push({
    clientId: cl.id, phone: cl.phone, body, segments,
    provider: 'sandbox', providerMessageId: `demo-${i}-${ri(100000, 999999)}`,
    templateId: tpl.id, templateName: tpl.name,
    status,
    rejectReason: status === 'REJECTED_BY_COMPLIANCE'
      ? (marketing ? pick(['ADVERT_OFF', 'UNSUBSCRIBED', 'NO_CONSENT'] as const) : pick(['LIMIT_CLIENT', 'SMS_TOO_LONG'] as const))
      : status === 'CANCELLED' ? 'TEMPLATE_CANCEL' : null,
    error: status === 'FAILED' ? pick(['Таймаут шлюза (демо)', 'Недоступен номер (демо)', 'Ошибка сети (демо)']) : null,
    sentAt, deliveredAt,
    attempts: status === 'FAILED' ? ri(1, 3) : status === 'SENT' ? 1 : 0,
    broadcastId: bc?.id ?? null, broadcastName: bc?.name ?? null,
    instanceId: inst?.id ?? null,
    createdAt: new Date(createdAt), updatedAt: new Date(deliveredAt ?? sentAt ?? createdAt),
  });
}
for (let i = 0; i < smsToCreate.length; i += 500) {
  await db.smsMessage.createMany({ data: smsToCreate.slice(i, i + 500) as never });
}
console.log(`SMS: +${smsToCreate.length} (всего ${existingSms + smsToCreate.length}; SENT-свежих ${sentFresh})`);

// ---------- 6. Журнал «События доставки» (MessageEvent) ----------
const msgEvents: Record<string, unknown>[] = [];
for (const s of smsToCreate as { status?: string; sentAt?: { getTime(): number }; deliveredAt?: { getTime(): number }; phone?: string; clientId?: string; body?: string }[]) {
  if (s.status !== 'DELIVERED' && s.status !== 'FAILED' && s.status !== 'SENT') continue;
  const sent = s.sentAt?.getTime() ?? now - ri(1, 3) * 60000;
  msgEvents.push({
    source: 'panel', eventType: 'send_sms', eventDate: new Date(sent), receivedAt: new Date(sent),
    phone: s.phone, provider: 'sandbox', smsMessageId: null, clientId: s.clientId ?? null,
    externalIds: JSON.stringify({ message_id: `demo-${ri(100000, 999999)}` }),
    payload: JSON.stringify({ event_name: 'send_sms', channel: 'sms', provider: 'sandbox' }),
    dedupKey: `demo-snd-${crypto.randomUUID()}`, status: 'PROCESSED',
    result: JSON.stringify({ applied: 'SENT' }),
  });
  if (s.status === 'DELIVERED' && s.deliveredAt) {
    msgEvents.push({
      source: 'panel', eventType: 'deliv_sms', eventDate: new Date(s.deliveredAt.getTime()), receivedAt: new Date(s.deliveredAt.getTime()),
      phone: s.phone, provider: 'sandbox', smsMessageId: null, clientId: s.clientId ?? null,
      externalIds: JSON.stringify({ message_id: `demo-${ri(100000, 999999)}` }),
      payload: JSON.stringify({ event_name: 'deliv_sms', channel: 'sms', provider: 'sandbox' }),
      dedupKey: `demo-dlv-${crypto.randomUUID()}`, status: 'PROCESSED',
      result: JSON.stringify({ applied: 'DELIVERED' }),
    });
  }
  if (s.status === 'FAILED' && s.sentAt) {
    msgEvents.push({
      source: 'panel', eventType: 'undeliv_sms', eventDate: new Date(s.sentAt.getTime() + 60000), receivedAt: new Date(s.sentAt.getTime() + 60000),
      phone: s.phone, provider: 'sandbox', smsMessageId: null, clientId: s.clientId ?? null,
      externalIds: JSON.stringify({ message_id: `demo-${ri(100000, 999999)}` }),
      payload: JSON.stringify({ event_name: 'undeliv_sms', undeliv_code: 500, undeliv_message: 'Delivery failed (demo)' }),
      dedupKey: `demo-und-${crypto.randomUUID()}`, status: 'PROCESSED',
      result: JSON.stringify({ applied: 'FAILED' }),
    });
  }
}
// внешние события (формат A45 — «занимание» из внешней системы): добор до 60
const EXT_TARGET = 60;
const existingExt = await db.messageEvent.count({ where: { source: 'external' } });
for (let i = 0; existingExt + i < EXT_TARGET; i++) {
  const cl = pick(newClientMeta);
  const t = recentMs(30);
  const type = chance(0.6) ? 'send_sms' : chance(0.6) ? 'deliv_sms' : chance(0.5) ? 'unsub_sms' : 'undeliv_sms';
  msgEvents.push({
    source: 'external', eventType: type, eventDate: new Date(t), receivedAt: new Date(t),
    phone: cl.phone, provider: null, smsMessageId: null, clientId: cl.id,
    externalIds: JSON.stringify({ message_id: `ext-${ri(100000, 999999)}`, campaign_name: 'Внешняя кампания' }),
    payload: JSON.stringify({ event_name: type, event_data: { phone: cl.phone, message_id: `ext-${ri(100000, 999999)}`, content: { sms: 'Внешнее SMS (демо)' } }, custom_data: { client_id: cl.externalId, campaign_name: 'Внешняя кампания' } }),
    dedupKey: `demo-ext-${i}-${t}`, status: 'PROCESSED',
    result: JSON.stringify(type === 'unsub_sms' ? { applied: 'UNSUBSCRIBE' } : { applied: 'EXTERNAL_ONLY' }),
  });
}
for (let i = 0; i < msgEvents.length; i += 500) {
  await db.messageEvent.createMany({ data: msgEvents.slice(i, i + 500) as never });
}
console.log(`События доставки: +${msgEvents.length} (в т.ч. внешних ${EXT_TARGET - existingExt})`);

// ---------- 7. Переходы по коротким ссылкам ----------
const visitsToCreate: Record<string, unknown>[] = [];
for (const l of links) {
  const n = chance(0.55) ? ri(1, 4) : 0;
  for (let v = 0; v < n; v++) {
    visitsToCreate.push({ linkId: l.id, kind: l.kind, createdAt: new Date(recentMs(30)) });
  }
}
for (let i = 0; i < visitsToCreate.length; i += 500) {
  await db.shortLinkVisit.createMany({ data: visitsToCreate.slice(i, i + 500) as never });
}
// счётчики переходов на самих ссылках — как их ведёт продакт-код
for (const l of links) {
  const n = visitsToCreate.filter(v => (v as { linkId: string }).linkId === l.id).length;
  if (n > 0) {
    await db.shortLink.updateMany({ where: { id: l.id }, data: { visits: n, lastVisitAt: new Date(recentMs(30)) } });
  }
}
console.log(`Переходы по ссылкам: +${visitsToCreate.length}`);

// ---------- 8. Отписки: 2 → ~40 ----------
const TARGET_UNSUB = 40;
const existingUnsub = await db.unsubscribeList.count();
const unsubToCreate: Record<string, unknown>[] = [];
// уже отписанные телефоны исключаются — повторный запуск с фиксированным seed
// выбирает тех же кандидатов (P2002 по unique phone)
const unsubscribedPhones = new Set((await db.unsubscribeList.findMany({ select: { phone: true } })).map((r) => r.phone));
const unsubCandidates = newClientMeta.filter(c => !c.marketing && !unsubscribedPhones.has(c.phone)).slice(0, TARGET_UNSUB - existingUnsub);
for (const c of unsubCandidates) {
  const t = recentMs(90);
  unsubToCreate.push({
    phone: c.phone, source: pick(['LINK', 'MANUAL', 'HOOK', 'IMPORT'] as const),
    clientId: c.id, createdAt: new Date(t),
  });
}
if (unsubToCreate.length) {
  await db.unsubscribeList.createMany({ data: unsubToCreate as never });
  for (const c of unsubCandidates) {
    await db.client.updateMany({ where: { id: c.id, unsubscribedAt: null }, data: { unsubscribedAt: new Date(recentMs(90)) } });
  }
}
console.log(`Отписки: +${unsubToCreate.length} (всего ${existingUnsub + unsubToCreate.length})`);

// ---------- 9. Триггерные события (EventsInbox): 18 → 360 ----------
const TARGET_INBOX = 360;
const existingInbox = await db.eventsInbox.count();
const inboxToCreate: Record<string, unknown>[] = [];
const EVENT_TYPES = ['LOAN_OVERDUE', 'PAYMENT_DUE_SOON', 'PAYMENT_RECEIVED', 'LOAN_CLOSED', 'BIRTHDAY', 'APPLICATION_APPROVED', 'APPROVAL_EXPIRED', 'APPLICATION_REJECTED', 'PREAPPROVE_ISSUED'] as const;
for (let i = 0; existingInbox + inboxToCreate.length < TARGET_INBOX; i++) {
  const cl = pick(newClientMeta);
  const t = recentMs(30);
  const ev = pick(EVENT_TYPES);
  inboxToCreate.push({
    event: ev, externalId: cl.externalId,
    payload: JSON.stringify({ agreement_id: ri(100000, 999999), amount: ri(3, 90) * 1000, overdue_days: ev === 'LOAN_OVERDUE' ? ri(1, 12) : 0 }),
    idempotencyKey: `demo-inbox-${i}-${Math.floor(t / 1000)}`,
    status: 'PROCESSED',
    result: JSON.stringify(chance(0.6) ? { instances: 1, funnel: pick(funnels).name } : { instances: 0, reason: 'skip: воронка не активна / уже пройдена' }),
    apiKeyId: null, source: chance(0.85) ? 'API' : 'PANEL', ip: '127.0.0.1',
    createdAt: new Date(t), updatedAt: new Date(t + 5000),
  });
}
for (let i = 0; i < inboxToCreate.length; i += 500) {
  await db.eventsInbox.createMany({ data: inboxToCreate.slice(i, i + 500) as never });
}
console.log(`Триггерные события (инбокс): +${inboxToCreate.length}`);

// ---------- 10. Кейс «Кредитная линия» (лайв-тест): кастомные поля ----------
//
// Реальный кейс вместо абстрактных демо-полей: переменные продукта «Кредитная
// линия PDL» из исходной постановки:
//   • is_credit_line (bool) — isCreditLine: true, если по тарифу последнего
//     договора выдана кредитная линия PDL (PDL_CL), иначе false;
//   • available_tranche_sum (numeric 10,2) — доступная сумма транша
//     (application.approve_money последней транш-заявки в статусе 7/8);
//   • grace_period_days (int) — дни грейс-периода из тарифа или промокода.
// Система данных передаёт их в client_card (isCreditLine / available_tranche_sum /
// grace_period_days); приём поддерживает три написания ключа: cf_<key>, сырой
// <key> и camelCase контракта системы данных. Здесь: чистка демо-мусора прошлых сессий
// (vip_level), идемпотентное создание реестра полей, правдоподобные значения
// клиентов + история профиля (EVENT), демо-операция массового обновления
// (MASS_UPDATE) и динамический сегмент «Кредитная линия подключена».
{
  // Чистка демо-мусора ранних сессий: вымышленное поле VIP (значения уходят каскадом)
  const removedVip = await db.customField.deleteMany({ where: { key: 'vip_level' } });
  if (removedVip.count > 0) console.log('Чистка демо-поля vip_level (значения — каскадом)');

  const admin = await db.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true, email: true } });

  // Реестр полей кейса: создаём недостающие, существующие не трогаем (идемпотентность)
  const CF_DEFS = [
    {
      key: 'is_credit_line', label: 'Кредитная линия подключена', type: 'bool',
      description: 'Признак продукта «Кредитная линия» (isCreditLine): true — по тарифу последнего договора выдана КЛ PDL. Система данных передаёт в client_card: isCreditLine / is_credit_line / cf_is_credit_line.',
    },
    {
      key: 'available_tranche_sum', label: 'Доступная сумма транша', type: 'number',
      description: 'Максимально доступная сумма транша по последней транш-заявке в статусе 7 или 8 (application.approve_money, numeric 10,2).',
    },
    {
      key: 'grace_period_days', label: 'Дней грейс-периода', type: 'number',
      description: 'Общее количество дней грейс-периода из тарифа или применённого промокода (agreement.grace_period).',
    },
  ] as const;
  const cfRows: { id: string; key: string; type: string }[] = [];
  for (const def of CF_DEFS) {
    const existing = await db.customField.findUnique({ where: { key: def.key }, select: { id: true, key: true, type: true } });
    const row =
      existing ??
      (await db.customField.create({
        data: { key: def.key, label: def.label, type: def.type, description: def.description, createdById: admin?.id ?? null },
        select: { id: true, key: true, type: true },
      }));
    cfRows.push(row);
  }
  const cfId = (key: string): string => cfRows.find((r) => r.key === key)!.id;

  // Существующие пары поле×клиент — повторный запуск добирает только недостающее
  const existingPairs = await db.clientFieldValue.findMany({
    where: { fieldId: { in: cfRows.map((r) => r.id) } },
    select: { fieldId: true, clientId: true },
  });
  const hasPair = new Set(existingPairs.map((p) => `${p.fieldId}|${p.clientId}`));

  // Значения по кейсу: 40% клиентов — КЛ подключена (у части — доступный транш и
  // грейс), 25% — КЛ нет (продукты PDL/IL), 35% — значение ещё не передано системой данных.
  // Итерация по дедуплицированным id (повторный запуск: existing и мета совпадают),
  // hasPair пополняется на лету — страховка от дублей внутри одного батча.
  const cfValuesToCreate: Record<string, unknown>[] = [];
  const cfHistory: Record<string, unknown>[] = [];
  for (const clientId of new Set(allClients)) {
    const r = rnd();
    if (r < 0.4) {
      const t = recentMs(45);
      const details = JSON.stringify({ eventId: crypto.randomUUID(), event: 'APPLICATION_APPROVED' });
      if (!hasPair.has(`${cfId('is_credit_line')}|${clientId}`)) {
        hasPair.add(`${cfId('is_credit_line')}|${clientId}`);
        cfValuesToCreate.push({ fieldId: cfId('is_credit_line'), clientId, valueBool: true });
        cfHistory.push({ clientId, field: 'cf_is_credit_line', oldValue: null, newValue: 'true', source: 'EVENT', sourceDetails: details, createdAt: new Date(t) });
      }
      // активная транш-заявка (статус 7/8) — доступная сумма; numeric 10,2
      if (chance(0.7) && !hasPair.has(`${cfId('available_tranche_sum')}|${clientId}`)) {
        hasPair.add(`${cfId('available_tranche_sum')}|${clientId}`);
        const sum = ri(10, 120) * 500 + (chance(0.4) ? 0.5 : 0);
        cfValuesToCreate.push({ fieldId: cfId('available_tranche_sum'), clientId, valueNum: sum });
        cfHistory.push({ clientId, field: 'cf_available_tranche_sum', oldValue: null, newValue: String(sum), source: 'EVENT', sourceDetails: details, createdAt: new Date(t) });
      }
      if (chance(0.85) && !hasPair.has(`${cfId('grace_period_days')}|${clientId}`)) {
        hasPair.add(`${cfId('grace_period_days')}|${clientId}`);
        const grace = pick([7, 14, 21, 30] as const);
        cfValuesToCreate.push({ fieldId: cfId('grace_period_days'), clientId, valueNum: grace });
        cfHistory.push({ clientId, field: 'cf_grace_period_days', oldValue: null, newValue: String(grace), source: 'EVENT', sourceDetails: details, createdAt: new Date(t) });
      }
    } else if (r < 0.65) {
      const t = recentMs(45);
      const details = JSON.stringify({ eventId: crypto.randomUUID(), event: 'APPLICATION_APPROVED' });
      if (!hasPair.has(`${cfId('is_credit_line')}|${clientId}`)) {
        hasPair.add(`${cfId('is_credit_line')}|${clientId}`);
        cfValuesToCreate.push({ fieldId: cfId('is_credit_line'), clientId, valueBool: false });
        cfHistory.push({ clientId, field: 'cf_is_credit_line', oldValue: null, newValue: 'false', source: 'EVENT', sourceDetails: details, createdAt: new Date(t) });
      }
    }
  }
  for (let i = 0; i < cfValuesToCreate.length; i += 500) {
    await db.clientFieldValue.createMany({ data: cfValuesToCreate.slice(i, i + 500) as never });
  }
  for (let i = 0; i < cfHistory.length; i += 500) {
    await db.profileChangeLog.createMany({ data: cfHistory.slice(i, i + 500) as never });
  }
  console.log(`Кредитная линия: значения +${cfValuesToCreate.length}, история +${cfHistory.length}`);

  // Демо-операция массового обновления (журнал «Массовые обновления»): оператор
  // проставил признак КЛ сегменту лояльных — false→true с записью истории
  if ((await db.massUpdateJob.count()) === 0) {
    const falseRows = await db.clientFieldValue.findMany({
      where: { fieldId: cfId('is_credit_line'), valueBool: false },
      select: { clientId: true },
      take: 40,
    });
    if (falseRows.length > 0) {
      const seg = (await db.segment.findFirst({ where: { name: 'Лояльные клиенты' }, select: { id: true, name: true } }))
        ?? (await db.segment.findFirst({ select: { id: true, name: true } }));
      const jobId = crypto.randomUUID();
      const jobName = 'Признак кредитной линии — лояльным клиентам';
      const startedAt = new Date(recentMs(6));
      const finishedAt = new Date(startedAt.getTime() + ri(20, 90) * 1000);
      await db.massUpdateJob.create({
        data: {
          id: jobId, name: jobName,
          segmentId: seg?.id ?? 'demo-segment', segmentName: seg?.name ?? 'Лояльные клиенты',
          updates: JSON.stringify([{ field: 'cf_is_credit_line', value: true }]),
          maxAffected: 10000, status: 'DONE',
          planned: falseRows.length, processed: falseRows.length, affected: falseRows.length,
          createdById: admin?.id ?? null, createdByEmail: admin?.email ?? 'admin@trigger.local',
          startedAt, finishedAt,
        },
      });
      const massHistory = falseRows.map((row) => ({
        clientId: row.clientId, field: 'cf_is_credit_line',
        oldValue: 'false', newValue: 'true',
        source: 'MASS_UPDATE', sourceDetails: JSON.stringify({ jobId, jobName }),
        createdAt: new Date(finishedAt.getTime() + ri(1, 40) * 1000),
      }));
      await db.profileChangeLog.createMany({ data: massHistory as never });
      await db.clientFieldValue.updateMany({
        where: { fieldId: cfId('is_credit_line'), clientId: { in: falseRows.map((r) => r.clientId) } },
        data: { valueBool: true },
      });
      console.log(`Массовое обновление (демо): «${jobName}» — ${falseRows.length} клиентов`);
    }
  }

  // Динамический сегмент кейса: {{cf_is_credit_line}} = true (SQL-фильтр по индексу)
  const segName = 'Кредитная линия подключена';
  const segExists = await db.segment.findFirst({ where: { name: segName }, select: { id: true } });
  if (!segExists) {
    await db.segment.create({
      data: {
        name: segName,
        description: 'Клиенты с подключённой кредитной линией (cf_is_credit_line = true) — рассылки по продукту «Кредитная линия PDL»',
        conditions: JSON.stringify({ match: 'all', rules: [{ field: 'cf_is_credit_line', op: 'eq', value: true }] }),
        mode: 'dynamic',
      },
    });
    console.log(`Сегмент «${segName}» создан`);
  }
}

// ---------- итог ----------
const total = {
  clients: await db.client.count(),
  sms: await db.smsMessage.count(),
  messageEvents: await db.messageEvent.count(),
  visits: await db.shortLinkVisit.count(),
  unsubscribed: await db.unsubscribeList.count(),
  inbox: await db.eventsInbox.count(),
  instances: await db.workflowInstance.count(),
  cfFields: await db.customField.count(),
  cfValues: await db.clientFieldValue.count(),
  profileHistory: await db.profileChangeLog.count(),
  massUpdateJobs: await db.massUpdateJob.count(),
};
console.log('ИТОГО В БД:', JSON.stringify(total));
await db.$disconnect();
