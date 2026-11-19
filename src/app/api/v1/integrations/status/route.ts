// GET /api/v1/integrations/status — снимок здоровья интеграции (G7): глубина
// и лаг events_inbox, поток импорта, очереди рассылок, SMS-обороты 24 ч,
// очередь обратного потока, свежесть воркера. Любая роль (панель «Интеграции»
// и мониторинг); JSON пригоден для zabbix-экспорта (числа/секунды).
// Чтение — без побочных эффектов; 200 всегда (при сбое агрегата — 500
// problem+json через глобальный обработчик).
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { getIntegrationStatus } from '@/lib/services/integration-status';

export const GET = withAuth(async (): Promise<NextResponse> => {
  return NextResponse.json(await getIntegrationStatus());
});
