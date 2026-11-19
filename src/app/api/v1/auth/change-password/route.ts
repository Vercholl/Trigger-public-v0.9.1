// POST /api/v1/auth/change-password — смена собственного пароля.
// Кросс-сайтовый POST отсекается тем же гейтом, что и withAuth.
// RBAC: любая аутентифицированная роль — меняет только СВОЙ пароль. Успех: 204;
// ошибки problem+json: 401 (нет сессии / неверный старый пароль), 422 (политика
// пароля или zod). Побочное: хеш обновляется, mustChangePassword сбрасывается,
// все ДРУГИЕ сессии пользователя инвалидируются; audit UPDATE/USER.
import { NextRequest, NextResponse } from 'next/server';
import { checkSameOrigin, readJson, toProblemResponse } from '@/lib/api';
import { changePassword, changePasswordSchema } from '@/lib/services/auth';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // CSRF-гейт → zod-валидация → сервис changePassword (verify старого пароля,
    // политика нового, инвалидация прочих сессий, audit) → 204.
    const crossSite = checkSameOrigin(req);
    if (crossSite) return crossSite;
    const dto = changePasswordSchema.parse(await readJson(req));
    return await changePassword(req, dto);
  } catch (e) {
    return toProblemResponse(e);
  }
}
