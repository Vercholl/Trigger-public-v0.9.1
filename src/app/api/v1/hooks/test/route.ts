// POST /api/v1/hooks/test — «Отправить тестовое событие»: генерирует событие
// deliv_sms и прогоняет его через ВЕСЬ конвейер приёмника (парсинг → дедуп →
// журнал → применение статуса к нашей SMS). MANAGER+.
// Тело (опционально): { smsId } — конкретная SMS для теста (tg_sms_id);
// без него цель выбирается автоматически: свежая в полёте (SENT/QUEUED/SENDING)
// → последняя уже отправлявшаяся (SENT/SENDING/FAILED). Подходящих нет → 422.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import { sendTestHookEvent } from '@/lib/services/message-events';

const testHookSchema = z.object({
  // Конкретная SMS для теста (tg_sms_id); пустое тело {} — авто-выбор цели
  smsId: z.string().trim().min(1, 'smsId не может быть пустым').max(64).optional(),
});

export const POST = withAuth(
  async (req, user): Promise<NextResponse> => {
    const dto = testHookSchema.parse(await readJson(req));
    const result = await sendTestHookEvent(user, getClientIp(req), { smsId: dto.smsId ?? null });
    return NextResponse.json(result);
  },
  { write: 'MANAGER' },
);
