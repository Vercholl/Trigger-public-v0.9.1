// E2E-проверка тестового контура SMS.TECH (запуск: bun run scripts/e2e-broadcast-test.ts).
// Полный путь владельца ДО подключения токена, но на провайдере sandbox:
//   создание рассылки ONCE «сейчас» с Origin публичной панели (симуляция заголовками
//   шлюза) → воркер запускает → 2 сообщения тестовым клиентам с рабочей ссылкой
//   отписки от Origin создания (не localhost!) → проверка статусов.
// В конце scratch-рассылка и её сообщения УДАЛЯЮТСЯ — лог не засоряется,
// дневные лимиты тестовых клиентов не расходуются.
const BASE = 'http://localhost:3000/api/v1';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';

const PUBLIC_HOST = 'demo-public.space-z.ai'; // симуляция публичного адреса панели
const SEGMENT_NAME = 'Тест SMS.TECH — 2 тестовых клиента';
const TEMPLATE_NAME = 'Тест SMS.TECH';
const SCRATCH_BROADCAST = 'E2E-прогон тестового контура (удаляется)';

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const login = await api('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (login.status !== 200) throw new Error(`логин: ${login.status}`);
  // Заголовки как от шлюза публичной панели: x-forwarded-host + браузерный Origin (HTTPS-сигнал)
  const auth = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${login.body.sessionToken}`,
    'x-forwarded-host': PUBLIC_HOST,
    origin: `https://${PUBLIC_HOST}`,
  };
  console.log('[e2e] вход ок');

  const segs = (await api('/segments', { headers: auth })).body.items ?? [];
  const segment = segs.find((s: any) => s.name === SEGMENT_NAME);
  const tpls = (await api('/templates?pageSize=100', { headers: auth })).body.items ?? [];
  const template = tpls.find((t: any) => t.name === TEMPLATE_NAME && t.isActive);
  if (!segment || !template) throw new Error('сегмент/шаблон тестового контура не найдены');
  console.log(`[e2e] сегмент ${segment.id} | шаблон ${template.id}`);

  // ---------- Создание рассылки ONCE «сейчас» ----------
  const created = await api('/broadcasts', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: SCRATCH_BROADCAST,
      description: 'Временная рассылка для E2E-проверки тестового контура — удаляется после прогона.',
      segmentId: segment.id,
      templateId: template.id,
      kind: 'ONCE',
      runNow: true,
      minDaysBetween: 0,
      maxRecipients: 10,
    }),
  });
  if (created.status !== 201) throw new Error(`создание рассылки: ${created.status} ${JSON.stringify(created.body)}`);
  const broadcastId: string = created.body.id;
  console.log(`[e2e] рассылка создана: ${broadcastId} (runNow)`);

  // ---------- Ожидание воркера (тик 5 с + отправка) ----------
  let messages: any[] = [];
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const sms = await api('/sms?pageSize=50', { headers: auth });
    messages = (sms.body.items ?? []).filter((m: any) => m.broadcastName === SCRATCH_BROADCAST);
    const sent = messages.filter((m: any) => ['SENT', 'DELIVERED', 'SENDING', 'QUEUED'].includes(m.status));
    if (messages.length >= 2 && sent.length === messages.length) break;
  }

  console.log(`\n[e2e] сообщений создано: ${messages.length}`);
  let ok = messages.length === 2;
  for (const m of messages) {
    const linkOk = typeof m.body === 'string' && m.body.includes(`https://${PUBLIC_HOST}/?u=`);
    const localhostLeak = typeof m.body === 'string' && m.body.includes('localhost');
    console.log(
      `  ${m.phone} | ${m.status} | частей: ${m.segments} | провайдер: ${m.provider} | ссылка от публичного Origin: ${linkOk ? 'да ✓' : 'НЕТ ✗'} | localhost-протечка: ${localhostLeak ? 'ЕСТЬ ✗' : 'нет ✓'}`,
    );
    console.log(`    текст: ${m.body}`);
    if (!linkOk || localhostLeak) ok = false;
  }

  // ---------- Проверка baseUrl в строке рассылки ----------
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const row = await db.broadcast.findUnique({ where: { id: broadcastId } });
    console.log(`\n[e2e] Broadcast.baseUrl = ${row?.baseUrl} ${row?.baseUrl === `https://${PUBLIC_HOST}` ? '✓' : '✗'}`);
    if (row?.baseUrl !== `https://${PUBLIC_HOST}`) ok = false;

    // ---------- Очистка scratch-данных ----------
    const del = await db.smsMessage.deleteMany({ where: { broadcastId } });
    await db.broadcastRun.deleteMany({ where: { broadcastId } });
    await db.broadcast.delete({ where: { id: broadcastId } });
    console.log(`\n[cleanup] удалено сообщений: ${del.count}; scratch-рассылка и запуски удалены`);

    const leftover = await db.smsMessage.count({ where: { broadcastName: SCRATCH_BROADCAST } });
    console.log(`[cleanup] остаток сообщений в логе: ${leftover} ${leftover === 0 ? '✓' : '✗'}`);
    if (leftover !== 0) ok = false;
  } finally {
    await db.$disconnect();
  }

  console.log(`\n[e2e] ИТОГ: ${ok ? 'ВСЁ ПРОШЛО ✓' : 'ЕСТЬ ОШИБКИ ✗'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[e2e] Ошибка:', e);
  process.exit(1);
});

// Изоляция областей имён (см. setup-smstech-test.ts).
export {};
