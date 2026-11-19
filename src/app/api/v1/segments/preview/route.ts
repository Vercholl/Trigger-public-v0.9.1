// POST /api/v1/segments/preview — вычислить условия без сохранения (MANAGER+):
// {conditions, sampleSize?} → {total, sample[]} — предпросмотр конструктора
// сегментов до создания. В БД ничего не пишет (без audit-лога);
// ошибки 422 (некорректные правила) — problem+json (RFC 7807).
import { NextRequest, NextResponse } from 'next/server';
import { readJson, withAuth } from '@/lib/api';
import { previewSegment, previewSegmentSchema } from '@/lib/services/segments';

export const POST = withAuth(
  async (req): Promise<NextResponse> => {
    const dto = previewSegmentSchema.parse(await readJson(req));
    const result = await previewSegment(dto);
    return NextResponse.json(result);
  },
  { write: 'MANAGER' },
);
