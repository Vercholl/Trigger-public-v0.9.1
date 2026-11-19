// GET /api/v1/unsubscribed — список отписавшихся (сессия, любая роль):
// ?search= (подстрока телефона) + стандартная пагинация → {items, total}.
// POST /api/v1/unsubscribed {phone} — операторское внесение номера (MANAGER+, П3):
// запись source=MANUAL + client.unsubscribedAt. Идемпотентно (существующий → 200).
// Ошибки 422 (не E.164) — problem+json (RFC 7807). Побочный эффект POST —
// audit-лог (UNSUBSCRIBE, source=MANUAL, маскированный телефон).
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parsePagination, readJson, withAuth } from '@/lib/api';
import { addUnsubscribedManual, listUnsubscribed } from '@/lib/services/unsubscribe';
import { getClientIp } from '@/lib/api';

// Тело POST: телефон. Формат E.164 глубоко проверяется в сервисе (addUnsubscribedManual).
const createSchema = z.object({
  phone: z.string().min(8).max(20),
});

export const GET = withAuth(async (req): Promise<NextResponse> => {
  const sp = req.nextUrl.searchParams;
  const result = await listUnsubscribed({
    search: sp.get('search') ?? undefined,
    ...parsePagination(sp),
  });
  return NextResponse.json(result);
});

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    const body = await readJson(req);
    const dto = createSchema.parse(body);
    const { item, created } = await addUnsubscribedManual(dto.phone, user, getClientIp(req));
    return NextResponse.json(item, { status: created ? 201 : 200 });
  },
  { write: 'MANAGER' },
);
