// DELETE /api/v1/auth/sessions/{id} — завершить СВОЮ сессию по идентификатору
// (id = sha256-хеш токена из GET /auth/sessions). Текущую завершать нельзя —
// для этого «Выйти» (409). Чужие idHash не матчатся по userId — 404.
// RBAC: аутентифицированный пользователь. Успех — 204.
// Побочное: аудит SESSION_REVOKED. Ошибки — problem+json (401/404/409).
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { revokeMySession } from '@/lib/services/sessions';

export const DELETE = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // id — 64 hex-символа sha256; мусор сразу 404 (не раскрывает формат)
    await revokeMySession(user, params.id.toLowerCase(), req);
    return new NextResponse(null, { status: 204 });
  },
  // Самообслуживание: любая роль над СВОИМИ сессиями (userId — из сессии)
  { write: 'VIEWER' },
);
