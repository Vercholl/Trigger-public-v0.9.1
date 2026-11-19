// Аутентификация панели: вход (брутфорс-защита), выход, смена пароля.
// Домен: security — учётные записи операторов панели и их сессии.
// Вызывается из API-роутов: /api/v1/auth/login, /auth/logout, /auth/me,
// /auth/change-password, /auth/change-password/skip.
// Таблицы Prisma: User, Session (создание/удаление), AuditLog (через logAudit);
// счётчик rate-limit входа — RateLimitEntry (внутри loginRateLimiter).
import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getClientIp } from '@/lib/api';
import { verifyPassword, validatePasswordPolicy, hashPassword } from '@/lib/security/password';
import { checkPasswordNotReused, recordPreviousPassword } from '@/lib/security/password-history';
import {
  createSession,
  destroySessionByToken,
  getSessionToken,
  getSessionUser,
  sessionCookieHeader,
  clearSessionCookieHeader,
  isSecureRequest,
  sha256Hex,
} from '@/lib/security/session';
import { loginRateLimiter, passwordRateLimiter } from '@/lib/security/rate-limiter';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import { DEFAULT_ADMIN_PASSWORD } from '@/lib/db-bootstrap';

/** Схема входа: email (валидный адрес) и непустой пароль. */
export const loginSchema = z.object({
  email: z.email('Некорректный email'),
  password: z.string().min(1, 'Пароль обязателен'),
});

/** Схема смены пароля: старый и новый (оба непустые); новый дополнительно
 *  прогоняется через политику validatePasswordPolicy внутри changePassword. */
export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, 'Текущий пароль обязателен'),
  newPassword: z.string().min(1, 'Новый пароль обязателен'),
});

export type LoginDto = z.infer<typeof loginSchema>;
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;

// Брутфорс-защита на уровне аккаунта: после MAX_FAILED_LOGINS подряд неверных
// паролей запись блокируется на LOCK_MINUTES (HTTP 423), счётчик обнуляется.
// Две независимые защиты: эта (per-user) и loginRateLimiter (per-IP, 30/5мин).
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

/** Лимит попыток смены пароля (подбор СТАРОГО пароля при украденной сессии):
 *  10 попыток / 10 минут на пользователя. Неверный старый пароль считается
 *  попыткой ДО bcrypt — дешёвый отбой 429, как у логина. */
const CHANGE_PASSWORD_MAX_ATTEMPTS = 10;
const CHANGE_PASSWORD_WINDOW_SEC = 600;

/** Обрезка User-Agent для аудита входа: 120 символов достаточно для
 *  идентификации браузера/ОС, не раздувает details. */
function auditUserAgent(req: NextRequest): string | undefined {
  const ua = req.headers.get('user-agent');
  if (!ua) return undefined;
  return ua.length > 120 ? `${ua.slice(0, 120)}…` : ua;
}

/** Фиктивный bcrypt-хеш (cost 12, пароль неизвестен никому): проверка пароля
 *  против него при отсутствии пользователя выравнивает время ответа —
 *  перечисление email по таймингу (быстрый 401 = «такого email нет»)
 *  перестаёт работать. */
const DUMMY_BCRYPT_HASH = '$2b$12$IeZ.eLvB99CH1/2nV1SHZeEDxmI2/jWYIfCA22aiXXpYIP4LLSiG.';

/** Проецирует запись User в безопасный публичный JSON ответа: только id/email/
 *  name/role/mustChangePassword (хеш пароля, isActive и пр. наружу не уходят). */
function publicUser(user: {
  id: string;
  email: string;
  name: string | null;
  role: string;
  mustChangePassword: boolean;
}): Record<string, unknown> {
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    },
  };
}

/**
 * POST /auth/login: rate-limit → блокировка (423) → bcrypt → деактивация (403,
 * только при верном пароле — анти-enumeration) → сессия.
 * Побочные эффекты: запись User (счётчик неудач/лок-аут/сброс), создание Session,
 * RateLimitEntry (30 попыток / 5 мин на IP), audit-лог LOGIN / LOGIN_FAILED.
 */
export async function login(req: NextRequest, dto: LoginDto): Promise<NextResponse> {
  const ip = getClientIp(req);
  // Первый рубеж: rate-limit по IP — ДО каких-либо обращений к User (дешёвый отбой 429)
  const allowed = await loginRateLimiter.check(`login:ip:${ip}`, 30, 300);
  if (!allowed) {
    return NextResponse.json(
      { type: 'about:blank', title: 'Слишком много попыток входа', status: 429 },
      { status: 429 },
    );
  }

  const email = dto.email.trim().toLowerCase();
  const user = await db.user.findUnique({ where: { email } });

  // Лок-аут проверяется ДО сверки пароля: заблокированный аккаунт не даёт
  // перебирать пароль даже с правильным кандидатом. Выравнивание тайминга:
  // перед 423 выполняется фиктивная bcrypt-проверка — иначе мгновенный 423 на
  // заблокированном аккаунте отличим по времени от медленного 401 (bcrypt) и
  // раскрывает факт блокировки конкретного email (анти-enumeration).
  if (user && user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await verifyPassword(dto.password, DUMMY_BCRYPT_HASH);
    return NextResponse.json(
      { type: 'about:blank', title: 'Аккаунт временно заблокирован', status: 423 },
      { status: 423 },
    );
  }

  if (!user) {
    // Выравнивание тайминга: bcrypt-проверка против фиктивного хеша (см. константу)
    await verifyPassword(dto.password, DUMMY_BCRYPT_HASH);
    await logAudit({ action: AuditAction.LOGIN_FAILED, entityType: AuditEntity.USER, details: { email }, ip });
    return NextResponse.json(
      { type: 'about:blank', title: 'Неверный email или пароль', status: 401 },
      { status: 401 },
    );
  }

  // Деактивированность проверяется ПОСЛЕ сверки пароля: мгновенный 403 без
  // bcrypt выдавал злоумышленнику существование и статус аккаунта БЕЗ знания
  // пароля (перебор email сводил на нет выравнивание тайминга DUMMY_BCRYPT_HASH
  // выше). Теперь неверный пароль на деактивированном аккаунте неотличим от
  // неизвестного email (401), честный 403 — только при верном пароле.
  const passwordOk = await verifyPassword(dto.password, user.passwordHash);
  if (!passwordOk) {
    // Наращивание счётчика — АТОМАРНЫМ инкрементом (read-modify-write терял
    // параллельные попытки: 5 одновременных неверных логинов могли оставить
    // счётчик =1 — до 5× попыток на окно до лок-аута). Порог проверяем по
    // значению из БД ПОСЛЕ инкремента; при достижении — лок-аут с обнулением
    // (после истечения блокировки у пользователя снова 5 попыток).
    const incremented = await db.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
    });
    if (incremented.failedLoginCount >= MAX_FAILED_LOGINS) {
      await db.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) },
      });
      // Явная запись о срабатывании блокировки: ИБ видит факт брутфорса в
      // журнале одной строкой LOGIN_LOCKED, а не восстанавливает по цепочке
      // LOGIN_FAILED (порог 5 сработал — счётчик обнулён).
      await logAudit({
        user: { id: user.id, email: user.email },
        action: AuditAction.LOGIN_LOCKED,
        entityType: AuditEntity.USER,
        entityId: user.id,
        details: { email: user.email, minutes: LOCK_MINUTES, attempts: MAX_FAILED_LOGINS },
        ip,
      });
    }
    await logAudit({ user: { id: user.id, email: user.email }, action: AuditAction.LOGIN_FAILED, entityType: AuditEntity.USER, ip });
    return NextResponse.json(
      { type: 'about:blank', title: 'Неверный email или пароль', status: 401 },
      { status: 401 },
    );
  }

  // Деактивированный аккаунт с ВЕРНЫМ паролем: честный 403 (при неверном —
  // неотличимый 401 выше, см. комментарий у verifyPassword).
  if (!user.isActive) {
    return NextResponse.json(
      { type: 'about:blank', title: 'Аккаунт деактивирован', status: 403 },
      { status: 403 },
    );
  }

  // Успешный вход сбрасывает счётчик неудач и снимает истёкший лок-аут
  await db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null },
  });

  const session = await createSession(user.id, ip, req.headers.get('user-agent'));
  await logAudit({
    user: { id: user.id, email: user.email },
    action: AuditAction.LOGIN,
    entityType: AuditEntity.USER,
    entityId: user.id,
    details: { email: user.email, ua: auditUserAgent(req) },
    ip,
  });

  // sessionToken в теле — аварийный Bearer-фолбэк для сред, где браузер блокирует
  // сторонние cookie (кросс-сайт iframe предпросмотра, Safari ITP): SPA сохраняет его
  // ТОЛЬКО если cookie-сессия не подтверждается через /auth/me.
  const res = NextResponse.json(
    { ...publicUser(user), sessionToken: session.token },
    { status: 200 },
  );
  res.headers.set('Set-Cookie', sessionCookieHeader(session.token, session.expiresAt, isSecureRequest(req)));
  return res;
}

/**
 * POST /auth/logout: удаляет сессию, чистит cookie.
 * Побочные эффекты: удаление Session из БД, audit-лог LOGOUT. Ответ — 204.
 */
export async function logout(req: NextRequest): Promise<NextResponse> {
  const user = await getSessionUser(req);
  const token = getSessionToken(req);
  if (token) await destroySessionByToken(token);
  if (user) {
    await logAudit({ user, action: AuditAction.LOGOUT, entityType: AuditEntity.USER, ip: getClientIp(req) });
  }
  return new NextResponse(null, {
    status: 204,
    headers: { 'Set-Cookie': clearSessionCookieHeader(isSecureRequest(req)) },
  });
}

/** GET /auth/me: текущий пользователь из cookie/Bearer-сессии; 401, если её нет. */
export async function me(req: NextRequest): Promise<NextResponse> {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ type: 'about:blank', title: 'Не авторизован', status: 401 }, { status: 401 });
  }
  return NextResponse.json(publicUser(user), { status: 200 });
}

/**
 * POST /auth/change-password: проверка старого, лимит попыток, политика,
 * анти-повтор по истории, инвалидация других сессий.
 * Побочные эффекты: запись passwordHash в User (сброс mustChangePassword),
 * строка PasswordHistory (старый хеш), удаление всех сессий пользователя
 * кроме текущей, audit-лог UPDATE.
 */
export async function changePassword(req: NextRequest, dto: ChangePasswordDto): Promise<NextResponse> {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ type: 'about:blank', title: 'Не авторизован', status: 401 }, { status: 401 });
  }
  const ip = getClientIp(req);
  const dbUser = await db.user.findUnique({ where: { id: user.id } });
  if (!dbUser) {
    return NextResponse.json({ type: 'about:blank', title: 'Не авторизован', status: 401 }, { status: 401 });
  }

  // Анти-брутфорс старого пароля (украденная сессия): счётчик инкрементируется
  // ДО bcrypt — отбой 429 дешёвый; окно 10 попыток / 10 минут на пользователя.
  const attemptAllowed = await passwordRateLimiter.check(
    `chpw:user:${user.id}`,
    CHANGE_PASSWORD_MAX_ATTEMPTS,
    CHANGE_PASSWORD_WINDOW_SEC,
  );
  if (!attemptAllowed) {
    return NextResponse.json(
      {
        type: 'about:blank',
        title: 'Слишком много попыток смены пароля',
        status: 429,
        detail: 'Повторите через несколько минут',
      },
      { status: 429 },
    );
  }

  const oldOk = await verifyPassword(dto.oldPassword, dbUser.passwordHash);
  if (!oldOk) {
    await logAudit({
      user,
      action: AuditAction.SECURITY,
      entityType: AuditEntity.USER,
      entityId: user.id,
      details: { kind: 'change_password_old_mismatch' },
      ip,
    });
    return NextResponse.json(
      { type: 'about:blank', title: 'Текущий пароль указан неверно', status: 401 },
      { status: 401 },
    );
  }

  // Политика нового пароля с контекстом владельца (email/имя не в пароле)
  const policyError = validatePasswordPolicy(dto.newPassword, {
    email: dbUser.email,
    name: dbUser.name,
  });
  if (policyError) {
    return NextResponse.json(
      { type: 'about:blank', title: 'Ошибка валидации', status: 422, detail: policyError },
      { status: 422 },
    );
  }

  // Анти-повтор: новый не должен совпадать с текущим и последними 5 паролями
  const reuse = await checkPasswordNotReused(user.id, dbUser.passwordHash, dto.newPassword);
  if (reuse.reused) {
    const detail =
      reuse.matchedIn === 'current'
        ? 'Новый пароль совпадает с текущим'
        : 'Этот пароль уже использовался недавно — придумайте новый';
    return NextResponse.json(
      { type: 'about:blank', title: 'Ошибка валидации', status: 422, detail },
      { status: 422 },
    );
  }

  const previousHash = dbUser.passwordHash;
  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(dto.newPassword),
      mustChangePassword: false,
    },
  });
  // Прежний пароль — в историю (запрет «вернуть старый» при следующей смене)
  await recordPreviousPassword(user.id, previousHash);

  // Инвалидировать все ДРУГИЕ сессии пользователя (текущая остаётся).
  const currentToken = getSessionToken(req);
  if (currentToken) {
    const currentHash = sha256Hex(currentToken);
    const others = await db.session.findMany({
      where: { userId: user.id },
      select: { idHash: true },
    });
    for (const s of others) {
      if (s.idHash !== currentHash) {
        // .catch: конкурентное истечение/удаление той же сессии не должно
        // ломать смену пароля — молча пропускаем уже удалённую.
        await db.session.delete({ where: { idHash: s.idHash } }).catch(() => {});
      }
    }
  }

  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.USER,
    entityId: user.id,
    details: { passwordChanged: true },
    ip,
  });

  return new NextResponse(null, { status: 204 });
}

/**
 * POST /auth/change-password/skip: отложить обязательную смену пароля.
 * Сбрасывает mustChangePassword текущего пользователя (смена останется доступной
 * в меню профиля). Понятно, зачем: вход по дефолтному паролю после бутстрапа БД
 * не должен блокировать проверку функционала панели. Действие аудируется.
 * Побочные эффекты: запись User.mustChangePassword=false, audit-лог UPDATE.
 */
export async function skipPasswordChange(req: NextRequest): Promise<NextResponse> {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ type: 'about:blank', title: 'Не авторизован', status: 401 }, { status: 401 });
  }
  const ip = getClientIp(req);
  // В PRODUCTION откладывать смену при всё ещё ДЕФОЛТНОМ пароле запрещено:
  // пароль публикуется вместе с исходниками дистрибутива, а skip обнулял
  // mustChangePassword в один запрос — защита «принудительная смена при
  // первом входе» не работала вовсе. В dev-песочнице (NODE_ENV=development)
  // skip остаётся — иначе проверка функционала панели после бутстрапа
  // требовала бы реальной смены пароля на каждом холодном старте.
  if (process.env.NODE_ENV === 'production') {
    const dbUser = await db.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (dbUser && (await verifyPassword(DEFAULT_ADMIN_PASSWORD, dbUser.passwordHash))) {
      return NextResponse.json(
        {
          type: 'about:blank',
          title: 'Сначала смените пароль',
          status: 403,
          detail: 'Пароль всё ещё дефолтный (публикуется в исходниках) — отложить смену нельзя, задайте новый пароль',
        },
        { status: 403 },
      );
    }
  }
  try {
    await db.user.update({
      where: { id: user.id },
      data: { mustChangePassword: false },
    });
  } catch (e) {
    // P2025: пользователя нет/удалён — честный 401; прочие ошибки (БД/диск/схема)
    // не маскируем под «не авторизован» — пробрасываем, роут отдаст 500.
    if ((e as { code?: string })?.code === 'P2025') {
      return NextResponse.json({ type: 'about:blank', title: 'Не авторизован', status: 401 }, { status: 401 });
    }
    throw e;
  }
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.USER,
    entityId: user.id,
    details: { passwordChangeSkipped: true },
    ip,
  });
  return new NextResponse(null, { status: 204 });
}