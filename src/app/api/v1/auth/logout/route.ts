// POST /api/v1/auth/logout — выход (любая роль). 204.
// Кросс-сайтовый POST (принудительный logout) отсекается тем же гейтом, что и withAuth.
// RBAC: сессия не обязательна (выход без активной сессии тоже даёт 204). Успех: 204,
// cookie сессии затирается; неожиданные ошибки — 500 problem+json.
// Побочные эффекты: удаление сессии из БД, audit LOGOUT.
import { NextRequest, NextResponse } from 'next/server';
import { checkSameOrigin, toProblemResponse } from '@/lib/api';
import { logout } from '@/lib/services/auth';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // CSRF-гейт → сервис logout (destroySessionByToken, чистка cookie, audit).
    const crossSite = checkSameOrigin(req);
    if (crossSite) return crossSite;
    return await logout(req);
  } catch (e) {
    return toProblemResponse(e);
  }
}
