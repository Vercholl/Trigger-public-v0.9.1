'use client';

// «Пользователи» — управление учётками панели: создание, роли, вкл/выкл,
// сброс пароля, удаление. Домен: users.
// API: GET/POST /api/v1/users, PUT /api/v1/users/{id} (вкл/выкл, роль),
// DELETE /api/v1/users/{id}, POST /api/v1/users/{id}/password (сброс: новый
// хеш + mustChangePassword=false + сброс брутфорс-лока + инвалидация сессий).
// Роли: только ADMIN (не-админам — заглушка EmptyState). Серверные гварды:
// последний активный ADMIN и самоудаление → 409.
import * as React from 'react';
import { Copy, KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, ApiError } from '@/lib/api-client';
import { useAppStore, type Role } from '@/lib/store';
import {
  invalidatePanel,
  copyText,
  EmptyState,
  ErrorState,
  fmtDT,
  ROLE_META,
  RoleBadge,
  useRole,
  type Paged,
  type UserItem,
} from '@/components/views/shared';

/** Расшифровки ролей для Select создания/редактирования (ADMIN/MANAGER/VIEWER). */
const ROLE_DESCRIPTIONS: Record<Role, string> = {
  ADMIN: 'Администратор — полный доступ',
  MANAGER: 'Менеджер — работа с воронками и клиентами',
  VIEWER: 'Наблюдатель — только просмотр',
};

/** Длина генерируемого пароля: 14 символов (политика сервера: ≥10, буквы+цифры). */
const PW_LENGTH = 14;

/** Равномерно случайное целое 0..maxExclusive-1 из crypto-байтов (rejection sampling). */
function randomInt(maxExclusive: number): number {
  // Байта (256) достаточно: отбрасываем «хвост», некратный диапазону
  const limit = 256 - (256 % maxExclusive);
  const buf = new Uint8Array(1);
  for (let i = 0; i < 8; i++) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % maxExclusive;
  }
  return buf[0] % maxExclusive; // практически недостижимо
}

/**
 * Пароль для сброса: 14 символов, ГАРАНТИРОВАННО содержит букву и цифру
 * (политика сервера: ≥10 символов, буквы + цифры) — 1 буква + 1 цифра + 12
 * смешанных, затем перемешивание (Fisher–Yates на crypto).
 */
function generatePassword(): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const mixed = letters + digits;
  const chars = [letters[randomInt(letters.length)], digits[randomInt(digits.length)]];
  while (chars.length < PW_LENGTH) chars.push(mixed[randomInt(mixed.length)]);
  // Перемешивание, а не срез/сдвиг: гарантийная пара «буква+цифра» стоит в
  // предсказуемых позициях [0]/[1] — без Fisher–Yates первые символы любого
  // сброшенного пароля выдавали бы шаблон генерации.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/* ============================ Диалог создания/редактирования ============================ */

/** Диалог создания/редактирования: user=null → создание (POST, пароль вводится
 *  вручную), иначе редактирование (PUT, email заблокирован — менять нельзя). */
function UserDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserItem | null;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = React.useState('');
  const [name, setName] = React.useState('');
  const [role, setRole] = React.useState<Role>('VIEWER');
  const [password, setPassword] = React.useState('');
  const [mustChangePassword, setMustChangePassword] = React.useState(true);
  const [isActive, setIsActive] = React.useState(true);
  const [serverError, setServerError] = React.useState<string | null>(null);

  // При открытии: редактирование — заполняется из user, создание — дефолты.
  React.useEffect(() => {
    if (!open) return;
    setServerError(null);
    if (user) {
      setEmail(user.email);
      setName(user.name ?? '');
      setRole(user.role);
      setPassword('');
      setMustChangePassword(user.mustChangePassword);
      setIsActive(user.isActive);
    } else {
      setEmail('');
      setName('');
      setRole('VIEWER');
      setPassword('');
      setMustChangePassword(true);
      setIsActive(true);
    }
  }, [open, user]);

  // Редактирование — PUT с изменяемыми полями; создание — POST с паролем.
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (user) {
        return api<UserItem>(`/api/v1/users/${user.id}`, {
          method: 'PUT',
          body: {
            name: name.trim() || null,
            role,
            isActive,
            mustChangePassword,
          },
        });
      }
      return api<UserItem>('/api/v1/users', {
        method: 'POST',
        body: {
          email: email.trim(),
          name: name.trim() || null,
          role,
          password,
          mustChangePassword,
        },
      });
    },
    onSuccess: () => {
      toast.success(user ? 'Пользователь обновлён' : 'Пользователь создан');
      invalidatePanel(queryClient);
      onOpenChange(false);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось сохранить';
      setServerError(detail);
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Создание требует email + пароль ≥8; редактированию достаточно не-pending.
  const canSubmit = user
    ? !saveMutation.isPending
    : email.trim().length > 0 && password.length >= 8 && !saveMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{user ? `Пользователь ${user.email}` : 'Новый пользователь'}</DialogTitle>
          <DialogDescription>
            Роли определяют доступ к разделам и операциям панели
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="u-email">Email</Label>
            <Input
              id="u-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              disabled={user !== null}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="u-name">Имя</Label>
            <Input
              id="u-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Иван Иванов"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Роль</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger className="w-full" aria-label="Роль пользователя">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ROLE_DESCRIPTIONS) as Role[]).map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_DESCRIPTIONS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!user ? (
            <div className="space-y-1.5">
              <Label htmlFor="u-password">Пароль</Label>
              <Input
                id="u-password"
                type="text"
                className="font-mono"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="не менее 10 символов"
              />
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Минимум 10 символов, буквы и цифры; нельзя повторить недавний пароль</p>
            </div>
          ) : null}

          {/* mustChangePassword — по умолчанию ВКЛ: стартовый пароль задал
              админ и «знает» его, первый вход принудительно ведёт через смену */}
          <div className="flex items-start gap-3 rounded-md border border-border p-3">
            <Switch
              id="u-must-change"
              checked={mustChangePassword}
              onCheckedChange={setMustChangePassword}
            />
            <Label htmlFor="u-must-change" className="text-sm font-normal leading-snug">
              Потребовать смену пароля при входе
            </Label>
          </div>

          {/* Активность — переключатель только редактирования: новые учётки
              создаются сразу активными; выключение на сервере убивает сессии */}
          {user ? (
            <div className="flex items-start gap-3 rounded-md border border-border p-3">
              <Switch id="u-active" checked={isActive} onCheckedChange={setIsActive} />
              <Label htmlFor="u-active" className="text-sm font-normal leading-snug">
                Аккаунт активен
              </Label>
            </div>
          ) : null}

          {serverError ? (
            <Alert variant="destructive">
              <AlertTitle>Ошибка сохранения</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saveMutation.isPending}>
            Отмена
          </Button>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={!canSubmit}
            onClick={() => saveMutation.mutate()}
          >
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================ Диалог сброса пароля ============================ */

/** Диалог сброса пароля: пароль генерируется на клиенте (crypto, см.
 *  generatePassword) и показывается один раз; кнопка отправляет
 *  POST /users/{id}/password (сброс брутфорс-лока + инвалидация сессий). */
function ResetPasswordDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserItem | null;
}) {
  const queryClient = useQueryClient();
  const [password, setPassword] = React.useState('');
  const [done, setDone] = React.useState(false);

  React.useEffect(() => {
    // При каждом открытии — НОВЫЙ пароль: показанный ранее уже светился на
    // экране/в буфере обмена и считается скомпрометированным.
    if (open) {
      setPassword(generatePassword());
      setDone(false);
    }
  }, [open]);

  // done: пароль установлен — кнопка деактивируется, показывается успех.
  const resetMutation = useMutation({
    mutationFn: async () =>
      api<void>(`/api/v1/users/${user?.id}/password`, {
        method: 'POST',
        body: { newPassword: password },
      }),
    onSuccess: () => {
      // диалог намеренно НЕ закрываем: после установки пароль ещё нужен на
      // экране, чтобы успеть скопировать/передать (кнопка уже заблокирована)
      setDone(true);
      toast.success('Новый пароль установлен');
      // Таблица показывает mustChangePassword/failedLoginCount/lockedUntil —
      // серверный сброс пароля обнуляет все три; без инвалидации строка
      // продолжала показывать устаревшие флаги (refetchOnWindowFocus выключен).
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось сменить пароль';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  /** Копирование пароля в clipboard (сбой — подсказка скопировать вручную). */
  async function copyPassword() {
    // copyText — общий хелпер с execCommand-фолбэком для http-контура
    const ok = await copyText(password);
    if (ok) toast.success('Скопировано');
    else toast.error('Не удалось скопировать — скопируйте вручную');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Сброс пароля — {user?.email}</DialogTitle>
          <DialogDescription>Новый пароль генерируется автоматически</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-sm text-zinc-800 dark:text-zinc-200">
              {password}
            </code>
            <Button variant="outline" size="icon" onClick={() => void copyPassword()} aria-label="Скопировать пароль">
              <Copy className="size-4" aria-hidden />
            </Button>
          </div>

          <Alert variant="destructive">
            <AlertTitle>Показан один раз</AlertTitle>
            <AlertDescription>
              Сохраните пароль — после закрытия диалога он больше не отображается.
            </AlertDescription>
          </Alert>

          {done ? (
            <Alert className="border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300">
              <AlertTitle>Пароль установлен</AlertTitle>
              <AlertDescription>Передайте его пользователю по защищённому каналу.</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={resetMutation.isPending || done}
            onClick={() => resetMutation.mutate()}
          >
            Установить этот пароль
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================ Список ============================ */

/** Экран списка пользователей: таблица (переключатель активности инлайн,
 *  сброс/редактирование/удаление в строке) + диалоги подтверждения. */
export function UsersView() {
  const queryClient = useQueryClient();
  const { isAdmin } = useRole();
  const currentUser = useAppStore((s) => s.user);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<Paged<UserItem>>('/api/v1/users?pageSize=100'),
    enabled: isAdmin,
  });

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<UserItem | null>(null);
  const [resetTarget, setResetTarget] = React.useState<UserItem | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<UserItem | null>(null);

  // Инлайн-переключатель «Аккаунт активен»: PUT только с isActive.
  // Деактивация на сервере убивает сессии пользователя.
  const toggleMutation = useMutation({
    mutationFn: async (u: { id: string; isActive: boolean }) =>
      api<UserItem>(`/api/v1/users/${u.id}`, {
        method: 'PUT',
        body: { isActive: u.isActive },
      }),
    onSuccess: (_d, vars) => {
      toast.success(vars.isActive ? 'Пользователь включён' : 'Пользователь отключён');
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось изменить';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Удаление — физическое (сессии сносятся каскадом); себя удалить нельзя
  // (кнопка disabled + серверный 409).
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api<void>(`/api/v1/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Пользователь удалён');
      setDeleteTarget(null);
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось удалить';
      toast.error(`Ошибка: ${detail}`);
      setDeleteTarget(null);
    },
  });

  if (!isAdmin) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Раздел доступен только администраторам"
      />
    );
  }

  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      {/* --- Подсказка о брутфорс-защите + кнопка создания --- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Брутфорс-защита: 5 неудачных входов → блокировка на 15 минут
        </p>
        <Button
          className="bg-emerald-600 text-white hover:bg-emerald-700"
          onClick={() => {
            setEditTarget(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="size-4" aria-hidden />
          Добавить пользователя
        </Button>
      </div>

      {/* --- Таблица пользователей --- */}
      <Card className="shadow-sm">
        <CardContent className="p-0">
          {isPending ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : error ? (
            <div className="p-4">
              <ErrorState error={error} onRetry={() => void refetch()} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="Пользователей пока нет" />
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Роль</TableHead>
                    <TableHead>Активен</TableHead>
                    <TableHead>Смена пароля</TableHead>
                    <TableHead className="hidden lg:table-cell">Неудачных входов</TableHead>
                    <TableHead className="hidden lg:table-cell">Заблокирован до</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((u) => {
                    // Брутфорс-лок активен, только если lockedUntil в будущем.
                    const locked =
                      u.lockedUntil !== null && new Date(u.lockedUntil).getTime() > Date.now();
                    return (
                      <TableRow key={u.id} className="hover:bg-muted">
                        <TableCell className="py-3">
                          <p className="text-sm font-medium text-foreground">{u.email}</p>
                          {u.name ? <p className="text-xs text-zinc-500 dark:text-zinc-400">{u.name}</p> : null}
                          {u.id === currentUser?.id ? (
                            <Badge variant="outline" className="mt-1 border-border bg-muted text-zinc-500 dark:text-zinc-400">
                              это вы
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="py-3">
                          <RoleBadge role={u.role} />
                        </TableCell>
                        <TableCell className="py-3">
                          <Switch
                            checked={u.isActive}
                            disabled={toggleMutation.isPending || u.id === currentUser?.id}
                            onCheckedChange={(checked) =>
                              toggleMutation.mutate({ id: u.id, isActive: checked })
                            }
                            aria-label={`Активность пользователя ${u.email}`}
                          />
                        </TableCell>
                        <TableCell className="py-3">
                          {u.mustChangePassword ? (
                            <Badge variant="outline" className="border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400">
                              требуется
                            </Badge>
                          ) : (
                            <span className="text-sm text-zinc-400">—</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden py-3 text-sm text-zinc-600 dark:text-zinc-400 lg:table-cell">
                          {u.failedLoginCount}
                        </TableCell>
                        <TableCell className="hidden py-3 text-xs lg:table-cell">
                          {locked ? (
                            <span className="text-red-600 dark:text-red-400" title={u.lockedUntil ?? undefined}>
                              до {fmtDT(u.lockedUntil)}
                            </span>
                          ) : (
                            <span className="text-zinc-400">—</span>
                          )}
                        </TableCell>
                        <TableCell className="py-3">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setEditTarget(u);
                                setDialogOpen(true);
                              }}
                              aria-label={`Редактировать пользователя ${u.email}`}
                            >
                              <Pencil className="size-4" aria-hidden />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setResetTarget(u)}
                              aria-label={`Сбросить пароль ${u.email}`}
                            >
                              <KeyRound className="size-4" aria-hidden />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-red-500 dark:text-red-400 hover:text-red-600 dark:text-red-400"
                              onClick={() => setDeleteTarget(u)}
                              disabled={u.id === currentUser?.id}
                              aria-label={`Удалить пользователя ${u.email}`}
                            >
                              <Trash2 className="size-4" aria-hidden />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* --- Диалоги: создание/редактирование, сброс пароля, подтверждение удаления --- */}
      <UserDialog open={dialogOpen} onOpenChange={setDialogOpen} user={editTarget} />
      <ResetPasswordDialog open={resetTarget !== null} onOpenChange={(open) => (open ? null : setResetTarget(null))} user={resetTarget} />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить пользователя {deleteTarget?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              Пользователь потеряет доступ к панели. Свою учётную запись удалить нельзя.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              // анти-двойной клик: блокируем кнопку, пока идёт запрос
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
