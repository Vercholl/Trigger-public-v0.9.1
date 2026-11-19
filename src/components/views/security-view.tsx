'use client';

// «Безопасность» — самообслуживание и контроль защиты:
//  1. «Активные сессии» (все роли): список своих сессий (IP, устройство,
//     активность), завершение одной / всех прочих. API: GET/DELETE
//     /api/v1/auth/sessions, DELETE /api/v1/auth/sessions/{id}.
//  2. «Состояние защиты» (только ADMIN): self-check конфигурации — чек-лист
//     секретов/политик/атак из GET /api/v1/security/status (для отдела ИБ).
//  3. Карточка «Пароль» — короткая сводка активной политики паролей.
// Роли: сессии — любая; статус защиты — ADMIN (сервер отдаёт 403 прочим).
import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  XCircle,
  KeyRound,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api-client';
import { ErrorState, fmtDT, useRole } from '@/components/views/shared';

/** Сессия из GET /api/v1/auth/sessions. */
interface SessionItem {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

interface SessionsResponse {
  items: SessionItem[];
  total: number;
  policy: { ttlHours: number; idleHours: number };
}

/** Пункт self-check из GET /api/v1/security/status. */
interface SecurityCheckItem {
  id: string;
  title: string;
  status: 'ok' | 'warn' | 'fail';
  value?: string;
  recommendation?: string;
}

interface SecurityStatusResponse {
  checks: SecurityCheckItem[];
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

/**
 * Компактное описание браузера/ОС из User-Agent (для таблицы сессий): сырой
 * UA — строка на ~150 символов, в узкой колонке нечитаем, а по паре
 * «Edge · Windows» человек узнаёт свою сессию и замечает чужую.
 */
function uaSummary(ua: string | null): string {
  if (!ua) return '—';
  let browser = 'Браузер неизвестен';
  // Порядок веток принципиален: UA «накопительно» содержит чужие токены —
  // Edge и Opera включают подстроку «Chrome/», поэтому проверяются РАНЬШЕ
  // Chrome, иначе подписались бы «Chrome». curl — последняя ветка: это
  // CLI-клиент (интеграционные запросы), а не браузер.
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  else if (/curl/i.test(ua)) browser = 'curl';
  let os = '';
  // ОС — тот же принцип специфичности: «Android» содержит «Linux», а iPhone/
  // iPad — «like Mac OS X», поэтому частные токены идут раньше общих.
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  return os ? `${browser} · ${os}` : browser;
}

/** Относительное время «5 мин назад» — для колонки активности. */
function relTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн назад`;
}

/**
 * Карточка «Активные сессии»: таблица своих сессий (устройство/IP/активность,
 * бейдж «текущая») + завершение одной строки или всех прочих. Свою сессию
 * завершить нельзя (кнопки у «текущей» нет) — только выходом/сменой пароля.
 */
function ActiveSessionsCard() {
  const qc = useQueryClient();
  // Опрос каждые 30 с: список «живой» — новые входы и завершённые/истёкшие
  // сессии появляются и исчезают без ручного обновления экрана.
  const sessionsQuery = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => api<SessionsResponse>('/api/v1/auth/sessions'),
    refetchInterval: 30_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api<void>(`/api/v1/auth/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Сессия завершена');
      void qc.invalidateQueries({ queryKey: ['auth-sessions'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось завершить сессию'),
  });

  // «Завершить все прочие» — DELETE ?scope=others: сервер отзывает все сессии
  // КРОМЕ текущей (в отличие от смены пароля, аннулирующей вообще все);
  // ответ { revoked } — сколько снято, для тоста.
  const revokeOthersMutation = useMutation({
    mutationFn: () =>
      api<{ revoked: number }>('/api/v1/auth/sessions?scope=others', { method: 'DELETE' }),
    onSuccess: (data) => {
      toast.success(`Завершено прочих сессий: ${data.revoked}`);
      void qc.invalidateQueries({ queryKey: ['auth-sessions'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Не удалось завершить сессии'),
  });

  const items = sessionsQuery.data?.items ?? [];
  const othersCount = items.filter((s) => !s.current).length;

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            <MonitorSmartphone className="size-4" aria-hidden />
            Активные сессии
            {sessionsQuery.data ? (
              <Badge variant="secondary">{sessionsQuery.data.total}</Badge>
            ) : null}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void sessionsQuery.refetch()}
              aria-label="Обновить список сессий"
            >
              <RefreshCw className="size-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-red-600 hover:text-red-700 dark:text-red-400"
              disabled={othersCount === 0 || revokeOthersMutation.isPending}
              onClick={() => revokeOthersMutation.mutate()}
            >
              Завершить все прочие
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {sessionsQuery.isLoading ? (
          <p className="text-sm text-zinc-500">Загрузка…</p>
        ) : sessionsQuery.isError ? (
          <ErrorState
            error={sessionsQuery.error}
            onRetry={() => void sessionsQuery.refetch()}
          />
        ) : items.length === 0 ? (
          <p className="text-sm text-zinc-500">Нет активных сессий</p>
        ) : (
          <>
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Устройство</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead>Активность</TableHead>
                    <TableHead>Истекает</TableHead>
                    <TableHead className="w-10" aria-label="Действия" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="max-w-[220px]">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm">{uaSummary(s.userAgent)}</span>
                          {s.current ? (
                            <Badge className="bg-emerald-600/15 text-emerald-700 dark:text-emerald-400" variant="secondary">
                              текущая
                            </Badge>
                          ) : null}
                        </div>
                        <p className="text-xs text-zinc-500">создана {fmtDT(s.createdAt)}</p>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{s.ip ?? '—'}</TableCell>
                      <TableCell className="text-sm">{relTime(s.lastActivityAt)}</TableCell>
                      <TableCell className="text-sm">{fmtDT(s.expiresAt)}</TableCell>
                      <TableCell>
                        {s.current ? null : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 text-red-600 hover:text-red-700 dark:text-red-400"
                            disabled={revokeMutation.isPending}
                            onClick={() => revokeMutation.mutate(s.id)}
                            aria-label="Завершить сессию"
                          >
                            Завершить
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {sessionsQuery.data ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Политика: сессия живёт до {sessionsQuery.data.policy.ttlHours} ч (абсолютный
                лимит) и до {sessionsQuery.data.policy.idleHours} ч без активности; смена
                пароля и «Завершить все прочие» аннулируют остальные сессии.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Иконка-статус пункта self-check. */
function CheckStatusIcon({ status }: { status: 'ok' | 'warn' | 'fail' }) {
  if (status === 'ok') {
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
  }
  if (status === 'warn') {
    return <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />;
  }
  return <XCircle className="size-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden />;
}

/** Карточка «Состояние защиты» (ADMIN): self-check + счётчики + политика. */
function SecurityStatusCard() {
  // GET /api/v1/security/status, опрос раз в минуту: карточка задумана как
  // дежурный экран ИБ — сводка подтягивается сама, без F5.
  const statusQuery = useQuery({
    queryKey: ['security-status'],
    queryFn: () => api<SecurityStatusResponse>('/api/v1/security/status'),
    refetchInterval: 60_000,
  });

  if (statusQuery.isLoading) {
    return (
      <Card className="shadow-sm">
        <CardContent className="py-10 text-center text-sm text-zinc-500">
          Проверка конфигурации…
        </CardContent>
      </Card>
    );
  }
  if (statusQuery.isError || !statusQuery.data) {
    return (
      <ErrorState
        error={statusQuery.error ?? new Error('Не удалось получить состояние защиты')}
        onRetry={() => void statusQuery.refetch()}
      />
    );
  }

  const data = statusQuery.data;
  // Сводный статус считается на клиенте по приоритету: любой fail — «критично»,
  // иначе любой warn — «внимания»; ok — только при чистом чек-листе
  // (серверного агрегата в ответе нет — только плоский список checks).
  const fails = data.checks.filter((c) => c.status === 'fail').length;
  const warns = data.checks.filter((c) => c.status === 'warn').length;
  const overall = fails > 0 ? 'fail' : warns > 0 ? 'warn' : 'ok';

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {overall === 'ok' ? (
              <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : (
              <ShieldAlert
                className={
                  overall === 'fail'
                    ? 'size-4 text-red-600 dark:text-red-400'
                    : 'size-4 text-amber-600 dark:text-amber-400'
                }
                aria-hidden
              />
            )}
            Состояние защиты
            <Badge
              variant="secondary"
              className={
                overall === 'ok'
                  ? 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
                  : overall === 'fail'
                    ? 'bg-red-600/15 text-red-700 dark:text-red-400'
                    : 'bg-amber-600/15 text-amber-700 dark:text-amber-400'
              }
            >
              {overall === 'ok'
                ? 'всё в порядке'
                : overall === 'fail'
                  ? `${fails} критичных`
                  : `${warns} внимания`}
            </Badge>
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void statusQuery.refetch()}
            aria-label="Перепроверить состояние защиты"
          >
            <RefreshCw className="size-4" aria-hidden />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Чек-лист конфигурации */}
        <ul className="divide-y rounded-md border">
          {data.checks.map((c) => (
            <li key={c.id} className="flex items-start gap-3 px-3 py-2.5">
              <span className="mt-0.5">
                <CheckStatusIcon status={c.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <p className="text-sm font-medium text-foreground">{c.title}</p>
                  {c.value ? (
                    <p className="max-w-full break-words text-right text-xs text-zinc-500 dark:text-zinc-400 sm:max-w-[55%]">
                      {c.value}
                    </p>
                  ) : null}
                </div>
                {c.recommendation ? (
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    → {c.recommendation}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        {/* Счётчики */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              ['Пользователи', data.metrics.activeUsers],
              ['Сессии', data.metrics.activeSessions],
              ['API-ключи', data.metrics.activeApiKeys],
              ['Записей аудита', data.metrics.auditEntries],
              ['Аудит за 24 ч', data.metrics.auditEntries24h],
              ['Неудачные входы (24 ч)', data.metrics.failedLogins24h],
              ['SECURITY-события (24 ч)', data.metrics.securityEvents24h],
              ['Блокировок сейчас', data.metrics.lockedAccounts],
            ] as [string, number][]
          ).map(([label, value]) => (
            <div key={label} className="rounded-md border p-2.5">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
              <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
            </div>
          ))}
        </div>

        {/* Активная политика */}
        <div className="rounded-md border p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Активная политика защиты
          </p>
          <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <dt className="text-zinc-500 dark:text-zinc-400">Пароль</dt>
              <dd className="sm:text-right">≥ {data.policy.passwordMinLength} символов, буквы + цифры, не email</dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <dt className="text-zinc-500 dark:text-zinc-400">История паролей</dt>
              <dd className="sm:text-right">нельзя повторить {data.policy.passwordHistoryDepth} последних</dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <dt className="text-zinc-500 dark:text-zinc-400">Хэш</dt>
              <dd className="sm:text-right">bcrypt, cost {data.policy.bcryptCost}</dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <dt className="text-zinc-500 dark:text-zinc-400">Сессия</dt>
              <dd className="sm:text-right">
                до {data.policy.sessionTtlHours} ч; idle {data.policy.sessionIdleHours} ч
              </dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <dt className="text-zinc-500 dark:text-zinc-400">Вход</dt>
              <dd className="sm:text-right">{data.policy.loginRateLimit}; {data.policy.accountLockout}</dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <dt className="text-zinc-500 dark:text-zinc-400">Смена пароля</dt>
              <dd className="sm:text-right">{data.policy.changePasswordRateLimit}</dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
              <dt className="text-zinc-500 dark:text-zinc-400">Публичные приёмники</dt>
              <dd className="sm:text-right">лимит тела: {data.policy.publicEndpointsBodyLimit}</dd>
            </div>
          </dl>
        </div>

        {overall !== 'ok' ? (
          <Alert variant={overall === 'fail' ? 'destructive' : 'default'}>
            <AlertTriangle className="size-4" aria-hidden />
            <AlertTitle>
              {overall === 'fail'
                ? 'Есть критичные пункты — закройте до приёмки ИБ'
                : 'Часть проверок требует внимания'}
            </AlertTitle>
            <AlertDescription>
              Жёлтые пункты — осознанные компромиссы окружения (предпросмотр, dev-режим).
              Красные — конкретные дыры: следуйте рекомендациям «→» в списке выше.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Карточка «Пароль»: сводка политики для пользователя (все роли). */
function PasswordPolicyCard() {
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          <KeyRound className="size-4" aria-hidden />
          Пароль и защита входа
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          <li className="flex items-center gap-2">
            <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ≥ 10 символов: буквы (латиница или кириллица) и цифры
          </li>
          <li className="flex items-center gap-2">
            <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            Не содержит ваш email и имя; не из списка популярных
          </li>
          <li className="flex items-center gap-2">
            <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            Нельзя повторить один из 5 последних паролей
          </li>
          <li className="flex items-center gap-2">
            <Clock className="size-4 shrink-0 text-zinc-400" aria-hidden />
            5 неверных входов — блокировка аккаунта на 15 минут
          </li>
          <li className="flex items-center gap-2">
            <Clock className="size-4 shrink-0 text-zinc-400" aria-hidden />
            10 попыток смены пароля / 10 минут — лимит подбора старого пароля
          </li>
        </ul>
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Смена пароля доступна в меню пользователя (правый верхний угол) — все прочие
          сессии при этом аннулируются.
        </p>
      </CardContent>
    </Card>
  );
}

/** Экран «Безопасность»: сессии (все роли) + состояние защиты и политика (ADMIN). */
export function SecurityView() {
  const { isAdmin } = useRole();
  return (
    <div className="space-y-4">
      {isAdmin ? <SecurityStatusCard /> : null}
      <ActiveSessionsCard />
      <PasswordPolicyCard />
    </div>
  );
}
