// GET /api/v1/auth/me — текущий пользователь по сессии.
// RBAC: любая аутентифицированная роль. Успех: 200 {user{id, email, name, role,
// mustChangePassword}}; без валидной сессии — 401 problem+json.
// Побочных эффектов нет (чистое чтение, cookie не меняются).
import { NextRequest, NextResponse } from 'next/server';
import { toProblemResponse } from '@/lib/api';
import { me } from '@/lib/services/auth';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // withAuth не используется — сервис сам резолвит сессию (401/200).
    return await me(req);
  } catch (e) {
    return toProblemResponse(e);
  }
}
