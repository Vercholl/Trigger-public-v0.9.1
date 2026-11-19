// Самообслуживание «Активные сессии»: список своих сессий и отзыв (одной/всех
// прочих). Вызывается из API-роутов /api/v1/auth/sessions (GET, DELETE
// ?scope=others) и /api/v1/auth/sessions/[id] (DELETE).
// Таблицы Prisma: Session (чтение/удаление), AuditLog (SESSION_REVOKED).
// Идентификатор сессии наружу — sha256-хеш токена (idHash): по нему невозможно
// восстановить сам токен (preimage-устойчивость), отзыв — только владельцем
// (сессия запроса проверена withAuth, чужие idHash не совпадают с userId).
import type { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { ApiError, getClientIp } from '@/lib/api';
import { getSessionToken, sha256Hex, type SessionUser } from '@/lib/security/session';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';

export interface SessionListItem {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Список активных сессий пользователя (не истёкших, по убыванию активности). */
export async function listMySessions(user: SessionUser, req: NextRequest): Promise<SessionListItem[]> {
  const token = getSessionToken(req);
  const currentHash = token ? sha256Hex(token) : null;
  const rows = await db.session.findMany({
    where: { userId: user.id, expiresAt: { gt: new Date() } },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map((s) => ({
    id: s.idHash,
    createdAt: s.createdAt.toISOString(),
    lastActivityAt: s.updatedAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    ip: s.ip,
    userAgent: s.userAgent,
    current: currentHash !== null && s.idHash === currentHash,
  }));
}

/** Отзыв своей сессии по idHash. Текущую отзывать нельзя (для этого — «Выход»). */
export async function revokeMySession(
  user: SessionUser,
  sessionHash: string,
  req: NextRequest,
): Promise<void> {
  const token = getSessionToken(req);
  const currentHash = token ? sha256Hex(token) : null;
  if (currentHash !== null && sessionHash === currentHash) {
    throw new ApiError(409, 'Текущую сессию завершает «Выйти»', 'Используйте выход из аккаунта');
  }
  // where по паре (idHash, userId) — чужую сессию удалить невозможно даже зная её idHash
  const removed = await db.session.deleteMany({ where: { idHash: sessionHash, userId: user.id } });
  if (removed.count === 0) throw new ApiError(404, 'Сессия не найдена');
  await logAudit({
    user,
    action: AuditAction.SESSION_REVOKED,
    entityType: AuditEntity.USER,
    entityId: user.id,
    details: { session: sessionHash.slice(0, 12) },
    ip: getClientIp(req),
  });
}

/** Отзыв ВСЕХ прочих сессий пользователя (текущая остаётся). Возвращает число. */
export async function revokeOtherSessions(user: SessionUser, req: NextRequest): Promise<number> {
  const token = getSessionToken(req);
  const currentHash = token ? sha256Hex(token) : null;
  const removed = await db.session.deleteMany({
    where: currentHash
      ? { userId: user.id, NOT: { idHash: currentHash } }
      : { userId: user.id },
  });
  if (removed.count > 0) {
    await logAudit({
      user,
      action: AuditAction.SESSION_REVOKED,
      entityType: AuditEntity.USER,
      entityId: user.id,
      details: { revoked: removed.count, scope: 'others' },
      ip: getClientIp(req),
    });
  }
  return removed.count;
}
