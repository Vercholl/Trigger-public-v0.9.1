// POST /api/v1/users/{id}/password — сброс пароля администратором (ADMIN).
// RBAC: только ADMIN. Успех: 204 (тела нет). Ошибки problem+json: 401/403,
// 404 (пользователь не найден), 422 (политика пароля / zod).
// Побочное: новый хеш + mustChangePassword=false + сброс брутфорс-лока,
// все сессии пользователя инвалидируются; audit UPDATE/USER (passwordReset).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { setUserPassword, setUserPasswordSchema } from '@/lib/services/users';

export const POST = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // zod-валидация → сервис setUserPassword (политика, хеш, инвалидация всех
    // сессий цели, сброс failedLoginCount/lockedUntil, audit) → 204.
    const dto = setUserPasswordSchema.parse(await readJson(req));
    await setUserPassword(params.id, dto.newPassword, user, getClientIp(req));
    return new NextResponse(null, { status: 204 });
  },
  { write: 'ADMIN' },
);
