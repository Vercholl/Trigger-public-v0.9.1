// Диагностика кредов МТС OmniChannel (запуск: bun run scripts/mts-creds-diag.ts [--send]).
// Отвечает на вопрос «шлюз доступен, но логин/пароль отклонены (код 804: Bad
// credentials) — почему?» и используется при приёмке/разборе инцидентов.
//
// Режим по умолчанию (бесплатные зонды, отправки SMS нет):
//   [1] PROD  /messages/info + сохранённые креды, int_ids=[] — зонд кнопки
//       «Проверить подключение»: 804 «Bad credentials» = шлюз отверг креды;
//       422/602/612 «…in body…» = креды приняты (упала валидация пустого тела);
//   [2] STAGE — то же на тестовом окружении (креды могут быть выданы для STAGE);
//   [3] PROD  + заведомо ложные креды — бейзлайн отказа (как выглядит «чужой» логин).
//
// Режим --send (ОДНА реальная попытка отправки недоставляемого сообщения:
// незарегистрированный нейминг ZZCHK + несуществующий номер 70000000000 —
// в оператор не уйдёт, но при валидных кредах попадает в платформу):
//   [4] PROD  /messages полное тело + сохранённые креды — ОДНОЗНАЧНЫЙ вердикт:
//       802 «Bad credentials» = креды отвергнуты шлюзом отправки (то, что
//       документация V.1.14 описывает кодом 802); любой другой ответ = креды
//       приняты платформой;
//   [5] PROD  то же с ложными креды — контроль (ожидается 802).
// Флаг используйте, когда бесплатный зонд даёт отказ, а уверенности в кредах
// нет: это единственный способ отличить «неверные креды» от «нет права на
// запрос статусов». Не запускайте без необходимости — при валидных креды
// создаётся одна недоставляемая запись в платформе МТС.
//
// Секреты в вывод не печатаются: только длина, маска первых символов логина и
// признаки опечаток (кириллица/пробелы). Путь кредов проверен alongside
// (форма → trim → AES-256-GCM → Basic): до шлюза доходит ровно введённое.
import { randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { decryptSecret } from '@/lib/security/secrets';

const PROD = 'https://omnichannel.mts.ru';
const STAGE = 'https://stage.omnichannel.mts.ru';
const TIMEOUT_MS = 10_000;

/** Описание секрета без раскрытия: длина, кириллица (⚠️ опечатка раскладки), пробелы. */
function describe(label: string, v: string): string {
  const flags: string[] = [];
  if (/[А-Яа-яЁё]/.test(v)) flags.push('ЕСТЬ КИРИЛЛИЦА (возможна опечатка раскладки!)');
  if (/\s/.test(v)) flags.push('есть пробельные символы');
  return `${label}: длина ${v.length}${flags.length > 0 ? ` — ${flags.join(', ')}` : ''}`;
}

async function probe(base: string, path: string, body: unknown, auth?: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (auth) headers.Authorization = `Basic ${auth}`;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = (await res.text()).trim();
    return `HTTP ${res.status} — ${text.slice(0, 240)}`;
  } catch (e) {
    return `СЕТЬ — ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  } finally {
    clearTimeout(timer);
  }
}

/** Недоставляемое тело отправки: нейминг не зарегистрирован, номер не существует. */
function undeliverableBody(): Record<string, unknown> {
  return {
    messages: [
      {
        content: { short_text: 'ping' },
        to: [{ msisdn: '70000000000', message_id: randomUUID() }],
        from: { sms_address: 'ZZCHK' },
      },
    ],
  };
}

async function main(): Promise<void> {
  const withSend = process.argv.includes('--send');
  console.log('=== Диагностика кредов МТС OmniChannel ===');
  const row = await db.appSettings.findUnique({
    where: { id: 'app' },
    select: { mtsLogin: true, mtsPassword: true },
  });
  const login = decryptSecret(row?.mtsLogin ?? '').trim();
  const password = decryptSecret(row?.mtsPassword ?? '').trim();
  const envLogin = (process.env.MTS_LOGIN ?? '').trim();
  const envPassword = (process.env.MTS_PASSWORD ?? '').trim();

  if (login === '' || password === '') {
    console.log(
      `Креды в БД: логин ${login === '' ? 'НЕ задан' : 'задан'}, пароль ${password === '' ? 'НЕ задан' : 'задан'}; ` +
        `env MTS_LOGIN/MTS_PASSWORD: ${envLogin === '' ? 'пусты' : 'задан'} / ${envPassword === '' ? 'пусты' : 'задан'} — ` +
        'проверять нечего, сохраните креды на вкладке «Интеграции»',
    );
    return;
  }

  console.log(describe('Логин (панель, расшифрован)', login));
  console.log(describe('Пароль (панель, расшифрован)', password));
  console.log(`Маска логина: ${login.slice(0, 3)}•••`);
  const goodAuth = Buffer.from(`${login}:${password}`, 'utf8').toString('base64');
  const badAuth = Buffer.from('zz-nonexistent-login:zz-wrong-password-123', 'utf8').toString('base64');

  console.log('\n--- Бесплатные зонды (кнопка «Проверить подключение») ---');
  console.log(`[1] PROD  + сохранённые креды    → ${await probe(PROD, '/http-api/v1/messages/info', { int_ids: [] }, goodAuth)}`);
  console.log(`[2] STAGE + сохранённые креды    → ${await probe(STAGE, '/http-api/v1/messages/info', { int_ids: [] }, goodAuth)}`);
  console.log(`[3] PROD  + заведомо неверные    → ${await probe(PROD, '/http-api/v1/messages/info', { int_ids: [] }, badAuth)}`);
  console.log('Трактовка: 804 «Bad credentials» = шлюз отверг креды (код 804 на /messages/info —');
  console.log('особенность живого шлюза, в документации отказ кредов описан кодом 802);');
  console.log('422/602/612 «…in body…» или 200 = креды приняты.');

  if (withSend) {
    console.log('\n--- Режим --send: окончательный вердикт по кредам (недоставляемое сообщение) ---');
    console.log(`[4] PROD  /messages + сохранённые креды → ${await probe(PROD, '/http-api/v1/messages', undeliverableBody(), goodAuth)}`);
    console.log(`[5] PROD  /messages + заведомо неверные → ${await probe(PROD, '/http-api/v1/messages', undeliverableBody(), badAuth)}`);
    console.log('Трактовка: 802 в [4] = креды отвергнуты и шлюзом отправки; любой другой ответ');
    console.log('в [4] (при 802 в [5]) = креды приняты платформой — причина отказа зонда статусов');
    console.log('в отсутствии права на /messages/info у этого system_id.');
  } else {
    console.log('\nДля окончательного вердикта по кредам (недоставляемая отправка): bun run scripts/mts-creds-diag.ts --send');
  }
}

void main().finally(() => {
  void db.$disconnect().finally(() => process.exit(0));
});
