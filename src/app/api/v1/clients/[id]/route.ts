// GET/PUT/DELETE /api/v1/clients/{id} — карточка клиента (запись — MANAGER+).
// GET — любая роль: 200 (карточка + customFields — значения кастомных полей) |
// 404. PUT — MANAGER+: 200; 404/409 (дубль externalId)/422 (в т.ч. невалидное
// значение custom_fields); audit UPDATE/CLIENT. DELETE — MANAGER+: 204 без тела;
// 409, если у клиента есть SMS или экземпляры воронок; audit DELETE/CLIENT.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import {
  deleteClient,
  getClientById,
  serializeClientWithCf,
  updateClient,
  updateClientSchema,
} from '@/lib/services/clients';

export const GET = withAuth<{ id: string }>(async (_req, _user, params): Promise<NextResponse> => {
  const client = await getClientById(params.id);
  return NextResponse.json(await serializeClientWithCf(client));
});

export const PUT = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Частичное обновление: zod пропускает только переданные поля; сервис ведёт
    // audit-лог с IP инициатора и контролирует уникальность externalId (409).
    const dto = updateClientSchema.parse(await readJson(req));
    const client = await updateClient(params.id, dto, user, getClientIp(req));
    return NextResponse.json(await serializeClientWithCf(client));
  },
  { write: 'MANAGER' },
);

export const DELETE = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Физическое удаление; гард целостности в сервисе — 409 при связанных сообщениях.
    await deleteClient(params.id, user, getClientIp(req));
    return new NextResponse(null, { status: 204 });
  },
  { write: 'MANAGER' },
);
