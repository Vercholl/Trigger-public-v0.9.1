// POST /api/v1/integrations/forwarder/test — проверка связности обратного
// потока (MANAGER+, лимит секретов 20/мин): синтетическое событие send_sms
// POST-ится прямо в настроенный URL приёмника (мимо очереди —
// не журналируется и не считается в статистике доставки). 200 {ok, url,
// tokenAttached, error?}: ok=true — приёмник ответил 2xx. Ошибки problem+json:
// 401/403, 429, 422 (URL не задан). Побочное: audit RUN/SETTINGS.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, problem, withAuth } from '@/lib/api';
import { secretsRateLimiter } from '@/lib/security/rate-limiter';
import { testForwarder } from '@/lib/services/forwarder';

export const POST = withAuth(
  async (req: NextRequest, user): Promise<NextResponse> => {
    const allowed = await secretsRateLimiter.check(`secrets:ip:${getClientIp(req)}`, 20, 60);
    if (!allowed) {
      return problem(429, 'Слишком много запросов', 'Превышен лимит операций с секретами (20 в минуту с одного IP)');
    }
    const result = await testForwarder(user, getClientIp(req));
    return NextResponse.json(result);
  },
  { write: 'MANAGER' },
);
