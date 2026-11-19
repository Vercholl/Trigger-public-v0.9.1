// POST /api/v1/webhooks/mts — ПУБЛИЧНЫЙ webhook МТС OmniChannel: коллбэк о
// статусе исходящих сообщений (раздел «Callback» документации V.1.14).
// Платформа шлёт POST JSON {"items":[{internal_id, status, message_id,
// destination, naming, event_at, received_at, total_parts, call_direction,
// internal_errors, operator_group_id}, …]} на URL, переданный менеджеру МТС
// (поддерживаются доменные имена, порты 80/443/5070).
//
// Коды событий (приложение): 200 — отправлено; 201 — не отправлено; 202 —
// отправлена часть сегментов; 300 — доставлено; 301 — не доставлено; 302 —
// доставлена часть сегментов. Идентификация сообщения: internal_id ==
// internal_id из ответа на отправку (сохранён в sms_messages.providerMessageId).
// Ответ клиентской системы — 200 OK (документ допускает 200/204).
//
// Защита (опционально): подписи в протоколе НЕТ; если задан MTS_WEBHOOK_SECRET,
// URL для МТС формируется с параметром ?secret=<значение> и сверяется; без
// секретного параметра в env проверка выключена (симметрично webhook-у Т2).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, publicRoute, problem } from '@/lib/api';
import { db } from '@/lib/db';
import { mapMtsStatus, type MtsEvent } from '@/lib/provider/mts';
import { journalSmsEvent } from '@/lib/services/message-events';
import { webhookRateLimitPerMin, webhookRateLimiter } from '@/lib/security/rate-limiter';
import { constantTimeEquals } from '@/lib/security/secrets';
import { logSecurityEventThrottled } from '@/lib/security/audit';
import { readJsonBounded } from '@/lib/security/body-limit';

/** Потолок батча коллбэка (симметрия MAX_HOOK_BATCH приёмника событий):
 *  каждый элемент = 2–4 обращения к БД — неограниченный массив на публичном
 *  роуте был бы DoS-поверхностью (один «толстый» POST монополизирует SQLite
 *  на минуты, голодая 5-секундный тик воркера в том же процессе). Реальные
 *  коллбэки МТС поштучные (по одному сообщению), 1000 — с запасом. */
const MAX_CALLBACK_ITEMS = 1000;

/** Лимит тела коллбэка: 2 МБ (батч 1000 элементов — с запасом; анти-DoS). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Коллбэк МТС: элемент массива items (раздел «Параметры callback»). */
interface MtsCallbackItem extends MtsEvent {
  call_direction?: string;
  operator_group_id?: number;
}

export const POST = publicRoute(async (req: NextRequest): Promise<NextResponse> => {
  // Rate-limit ДО сверки секрета (см. t2-webhook)
  const ip = getClientIp(req);
  const allowed = await webhookRateLimiter.check(`webhook:ip:${ip}`, webhookRateLimitPerMin(), 60);
  if (!allowed) {
    return problem(429, 'Слишком много запросов');
  }

  // Опциональная проверка секрета: ?secret=<MTS_WEBHOOK_SECRET> в URL для МТС
  // (сверка за постоянное время — защита от тайминг-атаки на подбор)
  const secret = (process.env.MTS_WEBHOOK_SECRET ?? '').trim();
  if (secret !== '') {
    const got = (req.nextUrl.searchParams.get('secret') ?? '').trim();
    if (!constantTimeEquals(got, secret)) {
      // Аудит неудачной аутентификации (SECURITY, троттлинг 1/10 мин на ip)
      await logSecurityEventThrottled('webhook_mts_bad_secret', ip, { path: '/api/v1/webhooks/mts' });
      return problem(401, 'Неверный параметр secret');
    }
  }

  // Тело коллбэка: {"items":[…]} (раздел «Пример callback»)
  let items: MtsCallbackItem[];
  try {
    const body = (await readJsonBounded(req, MAX_BODY_BYTES)) as { items?: MtsCallbackItem[] };
    items = Array.isArray(body.items) ? body.items : [];
  } catch (e) {
    const status = (e as { status?: number })?.status === 413 ? 413 : 400;
    const detail =
      status === 413
        ? `Тело больше лимита ${MAX_BODY_BYTES} байт`
        : 'Ожидается JSON-тело {"items":[…]}';
    return problem(status, status === 413 ? 'Тело запроса слишком большое' : 'Некорректное уведомление', detail);
  }
  if (items.length === 0) {
    return problem(400, 'Некорректное уведомление', 'Массив items пуст');
  }
  if (items.length > MAX_CALLBACK_ITEMS) {
    return problem(
      413,
      'Слишком много элементов',
      `items содержит ${items.length} — максимум ${MAX_CALLBACK_ITEMS} за запрос`,
    );
  }

  let updated = 0;
  let unknown = 0;
  for (const item of items) {
    const internalId = typeof item.internal_id === 'string' ? item.internal_id.trim() : '';
    // Код события — число по документу, но эмуляторы/прокси шлюза могут
    // прислать строкой («300») — коэрсим; Number.isInteger отсекает
    // NaN/дроби/булевы (Number(true) === 1 — не код события)
    const rawStatus: unknown = item.status;
    const status =
      typeof rawStatus === 'number'
        ? rawStatus
        : typeof rawStatus === 'string' && rawStatus.trim() !== ''
          ? Number(rawStatus)
          : Number.NaN;
    if (internalId === '' || !Number.isInteger(status)) {
      // Мусорный элемент — пропускаем (весь запрос НЕ валится)
      unknown += 1;
      continue;
    }

    // Строка SMS у нас: провайдер mts, идентификатор = internal_id
    const row = await db.smsMessage.findFirst({
      where: { provider: 'mts', providerMessageId: internalId },
      select: { id: true, status: true, phone: true, clientId: true },
    });
    if (!row) {
      // Не наше сообщение (или отправлено до включения логирования) — подтверждаем приём
      unknown += 1;
      continue;
    }

    // Дата события (event_at, RFC-3339 UTC+3) — в журнал с датой шлюза
    const eventAt = typeof item.event_at === 'string' ? new Date(item.event_at) : new Date();
    const eventDate = Number.isNaN(eventAt.getTime()) ? new Date() : eventAt;

    const data: Record<string, unknown> = {};

    // Единый маппинг кодов событий МТС (приложение) — mapMtsStatus.
    // Гвард от понижения (симметрично t2/smstech-webhook): DELIVERED и FAILED —
    // финальные статусы; поздние промежуточные (200/202) их не понижают.
    // DELIVERED — сильнейший факт доставки.
    let statusKept: string | null = null;
    const mapped = mapMtsStatus(status);
    if (mapped === 'DELIVERED') {
      data.status = 'DELIVERED';
      data.deliveredAt = eventDate;
      data.error = null;
    } else if (mapped === 'SENT') {
      // 200/202: не понижаем достигнутые DELIVERED/FAILED
      if (row.status !== 'DELIVERED' && row.status !== 'FAILED') {
        data.status = 'SENT';
      } else {
        statusKept = row.status;
      }
    } else if (mapped === 'FAILED') {
      if (row.status !== 'DELIVERED') {
        data.status = 'FAILED';
        const errs = Array.isArray(item.internal_errors) ? item.internal_errors.filter((e) => e !== 0) : [];
        data.error =
          errs.length > 0
            ? `МТС: ошибка доставки (код события ${status}, внутренние коды ${errs.join(', ')})`
            : `МТС: ошибка доставки (код события ${status})`;
      } else {
        statusKept = row.status;
      }
    }
    // QUEUED-статусы состояние не меняют

    // total_parts — количество сегментов сообщения (раздел «Параметры callback»)
    if (typeof item.total_parts === 'number' && item.total_parts > 0) data.segments = item.total_parts;

    if (Object.keys(data).length === 0) {
      // Промежуточный статус (QUEUED-ветка) — в журнал как «update», без
      // изменения строки SMS (тумблер выключен — journalSmsEvent сам no-op).
      // Сюда же попадает принятый поздний 200 при уже финальном статусе.
      await journalSmsEvent({
        source: 'mts',
        eventType: 'update',
        smsMessageId: row.id,
        clientId: row.clientId,
        phone: row.phone,
        provider: 'mts',
        eventDate,
        externalIds: { internal_id: internalId, message_id: item.message_id ?? null },
        payload: item,
        dedupKey: `mts:${internalId}:${status}`,
        result: {
          smsStatus: row.status,
          via: 'webhook',
          intermediate: true,
          ...(statusKept !== null ? { statusKept } : {}),
        },
      });
      continue;
    }

    await db.smsMessage.update({ where: { id: row.id }, data });

    // «Захват событий»: финальное уведомление МТС — событие журнала
    const hookType = mapped === 'DELIVERED' ? 'deliv_sms' : mapped === 'FAILED' ? 'undeliv_sms' : 'send_sms';
    await journalSmsEvent({
      source: 'mts',
      eventType: hookType,
      smsMessageId: row.id,
      clientId: row.clientId,
      phone: row.phone,
      provider: 'mts',
      eventDate,
      externalIds: { internal_id: internalId, message_id: item.message_id ?? null },
      payload: item,
      dedupKey: `mts:${internalId}:${status}`,
      result: {
        smsStatus: (data.status as string | undefined) ?? row.status,
        via: 'webhook',
        ...(statusKept !== null ? { statusKept } : {}),
      },
    });
    updated += 1;
  }

  // Документ: ответ клиентской системы — 200 OK (или 204 No Content)
  return NextResponse.json({ ok: true, updated, unknown });
});
