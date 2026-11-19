// GET /api/v1/audit?limit=30 — журнал аудита (только ADMIN).
// Заимствовано из альтернативной линии разработки 22.10 (V2): текущая ветка
// пишет аудит из 47 точек сервисного слоя, но нигде не показывала его;
// теперь записи видны в карточке «Журнал аудита» во вкладке «Настройки».
// details — JSON-строка без секретов (см. security/audit.ts), клиент парсит сам.
// RBAC: только ADMIN (read:'ADMIN'). Успех: 200 {items, total} (items — последние
// записи по createdAt desc); ошибки problem+json: 401/403. Побочных эффектов нет.
import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api';
import { db } from '@/lib/db';

export const GET = withAuth(
  async (req: NextRequest): Promise<NextResponse> => {
    // limit: клэмп 1..200, дефолт 30 (NaN/мусор → 30).
    const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? 30) || 30;
    const limit = Math.min(200, Math.max(1, Math.trunc(limitRaw)));

    // Последние записи журнала (take=limit) + общий счётчик.
    const entries = await db.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        userEmail: true,
        ip: true,
        details: true,
        createdAt: true,
      },
    });
    const total = await db.auditLog.count();

    return NextResponse.json({
      items: entries.map((e) => ({
        id: e.id,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        userEmail: e.userEmail,
        ip: e.ip,
        details: e.details,
        createdAt: e.createdAt,
      })),
      total,
    });
  },
  { read: 'ADMIN' },
);
