// POST /api/v1/integrations/smstech/token — сохранение токена доступа SMS.Tech
// из панели (поле «Токен доступа» на вкладке «Интеграции»). Пустая строка —
// удалить токен. Токен шифруется (AES-256-GCM) и в ответе не возвращается.
// Только ADMIN; лимит 20 операций/мин с IP.
import { NextRequest } from 'next/server';
import { getClientIp, problem, readJson, withAuth } from '@/lib/api';
import { secretsRateLimiter } from '@/lib/security/rate-limiter';
import { saveSmstechToken, saveSmstechTokenSchema } from '@/lib/services/integrations';

export const POST = withAuth(
  async (req: NextRequest, user): Promise<Response> => {
    const allowed = await secretsRateLimiter.check(`secrets:ip:${getClientIp(req)}`, 20, 60);
    if (!allowed) {
      return problem(429, 'Слишком много запросов', 'Превышен лимит операций с секретами (20 в минуту с одного IP)');
    }
    const dto = saveSmstechTokenSchema.parse(await readJson(req));
    const data = await saveSmstechToken(dto, user, getClientIp(req));
    return Response.json(data);
  },
  { write: 'ADMIN' },
);
