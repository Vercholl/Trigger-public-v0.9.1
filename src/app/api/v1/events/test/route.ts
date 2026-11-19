// POST /api/v1/events/test — ручная отправка события из панели (источник PANEL).
// Идея заимствована из альтернативной линии разработки 22.10 (V2): кнопка
// «Отправить событие» во вкладке «События» существует со времён Phase 6,
// но роута под ней не было (404) — теперь она работает.
// Отличия от боевого POST /events: авторизация по сессии панели (не API-ключ),
// источник события помечается как PANEL, лимит IP не применяется.
// Успех 202 { eventId, duplicate } — дальше тот же путь: events_inbox (NEW) →
// воркер → воронки; 422 — некорректное тело.
import { NextRequest, NextResponse } from 'next/server';
import { deriveBaseUrl, getClientIp, readJson, withAuth } from '@/lib/api';
import { eventIngestSchema, ingestEvent, rawClientCardOf } from '@/lib/services/events';

export const POST = withAuth(
  async (req: NextRequest): Promise<NextResponse> => {
    const body = await readJson(req);
    const dto = eventIngestSchema.parse(body);
    const result = await ingestEvent(
      dto,
      {
        apiKeyId: null,
        source: 'PANEL',
        ip: getClientIp(req),
        baseUrl: deriveBaseUrl(req), // Origin запроса → ссылка отписки
      },
      rawClientCardOf(body),
    );
    return NextResponse.json(result, { status: 202 });
  },
  { write: 'MANAGER' },
);
