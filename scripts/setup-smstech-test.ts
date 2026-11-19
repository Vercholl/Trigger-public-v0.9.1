// Подготовка тестового контура для проверки шлюза SMS.TECH (запуск: bun run scripts/setup-smstech-test.ts).
// Создаёт через API панели (от имени администратора — с валидацией и записью в аудит):
//   1) двух тестовых клиентов CLI-9001/CLI-9002 (фамилия-маркер SMSTECH, согласие GRANTED);
//   2) сегмент «Тест SMS.TECH» — правило «Фамилия = SMSTECH» (ровно эти клиенты);
//   3) маркетинговый шаблон «Тест SMS.TECH» для рассылки по сегменту.
// Идемпотентно: существующие сущности не дублируются, проверяется состав сегмента.
const BASE = 'http://localhost:3000/api/v1';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';

const MARKER_LAST_NAME = 'SMSTECH';
const SEGMENT_NAME = 'Тест SMS.TECH — 2 тестовых клиента';
const TEMPLATE_NAME = 'Тест SMS.TECH';

interface TestClientSpec {
  externalId: string;
  phone: string;
  firstName: string;
  applicationId: number;
  agreementId: number;
}

// Номера-заглушки (валидный E.164): владелец заменит их на реальные через вкладку «Клиенты».
const TEST_CLIENTS: TestClientSpec[] = [
  { externalId: 'CLI-9001', phone: '+79000001001', firstName: 'Первый', applicationId: 9900001, agreementId: 900001 },
  { externalId: 'CLI-9002', phone: '+79000001002', firstName: 'Второй', applicationId: 9900002, agreementId: 900002 },
];

// Карточка, одинаковая для обоих: минимальный действующий PDL-договор.
// smsConsentStatus=GRANTED + notification_active=true + нет отписки →
// маркетинговая рассылка проходит комплаенс (отписка/реклама/согласие).
function cardFields(spec: TestClientSpec): Record<string, unknown> {
  return {
    client_first_name: spec.firstName,
    client_last_name: MARKER_LAST_NAME,
    application_id: spec.applicationId,
    application_actual_status: 4,
    application_previous_status: 1,
    agreement_id: spec.agreementId,
    agreement_actual_status: 16, // действующий
    agreement_previous_status: 15,
    loan_amount: 15000,
    loan_period: 15,
    notification_active: true,
    last_product_type: 'PDL',
    agreements_for_lastyear: 0,
    agreements_for_lifetime: 1,
    ban_days: 0,
    date_update: new Date().toISOString(),
  };
}

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

async function main(): Promise<void> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('[setup] Обязательны ADMIN_EMAIL и ADMIN_PASSWORD в .env');
    process.exit(1);
  }

  // ---------- 0. Вход ----------
  const login = await api('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (login.status !== 200) {
    console.error('[setup] Логин не удался:', login.status, JSON.stringify(login.body));
    process.exit(1);
  }
  const token: string | undefined = login.body?.sessionToken;
  if (!token) {
    console.error('[setup] В ответе логина нет sessionToken:', JSON.stringify(login.body));
    process.exit(1);
  }
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  console.log('[setup] вход:', ADMIN_EMAIL, '— ok');

  // ---------- 1. Тестовые клиенты ----------
  const list = await api('/clients?pageSize=100', { headers: auth });
  if (list.status !== 200) {
    console.error('[setup] Список клиентов не получен:', list.status);
    process.exit(1);
  }
  const existing = new Map<string, { id: string; phone: string }>();
  for (const c of list.body.items ?? []) {
    if (typeof c.externalId === 'string') existing.set(c.externalId, { id: c.id, phone: c.phone });
  }

  for (const spec of TEST_CLIENTS) {
    if (existing.has(spec.externalId)) {
      console.log(`[setup] клиент ${spec.externalId} уже существует (${existing.get(spec.externalId)!.phone}) — пропущено`);
      continue;
    }
    const created = await api('/clients', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        externalId: spec.externalId,
        phone: spec.phone,
        timezone: 'Asia/Novosibirsk',
        smsConsentStatus: 'GRANTED',
        smsConsentSource: 'manual',
        ...cardFields(spec),
      }),
    });
    if (created.status !== 201) {
      console.error(`[setup] клиент ${spec.externalId} не создан:`, created.status, JSON.stringify(created.body));
      process.exit(1);
    }
    console.log(`[setup] клиент ${spec.externalId} создан: ${created.body.phone} (${MARKER_LAST_NAME} ${spec.firstName})`);
  }

  // ---------- 2. Сегмент ----------
  const segList = await api('/segments', { headers: auth });
  if (segList.status !== 200) {
    console.error('[setup] Список сегментов не получен:', segList.status);
    process.exit(1);
  }
  let segment = (segList.body.items ?? []).find((s: any) => s.name === SEGMENT_NAME);
  if (segment) {
    console.log(`[setup] сегмент «${SEGMENT_NAME}» уже существует — пропущено`);
  } else {
    const created = await api('/segments', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: SEGMENT_NAME,
        description:
          'Только два тестовых клиента для проверки доставки через шлюз SMS.TECH (CLI-9001/CLI-9002, фамилия SMSTECH). ' +
          'Перед тестом замените номера-заглушки на реальные во вкладке «Клиенты» — сегмент строится по фамилии-маркеру и замену номеров переживёт.',
        conditions: {
          match: 'all',
          rules: [{ field: 'client_last_name', op: 'eq', value: MARKER_LAST_NAME }],
        },
      }),
    });
    if (created.status !== 201) {
      console.error('[setup] сегмент не создан:', created.status, JSON.stringify(created.body));
      process.exit(1);
    }
    segment = created.body;
    console.log(`[setup] сегмент «${SEGMENT_NAME}» создан: правило «Фамилия = ${MARKER_LAST_NAME}»`);
  }

  // ---------- 3. Шаблон ----------
  const tplList = await api('/templates?pageSize=100', { headers: auth });
  if (tplList.status !== 200) {
    console.error('[setup] Список шаблонов не получен:', tplList.status);
    process.exit(1);
  }
  let template = (tplList.body.items ?? []).find((t: any) => t.name === TEMPLATE_NAME && t.isActive);
  if (template) {
    console.log(`[setup] шаблон «${TEMPLATE_NAME}» уже существует — пропущено`);
  } else {
    const created = await api('/templates', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: TEMPLATE_NAME,
        description:
          'Для проверки доставки через шлюз SMS.TECH: рассылка ONCE «сейчас» по сегменту «Тест SMS.TECH — 2 тестовых клиента». ' +
          'Маркетинговый — к тексту автоматически добавляется рекламная приписка со ссылкой отписки; доставка в 9:00–21:00 по местному времени клиента.',
        isMarketing: true,
        body: '{{client_first_name}}, это тестовое SMS для проверки доставки через шлюз SMS.TECH.',
      }),
    });
    if (created.status !== 201) {
      console.error('[setup] шаблон не создан:', created.status, JSON.stringify(created.body));
      process.exit(1);
    }
    template = created.body;
    console.log(`[setup] шаблон «${TEMPLATE_NAME}» создан (маркетинговый)`);
  }

  // ---------- 4. Проверка состава сегмента ----------
  const segClients = await api(`/segments/${segment.id}/clients?page=1&pageSize=50`, { headers: auth });
  if (segClients.status !== 200) {
    console.error('[setup] Клиенты сегмента не получены:', segClients.status, JSON.stringify(segClients.body));
    process.exit(1);
  }
  const members: any[] = segClients.body.items ?? [];
  console.log(`\n[verify] сегмент «${SEGMENT_NAME}»: ${segClients.body.total} клиент(ов)`);
  for (const m of members) {
    console.log(
      `  ${m.externalId} | ${m.client_last_name} ${m.client_first_name} | ${m.phone} | согласие: ${m.smsConsentStatus} | реклама: ${m.notification_active ? 'разрешена' : 'запрещена'}`,
    );
  }
  const expected = new Set(TEST_CLIENTS.map((c) => c.externalId));
  const actual = new Set(members.map((m: any) => m.externalId));
  const exact =
    segClients.body.total === TEST_CLIENTS.length &&
    members.every((m: any) => expected.has(m.externalId)) &&
    [...expected].every((id) => actual.has(id));
  console.log(`[verify] состав сегмента ${exact ? 'ТОЧНО совпадает с тестовой парой ✓' : 'ОШИБКА: несовпадение ✗'}`);
  if (!exact) process.exit(1);

  // ---------- 5. Превью шаблона (итоговый текст с припиской) ----------
  const preview = await api('/templates/preview', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      body: template.body,
      isMarketing: true,
      sampleData: { client_first_name: 'Первый' },
    }),
  });
  if (preview.status === 200) {
    console.log('\n[verify] превью итогового SMS (с рекламной припиской):');
    console.log('  текст:', preview.body.renderedWithDisclaimer);
    console.log(
      '  частей:', preview.body.segmentsWithDisclaimer,
      '| без приписки:', preview.body.segments,
      '| символов:', preview.body.chars,
    );
  } else {
    console.error('[verify] превью не построено:', preview.status, JSON.stringify(preview.body));
    process.exit(1);
  }

  console.log('\n[setup] Тестовый контур готов. Далее: Интеграции → токен SMS.Tech → активировать SMS.Tech → Клиенты → заменить номера → Рассылки → ONCE «сейчас».');
}

main().catch((e) => {
  console.error('[setup] Ошибка:', e);
  process.exit(1);
});

// Изоляция областей имён: без экспортов TS трактует скрипт как глобальный
// и константы конфликтуют с соседними scripts/*.ts.
export {};
