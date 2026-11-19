// POST /api/v1/templates/preview — предпросмотр рендера шаблона (MANAGER+).
// previewTemplateSchema: body + sampleData + isMarketing + maxSegments.
// Успех 200: rendered, число символов/сегментов, кодировка, список переменных,
// вариант с дисклеймером и флаг overLimit; 422 — ошибка синтаксиса или рендера.
// Расчётный эндпоинт: без записи в БД и без audit (дисклеймер — с демо-токеном).
import { NextRequest, NextResponse } from 'next/server';
import { readJson, withAuth } from '@/lib/api';
import { previewTemplate, previewTemplateSchema } from '@/lib/services/templates';

export const POST = withAuth(
  async (req): Promise<NextResponse> => {
    // Рендер по sampleData — как будет выглядеть SMS у клиента, без сохранения.
    const dto = previewTemplateSchema.parse(await readJson(req));
    const result = await previewTemplate(dto);
    return NextResponse.json(result);
  },
  { write: 'MANAGER' },
);
