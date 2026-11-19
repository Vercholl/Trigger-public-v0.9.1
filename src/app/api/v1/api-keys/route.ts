// GET/POST /api/v1/api-keys — ключи приёма событий (только ADMIN).
// RBAC: обе операции — ADMIN (read/write:'ADMIN'). Успех: GET 200 {items, total}
// (метаданные prefix/ipAllowlist/lastUsedAt — сам ключ в БД не хранится, только
// sha256-хеш); POST 201 {id, name, prefix, key} — raw-ключ показывается РОВНО
// ОДИН раз. Ошибки problem+json: 401/403, 422 (zod / ipAllowlist).
// Побочное: POST пишет audit CREATE/API_KEY.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { createApiKey, createApiKeySchema, listApiKeys } from '@/lib/services/api-keys-service';

export const GET = withAuth(
  async (): Promise<NextResponse> => {
    // Сервис: список ключей по createdAt desc, без пагинации и без секретов.
    const result = await listApiKeys();
    return NextResponse.json(result);
  },
  { read: 'ADMIN' },
);

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    // zod-валидация → сервис createApiKey (валидация ipAllowlist, генерация,
    // sha256+prefix в БД, audit) → 201 с единственным показом raw-ключа.
    const dto = createApiKeySchema.parse(await readJson(req));
    const result = await createApiKey(dto, user, getClientIp(req));
    return NextResponse.json(result, { status: 201 });
  },
  { write: 'ADMIN' },
);
