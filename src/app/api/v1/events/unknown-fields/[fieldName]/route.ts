// DELETE /api/v1/events/unknown-fields/{fieldName} — убрать наблюдение радара
// из сводки (ADMIN): после подключения поля в реестр registry/card-fields или
// решения игнорировать. Пока поле не в реестре, новое наблюдение воссоздаст
// строку — радар не замалчивает дыру в схеме. Побочный эффект — audit DELETE.
// 204 — удалено; 404 — наблюдения нет. fieldName — сегмент пути (URL-безопасные
// snake_case-имена); Next.js уже декодирует params, повторный decode — только
// страховкой (имя с голым «%» не должно ронять роут 500-й, см. safeDecode).
import { NextResponse } from 'next/server';
import { getClientIp, withAuth } from '@/lib/api';
import { deleteUnknownField } from '@/lib/services/events';

/** Осторожное декодирование: Next.js передаёт params УЖЕ декодированными,
 *  поэтому повторный decodeURIComponent нужен лишь для случая двойного
 *  кодирования от клиента. Имя с некорректной %-последовательностью
 *  (URIError) берётся как есть — сервис просто ответит 404. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

export const DELETE = withAuth<{ fieldName: string }>(
  async (req, user, params): Promise<NextResponse> => {
    const fieldName = safeDecode(params.fieldName);
    await deleteUnknownField(fieldName, user, getClientIp(req));
    return new NextResponse(null, { status: 204 });
  },
  { write: 'ADMIN' },
);

