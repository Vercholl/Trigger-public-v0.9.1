'use client';

// «Стоп-лист отписавшихся» — номера, исключённые из РЕКЛАМНЫХ рассылок
// (сервисные SMS доставляются как обычно). Домен: unsubscribe.
// API: GET /api/v1/unsubscribed (пагинация + поиск по номеру),
// POST /api/v1/unsubscribed (ручное внесение, MANAGER+, source=MANUAL),
// DELETE /api/v1/unsubscribed/{id} (снятие; сервер также чистит
// client.unsubscribedAt). Роли: чтение — любая; кнопки «Внести»/«Убрать»
// скрыты от VIEWER обёрткой ViewerGuard.
import * as React from 'react';
import { Ban, Plus, RotateCcw, Search } from 'lucide-react';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, ApiError } from '@/lib/api-client';
import { useDebounced } from '@/lib/hooks/use-debounced';
import {
  invalidatePanel,
  EmptyState,
  ErrorState,
  fmtDT,
  TablePagination,
  ViewerGuard,
  type Paged,
  type UnsubscribedItem,
} from '@/components/views/shared';

/**
 * Человекочитаемые подписи источников попадания в стоп-лист: LINK — клиент
 * тапнул «Отписаться» в SMS; MANUAL — внёс оператор (AddManualDialog);
 * IMPORT — миграция базы; HOOK — внешнее событие доставки unsub_sms
 * (вебхук/захват, см. message-events.ts).
 */
const SOURCE_META: Record<UnsubscribedItem['source'], string> = {
  LINK: 'По ссылке',
  MANUAL: 'Внесён оператором',
  IMPORT: 'Импорт',
  HOOK: 'Из события доставки',
};

/** E.164 для клиентской валидации перед POST (сервер проверяет так же, 422). */
const PHONE_RE = /^\+[1-9]\d{7,14}$/;

/** Экран стоп-листа: поиск → таблица → подтверждение снятия (AlertDialog). */
export function UnsubscribedView() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [searchInput, setSearchInput] = React.useState('');
  // Дебаунс 400 мс — не дёргаем API на каждый символ; ввод также сбрасывает
  // страницу на 1 (в отфильтрованной выдаче страниц может стать меньше).
  const search = useDebounced(searchInput, 400);
  const pageSize = 20;

  // Список с серверной пагинацией; поиск уходит query-параметром search.
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['unsubscribed', page, search],
    queryFn: () =>
      api<Paged<UnsubscribedItem>>(
        `/api/v1/unsubscribed?page=${page}&pageSize=${pageSize}${
          search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''
        }`,
      ),
  });

  const [restoreTarget, setRestoreTarget] = React.useState<UnsubscribedItem | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);

  // Снятие с листа (DELETE): помимо записи стоп-листа сервер сбрасывает
  // client.unsubscribedAt — клиент снова получает рекламные SMS.
  const restoreMutation = useMutation({
    mutationFn: async (id: string) => api<void>(`/api/v1/unsubscribed/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Клиент убран из списка отписавшихся');
      setRestoreTarget(null);
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось изменить запись';
      toast.error(`Ошибка: ${detail}`);
      setRestoreTarget(null);
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      {/* --- Пояснение домена + кнопка «Внести номер» (не для VIEWER) --- */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
          Номера из этого списка не получают <span className="font-medium text-zinc-700 dark:text-zinc-300">рекламные</span>{' '}
          SMS. Сервисные сообщения (напоминания об оплате, статусы, коды) доставляются как обычно —
          активные воронки продолжают работу, рекламные шаги просто пропускаются.
        </p>
        <ViewerGuard>
          <Button className="shrink-0" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Внести номер
          </Button>
        </ViewerGuard>
      </div>

      {/* --- Секция: поиск + таблица стоп-листа --- */}
      <Card className="shadow-sm">
        <CardContent className="p-0">
          <div className="flex flex-col gap-2 border-b border-border p-4 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
              <Input
                value={searchInput}
                onChange={(e) => {
                  setPage(1);
                  setSearchInput(e.target.value);
                }}
                placeholder="Поиск по номеру телефона…"
                className="pl-9"
                aria-label="Поиск по номеру телефона"
              />
            </div>
          </div>
          {isPending ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : error ? (
            <div className="p-4">
              <ErrorState error={error} onRetry={() => void refetch()} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Ban}
              title={search.trim() ? 'Ничего не найдено' : 'Список отписавшихся пуст'}
            />
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>Телефон</TableHead>
                    <TableHead>Источник</TableHead>
                    <TableHead>Клиент</TableHead>
                    <TableHead>Дата</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((u) => (
                    <TableRow key={u.id} className="hover:bg-muted">
                      <TableCell className="py-3 font-mono text-sm text-zinc-700 dark:text-zinc-300">{u.phone}</TableCell>
                      <TableCell className="py-3">
                        <Badge
                          variant="outline"
                          className={
                            u.source === 'MANUAL'
                              ? 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400'
                              : 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
                          }
                        >
                          {SOURCE_META[u.source] ?? u.source}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                        {u.clientId ? (
                          <span title={u.clientId}>{u.clientId.slice(0, 8)}…</span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="py-3 text-xs text-zinc-500 dark:text-zinc-400">{fmtDT(u.createdAt)}</TableCell>
                      <TableCell className="py-3">
                        <div className="flex justify-end">
                          <ViewerGuard>
                            <Button variant="outline" size="sm" onClick={() => setRestoreTarget(u)}>
                              <RotateCcw className="size-4" aria-hidden />
                              Убрать из списка
                            </Button>
                          </ViewerGuard>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {data ? (
            <div className="px-4 pb-4">
              <TablePagination page={page} pageSize={pageSize} total={data.total} onPage={setPage} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* --- Диалоги: внесение номера + подтверждение снятия --- */}
      <AddManualDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => {
          invalidatePanel(queryClient);
                  }}
      />

      <AlertDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Убрать из списка отписавшихся?</AlertDialogTitle>
            <AlertDialogDescription>
              Вернуть клиенту возможность получения рекламных SMS? Номер {restoreTarget?.phone} снова
              сможет получать рекламные сообщения; сервисные приходят в любом случае.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              // анти-двойной клик: блокируем кнопку, пока идёт запрос
              disabled={restoreMutation.isPending}
              onClick={() => {
                if (restoreTarget) restoreMutation.mutate(restoreTarget.id);
              }}
            >
              Убрать из списка
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Диалог операторского внесения номера в отписку (П3, MANAGER+).
 *  POST идемпотентен: повторный номер → 200 (существующая запись), новый → 201;
 *  номер из базы клиентов дополнительно помечается unsubscribedAt. */
function AddManualDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [phone, setPhone] = React.useState('');
  const [touched, setTouched] = React.useState(false);

  // touched: показываем ошибку формата только после касания поля/сабмита.
  // Нормализация — только trim: E.164 оператор вводит целиком (без
  // авто-дорисовки +7), чтобы опечатка в коде страны не прошла молча.
  const trimmed = phone.trim();
  const valid = PHONE_RE.test(trimmed);

  // В body — только телефон: source=MANUAL дописывает СЕРВЕР (клиент не может
  // выбрать/подделать источник), он же ставит client.unsubscribedAt.
  const addMutation = useMutation({
    mutationFn: async () => {
      const item = await api<UnsubscribedItem>('/api/v1/unsubscribed', {
        method: 'POST',
        body: { phone: trimmed },
      });
      return item;
    },
    onSuccess: (item) => {
      toast.success(`Номер ${item.phone} внесён в список отписавшихся`);
      setPhone('');
      setTouched(false);
      onOpenChange(false);
      onAdded();
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось внести номер';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Внести номер в отписку</DialogTitle>
          <DialogDescription>
            Номер перестанет получать рекламные SMS. Сервисные сообщения (напоминания об оплате,
            статусы, коды) будут доставляться как обычно.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (valid) addMutation.mutate();
          }}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="unsub-phone">Телефон (E.164)</Label>
            <Input
              id="unsub-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="+79001234567"
              className="font-mono"
              inputMode="tel"
              autoFocus
              aria-invalid={touched && !valid}
              aria-describedby={touched && !valid ? 'unsub-phone-error' : undefined}
              disabled={addMutation.isPending}
            />
            {touched && !valid ? (
              <p id="unsub-phone-error" className="text-xs text-red-600 dark:text-red-400">
                Введите номер в международном формате, например +79001234567
              </p>
            ) : (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Если номер есть в базе клиентов, клиент будет помечен как отписавшийся
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={addMutation.isPending}>
              Отмена
            </Button>
            <Button type="submit" disabled={!valid || addMutation.isPending}>
              {addMutation.isPending ? 'Вносим…' : 'Внести'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
