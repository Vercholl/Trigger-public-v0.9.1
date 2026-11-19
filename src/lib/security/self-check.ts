// Самодиагностика защиты (self-check) — читаемая панель «Состояние защиты»
// для администратора и отдела ИБ: единый список проверок конфигурации
// (секреты, webhook-подписи, дефолтные пароли, режим развёртывания) с
// вердиктами ok / warn / fail и рекомендацией по каждому пункту.
//
// ПРИНЦИП: проверка только ЧИТАЕТ конфигурацию и БД (без побочных эффектов);
// секреты НЕ раскрываются — только факт «задан/не задан» и маска длины.
// Индикаторы имеют эксплуатационный смысл: warn = «работает, но ИБ спросит»,
// fail = «конкретная дыра, закрыть до приёмки».
import { db } from '@/lib/db';
import { verifyPassword, PASSWORD_MIN_LENGTH } from '@/lib/security/password';
import { PASSWORD_HISTORY_DEPTH } from '@/lib/security/password-history';
import { SESSION_IDLE_MS, SESSION_TTL_MS } from '@/lib/security/session';
import { DEFAULT_ADMIN_PASSWORD } from '@/lib/db-bootstrap';

export type SecurityCheckStatus = 'ok' | 'warn' | 'fail';

export interface SecurityCheck {
  id: string;
  title: string;
  status: SecurityCheckStatus;
  /** Текущее значение проверки (без секретов). */
  value?: string;
  /** Что делать, чтобы закрыть пункт (для warn/fail). */
  recommendation?: string;
}

export interface SecurityStatus {
  /** Чек-лист конфигурации (сверху — самые критичные). */
  checks: SecurityCheck[];
  /** Сводные счётчики для быстрого взгляда. */
  metrics: {
    activeUsers: number;
    activeSessions: number;
    activeApiKeys: number;
    auditEntries: number;
    auditEntries24h: number;
    failedLogins24h: number;
    securityEvents24h: number;
    lockedAccounts: number;
  };
  /** Активная политика (для отчёта ИБ). */
  policy: {
    passwordMinLength: number;
    passwordHistoryDepth: number;
    bcryptCost: number;
    sessionTtlHours: number;
    sessionIdleHours: number;
    loginRateLimit: string;
    accountLockout: string;
    changePasswordRateLimit: string;
    publicEndpointsBodyLimit: string;
  };
  generatedAt: string;
}

/** Проверка «env-секрет задан и не выглядит дефолтным». */
function envSecretCheck(id: string, title: string, envName: string, recommendation: string): SecurityCheck {
  const raw = (process.env[envName] ?? '').trim();
  if (raw === '') {
    return { id, title, status: 'fail', value: 'не задан', recommendation };
  }
  // Очевидные «слабые» паттерны: имя переменной, слово secret/password, короткая длина
  const weak =
    raw.length < 16 ||
    raw.toLowerCase().includes('secret') ||
    raw.toLowerCase().includes('password') ||
    raw.toLowerCase().includes('changeme') ||
    raw.toLowerCase().includes('placeholder');
  return {
    id,
    title,
    status: weak ? 'warn' : 'ok',
    value: weak ? 'задан, но выглядит слабым' : `задан (${raw.length} символов)`,
    ...(weak ? { recommendation } : {}),
  };
}

export async function collectSecurityStatus(): Promise<SecurityStatus> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    activeUsers,
    activeSessions,
    activeApiKeys,
    auditEntries,
    auditEntries24h,
    failedLogins24h,
    securityEvents24h,
    lockedAccounts,
    usersList,
    settings,
  ] = await Promise.all([
    db.user.count({ where: { isActive: true } }),
    db.session.count({ where: { expiresAt: { gt: new Date() } } }),
    db.apiKey.count({ where: { isActive: true, revokedAt: null } }),
    db.auditLog.count(),
    db.auditLog.count({ where: { createdAt: { gt: dayAgo } } }),
    db.auditLog.count({ where: { action: 'LOGIN_FAILED', createdAt: { gt: dayAgo } } }),
    db.auditLog.count({ where: { action: 'SECURITY', createdAt: { gt: dayAgo } } }),
    db.user.count({ where: { lockedUntil: { gt: new Date() } } }),
    db.user.findMany({ select: { id: true, email: true, passwordHash: true, mustChangePassword: true } }),
    db.appSettings.findUnique({ where: { id: 'app' } }),
  ]);

  const checks: SecurityCheck[] = [];

  // 1. Дефолтный пароль стартового администратора — критично
  let defaultAdminActive = false;
  for (const u of usersList) {
    if (await verifyPassword(DEFAULT_ADMIN_PASSWORD, u.passwordHash)) {
      defaultAdminActive = true;
      break;
    }
  }
  checks.push({
    id: 'default-admin-password',
    title: 'Дефолтный пароль администратора',
    status: defaultAdminActive ? 'fail' : 'ok',
    value: defaultAdminActive ? 'ВСЁ ЕЩЁ АКТИВЕН (публикуется в исходниках)' : 'сменён',
    ...(defaultAdminActive
      ? { recommendation: 'Войдите под администратором и смените пароль либо сбросьте его в разделе «Пользователи»' }
      : {}),
  });

  // 2. Секреты окружения
  checks.push(envSecretCheck('session-secret', 'Секрет сессий (SESSION_SECRET)', 'SESSION_SECRET', 'Задайте openssl rand -hex 32 в .env'));
  checks.push(envSecretCheck('secrets-key', 'Ключ шифрования секретов БД (SECRETS_KEY)', 'SECRETS_KEY', 'Задайте openssl rand -hex 32 — ключ AES-256-GCM для кредов провайдеров'));
  checks.push(envSecretCheck('unsubscribe-secret', 'Секрет ссылок отписки (UNSUBSCRIBE_SECRET)', 'UNSUBSCRIBE_SECRET', 'Задайте openssl rand -hex 32 — подпись HMAC токенов отписки'));

  // 3. Ключи приёма событий
  const eventsKeySet = (process.env.EVENTS_API_KEY ?? '').trim() !== '';
  checks.push({
    id: 'events-api-key',
    title: 'Ключ приёма событий (X-Api-Key)',
    status: activeApiKeys > 0 ? 'ok' : eventsKeySet ? 'warn' : 'fail',
    value:
      activeApiKeys > 0
        ? `${activeApiKeys} активных ключей БД${eventsKeySet ? ' + статический env' : ''}`
        : eventsKeySet
          ? 'только статический env-ключ'
          : 'не задан',
    ...(activeApiKeys > 0
      ? {}
      : {
          recommendation:
            'Заведите ключи в разделе «API-ключи» (sha256 + IP-allowlist + отзыв); статический EVENTS_API_KEY замените ключом из БД',
        }),
  });

  // 4. Подписи webhook-ов провайдеров
  const webhookSecrets: [string, string][] = [
    ['SMSTECH_WEBHOOK_SECRET', 'SMS.Tech'],
    ['T2_WEBHOOK_SECRET', 'Т2'],
    ['MTS_WEBHOOK_SECRET', 'МТС OmniChannel'],
  ];
  const missingWebhookSecrets: string[] = [];
  for (const [envName, provider] of webhookSecrets) {
    if ((process.env[envName] ?? '').trim() === '') missingWebhookSecrets.push(provider);
  }
  checks.push({
    id: 'webhook-secrets',
    title: 'Секреты webhook-ов провайдеров',
    status: missingWebhookSecrets.length === 0 ? 'ok' : 'warn',
    value:
      missingWebhookSecrets.length === 0
        ? 'SMS.Tech, Т2, МТС — подписаны'
        : `без секрета: ${missingWebhookSecrets.join(', ')}`,
    ...(missingWebhookSecrets.length === 0
      ? {}
      : { recommendation: 'Задайте секрета в .env и передайте значения провайдерам — webhook-ы будут подписаны (в протоколах подписи тела нет)' }),
  });

  // 5. Секреты приёмника «Захват событий»
  const hooksTokenSet = (settings?.hooksToken ?? '').trim() !== '';
  checks.push({
    id: 'hooks-token',
    title: 'Токен приёмника «Захват событий»',
    status: hooksTokenSet ? 'ok' : 'warn',
    value: hooksTokenSet ? 'сгенерирован' : 'не сгенерирован',
    ...(hooksTokenSet ? {} : { recommendation: 'Сгенерируйте токен в карточке «Захват событий» — без него приёмник закрыт' }),
  });

  // 6. Секреты провайдеров в БД зашифрованы
  const dbSecrets = [settings?.smstechToken ?? '', settings?.t2Password ?? '', settings?.mtsPassword ?? ''];
  const storedSecrets = dbSecrets.filter((s) => s.trim() !== '');
  const encryptedOk = storedSecrets.every((s) => s.startsWith('enc:v1:'));
  checks.push({
    id: 'db-secrets-encrypted',
    title: 'Секреты провайдеров в БД (AES-256-GCM)',
    status: storedSecrets.length === 0 ? 'ok' : encryptedOk ? 'ok' : 'fail',
    value:
      storedSecrets.length === 0
        ? 'креды не сохранены'
        : encryptedOk
          ? `${storedSecrets.length} секретов зашифровано`
          : 'есть незашифрованные (легаси-plaintext)',
    ...(encryptedOk || storedSecrets.length === 0
      ? {}
      : { recommendation: 'Пересохраните креды на вкладке «Интеграции» — они перезапишутся в зашифрованном виде' }),
  });

  // 7. Режим развёртывания
  const isProd = process.env.NODE_ENV === 'production';
  checks.push({
    id: 'node-env',
    title: 'Режим развёртывания (production)',
    status: isProd ? 'ok' : 'warn',
    value: isProd ? 'production' : 'development',
    ...(isProd ? {} : { recommendation: 'Боевой запуск — NODE_ENV=production: включает CSP, полный набор security-заголовков, запрет skip смены дефолтного пароля' }),
  });

  // 8. Защита от встраивания в iframe
  const frameProtection = process.env.FRAME_PROTECTION === '1';
  checks.push({
    id: 'frame-protection',
    title: 'Защита от кликджекинга (X-Frame-Options)',
    status: frameProtection ? 'ok' : 'warn',
    value: frameProtection ? 'FRAME_PROTECTION=1 (DENY)' : 'выключена (для предпросмотра платформы)',
    ...(frameProtection ? {} : { recommendation: 'На сервере компании задайте FRAME_PROTECTION=1, если панель НЕ встраивается в чужие iframe' }),
  });

  // 9. Idle-таймаут сессий
  const idleHours = Math.round(SESSION_IDLE_MS / 3_600_000);
  checks.push({
    id: 'session-idle',
    title: 'Idle-таймаут сессий',
    status: idleHours > 0 && idleHours <= 24 * 7 ? 'ok' : idleHours === 0 ? 'warn' : 'warn',
    value: idleHours === 0 ? 'выключен' : `${idleHours} ч без активности`,
    ...(idleHours > 0 && idleHours <= 24 * 14
      ? {}
      : { recommendation: 'SESSION_IDLE_HOURS: рекомендуем 24–168 — окно жизни угнанной сессии' }),
  });

  // 10. Пользователи, отложившие смену пароля
  const pendingChange = usersList.filter((u) => u.mustChangePassword).length;
  checks.push({
    id: 'users-must-change',
    title: 'Пользователи с несменённым паролем',
    status: pendingChange === 0 ? 'ok' : 'warn',
    value: pendingChange === 0 ? 'все сменили' : `${pendingChange} ждут смену`,
    ...(pendingChange === 0 ? {} : { recommendation: 'mustChangePassword выставлен при создании/сбросе — проконтролируйте фактическую смену' }),
  });

  // 11. Индикатор атак (брутфорс за 24 ч)
  checks.push({
    id: 'failed-logins-24h',
    title: 'Неудачные входы за 24 ч',
    status: failedLogins24h === 0 ? 'ok' : failedLogins24h <= 10 ? 'ok' : 'warn',
    value: `${failedLogins24h} (блокировок сейчас: ${lockedAccounts})`,
    ...(failedLogins24h <= 10
      ? {}
      : { recommendation: 'Проверьте журнал аудита (LOGIN_FAILED/LOGIN_LOCKED) — интенсивный подбор паролей' }),
  });

  const ttlHours = Math.round(SESSION_TTL_MS / 3_600_000);
  return {
    checks,
    metrics: {
      activeUsers,
      activeSessions,
      activeApiKeys,
      auditEntries,
      auditEntries24h,
      failedLogins24h,
      securityEvents24h,
      lockedAccounts,
    },
    policy: {
      passwordMinLength: PASSWORD_MIN_LENGTH,
      passwordHistoryDepth: PASSWORD_HISTORY_DEPTH,
      bcryptCost: 12,
      sessionTtlHours: ttlHours,
      sessionIdleHours: idleHours,
      loginRateLimit: '30 попыток / 5 мин на IP',
      accountLockout: '5 неудач → блокировка 15 мин',
      changePasswordRateLimit: '10 попыток / 10 мин на пользователя',
      publicEndpointsBodyLimit: 'hooks 5 МБ, events/webhooks 2 МБ',
    },
    generatedAt: new Date().toISOString(),
  };
}
