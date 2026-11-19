// GET/PUT /api/v1/hooks — состояние «Захвата событий» (тумблер + токен + URL).
// GET — MANAGER+: URL приёмника не секретнее самой панели, но ТОКЕН — это
// write-креденшл публичного приёмника /hooks/events (им можно вносить телефоны
// в стоп-лист и менять статусы SMS) — VIEWER'у он не выдаётся. PUT (тумблер) —
// ADMIN, как и прочие действия в «Интеграциях».
import { NextRequest, NextResponse } from 'next/server';
import { deriveBaseUrl, getClientIp, readJson, withAuth } from '@/lib/api';
import { getHooksConfig, setHooksEnabled, setHooksEnabledSchema } from '@/lib/services/message-events';

export const GET = withAuth(
  async (req: NextRequest): Promise<NextResponse> => {
    const config = await getHooksConfig(deriveBaseUrl(req));
    return NextResponse.json(config);
  },
  { read: 'MANAGER' },
);

export const PUT = withAuth(
  async (req, user): Promise<NextResponse> => {
    const dto = setHooksEnabledSchema.parse(await readJson(req));
    const result = await setHooksEnabled(dto, user, getClientIp(req));
    const config = await getHooksConfig(deriveBaseUrl(req));
    return NextResponse.json({ ...result, ...config });
  },
  { write: 'ADMIN' },
);
