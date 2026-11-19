// POST /api/v1/auth/login — вход с брутфорс-защитой и созданием сессии.
// Кросс-сайтовый POST (login-CSRF) отсекается ДО создания сессии тем же гейтом,
// что и в withAuth (Sec-Fetch-Site / сверка имени хоста Origin↔Host).
// RBAC: публичный (сессия не требуется). Успех: 200 {user, sessionToken} +
// Set-Cookie (HttpOnly-сессия); ошибки problem+json: 401 (неверный email/пароль),
// 403 (деактивирован), 423 (брутфорс-блок), 429 (rate 30/5мин), 422 (zod), 400 (не-JSON).
// Побочные эффекты: cookie сессии, audit LOGIN | LOGIN_FAILED (services/auth.ts).
import { NextRequest, NextResponse } from 'next/server';
import { checkSameOrigin, readJson, toProblemResponse } from '@/lib/api';
import { login, loginSchema } from '@/lib/services/auth';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // Смысловые шаги: CSRF-гейт → zod-валидация тела → сервис login
    // (rate-limit, брутфорс-лок, bcrypt, сессия, audit) → ответ.
    const crossSite = checkSameOrigin(req);
    if (crossSite) return crossSite;
    const dto = loginSchema.parse(await readJson(req));
    return await login(req, dto);
  } catch (e) {
    return toProblemResponse(e);
  }
}
