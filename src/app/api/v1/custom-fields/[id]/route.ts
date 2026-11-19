// PATCH/DELETE /api/v1/custom-fields/{id} — правка и удаление поля (ADMIN).
// PATCH: {label?, description?, isActive?}; 200 + поле | 404 | 422. isActive=false
// — деактивация: поле исчезает из конструкторов сегментов/подсказок и перестаёт
// приниматься из client_card, значения НЕ удаляются (живые шаблоны продолжают
// подставлять {{cf_*}}). Побочные эффекты: запись CustomField, инвалидация кэша,
// audit-лог (UPDATE и/или ACTIVATE/DEACTIVATE при смене активности).
// DELETE: безвозвратное удаление поля + всех значений клиентов; 204 без тела;
// 409 — переменная {{cf_<key>}} используется шаблонами/воронками/сегментами
// (гварды в сервисе); 404. Побочные эффекты: транзакция (значения + поле),
// поглощение наблюдений радара, инвалидация кэша, audit DELETE/CUSTOM_FIELD.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import {
  deleteCustomField,
  serializeCustomField,
  updateCustomField,
  updateCustomFieldSchema,
} from '@/lib/services/custom-fields';

export const PATCH = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const dto = updateCustomFieldSchema.parse(await readJson(req));
    const row = await updateCustomField(params.id, dto, user, getClientIp(req));
    return NextResponse.json(serializeCustomField(row));
  },
  { write: 'ADMIN' },
);

export const DELETE = withAuth<{ id: string }>(
  async (req, user, params): Promise<NextResponse> => {
    // Гварды «используется шаблонами/воронками/сегментами» (409) — в сервисе.
    await deleteCustomField(params.id, user, getClientIp(req));
    return new NextResponse(null, { status: 204 });
  },
  { write: 'ADMIN' },
);
