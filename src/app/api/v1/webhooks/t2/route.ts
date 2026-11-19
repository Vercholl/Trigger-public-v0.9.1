// GET /api/v1/webhooks/t2 — ПУБЛИЧНЫЙ webhook Т2 «Бизнес SMS»: уведомление партнёра
// о статусе исходящих сообщений (раздел 7 документа). Т2 отправляет HTTP GET на URL,
// полученный от партнёра, с параметрами: status, id, parts, transaction_id, ptag,
// text, abonent, sender, error_codes, delivery_type.
//
// Статусы (раздел 6): delivered/expired/undeliverable/rejected — финальные;
// unknown/billed/not_sent/accepted/enrote — промежуточные.
// Идентификация сообщения: id (== transaction_id) — идентификатор транзакции из
// ответа на operation=send (сохранён в sms_messages.providerMessageId).
//
// Защита (опционально): если задан T2_WEBHOOK_SECRET, URL для Т2 формируется с
// параметром ?secret=<значение> и сверяется; без секретного параметра в env
// проверка выключена (в документе Т2 подписи не предусмотрено).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, publicRoute, problem } from '@/lib/api';
import { db } from '@/lib/db';
import { mapT2Status } from '@/lib/provider/t2';
import { journalSmsEvent } from '@/lib/services/message-events';
import { webhookRateLimitPerMin, webhookRateLimiter } from '@/lib/security/rate-limiter';
import { constantTimeEquals } from '@/lib/security/secrets';
import { logSecurityEventThrottled } from '@/lib/security/audit';

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const GET = publicRoute(async (req: NextRequest): Promise<NextResponse> => {
  // Rate-limit ДО сверки секрета (см. smstech-webhook)
  const ip = getClientIp(req);
  const allowed = await webhookRateLimiter.check(`webhook:ip:${ip}`, webhookRateLimitPerMin(), 60);
  if (!allowed) {
    return problem(429, 'Слишком много запросов');
  }

  // Опциональная проверка секрета: ?secret=<T2_WEBHOOK_SECRET> в URL для Т2
  // (сверка за постоянное время — защита от тайминг-атаки на подбор)
  const secret = (process.env.T2_WEBHOOK_SECRET ?? '').trim();
  if (secret !== '') {
    const got = (req.nextUrl.searchParams.get('secret') ?? '').trim();
    if (!constantTimeEquals(got, secret)) {
      // Аудит неудачной аутентификации (SECURITY, троттлинг 1/10 мин на ip)
      await logSecurityEventThrottled('webhook_t2_bad_secret', ip, { path: '/api/v1/webhooks/t2' });
      return problem(401, 'Неверный параметр secret');
    }
  }

  const sp = req.nextUrl.searchParams;
  // id и transaction_id — синонимы (раздел 7); delivery_type: учитываем sms,
  // прочие каналы (viber/social) в этой интеграции не отправляются
  const rawId = sp.get('id') ?? sp.get('transaction_id') ?? '';
  const transactionId = rawId.trim();
  const status = (sp.get('status') ?? '').trim().toLowerCase();
  const parts = parsePositiveInt(sp.get('parts'));
  const errorCodes = (sp.get('error_codes') ?? '').trim();

  if (transactionId === '' || status === '') {
    // Мусорный запрос — сразу 4xx, чтобы Т2 не считал его нашей ошибкой
    return problem(400, 'Некорректное уведомление', 'Ожидаются параметры id и status');
  }

  // Строка SMS у нас: провайдер t2, идентификатор = id транзакции
  const row = await db.smsMessage.findFirst({
    where: { provider: 't2', providerMessageId: transactionId },
    select: { id: true, status: true, phone: true, clientId: true },
  });
  if (!row) {
    // Не наше сообщение (или отправлено до включения логирования) — подтверждаем приём
    return NextResponse.json({ ok: true, updated: 0, reason: 'unknown-id' });
  }

  const data: Record<string, unknown> = {};

  // Единый маппинг статусов Т2 (раздел 6) — mapT2Status.
  // Гард от понижения (симметрично smstech-webhook): DELIVERED и FAILED —
  // финальные статусы; поздние промежуточные (accepted) или ошибочные
  // уведомления их не понижают. DELIVERED — сильнейший факт доставки.
  let statusKept: string | null = null;
  const mapped = mapT2Status(status);
  if (mapped === 'DELIVERED') {
    data.status = 'DELIVERED';
    data.deliveredAt = new Date();
    data.error = null;
  } else if (mapped === 'SENT') {
    // accepted: не понижаем достигнутые DELIVERED/FAILED
    if (row.status !== 'DELIVERED' && row.status !== 'FAILED') {
      data.status = 'SENT';
    } else {
      statusKept = row.status;
    }
  } else if (mapped === 'FAILED') {
    if (row.status !== 'DELIVERED') {
      data.status = 'FAILED';
      data.error =
        errorCodes !== '' && errorCodes !== '0'
          ? `Т2: ошибка доставки (статус ${status}, коды ${errorCodes})`
          : `Т2: ошибка доставки (статус ${status})`;
    } else {
      statusKept = row.status;
    }
  }
  // QUEUED-статусы (unknown/billed/not_sent/enrote) состояние не меняют

  // parts — количество частей в сообщении (раздел 7)
  if (parts !== null && parts > 0) data.segments = parts;

  if (Object.keys(data).length === 0) {
    // Промежуточный статус (QUEUED-ветка) — в журнал как «update», без
    // изменения строки SMS (тумблер выключен — journalSmsEvent сам no-op).
    // Сюда же попадает принятый поздний accepted при уже финальном статусе.
    await journalSmsEvent({
      source: 't2',
      eventType: 'update',
      smsMessageId: row.id,
      clientId: row.clientId,
      phone: row.phone,
      provider: 't2',
      externalIds: { send_message_id: transactionId },
      payload: Object.fromEntries(sp.entries()),
      dedupKey: `t2:${transactionId}:${status}`,
      result: {
        smsStatus: row.status,
        via: 'webhook',
        intermediate: true,
        ...(statusKept !== null ? { statusKept } : {}),
      },
    });
    return NextResponse.json({ ok: true, updated: 0, reason: 'non-final-status' });
  }

  await db.smsMessage.update({ where: { id: row.id }, data });

  // «Захват событий»: финальное уведомление Т2 — событие журнала
  const hookType = mapped === 'DELIVERED' ? 'deliv_sms' : mapped === 'FAILED' ? 'undeliv_sms' : 'send_sms';
  await journalSmsEvent({
    source: 't2',
    eventType: hookType,
    smsMessageId: row.id,
    clientId: row.clientId,
    phone: row.phone,
    provider: 't2',
    externalIds: { send_message_id: transactionId },
    payload: Object.fromEntries(sp.entries()),
    dedupKey: `t2:${transactionId}:${status}`,
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
  });
});
