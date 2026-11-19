// POST /api/v1/integrations/mts/test — отправка тестового SMS через МТС
// OmniChannel (кнопка «Отправить тест» на карточке подключения, вкладка
// «Интеграции»). Реальная отправка в шлюз omnichannel.mts.ru: результат — в
// SMS-лог и аудит. Только ADMIN; лимит 5 тестовых отправок/мин с IP (реальная
// тарификация).
import { NextRequest } from 'next/server';
import { getClientIp, problem, readJson, withAuth } from '@/lib/api';
import { secretsRateLimiter } from '@/lib/security/rate-limiter';
import { sendMtsTest, testMtsSchema } from '@/lib/services/integrations';

export const POST = withAuth(
  async (req: NextRequest, user): Promise<Response> => {
    const allowed = await secretsRateLimiter.check(`sms-test:ip:${getClientIp(req)}`, 5, 60);
    if (!allowed) {
      return problem(
        429,
        'Слишком много запросов',
        'Превышен лимит тестовых отправок (5 в минуту с одного IP) — подождите немного',
      );
    }
    const dto = testMtsSchema.parse(await readJson(req));
    const data = await sendMtsTest(dto, user, getClientIp(req));
    return Response.json(data);
  },
  { write: 'ADMIN' },
);
