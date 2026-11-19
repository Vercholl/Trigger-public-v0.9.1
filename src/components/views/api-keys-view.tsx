'use client';

// «API-ключи» — управление ключами приёма событий POST /api/v1/events от
// внешней системы (заголовок X-Api-Key). Домен: api-keys. С Task 59 — НЕ
// отдельный экран сайдбара, а блок вкладки «Интеграции» → «Интеграция с
// системой данных» (креденты трубы обмена с внешней системой — рядом с её
// мониторингом; сам компонент рендерится внутри IntegrationsView).
// API: GET/POST /api/v1/api-keys, DELETE /api/v1/api-keys/{id} (soft-revoke:
// запись остаётся для истории). Raw-ключ показывается один раз при создании.
// Роли: только ADMIN (не-админам — заглушка EmptyState, запрос не выполняется).
import * as React from 'react';
import { Ban, Copy, Gauge, KeyRound, Plus, ShieldCheck } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import {
  invalidatePanel,
  copyText,
  EmptyState,
  ErrorState,
  fmtDT,
  relTime,
  useRole,
  type ApiKeyItem,
  type Paged,
} from '@/components/views/shared';

/** Диалог создания ключа: название + опциональный IP-allowlist (через запятую,
 *  поддерживается CIDR) + опциональный лимит запросов/мин (интеграционный ключ
 *  адаптера ядра — повышенный; пусто = общий дефолт). Пустой allowlist в body
 *  не попадает (= без ограничения). onSuccess передаёт raw-ключ наверх — только
 *  один показ (CreatedKeyDialog). */
function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: string) => void;
}) {
  const [name, setName] = React.useState('');
  const [ipAllowlist, setIpAllowlist] = React.useState('');
  const [rateLimit, setRateLimit] = React.useState('');
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Сброс полей при каждом открытии — не тянем значения прошлого ключа.
  React.useEffect(() => {
    if (open) {
      setName('');
      setIpAllowlist('');
      setRateLimit('');
      setServerError(null);
    }
  }, [open]);

  // POST: raw-ключ возвращается ровно один раз (в БД — только sha256 и prefix).
  const createMutation = useMutation({
    mutationFn: async () => {
      const trimmed = ipAllowlist.trim();
      const parsedLimit = Number.parseInt(rateLimit.trim(), 10);
      return api<ApiKeyItem & { key: string }>('/api/v1/api-keys', {
        method: 'POST',
        body: {
          name: name.trim(),
          ...(trimmed.length > 0 ? { ipAllowlist: trimmed } : {}),
          ...(rateLimit.trim() !== '' && Number.isInteger(parsedLimit) && parsedLimit >= 1
            ? { rateLimitPerMin: parsedLimit }
            : {}),
        },
      });
    },
    onSuccess: (res) => {
      onCreated(res.key);
      onOpenChange(false);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось создать ключ';
      setServerError(detail);
      toast.error(`Ошибка: ${detail}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Новый API-ключ</DialogTitle>
          <DialogDescription>
            Ключ используется в заголовке X-Api-Key при отправке событий
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="key-name">Название</Label>
            <Input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Система данных — прод"
              maxLength={100}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="key-ips">IP-ограничение</Label>
            <Textarea
              id="key-ips"
              className="font-mono text-sm"
              rows={3}
              value={ipAllowlist}
              onChange={(e) => setIpAllowlist(e.target.value)}
              placeholder="10.0.0.5, 10.0.1.0/24 — пусто = без ограничений"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="key-limit">Лимит запросов/мин</Label>
            <Input
              id="key-limit"
              inputMode="numeric"
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value)}
              placeholder="пусто = общий дефолт (120); для адаптера ядра — 600+"
              className="max-w-56"
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Повышенный потолок для интеграционного ключа: волны статусов ядра.
              Меняется позже без перевыпуска ключа.
            </p>
          </div>

          {serverError ? (
            <Alert variant="destructive">
              <AlertTitle>Ошибка создания</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={createMutation.isPending}>
            Отмена
          </Button>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={name.trim().length === 0 || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            Создать ключ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Диалог правки лимита ключа (PUT /api/v1/api-keys/{id}): повышенный потолок
 *  для интеграционного ключа меняется без перевыпуска. Пустое значение = общий
 *  дефолт (rateLimitPerMin: null). */
function EditLimitDialog({
  target,
  onClose,
}: {
  target: ApiKeyItem | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = React.useState('');

  React.useEffect(() => {
    // Открытие окна: подставляем текущий потолок ключа; пусто — если ключ
    // живёт на общем env-дефолте (rateLimitPerMin = null).
    setValue(target?.rateLimitPerMin !== null && target?.rateLimitPerMin !== undefined ? String(target.rateLimitPerMin) : '');
  }, [target]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const trimmed = value.trim();
      const parsed = Number.parseInt(trimmed, 10);
      return api<{ id: string; rateLimitPerMin: number | null }>(`/api/v1/api-keys/${target?.id}`, {
        method: 'PUT',
        // Пусто → null: возврат к общему дефолту приёма событий; сверх потолка
        // /api/v1/events отвечает 429 — лимит защищает воркер от «волн» ядра.
        body: trimmed === '' ? { rateLimitPerMin: null } : { rateLimitPerMin: parsed },
      });
    },
    onSuccess: () => {
      toast.success('Лимит ключа обновлён');
      invalidatePanel(queryClient);
      onClose();
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось обновить лимит';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  const parsed = Number.parseInt(value.trim(), 10);
  // Границы 1..100 000 — зеркало серверной схемы. «0 = без лимита» в системе
  // НЕТ: ноль запрещён, «без своего лимита» выражается пусто → null — ключ
  // возвращается на общий env-дефолт (для /events — 120/мин).
  const invalid = value.trim() !== '' && (!Number.isInteger(parsed) || parsed < 1 || parsed > 100000);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Лимит запросов/мин</DialogTitle>
          <DialogDescription>
            Ключ «{target?.name}» ({target?.prefix}…). Пусто — общий дефолт приёма событий.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="edit-limit">Запросов в минуту</Label>
          <Input
            id="edit-limit"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="напр. 600"
            aria-invalid={invalid}
          />
          {invalid ? (
            <p className="text-xs text-red-600 dark:text-red-400">Целое число от 1 до 100000</p>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Интеграционному ключу адаптера ядра — 600+ (волны статусов); обычным ключам хватит дефолта.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saveMutation.isPending}>
            Отмена
          </Button>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={invalid || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Единственный показ raw-ключа (в БД — только хэш и prefix): после закрытия
 *  восстановление невозможно, кнопка «Скопировать» — здесь. */
function CreatedKeyDialog({
  apiKey,
  onClose,
}: {
  apiKey: string | null;
  onClose: () => void;
}) {
  /** Копирование в clipboard; при запрете доступа — подсказка скопировать руками. */
  async function copyKey() {
    if (!apiKey) return;
    // copyText — общий хелпер с execCommand-фолбэком для http-контура
    const ok = await copyText(apiKey);
    if (ok) toast.success('Скопировано');
    else toast.error('Не удалось скопировать — скопируйте вручную');
  }

  return (
    <Dialog open={apiKey !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-600 text-white">
              <KeyRound className="size-5" aria-hidden />
            </span>
            Ключ создан
          </DialogTitle>
          <DialogDescription>
            Используйте его в заголовке <span className="font-mono">X-Api-Key</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-sm text-zinc-800 dark:text-zinc-200">
              {apiKey}
            </code>
            <Button variant="outline" size="icon" onClick={() => void copyKey()} aria-label="Скопировать ключ">
              <Copy className="size-4" aria-hidden />
            </Button>
          </div>

          <Alert variant="destructive">
            <AlertTitle>Сохраните ключ</AlertTitle>
            <AlertDescription>
              Ключ показывается только один раз — после закрытия диалога восстановить его невозможно.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={onClose}>
            Понятно
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Блок «API-ключи» (раздел «Интеграция с системой данных»): карточка с
 *  заголовком/кнопкой создания + таблица → отзыв через AlertDialog. Создание —
 *  цепочка CreateKeyDialog → CreatedKeyDialog (raw-ключ показывается один раз). */
export function ApiKeysView() {
  const queryClient = useQueryClient();
  const { isAdmin } = useRole();

  // Список берём одним запросом (pageSize=100 — раздел не рассчитан на больше);
  // не-ADMIN запрос не отправляет (enabled) и видит заглушку ниже.
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api<Paged<ApiKeyItem>>('/api/v1/api-keys?pageSize=100'),
    enabled: isAdmin,
  });

  const [createOpen, setCreateOpen] = React.useState(false);
  const [createdKey, setCreatedKey] = React.useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<ApiKeyItem | null>(null);
  const [limitTarget, setLimitTarget] = React.useState<ApiKeyItem | null>(null);

  // Отзыв (DELETE) — soft-revoke: сервер ставит isActive=false + revokedAt,
  // запись остаётся в таблице для истории.
  const revokeMutation = useMutation({
    mutationFn: async (id: string) => api<void>(`/api/v1/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Ключ отозван');
      setRevokeTarget(null);
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось отозвать ключ';
      toast.error(`Ошибка: ${detail}`);
      setRevokeTarget(null);
    },
  });

  if (!isAdmin) {
    return <EmptyState icon={ShieldCheck} title="Раздел доступен только администраторам" />;
  }

  const items = data?.items ?? [];

  return (
    <Card className="shadow-sm">
      {/* --- Заголовок блока (куда идёт ключ) + кнопка создания --- */}
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-400"
              aria-hidden
            >
              <KeyRound className="size-5" />
            </div>
            <div>
              <CardTitle className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                API-ключи
              </CardTitle>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                Ключи для приёма событий POST /api/v1/events (заголовок X-Api-Key) — ими
                стучится адаптер системы данных; также работает статический ключ из .env
                (EVENTS_API_KEY)
              </p>
            </div>
          </div>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-4" aria-hidden />
            Создать ключ
          </Button>
        </div>
      </CardHeader>

      {/* --- Таблица ключей --- */}
      <CardContent className="p-0">
        {isPending ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : error ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={() => void refetch()} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={KeyRound} title="Ключей пока нет — создайте первый" />
        ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>Название</TableHead>
                    <TableHead>Префикс</TableHead>
                    <TableHead className="hidden lg:table-cell">IP-ограничение</TableHead>
                    <TableHead className="hidden md:table-cell">Лимит/мин</TableHead>
                    <TableHead className="hidden lg:table-cell">Последнее использование</TableHead>
                    <TableHead>Статус</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((k) => (
                    <TableRow key={k.id} className="hover:bg-muted">
                      <TableCell className="py-3 text-sm font-medium text-foreground">{k.name}</TableCell>
                      <TableCell className="py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">{k.prefix}…</TableCell>
                      <TableCell className="hidden max-w-[200px] py-3 lg:table-cell">
                        {k.ipAllowlist ? (
                          <p className="truncate font-mono text-xs text-zinc-600 dark:text-zinc-400" title={k.ipAllowlist}>
                            {k.ipAllowlist}
                          </p>
                        ) : (
                          <span className="text-xs text-zinc-400">любой</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden py-3 text-xs tabular-nums text-zinc-600 dark:text-zinc-400 md:table-cell">
                        {k.rateLimitPerMin !== null && k.rateLimitPerMin !== undefined ? (
                          k.rateLimitPerMin.toLocaleString('ru-RU')
                        ) : (
                          <span className="text-zinc-400" title="Общий дефолт приёма событий (env)">
                            по умолч.
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden py-3 text-xs text-zinc-500 dark:text-zinc-400 lg:table-cell">
                        {k.lastUsedAt ? (
                          <span title={fmtDT(k.lastUsedAt)}>{relTime(k.lastUsedAt)}</span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="py-3">
                        {k.isActive ? (
                          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                            <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
                            Активен
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                            Отозван
                            {k.revokedAt ? ` · ${fmtDT(k.revokedAt)}` : ''}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex justify-end gap-1">
                          {/* Правка лимита — только активным ключам: отозванным
                              потолок уже не важен, окно им не показываем */}
                          {k.isActive ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                              onClick={() => setLimitTarget(k)}
                              title="Лимит запросов/мин"
                            >
                              <Gauge className="size-4" aria-hidden />
                            </Button>
                          ) : null}
                          {k.isActive ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600 dark:text-red-400 hover:text-red-700 dark:text-red-400"
                              onClick={() => setRevokeTarget(k)}
                            >
                              <Ban className="size-4" aria-hidden />
                              Отозвать
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
      </CardContent>

      {/* --- Диалоги: создание / показ raw-ключа / лимит / подтверждение отзыва --- */}
      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(key) => {
          setCreatedKey(key);
          invalidatePanel(queryClient);
        }}
      />
      <CreatedKeyDialog apiKey={createdKey} onClose={() => setCreatedKey(null)} />
      <EditLimitDialog target={limitTarget} onClose={() => setLimitTarget(null)} />

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отозвать ключ «{revokeTarget?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>Ключ перестанет работать немедленно.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              // анти-двойной клик: блокируем кнопку, пока идёт запрос
              disabled={revokeMutation.isPending}
              onClick={() => {
                if (revokeTarget) revokeMutation.mutate(revokeTarget.id);
              }}
            >
              Отозвать
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
