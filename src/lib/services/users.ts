// Сервис пользователей панели (ADMIN): CRUD, сброс пароля, защиты.
// Домен: RBAC — роли ADMIN (всё), MANAGER (рассылки/контент), VIEWER (чтение);
// матрица доступа — в src/lib/api (withAuth).
// Вызывается из API-роутов: /api/v1/users (GET/POST), /users/{id} (PUT/DELETE),
// /users/{id}/password (POST — сброс пароля администратором).
// Таблицы Prisma: User (основная), Session (массовое удаление при
// деактивации/сбросе пароля), AuditLog через logAudit.
import { z } from 'zod';
import type { Prisma, User } from '@prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { hashPassword, validatePasswordPolicy } from '@/lib/security/password';
import { checkPasswordNotReused, recordPreviousPassword } from '@/lib/security/password-history';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';

/** Роли панели: ADMIN — управление пользователями/настройками, MANAGER —
 *  операции с контентом и рассылками, VIEWER — только просмотр. */
export const ROLES = ['ADMIN', 'MANAGER', 'VIEWER'] as const;

/** Схема создания: email, имя ≤200, роль, пароль (политика — ниже в createUser),
 *  mustChangePassword (по умолчанию true — новый пользователь меняет пароль). */
export const createUserSchema = z.object({
  email: z.email('Некорректный email'),
  name: z.string().trim().max(200).nullish(),
  role: z.enum(ROLES),
  password: z.string().min(1, 'Пароль обязателен'),
  mustChangePassword: z.boolean().optional(),
});

/** Схема обновления: только имя/роль/isActive/mustChangePassword (email и
 *  пароль через отдельные эндпоинты — пароль меняет сам пользователь или сброс). */
export const updateUserSchema = z.object({
  name: z.string().trim().max(200).nullish(),
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
});

/** Схема сброса пароля администратором: один непустой newPassword
 *  (политика проверяется в setUserPassword). */
export const setUserPasswordSchema = z.object({
  newPassword: z.string().min(1, 'Новый пароль обязателен'),
});

export type CreateUserDto = z.infer<typeof createUserSchema>;
export type UpdateUserDto = z.infer<typeof updateUserSchema>;

/** Строка User → JSON API: без passwordHash; брутфорс-поля (failedLoginCount,
 *  lockedUntil) отдаются — для страницы «Пользователи» с состоянием блокировки. */
export function serializeUser(row: User): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    failedLoginCount: row.failedLoginCount,
    lockedUntil: row.lockedUntil,
    createdAt: row.createdAt,
  };
}

/** Список всех пользователей (без пагинации — их единицы). Чтение. */
export async function listUsers(): Promise<{ items: unknown[]; total: number }> {
  const rows = await db.user.findMany({ orderBy: { createdAt: 'asc' } });
  return { items: rows.map(serializeUser), total: rows.length };
}

/** Пользователь по id; 404 через ApiError, если не найден. */
export async function getUserById(id: string): Promise<User> {
  const row = await db.user.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, 'Пользователь не найден');
  return row;
}

/** Создание пользователя: email уникален (409, в т.ч. гонка P2002), пароль —
 *  по политике с контекстом владельца (422), по умолчанию требуется смена
 *  при первом входе. Новый хеш сразу пишется в историю паролей (запрет
 *  «сменить и вернуть» при следующей смене).
 *  Побочные эффекты: запись User (bcrypt-хеш) + PasswordHistory, audit-лог CREATE. */
export async function createUser(dto: CreateUserDto, user: SessionUser, ip: string): Promise<User> {
  const email = dto.email.trim().toLowerCase();
  const policyError = validatePasswordPolicy(dto.password, { email, name: dto.name ?? null });
  if (policyError) throw new ApiError(422, 'Ошибка валидации', policyError);
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) throw new ApiError(409, 'Пользователь с таким email уже существует');
  let row: User;
  try {
    row = await db.user.create({
      data: {
        email,
        name: dto.name ?? null,
        role: dto.role,
        passwordHash: await hashPassword(dto.password),
        mustChangePassword: dto.mustChangePassword ?? true,
      },
    });
  } catch (e) {
    // гонка: email создан параллельным запросом между findUnique и create —
    // отдаём тот же 409, а не 500.
    if ((e as { code?: string })?.code === 'P2002') {
      throw new ApiError(409, 'Пользователь с таким email уже существует');
    }
    throw e;
  }
  // Стартовый пароль — в историю: его нельзя будет «вернуть» после смены
  await recordPreviousPassword(row.id, row.passwordHash);
  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.USER,
    entityId: row.id,
    details: { email: row.email, role: row.role },
    ip,
  });
  return row;
}

/** Обновление: имя/роль/isActive/mustChangePassword. Гард «последнего
 *  администратора» — 409 на разжалование/деактивацию единственного активного
 *  ADMIN (иначе панель потеряет управление). Деактивация завершает все сессии.
 *  Побочные эффекты: запись User, при деактивации — удаление Session, audit-лог UPDATE. */
export async function updateUser(id: string, dto: UpdateUserDto, user: SessionUser, ip: string): Promise<User> {
  const target = await getUserById(id);
  // Защита последнего активного администратора: разжалование/деактивация себя
  // или последнего ADMIN оставит панель без единого администратора (восстановление — только через БД).
  const demotesAdmin =
    target.role === 'ADMIN' &&
    ((dto.role !== undefined && dto.role !== 'ADMIN') || dto.isActive === false);
  if (demotesAdmin) {
    const activeAdmins = await db.user.count({ where: { role: 'ADMIN', isActive: true } });
    if (activeAdmins <= 1) {
      throw new ApiError(409, 'Нельзя понизить/деактивировать последнего активного администратора');
    }
  }
  const row = await db.user.update({
    where: { id },
    data: {
      ...(dto.name !== undefined ? { name: dto.name ?? null } : {}),
      ...(dto.role !== undefined ? { role: dto.role } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.mustChangePassword !== undefined ? { mustChangePassword: dto.mustChangePassword } : {}),
    },
  });
  if (dto.isActive === false) {
    // деактивация — завершаем все сессии пользователя
    await db.session.deleteMany({ where: { userId: id } });
  }
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.USER,
    entityId: row.id,
    details: { email: row.email, role: row.role, isActive: row.isActive },
    ip,
  });
  return row;
}

/** Сброс пароля администратором: новый пароль по политике (с контекстом
 *  владельца), анти-повтор по истории, пользователь разблокируется (сброс
 *  брутфорс-счётчика/лок-аута), все сессии аннулируются.
 *  Побочные эффекты: запись User, строка PasswordHistory, удаление Session,
 *  audit-лог UPDATE (passwordReset). */
export async function setUserPassword(
  id: string,
  newPassword: string,
  user: SessionUser,
  ip: string,
): Promise<void> {
  const target = await getUserById(id);
  const policyError = validatePasswordPolicy(newPassword, {
    email: target.email,
    name: target.name,
  });
  if (policyError) throw new ApiError(422, 'Ошибка валидации', policyError);
  // Анти-повтор: админ не может задать пароль, совпадающий с текущим/последними
  const reuse = await checkPasswordNotReused(id, target.passwordHash, newPassword);
  if (reuse.reused) {
    const detail =
      reuse.matchedIn === 'current'
        ? 'Новый пароль совпадает с текущим'
        : 'Этот пароль уже использовался недавно — придумайте новый';
    throw new ApiError(422, 'Ошибка валидации', detail);
  }
  await db.user.update({
    where: { id },
    data: {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  // Прежний пароль — в историю
  await recordPreviousPassword(id, target.passwordHash);
  await db.session.deleteMany({ where: { userId: id } }); // сброс пароля — все сессии недействительны
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.USER,
    entityId: id,
    details: { passwordReset: true },
    ip,
  });
}

/** Удаление пользователя (нельзя удалить себя — 409). Сессии удаляются
 *  каскадом по FK. Побочные эффекты: физическое удаление User, audit-лог DELETE. */
export async function deleteUser(id: string, user: SessionUser, ip: string): Promise<void> {
  if (id === user.id) {
    throw new ApiError(409, 'Нельзя удалить собственную учётную запись');
  }
  await getUserById(id);
  await db.user.delete({ where: { id } });
  await logAudit({
    user,
    action: AuditAction.DELETE,
    entityType: AuditEntity.USER,
    entityId: id,
    ip,
  });
}
