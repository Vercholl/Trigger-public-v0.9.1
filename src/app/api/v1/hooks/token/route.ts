// POST /api/v1/hooks/token — перегенерация токена приёмника (ADMIN).
// Старый токен перестаёт работать сразу: отправитель начнёт получать 401 и
// повторять отправку — обновите URL в настройках захвата после ротации.
import { NextResponse } from 'next/server';
import { deriveBaseUrl, getClientIp, withAuth } from '@/lib/api';
import { getHooksConfig, regenerateHooksToken } from '@/lib/services/message-events';

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    await regenerateHooksToken(user, getClientIp(req));
    const config = await getHooksConfig(deriveBaseUrl(req));
    return NextResponse.json(config);
  },
  { write: 'ADMIN' },
);
