// Настройки приложения: singleton-строка id="app". При первом чтении строка
// создаётся со значениями из env (ADVERTISER_NAME, SMS_PROVIDER, DEFAULT_TIMEZONE).
// Домен: глобальные операционные параметры — провайдер SMS, тихие часы, лимиты,
// дисклеймер, отписка, зона по умолчанию.
// Вызывается из API-роута: /api/v1/settings (GET/PUT); getSettings — практически
// всеми сервисами (шаблоны/рассылки/воркер/комплаенс) и публичной отпиской.
// Таблицы Prisma: AppSettings (единственная строка), AuditLog через logAudit.
import { z } from 'zod';
import type { AppSettings } from '@prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';
import { validateDisclaimerTemplate } from '@/lib/compliance/disclaimer-text';

const SETTINGS_ID = 'app';

/** Чтение настроек (ленивый бутстрап): строки нет — создаётся из env;
 *  гонка параллельного создания ловится и перечитывается. Побочный эффект:
 *  возможна ОДНА вставка AppSettings при первом обращении. */
export async function getSettings(): Promise<AppSettings> {
  let row = await db.appSettings.findUnique({ where: { id: SETTINGS_ID } });
  if (!row) {
    try {
      row = await db.appSettings.create({
        data: {
          id: SETTINGS_ID,
          advertiserName: process.env.ADVERTISER_NAME?.trim() || 'ДемоКомпания',
          provider:
            process.env.SMS_PROVIDER === 'smstech' ||
            process.env.SMS_PROVIDER === 't2' ||
            process.env.SMS_PROVIDER === 'mts'
              ? process.env.SMS_PROVIDER
              : 'sandbox',
          defaultTimezone: process.env.DEFAULT_TIMEZONE?.trim() || 'Asia/Novosibirsk',
        },
      });
    } catch {
      // параллельное создание двумя запросами — читаем существующую строку
      row = await db.appSettings.findUniqueOrThrow({ where: { id: SETTINGS_ID } });
    }
  }
  return row;
}

/** Валидная IANA-зона: через Intl.supportedValuesOf, при недоступности —
 *  эвристика формата «область/город» ≤64. */
function isValidIanaTimezone(tz: string): boolean {
  try {
    const zones = Intl.supportedValuesOf?.('timeZone');
    if (Array.isArray(zones)) return zones.includes(tz);
  } catch {
    // supportedValuesOf недоступен — простая проверка формата
  }
  return tz.length > 0 && tz.length <= 64 && tz.includes('/');
}

/** Схема обновления: рекламодатель ≤200, тихие часы 0–23, дневные лимиты ≥1,
 *  провайдер sandbox/smstech/t2/mts, база отписок ≤500, зона по умолчанию ≤64,
 *  имя отправителя ≤20 (латиница/цифры/дефис), приписка ≤300, ретенция
 *  inbox 0–3650 дней (0 — не архивировать). */
export const updateSettingsSchema = z.object({
  advertiserName: z.string().trim().min(1, 'Название рекламодателя обязательно').max(200),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
  dailyClientLimit: z.number().int().min(1, 'Лимит должен быть не менее 1'),
  systemDailyLimit: z.number().int().min(1, 'Лимит должен быть не менее 1'),
  provider: z.enum(['sandbox', 'smstech', 't2', 'mts']),
  unsubscribeBaseUrl: z.string().trim().max(500),
  defaultTimezone: z.string().trim().min(1).max(64),
  // Имя отправителя по умолчанию (латиница/цифры/дефис, до 20 симв.)
  defaultSenderName: z
    .string()
    .trim()
    .max(20, 'Имя отправителя — максимум 20 символов')
    .regex(/^[A-Za-z0-9\-\s]*$/, 'Имя отправителя: латиница, цифры, дефис'),
  // Короткие ссылки отписки и редактируемый текст приписки
  useShortLinks: z.boolean(),
  marketingDisclaimer: z.string().trim().max(300, 'Приписка — максимум 300 символов'),
  // Авто-архивация обработанных событий и завершённых задач (0 = не удалять)
  inboxRetentionDays: z
    .number()
    .int()
    .min(0, 'Срок хранения не может быть отрицательным')
    .max(3650, 'Срок хранения — максимум 3650 дней'),
  // Ретеншн журнала MessageEvent с выгрузкой в gz-архив (0 = не удалять)
  messageEventRetentionDays: z
    .number()
    .int()
    .min(0, 'Срок хранения не может быть отрицательным')
    .max(3650, 'Срок хранения — максимум 3650 дней'),
});

export type UpdateSettingsDto = z.infer<typeof updateSettingsSchema>;

/** Обновление: доп. валидация IANA-зоны и шаблона дисклеймера (422), затем
 *  полная перезапись полей. Побочные эффекты: запись AppSettings, audit-лог
 *  UPDATE (полный слепок dto). */
export async function updateSettings(
  dto: UpdateSettingsDto,
  user: SessionUser,
  ip: string,
): Promise<AppSettings> {
  if (!isValidIanaTimezone(dto.defaultTimezone)) {
    throw new ApiError(422, 'Ошибка валидации', `Некорректный часовой пояс: ${dto.defaultTimezone}`);
  }
  // Контракт имени отправителя у Т2 — shortcode ≤11 символов ASCII без
  // пробелов/дефисов (t2.ts, раздел 4): общая схема допускает до 20 — «DemoBrand
  // Info» проходил сохранение, но КАЖДАЯ отправка T2 отклонялась шлюзом.
  // Проверяем по провайдеру из dto (меняется тем же запросом).
  if (dto.provider === 't2' && dto.defaultSenderName !== '' && !/^[A-Za-z0-9]{1,11}$/.test(dto.defaultSenderName)) {
    throw new ApiError(
      422,
      'Ошибка валидации',
      'Имя отправителя для провайдера Т2 — до 11 символов, только латиница и цифры (контракт shortcode)',
    );
  }
  // Контракт МТС OmniChannel — нейминг sms_address ≤11 символов без пробелов
  // (mts.ts, раздел «Отправка SMS»): дефис допускаем, пробелы — нет.
  if (dto.provider === 'mts' && dto.defaultSenderName !== '' && !/^[A-Za-z0-9\-]{1,11}$/.test(dto.defaultSenderName)) {
    throw new ApiError(
      422,
      'Ошибка валидации',
      'Имя отправителя для провайдера МТС — до 11 символов, латиница/цифры/дефис (контракт нейминга)',
    );
  }
  const disclaimerError = validateDisclaimerTemplate(dto.marketingDisclaimer);
  if (disclaimerError) {
    throw new ApiError(422, 'Ошибка валидации', disclaimerError);
  }
  await getSettings(); // гарантируем существование singleton-строки
  const row = await db.appSettings.update({ where: { id: SETTINGS_ID }, data: dto });
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.SETTINGS,
    entityId: SETTINGS_ID,
    details: { ...dto },
    ip,
  });
  return row;
}

/** Строка AppSettings → JSON API (все операционные поля без служебных). */
export function serializeSettings(row: AppSettings): Record<string, unknown> {
  return {
    advertiserName: row.advertiserName,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    dailyClientLimit: row.dailyClientLimit,
    systemDailyLimit: row.systemDailyLimit,
    provider: row.provider,
    unsubscribeBaseUrl: row.unsubscribeBaseUrl,
    defaultTimezone: row.defaultTimezone,
    defaultSenderName: row.defaultSenderName,
    useShortLinks: row.useShortLinks,
    marketingDisclaimer: row.marketingDisclaimer,
    inboxRetentionDays: row.inboxRetentionDays,
    messageEventRetentionDays: row.messageEventRetentionDays,
  };
}
