// Сервис «Интеграции»: предустановленные подключения SMS-провайдеров. Токен
// SMS.Tech сохраняется из панели
// (AppSettings.smstechToken) либо задаётся через env; в API отдаётся только факт
// его наличия — сам токен наружу никогда не возвращается.
// Домен: внешние шлюзы отправки — SMS.Tech (агрегатор), Т2 (оператор) и МТС
// OmniChannel (оператор, Basic Auth), плюс песочница; сами адаптеры —
// src/lib/provider/*.
// Вызывается из API-роутов: /api/v1/integrations (GET-карточки),
// /integrations/activate (POST), /integrations/smstech/token | check | test,
// /integrations/t2/credentials | check | test,
// /integrations/mts/credentials | check | test (POST).
// Таблицы Prisma: AppSettings (provider + шифрованные секреты enc:v1),
// SmsMessage (тестовые отправки), AuditLog (секреты — только факт/длина).
import { z } from 'zod';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import { decryptSecret, encryptSecret, maskLogin, maskSecret } from '@/lib/security/secrets';
import type { SessionUser } from '@/lib/security/session';
import { getSettings } from '@/lib/services/settings';
import { normalizePhone } from '@/lib/services/clients';
import { countSegments } from '@/lib/sms/segments';
import { TemporaryProviderError } from '@/lib/provider/types';
import {
  SmsTechProvider,
  checkSmsTechConnection,
  invalidateSmstechTokenCache,
  smstechAccessToken,
  type SmsTechCheckResult,
} from '@/lib/provider/smstech';
import {
  T2Provider,
  checkT2Connection,
  invalidateT2CredentialsCache,
  t2Credentials,
  type T2CheckResult,
} from '@/lib/provider/t2';
import {
  MtsProvider,
  checkMtsConnection,
  invalidateMtsCredentialsCache,
  mtsCredentials,
  type MtsCheckResult,
} from '@/lib/provider/mts';

/** Идентификаторы поддерживаемых провайдеров. */
export type ProviderId = 'sandbox' | 'smstech' | 't2' | 'mts';

/** Реестр провайдеров для UI (порядок = порядок карточек на странице). */
export const PROVIDER_IDS: ProviderId[] = ['smstech', 't2', 'mts', 'sandbox'];

/** Строка → ProviderId; неизвестное значение — 422. */
function toProviderId(value: string): ProviderId {
  if ((PROVIDER_IDS as string[]).includes(value)) return value as ProviderId;
  throw new ApiError(422, 'Ошибка валидации', `Неизвестный провайдер: ${value}`);
}

/** Сводное состояние интеграций для карточек «подключений». */
export async function listIntegrations(baseUrl: string): Promise<Record<string, unknown>> {
  const settings = await getSettings();
  const active = toProviderId(settings.provider);
  const smstechTokenSet = (await smstechAccessToken()) !== '';
  const t2CredsSet = (await t2Credentials()) !== null;
  const mtsCredsSet = (await mtsCredentials()) !== null;

  // Секреты: одно чтение строки → расшифровка → подсказка-маска и источник
  // (панель или env). Сами значения наружу не отдаются — только маска.
  let smstechPanel = '';
  let t2PanelLogin = '';
  let t2PanelPassword = '';
  let mtsPanelLogin = '';
  let mtsPanelPassword = '';
  try {
    const row = await db.appSettings.findUnique({
      where: { id: 'app' },
      select: { smstechToken: true, t2Login: true, t2Password: true, mtsLogin: true, mtsPassword: true },
    });
    smstechPanel = decryptSecret(row?.smstechToken ?? '').trim();
    t2PanelLogin = decryptSecret(row?.t2Login ?? '').trim();
    t2PanelPassword = decryptSecret(row?.t2Password ?? '').trim();
    mtsPanelLogin = decryptSecret(row?.mtsLogin ?? '').trim();
    mtsPanelPassword = decryptSecret(row?.mtsPassword ?? '').trim();
  } catch {
    // БД недоступна (db:push и т.п.) — карточки без подсказок
  }
  const smstechEnv = (process.env.SMSTECH_ACCESS_TOKEN ?? '').trim();
  const t2EnvLogin = (process.env.T2_LOGIN ?? '').trim();
  const t2EnvPassword = (process.env.T2_PASSWORD ?? '').trim();
  const mtsEnvLogin = (process.env.MTS_LOGIN ?? '').trim();
  const mtsEnvPassword = (process.env.MTS_PASSWORD ?? '').trim();

  return {
    activeProvider: active,
    providers: [
      {
        id: 'smstech',
        displayName: 'SMS.Tech',
        kind: 'aggregator',
        title: 'SMS.Tech — агрегатор отправки',
        description:
          'Единая точка входа через десятки провайдеров: шлюз выбирает выгодный маршрут по оператору получателя. Каналы SMS/Email, статусы webhook-ами, тарификация по сегментам.',
        active: active === 'smstech',
        // «Подключён» = токен сохранён (панель или env); активен = выбран провайдером
        configured: smstechTokenSet,
        secret: {
          stored: smstechPanel !== '' ? 'panel' : smstechEnv !== '' ? 'env' : null,
          hint: smstechPanel !== '' ? maskSecret(smstechPanel) : null,
          envName: 'SMSTECH_ACCESS_TOKEN',
        },
        defaultSenderName: settings.defaultSenderName,
        // Альфа-имя уже зарегистрировано у операторов в аккаунте SMS.Tech
        registeredSenderName: 'DemoBrand',
        webhook: {
          path: '/api/v1/webhooks/smstech',
          url: `${baseUrl.replace(/\/$/, '')}/api/v1/webhooks/smstech`,
          secretSet: (process.env.SMSTECH_WEBHOOK_SECRET ?? '').trim() !== '',
          method: 'POST',
        },
        envKeys: { webhookSecret: 'SMSTECH_WEBHOOK_SECRET' },
        cabinetUrl: 'https://hub.sms.tech',
        limits: {
          perPhonePerHour: 30,
          recommendedRps: 30,
          statusWaitDays: 3,
          segmentGsm7: '160/153 симв.',
          segmentUcs2: '70/67 симв.',
        },
      },
      {
        id: 't2',
        displayName: 'Т2 «Бизнес SMS»',
        kind: 'operator',
        title: 'Т2 — оператор связи (Бизнес SMS)',
        description:
          'Прямой оператор: отправка SMS по подписанному договору через HTTP API bsms.t2.ru. Статусы доставки webhook-ом, идемпотентность ext_id, каскады Viber/Social при необходимости.',
        active: active === 't2',
        // «Подключён» = логин/пароль сохранены (панель или env); активен = выбран провайдером
        configured: t2CredsSet,
        secret: {
          stored:
            t2PanelLogin !== '' && t2PanelPassword !== ''
              ? 'panel'
              : t2EnvLogin !== '' && t2EnvPassword !== ''
                ? 'env'
                : null,
          hint: t2PanelLogin !== '' ? maskLogin(t2PanelLogin) : null,
          envName: 'T2_LOGIN / T2_PASSWORD',
        },
        defaultSenderName: settings.defaultSenderName,
        webhook: {
          path: '/api/v1/webhooks/t2',
          url: `${baseUrl.replace(/\/$/, '')}/api/v1/webhooks/t2`,
          secretSet: (process.env.T2_WEBHOOK_SECRET ?? '').trim() !== '',
          method: 'GET',
        },
        envKeys: { webhookSecret: 'T2_WEBHOOK_SECRET' },
        cabinetUrl: 'https://bsms.t2.ru',
        limits: {
          segmentGsm7: '140/153 симв.',
          segmentUcs2: '70/67 симв.',
        },
      },
      {
        id: 'mts',
        displayName: 'МТС OmniChannel',
        kind: 'operator',
        title: 'МТС OmniChannel — оператор связи (A2P SMS)',
        description:
          'Прямой оператор МТС: A2P SMS через HTTP API omnichannel.mts.ru (Basic Auth, нейминг из договора). Статусы доставки коллбэками и запросами /messages/info, сообщения до 10 сегментов.',
        active: active === 'mts',
        // «Подключён» = логин/пароль сохранены (панель или env); активен = выбран провайдером
        configured: mtsCredsSet,
        secret: {
          stored:
            mtsPanelLogin !== '' && mtsPanelPassword !== ''
              ? 'panel'
              : mtsEnvLogin !== '' && mtsEnvPassword !== ''
                ? 'env'
                : null,
          hint: mtsPanelLogin !== '' ? maskLogin(mtsPanelLogin) : null,
          envName: 'MTS_LOGIN / MTS_PASSWORD',
        },
        defaultSenderName: settings.defaultSenderName,
        webhook: {
          path: '/api/v1/webhooks/mts',
          url: `${baseUrl.replace(/\/$/, '')}/api/v1/webhooks/mts`,
          secretSet: (process.env.MTS_WEBHOOK_SECRET ?? '').trim() !== '',
          method: 'POST',
        },
        envKeys: { webhookSecret: 'MTS_WEBHOOK_SECRET' },
        cabinetUrl: 'https://omnichannel.mts.ru',
        limits: {
          // Раздел «Лимиты и ограничения»: SMS ≤10 сегментов (670 кириллица / 1530 латиница)
          statusWaitDays: 3, // ttl_sec ≤259200 (3 дня) — срок ожидания статуса доставки
          segmentGsm7: '153/1530 симв. (сегм./макс.)',
          segmentUcs2: '67/670 симв. (сегм./макс.)',
        },
      },
      {
        id: 'sandbox',
        displayName: 'Песочница',
        kind: 'sandbox',
        title: 'Песочница — без реальной отправки',
        description:
          'Имитация провайдера для разработки и приёмки: SMS мгновенно «доставляется», деньги не тратятся. Данные синтетические.',
        active: active === 'sandbox',
        configured: true,
      },
    ],
  };
}

/** Выбор активного провайдера (кнопка «Сделать активным» на карточке). */
export const activateProviderSchema = z.object({
  provider: z.enum(['sandbox', 'smstech', 't2', 'mts']),
  /** Имя отправителя по умолчанию — упрощённая настройка при активации. */
  senderName: z
    .string()
    .trim()
    .max(20, 'Имя отправителя — максимум 20 символов')
    .regex(/^[A-Za-z0-9\-\s]*$/, 'Имя отправителя: латиница, цифры, дефис')
    .optional(),
});

/** Активация провайдера. Гварды: SMS.Tech — обязательно зарегистрированное
 *  альфа-имя и сохранённый токен; Т2 — shortcode (латиница/цифры ≤11) и
 *  сохранённые креды; МТС — нейминг sms_address (латиница/цифры/дефис ≤11) и
 *  сохранённые креды (422). Побочные эффекты: запись AppSettings (provider,
 *  возможно defaultSenderName), audit-лог ACTIVATE. */
export async function activateProvider(
  dto: z.infer<typeof activateProviderSchema>,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const provider = toProviderId(dto.provider);

  if (provider === 'smstech') {
    // SMS.Tech требует зарегистрированное альфа-имя (раздел 15 документации)
    const settings = await getSettings();
    const sender = dto.senderName?.trim() || settings.defaultSenderName.trim();
    if (sender === '') {
      throw new ApiError(
        422,
        'Ошибка валидации',
        'Для SMS.Tech обязательно имя отправителя: укажите его в форме подключения или в настройках',
      );
    }
    if ((await smstechAccessToken()) === '') {
      throw new ApiError(
        422,
        'SMS.Tech не настроен',
        'Сначала сохраните токен доступа в форме подключения SMS.Tech',
      );
    }
  }

  if (provider === 't2') {
    // Т2: shortcode — разрешённое имя отправителя, до 11 символов ASCII (раздел 4)
    const settings = await getSettings();
    const sender = dto.senderName?.trim() || settings.defaultSenderName.trim();
    if (sender === '') {
      throw new ApiError(
        422,
        'Ошибка валидации',
        'Для Т2 обязательно имя отправителя (shortcode): укажите его в форме подключения или в настройках',
      );
    }
    if (!/^[A-Za-z0-9]{1,11}$/.test(sender)) {
      throw new ApiError(
        422,
        'Ошибка валидации',
        'Имя отправителя Т2 (shortcode): латиница/цифры без пробелов, до 11 символов',
      );
    }
    if ((await t2Credentials()) === null) {
      throw new ApiError(
        422,
        'Т2 не настроен',
        'Сначала сохраните логин/пароль подключения в форме подключения Т2',
      );
    }
  }

  if (provider === 'mts') {
    // МТС: sms_address (нейминг) — сервисный номер из договора с МТС,
    // буквенно-цифровое обозначение (глоссарий/раздел «Отправка SMS»);
    // для совместимости с общим полем допускаем латиницу/цифры/дефис ≤11
    const settings = await getSettings();
    const sender = dto.senderName?.trim() || settings.defaultSenderName.trim();
    if (sender === '') {
      throw new ApiError(
        422,
        'Ошибка валидации',
        'Для МТС обязательно имя отправителя (нейминг): укажите его в форме подключения или в настройках',
      );
    }
    if (!/^[A-Za-z0-9\-]{1,11}$/.test(sender)) {
      throw new ApiError(
        422,
        'Ошибка валидации',
        'Имя отправителя МТС (нейминг): латиница/цифры/дефис, до 11 символов',
      );
    }
    if ((await mtsCredentials()) === null) {
      throw new ApiError(
        422,
        'МТС не настроен',
        'Сначала сохраните логин/пароль подключения (system_id из договора) в форме подключения МТС',
      );
    }
  }

  await getSettings(); // гарантируем существование singleton-строки
  const data: Record<string, unknown> = { provider };
  if (dto.senderName !== undefined && dto.senderName.trim() !== '') {
    data.defaultSenderName = dto.senderName.trim();
  }
  const row = await db.appSettings.update({ where: { id: 'app' }, data });
  await logAudit({
    user,
    action: AuditAction.ACTIVATE,
    entityType: AuditEntity.SETTINGS,
    entityId: 'app',
    details: { provider, senderName: data.defaultSenderName ?? null },
    ip,
  });
  return { provider: row.provider, defaultSenderName: row.defaultSenderName };
}

/** Сохранение токена доступа SMS.Tech из панели (поле «Токен доступа»).
 *  Пустая строка — очистить сохранённый токен. Значение в API не возвращается. */
export const saveSmstechTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .max(512, 'Токен — максимум 512 символов')
    .refine((t) => t === '' || t.length >= 8, 'Токен слишком короткий — проверьте значение из кабинета'),
});

/** Сохранение токена SMS.Tech: шифрование AES-256-GCM (enc:v1:…), сброс
 *  кэша провайдера. Побочные эффекты: запись AppSettings.smstechToken,
 *  инвалидация кэша, audit-лог ACTIVATE/DELETE (только факт и длина). */
export async function saveSmstechToken(
  dto: z.infer<typeof saveSmstechTokenSchema>,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const token = dto.token.trim();
  await getSettings(); // гарантируем существование singleton-строки
  // Шифруем перед записью: в БД — только «enc:v1:…», plaintext не кладём
  await db.appSettings.update({ where: { id: 'app' }, data: { smstechToken: encryptSecret(token) } });
  invalidateSmstechTokenCache();

  await logAudit({
    user,
    action: token === '' ? AuditAction.DELETE : AuditAction.ACTIVATE,
    entityType: AuditEntity.SETTINGS,
    entityId: 'app',
    // сам токен в аудит не пишем — только факт и длину
    details: { provider: 'smstech', tokenSaved: token !== '', tokenLength: token.length },
    ip,
  });

  return { ok: true, tokenSet: token !== '' };
}

/** Сохранение логина/пароля подключения Т2 из панели (поля «Логин/Пароль Т2»).
 *  Пустые строки — очистить сохранённые креды. Значения в API не возвращаются. */
export const saveT2CredentialsSchema = z.object({
  login: z
    .string()
    .trim()
    .max(128, 'Логин — максимум 128 символов')
    .refine((v) => v === '' || v.length >= 2, 'Логин слишком короткий — проверьте значение из кабинета'),
  password: z
    .string()
    .max(128, 'Пароль — максимум 128 символов')
    .refine((v) => v === '' || v.length >= 4, 'Пароль слишком короткий — проверьте значение из кабинета'),
});

/** Сохранение кредов Т2: оба поля или оба пустые (очистка); шифрование
 *  AES-256-GCM, сброс кэша провайдера. Побочные эффекты: запись
 *  AppSettings.t2Login/t2Password, инвалидация кэша, audit-лог ACTIVATE/DELETE. */
export async function saveT2Credentials(
  dto: z.infer<typeof saveT2CredentialsSchema>,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const login = dto.login.trim();
  const password = dto.password.trim();
  // Оба поля пустые — очистка; частичный ввод не допускаем
  if ((login === '') !== (password === '')) {
    throw new ApiError(422, 'Ошибка валидации', 'Укажите и логин, и пароль (либо оба поля пустыми для удаления)');
  }
  await getSettings(); // гарантируем существование singleton-строки
  // Шифруем перед записью: в БД — только «enc:v1:…», plaintext не кладём
  await db.appSettings.update({
    where: { id: 'app' },
    data: { t2Login: encryptSecret(login), t2Password: encryptSecret(password) },
  });
  invalidateT2CredentialsCache();

  await logAudit({
    user,
    action: login === '' ? AuditAction.DELETE : AuditAction.ACTIVATE,
    entityType: AuditEntity.SETTINGS,
    entityId: 'app',
    // сами креды в аудит не пишем — только факт
    details: { provider: 't2', credentialsSaved: login !== '' },
    ip,
  });

  return { ok: true, credentialsSet: login !== '' };
}

/** Проверка подключения Т2 без отправки SMS (operation=status, раздел 6). */
export async function checkT2(): Promise<T2CheckResult> {
  return checkT2Connection();
}

/** Схема теста Т2 (кнопка на карточке подключения): телефон, опциональные
 *  текст ≤480 и sender ≤11. */
export const testT2Schema = z.object({
  phone: z.string().trim().min(1, 'Телефон получателя обязателен'),
  text: z.string().trim().min(1).max(480).optional(),
  sender: z.string().trim().max(11).optional(),
});

/** Тестовая отправка через Т2: реальный вызов провайдера (временные ошибки —
 *  FAILED без ретрая) + запись в SMS-лог и аудит. Побочные эффекты: запись
 *  SmsMessage (SENT/FAILED), отправка реального SMS, audit-лог CREATE. */
export async function sendT2Test(
  dto: z.infer<typeof testT2Schema>,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const phone = normalizePhone(dto.phone);
  if (!phone) {
    throw new ApiError(422, 'Ошибка валидации', 'Некорректный номер телефона (ожидается РФ, например +79001234567)');
  }
  const settings = await getSettings();
  const sender = dto.sender?.trim() || settings.defaultSenderName.trim();
  if (!/^[A-Za-z0-9]{1,11}$/.test(sender)) {
    throw new ApiError(422, 'Ошибка валидации', 'Имя отправителя Т2 (shortcode): латиница/цифры, до 11 символов');
  }
  const text = dto.text?.trim() || 'Тестовое сообщение trigger (интеграция Т2)';
  const seg = countSegments(text);

  const provider = new T2Provider();
  let result;
  try {
    result = await provider.send({
      phone,
      body: text,
      sender,
      idempotencyScope: `test:${user.id}:${Date.now()}`,
      tags: ['trigger', 'test'],
    });
  } catch (e) {
    // Временные ошибки (таймаут/сеть/throttling) не ретраим тестом — честный FAILED в логе
    if (e instanceof TemporaryProviderError) {
      result = { ok: false, error: e.message };
    } else {
      throw e;
    }
  }

  // Тестовая отправка попадает в SMS-лог — единая история и аудит
  const row = await db.smsMessage.create({
    data: {
      phone,
      body: text,
      segments: result.segmentsCount ?? seg.segments,
      provider: 't2',
      providerMessageId: result.ok ? (result.providerMessageId ?? null) : null,
      templateName: 'Тест Т2',
      status: result.ok ? 'SENT' : 'FAILED',
      error: result.ok ? null : (result.error ?? 'Ошибка отправки'),
      sentAt: result.ok ? new Date() : null,
    },
  });

  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.SMS,
    entityId: row.id,
    details: { provider: 't2', test: true, phone, ok: result.ok },
    ip,
  });

  return {
    ok: result.ok,
    code: result.ok ? result.providerMessageId : null,
    segments: result.segmentsCount ?? seg.segments,
    smsId: row.id,
    error: result.ok ? null : result.error,
  };
}

/** Сохранение логина/пароля подключения МТС OmniChannel из панели (поля
 *  «Логин/Пароль МТС»). Пустые строки — очистить сохранённые креды. Значения
 *  в API не возвращаются. */
export const saveMtsCredentialsSchema = z.object({
  login: z
    .string()
    .trim()
    .max(128, 'Логин — максимум 128 символов')
    .refine((v) => v === '' || v.length >= 2, 'Логин слишком короткий — проверьте значение из договора (system_id)'),
  password: z
    .string()
    .trim()
    .max(128, 'Пароль — максимум 128 символов')
    .refine((v) => v === '' || v.length >= 4, 'Пароль слишком короткий — проверьте значение из договора'),
});

/** Сохранение кредов МТС: оба поля или оба пустые (очистка); шифрование
 *  AES-256-GCM, сброс кэша провайдера. Побочные эффекты: запись
 *  AppSettings.mtsLogin/mtsPassword, инвалидация кэша, audit-лог ACTIVATE/DELETE. */
export async function saveMtsCredentials(
  dto: z.infer<typeof saveMtsCredentialsSchema>,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const login = dto.login.trim();
  const password = dto.password.trim();
  // Оба поля пустые — очистка; частичный ввод не допускаем
  if ((login === '') !== (password === '')) {
    throw new ApiError(422, 'Ошибка валидации', 'Укажите и логин, и пароль (либо оба поля пустыми для удаления)');
  }
  await getSettings(); // гарантируем существование singleton-строки
  // Шифруем перед записью: в БД — только «enc:v1:…», plaintext не кладём
  await db.appSettings.update({
    where: { id: 'app' },
    data: { mtsLogin: encryptSecret(login), mtsPassword: encryptSecret(password) },
  });
  invalidateMtsCredentialsCache();

  await logAudit({
    user,
    action: login === '' ? AuditAction.DELETE : AuditAction.ACTIVATE,
    entityType: AuditEntity.SETTINGS,
    entityId: 'app',
    // сами креды в аудит не пишем — только факт
    details: { provider: 'mts', credentialsSaved: login !== '' },
    ip,
  });

  return { ok: true, credentialsSet: login !== '' };
}

/** Проверка подключения МТС без отправки SMS (POST /messages/info с пустым
 *  int_ids — валидация тела проваливается уже ПОСЛЕ авторизации). */
export async function checkMts(): Promise<MtsCheckResult> {
  return checkMtsConnection();
}

/** Схема теста МТС (кнопка на карточке подключения): телефон, опциональные
 *  текст ≤480 и sender ≤11 (нейминг sms_address). */
export const testMtsSchema = z.object({
  phone: z.string().trim().min(1, 'Телефон получателя обязателен'),
  text: z.string().trim().min(1).max(480).optional(),
  sender: z.string().trim().max(11).optional(),
});

/** Тестовая отправка через МТС OmniChannel: реальный вызов провайдера
 *  (временные ошибки — FAILED без ретрая) + запись в SMS-лог и аудит.
 *  Побочные эффекты: запись SmsMessage (SENT/FAILED), отправка реального SMS,
 *  audit-лог CREATE. */
export async function sendMtsTest(
  dto: z.infer<typeof testMtsSchema>,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const phone = normalizePhone(dto.phone);
  if (!phone) {
    throw new ApiError(422, 'Ошибка валидации', 'Некорректный номер телефона (ожидается РФ, например +79001234567)');
  }
  const settings = await getSettings();
  const sender = dto.sender?.trim() || settings.defaultSenderName.trim();
  if (!/^[A-Za-z0-9\-]{1,11}$/.test(sender)) {
    throw new ApiError(422, 'Ошибка валидации', 'Имя отправителя МТС (нейминг): латиница/цифры/дефис, до 11 символов');
  }
  const text = dto.text?.trim() || 'Тестовое сообщение trigger (интеграция МТС)';
  const seg = countSegments(text);

  const provider = new MtsProvider();
  let result;
  try {
    result = await provider.send({
      phone,
      body: text,
      sender,
      idempotencyScope: `test:${user.id}:${Date.now()}`,
      tags: ['trigger', 'test'],
    });
  } catch (e) {
    // Временные ошибки (таймаут/сеть/лимит скорости) не ретраим тестом — честный FAILED в логе
    if (e instanceof TemporaryProviderError) {
      result = { ok: false, error: e.message };
    } else {
      throw e;
    }
  }

  // Тестовая отправка попадает в SMS-лог — единая история и аудит
  const row = await db.smsMessage.create({
    data: {
      phone,
      body: text,
      segments: result.segmentsCount ?? seg.segments,
      provider: 'mts',
      providerMessageId: result.ok ? (result.providerMessageId ?? null) : null,
      templateName: 'Тест МТС',
      status: result.ok ? 'SENT' : 'FAILED',
      error: result.ok ? null : (result.error ?? 'Ошибка отправки'),
      sentAt: result.ok ? new Date() : null,
    },
  });

  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.SMS,
    entityId: row.id,
    details: { provider: 'mts', test: true, phone, ok: result.ok },
    ip,
  });

  return {
    ok: result.ok,
    code: result.ok ? result.providerMessageId : null,
    segments: result.segmentsCount ?? seg.segments,
    smsId: row.id,
    error: result.ok ? null : result.error,
  };
}

/** Схема проверки SMS.Tech (ResolveOperators, раздел 12): опциональный
 *  телефон — для резолва оператора. */
export const checkSmstechSchema = z.object({
  phone: z.string().trim().optional(),
});

/** Проверка подключения SMS.Tech без отправки (номер опционально — для
 *  резолва оператора). Побочных эффектов нет (внешний вызов + чтение секрета). */
export async function checkSmstech(
  dto: z.infer<typeof checkSmstechSchema>,
): Promise<SmsTechCheckResult> {
  const phone = dto.phone ? normalizePhone(dto.phone) : null;
  if (dto.phone && !phone) {
    throw new ApiError(422, 'Ошибка валидации', 'Некорректный номер телефона для проверки');
  }
  return checkSmsTechConnection(phone ?? undefined);
}

/** Схема теста SMS.Tech (кнопка на карточке подключения): телефон,
 *  опциональные текст ≤480 и sender ≤255. */
export const testSmstechSchema = z.object({
  phone: z.string().trim().min(1, 'Телефон получателя обязателен'),
  text: z.string().trim().min(1).max(480).optional(),
  sender: z.string().trim().max(255).optional(),
});

/** Тестовая отправка через SMS.Tech: реальный вызов провайдера (временные
 *  ошибки — FAILED без ретрая) + запись в SMS-лог и аудит. Побочные эффекты:
 *  запись SmsMessage (SENT/FAILED), отправка реального SMS, audit-лог CREATE. */
export async function sendSmstechTest(
  dto: z.infer<typeof testSmstechSchema>,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const phone = normalizePhone(dto.phone);
  if (!phone) {
    throw new ApiError(422, 'Ошибка валидации', 'Некорректный номер телефона (ожидается РФ, например +79001234567)');
  }
  const settings = await getSettings();
  const sender = dto.sender?.trim() || settings.defaultSenderName.trim();
  const text = dto.text?.trim() || 'Тестовое сообщение trigger (интеграция SMS.Tech)';
  const seg = countSegments(text);

  const provider = new SmsTechProvider();
  let result;
  try {
    result = await provider.send({
      phone,
      body: text,
      sender: sender || null,
      idempotencyScope: `test:${user.id}:${Date.now()}`,
      tags: ['trigger', 'test'],
    });
  } catch (e) {
    // Временные ошибки (таймаут/сеть/5xx) не ретраим тестом — честный FAILED в логе
    if (e instanceof TemporaryProviderError) {
      result = { ok: false, error: e.message };
    } else {
      throw e;
    }
  }

  // Тестовая отправка попадает в SMS-лог — единая история и аудит
  const row = await db.smsMessage.create({
    data: {
      phone,
      body: text,
      segments: result.segmentsCount ?? seg.segments,
      provider: 'smstech',
      providerMessageId: result.ok ? (result.providerMessageId ?? null) : null,
      templateName: 'Тест SMS.Tech',
      status: result.ok ? 'SENT' : 'FAILED',
      error: result.ok ? null : (result.error ?? 'Ошибка отправки'),
      sentAt: result.ok ? new Date() : null,
    },
  });

  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.SMS,
    entityId: row.id,
    details: { provider: 'smstech', test: true, phone, ok: result.ok },
    ip,
  });

  return {
    ok: result.ok,
    code: result.ok ? result.providerMessageId : null,
    segments: result.segmentsCount ?? seg.segments,
    smsId: row.id,
    error: result.ok ? null : result.error,
  };
}
