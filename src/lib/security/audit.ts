// Аудит значимых действий. Запись в аудит не должна ломать основной сценарий.
//
// КТО и КОГДА пишет: только серверный код — API-роуты (после withAuth) и
// сервисы из lib/services / lib/compliance — всегда ПОСЛЕ успешного действия;
// actor берётся из сессии (SessionUser: id/email), IP — из запроса. Действия
// БЕЗ пользователя (система): отписка клиента по HMAC-ссылке и из вебхуков
// доставки (UNSUBSCRIBE c source=LINK/HOOK) — пишутся с user=null.
// Хранение: таблица AuditLog (userId/userEmail дублируются на случай удаления
// пользователя). Чтение — панель «Аудит» (ADMIN, см. RBAC в docs/security.md).
import { db } from '@/lib/db';
import type { SessionUser } from '@/lib/security/session';

/** Одна запись журнала: actor (user из сессии или null для системных действий),
 * действие, сущность (id + details JSON) и IP источника запроса. */
export interface AuditEntry {
  user?: Pick<SessionUser, 'id' | 'email'> | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
}

/**
 * Действия аудита (неполный список — значения открытые).
 * Типовые пары действие → сущность:
 * LOGIN/LOGIN_FAILED/LOGOUT — вход (успех/брутфорс-лок/выход) в USER;
 * CREATE/UPDATE/DELETE — CRUD пользователя/шаблона/воронки/сегмента/ссылки…;
 * ACTIVATE/DEACTIVATE — переключение шаблонов/воронок/пользователя;
 * REVOKE — отзыв API-ключа; CANCEL — отмена рассылки/экземпляра воронки;
 * IMPORT/EXPORT — импорт клиентов/выгрузка SMS-журнала (CSV);
 * UNSUBSCRIBE — отписка (в т.ч. системная по HMAC-ссылке без user);
 * RUN/PAUSE/RESUME/RETRY — жизненный цикл рассылки и ретрай события;
 * FREEZE/UNFREEZE — заморозка/разморозка сегмента (снапшот состава);
 * ACTIVATE/DEACTIVATE — в т.ч. кастомные поля профиля (вместо удаления).
 */
export const AuditAction = {
  LOGIN: 'LOGIN',
  LOGIN_FAILED: 'LOGIN_FAILED',
  /** Срабатывание брутфорс-лок аут-каунта: аккаунт заблокирован на 15 минут. */
  LOGIN_LOCKED: 'LOGIN_LOCKED',
  LOGOUT: 'LOGOUT',
  /** Принудительное завершение сессии (самообслуживание «Активные сессии»). */
  SESSION_REVOKED: 'SESSION_REVOKED',
  /** Неудачная аутентификация на публичном приёмнике (токен/ключ/секрет). */
  SECURITY: 'SECURITY',
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  ACTIVATE: 'ACTIVATE',
  DEACTIVATE: 'DEACTIVATE',
  REVOKE: 'REVOKE',
  CANCEL: 'CANCEL',
  IMPORT: 'IMPORT',
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  EXPORT: 'EXPORT',
  RUN: 'RUN',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  RETRY: 'RETRY',
  FREEZE: 'FREEZE',
  UNFREEZE: 'UNFREEZE',
} as const;

/** Сущности, над которыми выполняются действия (таблицы предметной области). */
export const AuditEntity = {
  USER: 'USER',
  CLIENT: 'CLIENT',
  TEMPLATE: 'TEMPLATE',
  FUNNEL: 'FUNNEL',
  INSTANCE: 'INSTANCE',
  API_KEY: 'API_KEY',
  SETTINGS: 'SETTINGS',
  SMS: 'SMS',
  SEGMENT: 'SEGMENT',
  BROADCAST: 'BROADCAST',
  SHORT_LINK: 'SHORT_LINK',
  EVENT: 'EVENT',
  CUSTOM_FIELD: 'CUSTOM_FIELD',
  MASS_UPDATE_JOB: 'MASS_UPDATE_JOB',
  /** Системные/инфраструктурные события (аутентификация приёмников и пр.). */
  SYSTEM: 'SYSTEM',
} as const;

/**
 * Запись в AuditLog. НИКОГДА не бросает (fail-soft: сбой аудита только в
 * консоль) — журнал не должен валить бизнес-операцию, но и не должен
 * молчать: источник сбоев виден в логе процесса.
 * Вызов дешёвый и неблокирующий для сценария: await без ретраев.
 */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: entry.user?.id ?? null,
        userEmail: entry.user?.email ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        details: entry.details ? JSON.stringify(entry.details) : null,
        ip: entry.ip ?? null,
      },
    });
  } catch (e) {
    console.error('[audit] write failed:', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Throttle-таблица для logSecurityEventThrottled (глобальная — переживает
 * hot-reload): kind+ip → время последней записи. Не более одной записи на
 * пару за окно — молотилка по чужому секрету не раздувает журнал.
 */
const securityThrottleState = (() => {
  const g = globalThis as unknown as { __triggerSecurityThrottle?: Map<string, number> };
  if (!g.__triggerSecurityThrottle) g.__triggerSecurityThrottle = new Map();
  return g.__triggerSecurityThrottle;
})();

/**
 * Аудит неудачной аутентификации на публичном приёмнике (SECURITY/SYSTEM):
 * неверный токен приёмника событий, неверный X-Api-Key, неверный секрет
 * webhook-а. Троттлинг: не чаще 1 записи на (kind, ip) в 10 минут — сами
 * приёмники ограничены rate-limit'ом (429), но без троттлинга каждая из
 * 300 попыток/мин создавала бы строку журнала. ИБ видит сам факт и адрес
 * источника; интенсивность видна в rate-limit счётчике, а не в аудите.
 * details не должен содержать сам секрет (только факт «предъявлен неверный»).
 */
export async function logSecurityEventThrottled(
  kind: string,
  ip: string,
  details: Record<string, unknown>,
): Promise<void> {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const last = securityThrottleState.get(key) ?? 0;
  if (now - last < 10 * 60 * 1000) return;
  securityThrottleState.set(key, now);
  // Мягкая защита от роста карты: при >1000 записей чистим устаревшие
  if (securityThrottleState.size > 1000) {
    for (const [k, t] of securityThrottleState) {
      if (now - t > 10 * 60 * 1000) securityThrottleState.delete(k);
    }
  }
  await logAudit({
    action: AuditAction.SECURITY,
    entityType: AuditEntity.SYSTEM,
    details: { kind, ...details },
    ip,
  });
}
