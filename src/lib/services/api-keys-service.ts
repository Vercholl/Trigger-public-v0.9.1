// Сервис API-ключей приёма событий (ADMIN): создание (ключ показывается один раз),
// список, отзыв. Хранится только sha256(raw) + prefix.
// Домен: внешний интеграционный доступ — POST /api/v1/events с X-API-Key
// (система данных шлёт триггерные события).
// Вызывается из API-роутов: /api/v1/api-keys (GET-список/POST-создание),
// /api-keys/{id} (DELETE — отзыв). Аутентификацию по ключу см. lib/api (withApiKey).
// Таблицы Prisma: ApiKey (keyHash/prefix/ipAllowlist/lastUsedAt), AuditLog.
import { z } from 'zod';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import {
  generateApiKey,
  apiKeyPrefix,
  validateIpAllowlist,
} from '@/lib/security/api-keys';
import { sha256Hex } from '@/lib/security/session';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';

/** Схема создания: название 1–200, опциональный ipAllowlist ≤2000 (список
 *  IP/CIDR — валидируется в createApiKey), опциональный rateLimitPerMin
 *  1–100 000 (повышенный потолок интеграционного ключа; null — общий дефолт). */
export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Название обязательно').max(200),
  ipAllowlist: z.string().trim().max(2000).nullish(),
  rateLimitPerMin: z.number().int().min(1, 'Лимит: минимум 1').max(100_000, 'Лимит: максимум 100000').nullish(),
});

export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

/** Список ключей: без хешей (только prefix — для узнавания в журнале);
 *  факт отзыва виден по isActive/revokedAt. Чтение. */
export async function listApiKeys(): Promise<{ items: unknown[]; total: number }> {
  const rows = await db.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      ipAllowlist: row.ipAllowlist,
      rateLimitPerMin: row.rateLimitPerMin,
      isActive: row.isActive,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
    })),
    total: rows.length,
  };
}

/** Создание ключа: возвращает raw-ключ РОВНО ОДИН раз (в БД — только хеш).
 *  Побочные эффекты: запись ApiKey (sha256-хеш + префикс), audit-лог CREATE
 *  (префикс, не сам ключ). */
export async function createApiKey(dto: CreateApiKeyDto, user: SessionUser, ip: string): Promise<Record<string, unknown>> {
  const allowlist = dto.ipAllowlist?.trim() ?? '';
  if (allowlist !== '') {
    const error = validateIpAllowlist(allowlist);
    if (error) throw new ApiError(422, 'Ошибка валидации', error);
  }
  const key = generateApiKey();
  const row = await db.apiKey.create({
    data: {
      name: dto.name,
      keyHash: sha256Hex(key),
      prefix: apiKeyPrefix(key),
      ipAllowlist: allowlist !== '' ? allowlist : null,
      rateLimitPerMin: dto.rateLimitPerMin ?? null,
      isActive: true,
      createdById: user.id,
    },
  });
  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.API_KEY,
    entityId: row.id,
    details: { name: row.name, prefix: row.prefix, rateLimitPerMin: row.rateLimitPerMin },
    ip,
  });
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    rateLimitPerMin: row.rateLimitPerMin,
    key, // показывается единственный раз
  };
}

/** Схема обновления лимита ключа: rateLimitPerMin 1–100 000 или null
 *  (null — общий дефолт приёма событий). */
export const updateApiKeySchema = z.object({
  rateLimitPerMin: z.number().int().min(1, 'Лимит: минимум 1').max(100_000, 'Лимит: максимум 100000').nullish(),
});

export type UpdateApiKeyDto = z.infer<typeof updateApiKeySchema>;

/** Обновление пер-ключевого лимита запросов/мин (ADMIN): боевое значение для
 *  интеграционного ключа адаптера ядра меняется без перевыпуска ключа.
 *  Побочные эффекты: запись ApiKey, audit-лог UPDATE. */
export async function updateApiKeyRateLimit(
  id: string,
  dto: UpdateApiKeyDto,
  user: SessionUser,
  ip: string,
): Promise<Record<string, unknown>> {
  const row = await db.apiKey.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'API-ключ не найден');
  const next = dto.rateLimitPerMin ?? null;
  await db.apiKey.update({ where: { id }, data: { rateLimitPerMin: next } });
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.API_KEY,
    entityId: id,
    details: { name: row.name, rateLimitPerMin: next, prev: row.rateLimitPerMin },
    ip,
  });
  return { id, rateLimitPerMin: next };
}

/** Отзыв ключа (soft: isActive=false + revokedAt; строки остаются для истории).
 *  Побочные эффекты: запись ApiKey, audit-лог REVOKE. */
export async function revokeApiKey(id: string, user: SessionUser, ip: string): Promise<void> {
  const row = await db.apiKey.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'API-ключ не найден');
  await db.apiKey.update({
    where: { id },
    data: { isActive: false, revokedAt: new Date() },
  });
  await logAudit({
    user,
    action: AuditAction.REVOKE,
    entityType: AuditEntity.API_KEY,
    entityId: id,
    details: { name: row.name },
    ip,
  });
}
