// POST /api/v1/integrations/mts/check — проверка подключения МТС OmniChannel
// без отправки SMS: POST /messages/info с пустым int_ids (валидация тела
// проваливается ПОСЛЕ авторизации) отличает «логин/пароль неверны» (802/401)
// от «креды приняты» (422/602/200). Только ADMIN.
import { NextRequest } from 'next/server';
import { withAuth } from '@/lib/api';
import { checkMts } from '@/lib/services/integrations';

export const POST = withAuth(
  async (_req: NextRequest): Promise<Response> => {
    const data = await checkMts();
    return Response.json(data);
  },
  { write: 'ADMIN' },
);
