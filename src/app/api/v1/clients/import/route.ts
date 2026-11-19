// POST /api/v1/clients/import — CSV-импорт клиентов (MANAGER+).
// Тело: { csv } (importClientsSchema; 422 при мусоре). CSV разбирает сервис:
// автоопределение разделителя (;/,/TAB), необязательная строка заголовка,
// существующие клиенты ОБНОВЛЯЮТСЯ по externalId, новые создаются.
// Успех 200 { created, updated, errors[] } — битые строки не валят импорт,
// а возвращаются с номером строки. Побочный эффект — audit IMPORT/CLIENT.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { importClients, importClientsSchema } from '@/lib/services/clients';

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    // Валидация тела: непустой CSV с капом 2 МБ (~10–15 тыс. строк); разбор строк — в сервисе.
    const dto = importClientsSchema.parse(await readJson(req));
    const result = await importClients(dto.csv, user, getClientIp(req));
    return NextResponse.json(result);
  },
  { write: 'MANAGER' },
);
