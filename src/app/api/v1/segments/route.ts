// GET /api/v1/segments — список сегментов (сессия, любая роль).
// POST /api/v1/segments — создать сегмент (MANAGER+): {name, description?, conditions}.
// Успех: GET → {items, total} (порядок по createdAt); POST → 201 + карточка
// сегмента (serializeSegment). Ошибки — problem+json (RFC 7807): 422 —
// некорректные правила условий. Побочный эффект POST — audit-лог (CREATE/SEGMENT).
// Роут тонкий: валидация и логика — в services/segments.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { createSegment, createSegmentSchema, listSegments, serializeSegment } from '@/lib/services/segments';

export const GET = withAuth(async (): Promise<NextResponse> => {
  const result = await listSegments();
  return NextResponse.json(result);
});

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    // zod-схема проверяет форму запроса; доменная валидация правил и audit — внутри createSegment.
    const dto = createSegmentSchema.parse(await readJson(req));
    const row = await createSegment(dto, user, getClientIp(req));
    return NextResponse.json(serializeSegment(row), { status: 201 });
  },
  { write: 'MANAGER' },
);
