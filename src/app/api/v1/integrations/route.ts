// GET /api/v1/integrations — карточки подключений SMS-провайдеров.
// Токены не отдаются — только факт наличия и URL webhook-а для настройки у SMS.Tech.
import { NextRequest } from 'next/server';
import { deriveBaseUrl, withAuth } from '@/lib/api';
import { listIntegrations } from '@/lib/services/integrations';

export const GET = withAuth(async (req: NextRequest): Promise<Response> => {
  const data = await listIntegrations(deriveBaseUrl(req));
  return Response.json(data);
});
