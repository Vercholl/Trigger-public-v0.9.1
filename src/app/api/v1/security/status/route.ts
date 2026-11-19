// GET /api/v1/security/status — самодиагностика защиты для ИБ (ADMIN).
// Чек-лист конфигурации (секреты, webhook-подписи, дефолтные пароли, режим),
// счётчики (сессии/аудит/атаки) и активная политика паролей/сессий.
// Секреты не раскрываются — только факты «задан/не задан».
// RBAC: ADMIN (write-ранг не нужен — роут только читает). Ошибки — problem+json.
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { collectSecurityStatus } from '@/lib/security/self-check';

export const GET = withAuth(async (): Promise<NextResponse> => {
  const status = await collectSecurityStatus();
  return NextResponse.json(status);
}, { read: 'ADMIN' });
