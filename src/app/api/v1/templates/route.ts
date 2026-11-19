// GET/POST /api/v1/templates — список и создание SMS-шаблонов (запись — MANAGER+).
// GET — любая роль: фильтр search, includeDeleted (1|true — вместе с
// отключёнными soft-delete-шаблонами) + пагинация; 200 { items, total }.
// POST — MANAGER+: createTemplateSchema → 201 (шаблон); 422 — ошибка
// синтаксиса тела (плейсхолдеры). Побочный эффект — audit CREATE/TEMPLATE.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, parsePagination, readJson, withAuth } from '@/lib/api';
import {
  createTemplate,
  createTemplateSchema,
  listTemplates,
  serializeTemplate,
} from '@/lib/services/templates';

export const GET = withAuth(async (req): Promise<NextResponse> => {
  // По умолчанию скрыты отключённые (soft-delete); includeDeleted=1|true — показать и их.
  const sp = req.nextUrl.searchParams;
  const result = await listTemplates({
    search: sp.get('search') ?? undefined,
    includeDeleted: sp.get('includeDeleted') === '1' || sp.get('includeDeleted') === 'true',
    ...parsePagination(sp),
  });
  return NextResponse.json(result);
});

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    const dto = createTemplateSchema.parse(await readJson(req));
    const template = await createTemplate(dto, user, getClientIp(req));
    return NextResponse.json(serializeTemplate(template), { status: 201 });
  },
  { write: 'MANAGER' },
);
