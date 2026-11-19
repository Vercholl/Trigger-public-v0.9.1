'use client';

// Экран входа в панель Trigger — единственная вью без авторизации.
// Домен: auth. Показывается, когда GET /api/v1/auth/me не вернул сессию
// (решение принимает входная точка src/app/page.tsx). Отправляет
// POST /api/v1/auth/login и подтверждает сессию через establishSession
// (HttpOnly-cookie tg_sid; при блокировке cookie — Bearer-фолбэк).
// Роли: неавторизованные (сюда же попадает любая роль после logout).
import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { TriggerMark } from '@/components/logo';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError, establishSession } from '@/lib/api-client';
import { useAppStore, type CurrentUser } from '@/lib/store';

/** Ошибка входа, сведённая к одному из вариантов UI: 'invalid' — неверные
 *  данные (401), 'locked' — брутфорс-блокировка (423), 'unavailable' —
 *  сеть/404, 'session' — вход успешен, но cookie и localStorage заблокированы
 *  (iframe-предпросмотр). null — ошибки нет. */
type LoginError = 'invalid' | 'locked' | 'unavailable' | 'session' | null;

/** Последний успешный email — чтобы повторный вход был в один шаг. */
const LOGIN_EMAIL_KEY = 'tg_login_email';

/** Сохранённый email для поля (сбой storage → ''); читается в useEffect ниже — hydration-safe. */
function storedLoginEmail(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(LOGIN_EMAIL_KEY) ?? '';
  } catch {
    return ''; // приватный режим / блокировка storage
  }
}

/** Экран входа: форма → POST /api/v1/auth/login → setUser в store →
 *  AppShell переключается сам (toast не нужен). Ошибки — инлайн Alert'ы. */
export function LoginView() {
  const setUser = useAppStore((s) => s.setUser);
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<LoginError>(null);

  // Hydration-safe: localStorage читаем ПОСЛЕ монтирования — иначе первый
  // клиентский рендер с сохранённым email не совпадает с SSR-разметкой (warning React 19)
  React.useEffect(() => {
    setEmail(storedLoginEmail());
  }, []);

  /** Сабмит: логин → подтверждение сессии → запомнить email для следующего
   *  входа в один шаг. Статус ApiError переводится в вариант LoginError. */
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await api<{ user: CurrentUser; sessionToken?: string }>(
        '/api/v1/auth/login',
        {
          method: 'POST',
          body: { email: email.trim(), password },
        },
      );
      // Подтверждаем сессию: cookie, а при блокировке cookie — Bearer-фолбэк.
      const confirmed = await establishSession(res);
      if (confirmed) {
        try {
          window.localStorage.setItem(LOGIN_EMAIL_KEY, email.trim());
        } catch {
          /* приватный режим — не критично */
        }
        setUser(res.user);
        // toast не нужен — UI сам переключится
      } else {
        setError('session');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) setError('invalid');
        else if (err.status === 423) setError('locked');
        else if (err.status === 0 || err.status === 404) setError('unavailable');
        else setError('invalid');
      } else {
        setError('unavailable');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted px-4 py-8 dark:bg-background">
      <Card className="w-full max-w-[360px] shadow-sm">
        <CardContent className="p-6">
          {/* --- Шапка карточки: логотип и слоган --- */}
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <TriggerMark className="size-12 rounded-xl shadow-sm" title="Trigger" />
            <div>
              <h1 className="text-lg font-bold tracking-tight text-foreground">Trigger</h1>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Триггерные SMS-коммуникации</p>
            </div>
          </div>

          <h2 className="mb-4 text-center text-sm font-medium text-zinc-700 dark:text-zinc-300">Вход в панель</h2>

          {/* --- Форма входа --- */}
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="login-email">Email</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="username"
                placeholder="user@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={pending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="login-password">Пароль</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={pending}
              />
            </div>

            {/* --- Инлайн-ошибки: один Alert на вариант LoginError --- */}
            {error === 'invalid' ? (
              <Alert variant="destructive">
                <AlertTitle>Неверный email или пароль</AlertTitle>
              </Alert>
            ) : null}
            {error === 'locked' ? (
              <Alert variant="destructive">
                <AlertTitle>Аккаунт временно заблокирован (защита от подбора)</AlertTitle>
                <AlertDescription>Повторите вход через несколько минут.</AlertDescription>
              </Alert>
            ) : null}
            {error === 'unavailable' ? (
              <Alert className="border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-800">
                <AlertTitle>Сервер недоступен, повторите позже</AlertTitle>
                <AlertDescription>
                  Возможно, сервер перезапускается или ещё не готов.
                </AlertDescription>
              </Alert>
            ) : null}
            {error === 'session' ? (
              <Alert className="border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-800">
                <AlertTitle>Браузер не сохраняет сессию</AlertTitle>
                <AlertDescription>
                  Вход выполнен, но cookie и локальное хранилище заблокированы
                  (встроенный режим просмотра). Откройте панель в отдельной вкладке
                  (кнопка «Открыть в новой вкладке» над панелью предпросмотра) и войдите
                  там.
                </AlertDescription>
              </Alert>
            ) : null}

            <Button
              type="submit"
              className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={pending}
            >
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Войти
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
