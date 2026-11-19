// PUT/DELETE /api/v1/users/{id} — изменение и удаление пользователя (ADMIN).
// RBAC: обе операции — только ADMIN (write:'ADMIN').
// Успех: PUT 200 (serializeUser), DELETE 204 (тела нет).
// Ошибки problem+json: 401/403, 404 (пользователь не найден), 409 (попытка
// понизить/деактивировать последнего активного ADMIN или удалить себя), 422 (zod).
// Побочное: audit UPDATE|DELETE/USER; деактивация (isActive=false) завершает
// все сессии цели (см. services/users.ts).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { deleteUser, serializeUser, updateUser, updateUserSchema } from '@/lib/services/users';

export const PUT = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // zod-валидация → сервис updateUser (защита последнего ADMIN, убийство
    // сессий при деактивации, audit) → 200.
    const dto = updateUserSchema.parse(await readJson(req));
    const updated = await updateUser(params.id, dto, user, getClientIp(req));
    return NextResponse.json(serializeUser(updated));
  },
  { write: 'ADMIN' },
);

export const DELETE = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Сервис deleteUser (self-delete → 409, аудит) → 204 без тела.
    await deleteUser(params.id, user, getClientIp(req));
    return new NextResponse(null, { status: 204 });
  },
  { write: 'ADMIN' },
);
