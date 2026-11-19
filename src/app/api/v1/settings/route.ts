// GET/PUT /api/v1/settings — настройки (чтение — все роли, запись — ADMIN).
// Успех: 200 + serializeSettings (обе операции; GET лениво создаёт singleton-строку
// AppSettings из env при первом обращении). Ошибки problem+json: 401/403, 422
// (zod-схема / не-IANA-таймзона / шаблон приписки). Побочное: PUT — audit UPDATE/SETTINGS.
import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, readJson, withAuth } from '@/lib/api';
import {
  getSettings,
  serializeSettings,
  updateSettings,
  updateSettingsSchema,
} from '@/lib/services/settings';

export const GET = withAuth(async (): Promise<NextResponse> => {
  // Сервис getSettings: singleton id="app" (создаётся из env при первом чтении).
  const settings = await getSettings();
  return NextResponse.json(serializeSettings(settings));
});

export const PUT = withAuth(
  async (req, user): Promise<NextResponse> => {
    // zod-валидация → сервис updateSettings (IANA-таймзона, приписка, update,
    // audit) → 200 с обновлёнными настройками.
    const dto = updateSettingsSchema.parse(await readJson(req));
    const settings = await updateSettings(dto, user, getClientIp(req));
    return NextResponse.json(serializeSettings(settings));
  },
  { write: 'ADMIN' },
);
