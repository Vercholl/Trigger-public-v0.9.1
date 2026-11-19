// POST /api/v1/webhooks/smsru — ПУБЛИЧНЫЙ callback статусов доставки SMS.RU.
// Проверка hash по задокументированному предположению; обновляет sms_messages
// по providerMessageId. В sandbox не активен.
import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, publicRoute, problem } from '@/lib/api';
import { db } from '@/lib/db';
import { z } from 'zod';
import { mapSmsRuStatusCode } from '@/lib/provider/smsru';
import { constantTimeEquals } from '@/lib/security/secrets';
import { webhookRateLimitPerMin, webhookRateLimiter } from '@/lib/security/rate-limiter';
import { logSecurityEventThrottled } from '@/lib/security/audit';
import { readJsonBounded } from '@/lib/security/body-limit';

/** Лимит тела callback: 2 МБ (одиночное уведомление — с запасом; анти-DoS). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const webhookSchema = z.object({
  sms_id: z.string().min(1, 'sms_id обязателен'),
  status: z.union([z.string(), z.number()]).transform((v) => String(v)),
  hash: z.string().min(1, 'hash обязателен'),
});

// ПРОВЕРИТЬ ПО ДОКУМЕНТАЦИИ SMS.RU: алгоритм проверки подлинности callback
// (предположительно md5(api_id + sms_id + status + secret)).
function expectedHash(smsId: string, status: string): string | null {
  const apiId = process.env.SMSRU_API_ID ?? '';
  const secret = process.env.SMSRU_WEBHOOK_SECRET ?? '';
  if (apiId === '' || secret === '') return null;
  return createHash('md5')
    .update(`${apiId}${smsId}${status}${secret}`)
    .digest('hex');
}

export const POST = publicRoute(async (req: NextRequest): Promise<NextResponse> => {
  // Rate-limit ДО сверки подписи (см. smstech-webhook)
  const ip = getClientIp(req);
  const allowed = await webhookRateLimiter.check(`webhook:ip:${ip}`, webhookRateLimitPerMin(), 60);
  if (!allowed) {
    return problem(429, 'Слишком много запросов');
  }

  const dto = webhookSchema.parse(await readJsonBounded(req, MAX_BODY_BYTES));

  const expected = expectedHash(dto.sms_id, dto.status);
  if (expected === null) {
    return problem(503, 'Webhook не настроен', 'SMSRU_API_ID/SMSRU_WEBHOOK_SECRET не заданы в окружении');
  }
  // Constant-time сравнение: побайтовое !== с ранним выходом — timing-оракул
  // (остальные приёмники — smstech/t2/hooks — уже используют constantTimeEquals).
  if (!constantTimeEquals(dto.hash.toLowerCase(), expected.toLowerCase())) {
    // Аудит неудачной аутентификации (SECURITY, троттлинг 1/10 мин на ip)
    await logSecurityEventThrottled('webhook_smsru_bad_hash', ip, { path: '/api/v1/webhooks/smsru' });
    return problem(401, 'Неверная подпись');
  }

  const code = Number.parseInt(dto.status, 10);
  const newStatus = Number.isFinite(code) ? mapSmsRuStatusCode(code) : 'SENT';
  // Фильтр по провайдеру обязателен: providerMessageId разных шлюзов не
  // гарантированно уникальны между собой (id Т2/SMS.Tech могли бы совпасть) —
  // без него callback SMS.RU перезаписал бы чужую запись (симметрично
  // webhooks/smstech и webhooks/t2, где where всегда ограничен провайдером).
  const row = await db.smsMessage.findFirst({
    where: { provider: 'smsru', providerMessageId: dto.sms_id },
    select: { id: true, status: true },
  });
  if (!row) {
    // Не наше сообщение — подтверждаем приём (как mts/t2-webhook: unknown)
    return NextResponse.json({ ok: true, updated: 0, unknown: 1 });
  }
  // Гвард от понижения (симметрично t2/smstech/mts-webhook): DELIVERED и
  // FAILED — финальные статусы; поздний промежуточный код SMS.RU (100/101/102
  // «в системе/передано оператору») их не понижает; DELIVERED — сильнейший факт.
  if (newStatus === 'SENT' && (row.status === 'DELIVERED' || row.status === 'FAILED')) {
    return NextResponse.json({ ok: true, updated: 0, statusKept: row.status });
  }
  if (newStatus === 'FAILED' && row.status === 'DELIVERED') {
    return NextResponse.json({ ok: true, updated: 0, statusKept: row.status });
  }
  await db.smsMessage.update({
    where: { id: row.id },
    data: {
      status: newStatus,
      ...(newStatus === 'DELIVERED' ? { deliveredAt: new Date(), error: null } : {}),
      ...(newStatus === 'FAILED' ? { error: `SMS.RU: код статуса ${dto.status}` } : {}),
    },
  });

  return NextResponse.json({ ok: true, updated: 1 });
});
