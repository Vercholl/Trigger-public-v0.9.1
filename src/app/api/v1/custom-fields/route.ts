// GET /api/v1/custom-fields — реестр кастомных полей профиля (чтение — любая
// роль: список нужен конструктору сегментов и подсказкам шаблонов).
// POST — создание поля (ADMIN): {key, label, type, description?}; 201 + поле;
// 409 — ключ занят; 422 — ключ/метка/тип. GET: по умолчанию только активные
// (?includeInactive=1 — весь реестр, ADMIN: раздел «Кастомные поля»).
// Побочные эффекты POST: запись CustomField + поглощение наблюдений радара
// + инвалидация кэша реестра + audit CREATE/CUSTOM_FIELD.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import {
  createCustomField,
  createCustomFieldSchema,
  listCustomFields,
  serializeCustomField,
} from '@/lib/services/custom-fields';

export const GET = withAuth(async (req: NextRequest): Promise<NextResponse> => {
  const includeInactive = req.nextUrl.searchParams.get('includeInactive') === '1';
  const items = await listCustomFields(includeInactive);
  return NextResponse.json({ items });
});

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    const dto = createCustomFieldSchema.parse(await readJson(req));
    const row = await createCustomField(dto, user, getClientIp(req));
    return NextResponse.json(serializeCustomField(row), { status: 201 });
  },
  { write: 'ADMIN' },
);
