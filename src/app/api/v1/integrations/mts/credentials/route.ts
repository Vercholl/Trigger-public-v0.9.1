// POST /api/v1/integrations/mts/credentials — сохранение логина/пароля
// подключения МТС OmniChannel (system_id/пароль из договора, Basic Auth) из
// панели (поля «Логин/Пароль МТС» на вкладке «Интеграции»). Пустые строки —
// удалить креды. Значения шифруются (AES-256-GCM) и в ответе не возвращаются.
// Только ADMIN; лимит 20 операций/мин с IP.
import { NextRequest } from 'next/server';
import { getClientIp, problem, readJson, withAuth } from '@/lib/api';
import { secretsRateLimiter } from '@/lib/security/rate-limiter';
import { saveMtsCredentials, saveMtsCredentialsSchema } from '@/lib/services/integrations';

export const POST = withAuth(
  async (req: NextRequest, user): Promise<Response> => {
    const allowed = await secretsRateLimiter.check(`secrets:ip:${getClientIp(req)}`, 20, 60);
    if (!allowed) {
      return problem(429, 'Слишком много запросов', 'Превышен лимит операций с секретами (20 в минуту с одного IP)');
    }
    const dto = saveMtsCredentialsSchema.parse(await readJson(req));
    const data = await saveMtsCredentials(dto, user, getClientIp(req));
    return Response.json(data);
  },
  { write: 'ADMIN' },
);
