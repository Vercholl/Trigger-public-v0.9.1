// GET/POST /api/v1/users — список и создание пользователей панели.
// RBAC-таблица (кто может): GET — только ADMIN (read:'ADMIN'); POST — только
// ADMIN (write:'ADMIN'); MANAGER/VIEWER на любом методе → 403. PUT/DELETE
// пользователя — соседний роут /api/v1/users/{id}.
// Успех: GET 200 {items, total} (сортировка createdAt asc, без пагинации);
// POST 201 — serializeUser (passwordHash наружу не отдаётся никогда).
// Ошибки problem+json: 401/403 (withAuth), 422 (zod / политика пароля),
// 409 (email уже существует, включая гонку P2002). Побочное: audit CREATE/USER.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { createUser, createUserSchema, listUsers, serializeUser } from '@/lib/services/users';

export const GET = withAuth(
  async (): Promise<NextResponse> => {
    // Сервис: полный список без пагинации (пользователей панели — единицы).
    const result = await listUsers();
    return NextResponse.json(result);
  },
  { read: 'ADMIN' },
);

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    // zod-валидация → сервис createUser (политика пароля, дубль email → 409,
    // audit) → 201 с сериализованным пользователем (без passwordHash).
    const dto = createUserSchema.parse(await readJson(req));
    const created = await createUser(dto, user, getClientIp(req));
    return NextResponse.json(serializeUser(created), { status: 201 });
  },
  { write: 'ADMIN' },
);
