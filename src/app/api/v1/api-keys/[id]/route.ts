// PUT /api/v1/api-keys/{id} — обновление пер-ключевого лимита запросов/мин
// (ADMIN): { rateLimitPerMin: 600 } либо { rateLimitPerMin: null } (общий
// дефолт). DELETE — отзыв ключа (ADMIN). RBAC: только ADMIN.
// Ошибки problem+json: 401/403, 404, 422 (значение вне 1..100000).
// Побочное: запись ApiKey, audit UPDATE/API_KEY (старое и новое значение).
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import {
  revokeApiKey,
  updateApiKeyRateLimit,
  updateApiKeySchema,
} from '@/lib/services/api-keys-service';

export const PUT = withAuth<{ id: string }>(
  async (req: NextRequest, user, params): Promise<NextResponse> => {
    const dto = updateApiKeySchema.parse(await readJson(req));
    const result = await updateApiKeyRateLimit(params.id, dto, user, getClientIp(req));
    return NextResponse.json(result);
  },
  { write: 'ADMIN' },
);

export const DELETE = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Сервис revokeApiKey (soft-revoke, audit) → 204 без тела.
    await revokeApiKey(params.id, user, getClientIp(req));
    return new NextResponse(null, { status: 204 });
  },
  { write: 'ADMIN' },
);
