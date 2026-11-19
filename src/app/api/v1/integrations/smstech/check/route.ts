// POST /api/v1/integrations/smstech/check — проверка подключения SMS.Tech
// без отправки SMS: ResolveOperators по пробному номеру (раздел 12 документации).
// Отличает «токен неверен» (401) от «шлюз доступен» (200). Только ADMIN.
import { NextRequest } from 'next/server';
import { readJson, withAuth } from '@/lib/api';
import { checkSmstech, checkSmstechSchema } from '@/lib/services/integrations';

export const POST = withAuth(
  async (req: NextRequest): Promise<Response> => {
    const dto = checkSmstechSchema.parse(await readJson(req));
    const data = await checkSmstech(dto);
    return Response.json(data);
  },
  { write: 'ADMIN' },
);
