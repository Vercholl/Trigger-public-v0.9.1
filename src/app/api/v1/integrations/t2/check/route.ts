// POST /api/v1/integrations/t2/check — проверка подключения Т2 без отправки SMS:
// operation=status по несуществующей транзакции (раздел 6 документа) отличает
// «логин/пароль неверны» от «креды приняты». Только ADMIN.
import { NextRequest } from 'next/server';
import { withAuth } from '@/lib/api';
import { checkT2 } from '@/lib/services/integrations';

export const POST = withAuth(
  async (): Promise<Response> => {
    const data = await checkT2();
    return Response.json(data);
  },
  { write: 'ADMIN' },
);
