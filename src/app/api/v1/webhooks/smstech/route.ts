// POST /api/v1/webhooks/smstech — ПУБЛИЧНЫЙ webhook статусов доставки SMS.Tech
// (агрегатор sms-gate.smsleads.ru). Формат по разделу 10.3 документации:
// тело { message: { code, version, status, errorText, priceMoney, dateSend,
// dateDelivered, … } }, заголовок Authorization — если задан при настройке
// эндпоинта у SMS.Tech (SMSTECH_WEBHOOK_SECRET; проверяем как «Bearer <значение>»
// или raw-значение). Цифровой подписи тела нет — раздел 10.3.
//
// Требования шлюза (10.4): отвечать 2xx за 10 секунд, дедуплицировать по паре
// code + version (более старую версию игнорировать), обработка «минимум один раз».
// Версия записи хранится в sms_messages.providerVersion.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, publicRoute, problem } from '@/lib/api';
import { db } from '@/lib/db';
import { z } from 'zod';
import { journalSmsEvent } from '@/lib/services/message-events';
import { webhookRateLimitPerMin, webhookRateLimiter } from '@/lib/security/rate-limiter';
import { constantTimeEquals } from '@/lib/security/secrets';
import { logSecurityEventThrottled } from '@/lib/security/audit';
import { readJsonBounded } from '@/lib/security/body-limit';

/** Лимит тела уведомления: 2 МБ (одиночное сообщение — с запасом; анти-DoS). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const webhookSchema = z.object({
  message: z.object({
    code: z.string().min(1, 'message.code обязателен'),
    // int64 строкой (раздел 3), но защищаемся и от числа
    version: z.union([z.string(), z.number()]).optional().nullable(),
    status: z.string().optional().nullable(),
    errorText: z.string().optional().nullable(),
    dateSend: z.string().optional().nullable(),
    dateDelivered: z.string().optional().nullable(),
    priceMoney: z
      .object({ units: z.union([z.string(), z.number()]).optional() })
      .optional()
      .nullable(),
    operatorCode: z.string().optional().nullable(),
    segmentsCount: z.number().optional().nullable(),
  }),
});

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseVersion(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseKopecks(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Authorization из настроек эндпоинта SMS.Tech: допускаем raw и «Bearer …».
 *  Сверка за постоянное время — защита от тайминг-атаки на подбор секрета. */
function authorizationOk(headerValue: string | null): boolean {
  const secret = (process.env.SMSTECH_WEBHOOK_SECRET ?? '').trim();
  if (secret === '') return true; // секрет не задан — проверка не включена (раздел 10.3: опционально)
  if (!headerValue) return false;
  const got = headerValue.trim();
  return constantTimeEquals(got, secret) || constantTimeEquals(got, `Bearer ${secret}`);
}

export const POST = publicRoute(async (req: NextRequest): Promise<NextResponse> => {
  // Rate-limit ДО сверки секрета: молотилка по кодам/подбор секрета отсекается
  // без нагрузки на БД (300 уведомлений / минуту с одного IP).
  const ip = getClientIp(req);
  const allowed = await webhookRateLimiter.check(`webhook:ip:${ip}`, webhookRateLimitPerMin(), 60);
  if (!allowed) {
    return problem(429, 'Слишком много запросов');
  }

  if (!authorizationOk(req.headers.get('authorization'))) {
    // Аудит неудачной аутентификации (SECURITY, троттлинг 1/10 мин на ip)
    await logSecurityEventThrottled('webhook_smstech_bad_secret', ip, { path: '/api/v1/webhooks/smstech' });
    return problem(401, 'Неверный заголовок Authorization');
  }

  let dto: z.infer<typeof webhookSchema>;
  try {
    dto = webhookSchema.parse(await readJsonBounded(req, MAX_BODY_BYTES));
  } catch (e) {
    // Мусорное тело — сразу 4xx, чтобы шлюз не ретраил бесконечно;
    // 413 — сверхлимитное тело (анти-DoS)
    if ((e as { status?: number })?.status === 413) {
      return problem(413, 'Тело запроса слишком большое', `Лимит: ${MAX_BODY_BYTES} байт`);
    }
    return problem(400, 'Некорректное тело уведомления', 'Ожидается { message: { code, … } }');
  }

  const msg = dto.message;
  const incomingVersion = parseVersion(msg.version);

  // Строка SMS у нас: идентификатор провайдера = message.code
  const row = await db.smsMessage.findFirst({
    where: { provider: 'smstech', providerMessageId: msg.code },
    select: { id: true, status: true, providerVersion: true, phone: true, clientId: true },
  });
  if (!row) {
    // Не наше сообщение (или отправлено до включения логирования) — подтверждаем приём
    return NextResponse.json({ ok: true, updated: 0, reason: 'unknown-code' });
  }

  // Дедупликация по code + version (10.4): старые и повторные версии игнорируем
  if (
    incomingVersion !== null &&
    row.providerVersion !== null &&
    incomingVersion <= row.providerVersion
  ) {
    return NextResponse.json({ ok: true, updated: 0, dedup: true });
  }

  const data: Record<string, unknown> = {
    providerVersion: incomingVersion ?? row.providerVersion,
  };

  // Статусы (раздел 9): SEND → SENT, DELIVERED → DELIVERED, SEND_ERROR → FAILED.
  // Отсутствие status (новое сообщение) уведомлением не приходит (10.2).
  // Гард от понижения: DELIVERED и FAILED — достигнутые финальные статусы;
  // поздние SEND/SEND_ERROR (в т.ч. без version, когда version-дедуп бессилен)
  // их не понижают — тарификацию/оператора при этом обновляем. DELIVERED —
  // сильнейший факт: не понижается и ошибкой. Причина — в результат события.
  let statusKept: string | null = null;
  if (msg.status === 'MESSAGE_STATUS_SEND') {
    if (row.status !== 'DELIVERED' && row.status !== 'FAILED') {
      data.status = 'SENT';
      const sendAt = parseDate(msg.dateSend);
      if (sendAt) data.sentAt = sendAt;
    } else {
      statusKept = row.status;
    }
  } else if (msg.status === 'MESSAGE_STATUS_DELIVERED') {
    data.status = 'DELIVERED';
    data.deliveredAt = parseDate(msg.dateDelivered) ?? new Date();
    data.error = null;
  } else if (msg.status === 'MESSAGE_STATUS_SEND_ERROR') {
    if (row.status !== 'DELIVERED') {
      data.status = 'FAILED';
      data.error = msg.errorText?.trim() || 'SMS.Tech: ошибка доставки (SEND_ERROR)';
    } else {
      statusKept = row.status;
    }
  }

  // Тарификация/оператор/сегменты появляются после тарификации шлюзом (7.4)
  const kopecks = parseKopecks(msg.priceMoney?.units);
  if (kopecks !== null) data.priceKopecks = kopecks;
  if (msg.operatorCode && msg.operatorCode.trim() !== '') data.operatorCode = msg.operatorCode.trim();
  if (typeof msg.segmentsCount === 'number' && msg.segmentsCount > 0) {
    data.segments = msg.segmentsCount;
  }

  await db.smsMessage.update({ where: { id: row.id }, data });

  // «Захват событий»: уведомление шлюза — событие журнала (тумблер внутри).
  // Тип — по статусу уведомления; дедуп smstech:{code}:{version}:{status} —
  // повторные доставки одного уведомления не создают дублей.
  const hookType =
    msg.status === 'MESSAGE_STATUS_SEND'
      ? 'send_sms'
      : msg.status === 'MESSAGE_STATUS_DELIVERED'
        ? 'deliv_sms'
        : msg.status === 'MESSAGE_STATUS_SEND_ERROR'
          ? 'undeliv_sms'
          : 'update';
  await journalSmsEvent({
    source: 'smstech',
    eventType: hookType,
    smsMessageId: row.id,
    clientId: row.clientId,
    phone: row.phone,
    provider: 'smstech',
    eventDate: parseDate(msg.dateDelivered) ?? parseDate(msg.dateSend) ?? undefined,
    externalIds: { send_message_id: msg.code, version: incomingVersion },
    payload: dto,
    dedupKey: `smstech:${msg.code}:${incomingVersion ?? 0}:${msg.status ?? '-'}`,
    result: {
      smsStatus: (data.status as string | undefined) ?? row.status,
      via: 'webhook',
      ...(statusKept !== null ? { statusKept } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    updated: 1,
    status: (data.status as string | undefined) ?? row.status,
    version: data.providerVersion,
  });
});
