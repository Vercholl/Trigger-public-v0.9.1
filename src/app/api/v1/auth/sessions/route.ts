// GET /api/v1/auth/sessions — список СВОИХ активных сессий (любая роль):
// id (sha256-хеш токена), создана, последняя активность, истекает, IP, UA,
// признак «текущая». RBAC: аутентифицированный пользователь — только свои.
// DELETE /api/v1/auth/sessions?scope=others — завершить все сессии, кроме
// текущей (аналог инвалидирующей смены пароля без смены пароля). 200 { revoked }.
// Побочное: аудит SESSION_REVOKED. Ошибки — problem+json (401/422).
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { listMySessions, revokeOtherSessions } from '@/lib/services/sessions';
import { SESSION_IDLE_MS, SESSION_TTL_MS } from '@/lib/security/session';

export const GET = withAuth(async (req, user): Promise<NextResponse> => {
  const items = await listMySessions(user, req);
  return NextResponse.json({
    items,
    total: items.length,
    policy: {
      ttlHours: Math.round(SESSION_TTL_MS / 3_600_000),
      idleHours: Math.round(SESSION_IDLE_MS / 3_600_000),
    },
  });
});

export const DELETE = withAuth(async (req, user): Promise<NextResponse> => {
  const scope = req.nextUrl.searchParams.get('scope') ?? '';
  if (scope !== 'others') {
    return NextResponse.json(
      {
        type: 'about:blank',
        title: 'Ошибка валидации',
        status: 422,
        detail: "Поддерживается только ?scope=others — завершение всех прочих сессий",
      },
      { status: 422 },
    );
  }
  const revoked = await revokeOtherSessions(user, req);
  return NextResponse.json({ revoked });
}, { write: 'VIEWER' });
