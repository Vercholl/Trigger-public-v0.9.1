// POST /api/v1/auth/change-password/skip — отложить обязательную смену пароля
// (сбрасывает mustChangePassword; смена остаётся доступной в меню профиля).
// Кросс-сайтовый POST (принудительный skip) отсекается тем же гейтом, что и withAuth.
// RBAC: любая аутентифицированная роль — действует только на себя. Успех: 204;
// ошибки problem+json: 401 (нет сессии). Побочное: audit UPDATE/USER (passwordChangeSkipped).
import { NextRequest, NextResponse } from 'next/server';
import { checkSameOrigin, toProblemResponse } from '@/lib/api';
import { skipPasswordChange } from '@/lib/services/auth';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // CSRF-гейт → сервис skipPasswordChange (сброс флага, audit) → 204.
    const crossSite = checkSameOrigin(req);
    if (crossSite) return crossSite;
    return await skipPasswordChange(req);
  } catch (e) {
    return toProblemResponse(e);
  }
}
