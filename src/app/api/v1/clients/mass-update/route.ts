// GET/POST /api/v1/clients/mass-update — массовое обновление клиентов по
// сегменту (P4). GET — журнал операций (любая роль; ?page=&pageSize=).
// POST — создать операцию (MANAGER+): {name, segmentId, updates:[{field,
// value}], maxAffected?}; 201 + карточка операции; 404 — сегмент; 422 —
// невалидные правила (неизвестное поле, тип значения). Воркер исполняет
// PENDING-операции в ближайших тиках (progress: planned/processed/affected).
// Побочные эффекты POST: запись MassUpdateJob + audit CREATE.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import {
  createMassUpdateJob,
  createMassUpdateSchema,
  listMassUpdateJobs,
  serializeMassUpdateJob,
} from '@/lib/services/mass-update';

const MAX_PAGE_SIZE = 50;

export const GET = withAuth(async (req: NextRequest): Promise<NextResponse> => {
  const page = Math.max(1, Number(req.nextUrl.searchParams.get('page')) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.nextUrl.searchParams.get('pageSize')) || 10));
  const result = await listMassUpdateJobs({ skip: (page - 1) * pageSize, take: pageSize });
  return NextResponse.json({ ...result, page, pageSize });
});

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    const dto = createMassUpdateSchema.parse(await readJson(req));
    const row = await createMassUpdateJob(dto, user, getClientIp(req));
    return NextResponse.json(serializeMassUpdateJob(row), { status: 201 });
  },
  { write: 'MANAGER' },
);
