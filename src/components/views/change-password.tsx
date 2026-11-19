'use client';

// Принудительная смена пароля + диалог смены из меню профиля. Домен: auth.
// Три экспорта: ChangePasswordForm — переиспользуемая форма; ChangePasswordGate —
// полноэкранный гейт при user.mustChangePassword (показывает page.tsx после
// входа/сброса пароля); ChangePasswordDialog — модалка из меню пользователя.
// API: POST /api/v1/auth/change-password, POST /api/v1/auth/change-password/skip,
// GET /api/v1/auth/me (обновление профиля после действия).
// Роли: любая аутентифицированная.
import * as React from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api-client';
import { useAppStore, type CurrentUser } from '@/lib/store';

/** Подсказка политики паролей — зеркалит серверную (≥10, буквы + цифры,
 *  не email/имя, не популярный, не повтор последних 5). */
const PASSWORD_HINT = 'Минимум 10 символов, буквы и цифры; не email и не популярный пароль';

/** Клиентская проверка политики — не гоняем заведомо слабый пароль на сервер.
 *  Полную проверку (блэклист/повторы) делает сервер — это UX-превью. */
function isValidPassword(pw: string): boolean {
  return pw.length >= 10 && /[A-Za-zА-Яа-яЁё]/.test(pw) && /\d/.test(pw);
}

/** Обновить профиль после skip/смены — гейт должен открыться.
 *  Ошибка /auth/me → сброс сессии (setUser(null)) и возврат на логин. */
async function refreshUser(): Promise<CurrentUser | null> {
  try {
    const me = await api<{ user: CurrentUser }>('/api/v1/auth/me');
    useAppStore.getState().setUser(me.user);
    return me.user;
  } catch {
    useAppStore.getState().setUser(null);
    return null;
  }
}

/** Форма смены пароля (текущий → новый → подтверждение). Клиентские проверки
 *  (политика + совпадение) сразу блокируют сабмит; ошибка сервера — Alert + toast.
 *  onDone вызывается после успешной смены (диалог закрывается). */
export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const [oldPassword, setOldPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Производные состояния для мгновенного фидбека: несовпадение подтверждения,
  // слабый пароль и итоговая готовность к сабмиту.
  const mismatch = confirm.length > 0 && confirm !== newPassword;
  const weak = newPassword.length > 0 && !isValidPassword(newPassword);
  const canSubmit =
    oldPassword.length > 0 && isValidPassword(newPassword) && !mismatch && !pending;

  /** Сабмит: POST /api/v1/auth/change-password (сервер проверяет старый пароль,
   *  инвалидирует прочие сессии) → refreshUser → onDone. */
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setServerError(null);
    try {
      await api<void>('/api/v1/auth/change-password', {
        method: 'POST',
        body: { oldPassword, newPassword },
      });
      toast.success('Пароль изменён');
      // обновляем профиль: gate должен открыться
      await refreshUser();
      onDone?.();
    } catch (err) {
      const detail =
        err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось изменить пароль';
      setServerError(detail);
      toast.error(`Ошибка: ${detail}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="cp-old">Текущий пароль</Label>
        <Input
          id="cp-old"
          type="password"
          autoComplete="current-password"
          value={oldPassword}
          onChange={(e) => setOldPassword(e.target.value)}
          disabled={pending}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="cp-new">Новый пароль</Label>
        <Input
          id="cp-new"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={pending}
          required
          aria-invalid={weak}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{PASSWORD_HINT}</p>
        {weak ? <p className="text-xs text-red-600 dark:text-red-400">Пароль не соответствует политике</p> : null}
      </div>
      <div className="space-y-2">
        <Label htmlFor="cp-confirm">Повторите новый пароль</Label>
        <Input
          id="cp-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={pending}
          required
          aria-invalid={mismatch}
        />
        {mismatch ? <p className="text-xs text-red-600 dark:text-red-400">Пароли не совпадают</p> : null}
      </div>

      {serverError ? (
        <Alert variant="destructive">
          <AlertTitle>Ошибка смены пароля</AlertTitle>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        type="submit"
        className="w-full bg-emerald-600 text-white hover:bg-emerald-700"
        disabled={!canSubmit}
      >
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        Сменить пароль
      </Button>
    </form>
  );
}

/** Полноэкранный гейт: показывается, пока user.mustChangePassword = true.
 * Смену можно отложить («Продолжить без смены») — флаг сбрасывается, пароль
 * остаётся доступным для смены в меню профиля в любой момент. */
export function ChangePasswordGate() {
  const [skipPending, setSkipPending] = React.useState(false);

  /** Отложить смену: POST .../skip сбрасывает mustChangePassword — вход
   *  продолжает работать со старым паролем (смена доступна в меню профиля). */
  async function onSkip() {
    if (skipPending) return;
    setSkipPending(true);
    try {
      await api<void>('/api/v1/auth/change-password/skip', { method: 'POST' });
      toast.info('Смена пароля отложена — доступна в меню профиля');
      await refreshUser();
    } catch (err) {
      const detail =
        err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось отложить смену пароля';
      toast.error(`Ошибка: ${detail}`);
    } finally {
      setSkipPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted px-4 py-8">
      <Card className="w-full max-w-md shadow-sm">
        <CardContent className="p-6">
          {/* --- Шапка гейта --- */}
          <div className="mb-5 flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400">
              <ShieldAlert className="size-5" aria-hidden />
            </div>
            <div>
              <h1 className="text-base font-bold text-foreground">Требуется смена пароля</h1>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Установите новый пароль, чтобы продолжить работу в панели
              </p>
            </div>
          </div>
          {/* --- Форма + отказ от смены (skip) --- */}
          <ChangePasswordForm />
          <div className="mt-4 border-t border-border pt-4">
            <Button
              type="button"
              variant="ghost"
              className="w-full text-zinc-600 hover:text-foreground dark:text-zinc-400"
              onClick={onSkip}
              disabled={skipPending}
            >
              {skipPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Продолжить без смены пароля
            </Button>
            <p className="mt-2 text-center text-xs text-zinc-500 dark:text-zinc-400">
              Аккаунт работает с текущим паролем; сменить его можно позже в меню профиля
              (правый верхний угол)
            </p>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

/** Диалог смены пароля из меню пользователя. */
export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Сменить пароль</DialogTitle>
          <DialogDescription>{PASSWORD_HINT}</DialogDescription>
        </DialogHeader>
        <ChangePasswordForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
