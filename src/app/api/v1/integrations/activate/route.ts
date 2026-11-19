// POST /api/v1/integrations/activate — выбор активного SMS-провайдера.
// Для smstech дополнительно можно задать имя отправителя по умолчанию.
import { NextRequest } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { activateProvider, activateProviderSchema } from '@/lib/services/integrations';

export const POST = withAuth(
  async (req: NextRequest, user): Promise<Response> => {
    const dto = activateProviderSchema.parse(await readJson(req));
    const data = await activateProvider(dto, user, getClientIp(req));
    return Response.json(data);
  },
  { write: 'ADMIN' },
);
