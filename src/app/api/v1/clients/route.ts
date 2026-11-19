// GET/POST /api/v1/clients — список и создание клиентов (запись — MANAGER+).
// GET — любая аутентифицированная роль: фильтры search/consent/unsubscribed
// + пагинация (page/pageSize); успех 200 { items, total }.
// POST — MANAGER+: createClientSchema → 201 (сериализованный клиент); 422 —
// валидация, 409 — дубль externalId. Побочный эффект — audit CREATE/CLIENT.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, parsePagination, readJson, withAuth } from '@/lib/api';
import {
  createClient,
  createClientSchema,
  listClients,
  serializeClient,
} from '@/lib/services/clients';

export const GET = withAuth(async (req): Promise<NextResponse> => {
  // Фильтры и пагинация из query-string; пустые параметры → undefined (сервис их игнорирует).
  const sp = req.nextUrl.searchParams;
  const filters = {
    search: sp.get('search') ?? undefined,
    consent: sp.get('consent') ?? undefined,
    unsubscribed: sp.get('unsubscribed') ?? undefined,
    ...parsePagination(sp),
  };
  const result = await listClients(filters);
  return NextResponse.json(result);
});

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    // Тело валидируется zod-схемой (422 при мусоре); сервис пишет audit-лог с IP инициатора.
    const dto = createClientSchema.parse(await readJson(req));
    const client = await createClient(dto, user, getClientIp(req));
    return NextResponse.json(serializeClient(client), { status: 201 });
  },
  { write: 'MANAGER' },
);
