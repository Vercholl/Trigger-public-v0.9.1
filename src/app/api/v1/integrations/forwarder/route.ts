// GET /api/v1/integrations/forwarder — конфиг карточки «Обратный поток»
// (тумблер, URL, маска токена, batchSize, статистика очереди). Любая роль.
// PUT — сохранение URL/токена/размера батча (ADMIN, лимит секретов 20/мин):
// тело {url, token?, batchSize?}; пустая строка token = не менять, null = удалить.
// POST — тумблер {enabled} (ADMIN, лимит секретов): включение требует URL и
// чистит накопленную очередь (forwardSkip) — в BI летят события с момента
// включения. Ошибки problem+json: 401/403, 429, 422 (URL/включение без URL).
// Побочное: записи AppSettings (токен AES-256-GCM), MessageEvent (forwardSkip),
// audit UPDATE/SETTINGS (секреты — только факт/длина).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, problem, readJson, withAuth } from '@/lib/api';
import { secretsRateLimiter } from '@/lib/security/rate-limiter';
import {
  getForwarderConfig,
  saveForwarderConfig,
  saveForwarderSchema,
  setForwarderEnabled,
  setForwarderEnabledSchema,
} from '@/lib/services/forwarder';

export const GET = withAuth(async (): Promise<NextResponse> => {
  return NextResponse.json(await getForwarderConfig());
});

export const PUT = withAuth(
  async (req: NextRequest, user): Promise<NextResponse> => {
    const allowed = await secretsRateLimiter.check(`secrets:ip:${getClientIp(req)}`, 20, 60);
    if (!allowed) {
      return problem(429, 'Слишком много запросов', 'Превышен лимит операций с секретами (20 в минуту с одного IP)');
    }
    const dto = saveForwarderSchema.parse(await readJson(req));
    const result = await saveForwarderConfig(dto, user, getClientIp(req));
    return NextResponse.json(result);
  },
  { write: 'ADMIN' },
);

export const POST = withAuth(
  async (req: NextRequest, user): Promise<NextResponse> => {
    const allowed = await secretsRateLimiter.check(`secrets:ip:${getClientIp(req)}`, 20, 60);
    if (!allowed) {
      return problem(429, 'Слишком много запросов', 'Превышен лимит операций с секретами (20 в минуту с одного IP)');
    }
    const dto = setForwarderEnabledSchema.parse(await readJson(req));
    const result = await setForwarderEnabled(dto, user, getClientIp(req));
    return NextResponse.json(result);
  },
  { write: 'ADMIN' },
);
