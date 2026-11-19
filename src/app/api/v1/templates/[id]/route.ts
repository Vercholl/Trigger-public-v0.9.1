// PUT/DELETE /api/v1/templates/{id} — обновление (version+1) и soft-delete.
// Оба — MANAGER+. PUT: updateTemplateSchema → 200 (шаблон с новым version);
// 404/422 (синтаксис тела шаблона); audit UPDATE/TEMPLATE.
// DELETE: 204 без тела; 409 — шаблон в активной воронке или ACTIVE/PAUSED-рассылке
// (запись помечается isActive=false, не физически удаляется); audit DELETE/TEMPLATE.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import {
  deleteTemplate,
  serializeTemplate,
  updateTemplate,
  updateTemplateSchema,
} from '@/lib/services/templates';

export const PUT = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Частичное обновление; при смене тела сервис проверяет синтаксис плейсхолдеров (422).
    const dto = updateTemplateSchema.parse(await readJson(req));
    const template = await updateTemplate(params.id, dto, user, getClientIp(req));
    return NextResponse.json(serializeTemplate(template));
  },
  { write: 'MANAGER' },
);

export const DELETE = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Soft-delete: гварды «используется воронкой/рассылкой» (409) — в сервисе.
    await deleteTemplate(params.id, user, getClientIp(req));
    return new NextResponse(null, { status: 204 });
  },
  { write: 'MANAGER' },
);
