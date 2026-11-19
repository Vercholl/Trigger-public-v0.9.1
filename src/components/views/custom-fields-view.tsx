'use client';

// «Кастомные поля» — реестр дополнительных полей профиля клиента: поля, которые
// компания заводит сама, без доработки системы данных. Домен: custom-fields.
// API: GET /api/v1/custom-fields?includeInactive=1 (весь реестр), POST (создание),
// PATCH /api/v1/custom-fields/{id} (метка/описание/активность), DELETE (удаление
// поля + всех значений; 409, если переменная {{cf_<key>}} используется шаблонами/
// воронками/сегментами). Деактивация — обратимый путь (поле исчезает из
// конструкторов/подсказок и перестаёт приниматься из client_card, значения
// сохраняются); удаление — безвозвратное.
// Роли: раздел и мутации — только ADMIN (не-админам — заглушка, запрос не идёт;
// сервер проверяет RBAC повторно). Чтение реестра (активные поля) доступно
// всем ролям через GET без параметра — его используют конструктор сегментов
// и подсказки шаблонов.
import * as React from 'react';
import { Loader2, PencilLine, Plus, PowerOff, Power, Shapes, Trash2 } from 'lucide-react';
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
import { CF_KEY_PREFIX } from '@/lib/registry/cf-ns';
import {
  ErrorState,
  fmtDT,
  useRole,
  type CustomFieldItem,
} from '@/components/views/shared';
import { CF_TYPE_META } from '@/components/views/shared';

/** Формат ключа — зеркало серверного CF_KEY_RE (registry/cf-ns): латиница/цифры/_,
 *  2–40 символов, с буквы; не начинается с cf_ (префикс добавится автоматически). */
const KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** Диалог создания поля: ключ (с живым превью имени переменной), метка, тип,
 *  описание. Ключ и тип после создания НЕ меняются (тип задаёт колонку хранения). */
function CreateFieldDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [key, setKey] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [type, setType] = React.useState<CustomFieldItem['type']>('text');
  const [description, setDescription] = React.useState('');
  const [serverError, setServerError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setKey('');
      setLabel('');
      setType('text');
      setDescription('');
      setServerError(null);
    }
  }, [open]);

  // Ключ невалиден, если не прошёл KEY_RE ИЛИ оператор сам вписал префикс cf_
  // (сервер допишет префикс сам — ручной превратился бы в «cf_cf_…»). Ввод
  // молча приводится к нижнему регистру в onChange: KEY_RE допускает только строчные.
  const keyInvalid = key.trim().length > 0 && (!KEY_RE.test(key.trim()) || key.trim().startsWith(CF_KEY_PREFIX));
  // Сабмит: валидный ключ + непустая метка; длины полей (метка ≤100, описание
  // ≤500) режутся maxLength — зеркалим серверные лимиты, до 422 не доходим.
  const canSubmit = key.trim().length >= 2 && !keyInvalid && label.trim().length > 0;

  const createMutation = useMutation({
    mutationFn: async () =>
      api<CustomFieldItem>('/api/v1/custom-fields', {
        method: 'POST',
        body: {
          key: key.trim(),
          label: label.trim(),
          type,
          ...(description.trim().length > 0 ? { description: description.trim() } : {}),
        },
      }),
    onSuccess: () => {
      toast.success(`Поле {{${CF_KEY_PREFIX}${key.trim()}}} создано`);
      // реестр влияет на конструкторы сегментов/подсказки — сбрасываем весь кэш
      void queryClient.invalidateQueries();
      onOpenChange(false);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось создать поле';
      setServerError(detail);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Новое кастомное поле</DialogTitle>
          <DialogDescription>
            Поле появится в карточке клиента, конструкторе сегментов и подсказках
            шаблонов; значение можно передавать и из client_card события.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cf-key">Ключ поля</Label>
            <Input
              id="cf-key"
              value={key}
              onChange={(e) => {
                setKey(e.target.value.toLowerCase());
                setServerError(null);
              }}
              placeholder="is_credit_line"
              aria-invalid={keyInvalid}
              className="font-mono"
              autoFocus
            />
            <p className={`text-xs ${keyInvalid ? 'text-red-600 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
              {key.trim().startsWith(CF_KEY_PREFIX)
                ? `Без префикса «${CF_KEY_PREFIX}» — он добавится сам`
                : 'Латинские буквы/цифры/подчёркивание, 2–40 символов, с буквы'}
              {KEY_RE.test(key.trim()) && !key.trim().startsWith(CF_KEY_PREFIX) ? ` — переменная: {${'{'}${CF_KEY_PREFIX}${key.trim()}}}` : ''}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cf-label">Название (для интерфейса)</Label>
            <Input
              id="cf-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Кредитная линия подключена"
              maxLength={100}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cf-type">Тип значений</Label>
            <Select value={type} onValueChange={(v) => setType(v as CustomFieldItem['type'])}>
              <SelectTrigger id="cf-type" aria-label="Тип значений поля">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CF_TYPE_META) as CustomFieldItem['type'][]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {CF_TYPE_META[t].label} — {CF_TYPE_META[t].hint}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Тип задаёт колонку хранения и операторы сегментации; после создания не меняется
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cf-desc">Описание (необязательно)</Label>
            <Textarea
              id="cf-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Для чего поле и кто его заполняет"
              rows={2}
              maxLength={500}
            />
          </div>
          {serverError && <p className="text-sm text-red-600 dark:text-red-400">{serverError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!canSubmit || createMutation.isPending}
          >
            {createMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
            Создать поле
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Диалог правки: метка и описание (ключ/тип неизменяемы — показываем read-only). */
function EditFieldDialog({
  field,
  onOpenChange,
}: {
  field: CustomFieldItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [label, setLabel] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [serverError, setServerError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (field) {
      setLabel(field.label);
      setDescription(field.description ?? '');
      setServerError(null);
    }
  }, [field]);

  const saveMutation = useMutation({
    mutationFn: async () =>
      api<CustomFieldItem>(`/api/v1/custom-fields/${field!.id}`, {
        method: 'PATCH',
        // Пустое описание уходит null, а не '': «описания нет» и «пустое» —
        // разные состояния, в таблице null рендерится как «—».
        body: { label: label.trim(), description: description.trim().length > 0 ? description.trim() : null },
      }),
    onSuccess: () => {
      toast.success('Поле обновлено');
      void queryClient.invalidateQueries();
      onOpenChange(false);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось обновить поле';
      setServerError(detail);
    },
  });

  if (!field) return null;

  return (
    <Dialog open={field !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Правка поля {`{{${field.varName}}}`}</DialogTitle>
          <DialogDescription>
            Ключ и тип неизменяемы — они определяют колонку хранения значений.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs text-zinc-500 dark:text-zinc-400">Ключ (не меняется)</Label>
              <p className="wrap-anywhere rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm">
                {field.key}
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-zinc-500 dark:text-zinc-400">Тип (не меняется)</Label>
              <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
                {CF_TYPE_META[field.type].label}
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cf-edit-label">Название</Label>
            <Input
              id="cf-edit-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={100}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cf-edit-desc">Описание</Label>
            <Textarea
              id="cf-edit-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={500}
            />
          </div>
          {serverError && <p className="text-sm text-red-600 dark:text-red-400">{serverError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={label.trim().length === 0 || saveMutation.isPending}
          >
            {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Подтверждение переключения активности с честным описанием последствий. */
function ToggleActiveConfirm({
  field,
  onOpenChange,
}: {
  field: CustomFieldItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  // ВАЖНО: цель передаётся ПЕРЕМЕННЫМИ мутации, а не берётся из замыкания field.
  // Radix AlertDialogAction закрывает диалог сразу по клику → setToggleField(null)
  // → ререндер с field=null успевает заменить mutationFn у pending-мутации
  // (observer.setOptions в useEffect) — замыкание на null роняло запрос МОЛЧА
  // (ошибка глоталась .catch(noop) внутри react-query: ни запроса, ни тоста).
  // Ниже — e.preventDefault(): диалог держим открытым до ответа сервера.
  const toggleMutation = useMutation({
    mutationFn: async (target: { id: string; isActive: boolean }) =>
      api<CustomFieldItem>(`/api/v1/custom-fields/${target.id}`, {
        method: 'PATCH',
        body: { isActive: target.isActive },
      }),
    onSuccess: (updated) => {
      toast.success(updated.isActive ? 'Поле включено' : 'Поле выключено');
      void queryClient.invalidateQueries();
      onOpenChange(false);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось изменить поле';
      toast.error(`Ошибка: ${detail}`);
      onOpenChange(false);
    },
  });

  if (!field) return null;
  const deactivating = field.isActive;

  return (
    <AlertDialog open={field !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {deactivating ? `Выключить поле {${'{'}${field.varName}}}?` : `Включить поле {${'{'}${field.varName}}}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deactivating
              ? 'Поле исчезнет из конструктора сегментов и подсказок шаблонов и перестанет обновляться из client_card. Сохранённые значения НЕ удаляются — переменные в собранных шаблонах продолжат подставляться. Сегменты с правилами по полю продолжат вычисляться по имеющимся данным.'
              : 'Поле снова появится в конструкторах и подсказках и начнёт приниматься из client_card.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            disabled={toggleMutation.isPending}
            onClick={(e) => {
              // диалог закрывает только onSuccess/onError — держим открытым,
              // пока идёт запрос (иначе мутация умирает вместе с компонентом)
              e.preventDefault();
              toggleMutation.mutate({ id: field.id, isActive: !field.isActive });
            }}
          >
            {toggleMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {deactivating ? 'Выключить' : 'Включить'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Подтверждение удаления поля: честное описание последствий + гварды 409.
 *  Паттерн как в ToggleActiveConfirm: цель — переменными мутации (не замыканием
 *  field) + e.preventDefault() — диалог держим открытым до ответа сервера. */
function DeleteFieldConfirm({
  field,
  onOpenChange,
}: {
  field: CustomFieldItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: async (id: string) =>
      api<void>(`/api/v1/custom-fields/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Поле удалено');
      // реестр влияет на конструкторы сегментов/подсказки — сбрасываем весь кэш
      void queryClient.invalidateQueries();
      onOpenChange(false);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось удалить поле';
      toast.error(`Ошибка: ${detail}`);
      onOpenChange(false);
    },
  });

  if (!field) return null;

  return (
    <AlertDialog open={field !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить поле {`{{${field.varName}}}` }?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            {/* Description сам рендерит <p> — вложенные абзацы делаем span'ами
                (block-класс сохраняет вертикальные отступы), иначе невалидная
                вложенность p-in-p, которую подсвечивает React */}
            <div className="space-y-2">
              <span className="block">
                Поле «{field.label}» и все его значения будут удалены безвозвратно
                {field.values > 0 ? ` (значения ${field.values} клиентов)` : ''}.
                Восстановить данные будет нельзя — передумали? Выключите поле вместо
                удаления: значения сохранятся, а сбор и подстановку можно остановить.
              </span>
              <span className="block">
                Если переменной пользуются шаблоны, воронки или сегменты, сервер
                отклонит удаление и покажет, где именно она встречается.
              </span>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 text-white hover:bg-red-700"
            disabled={deleteMutation.isPending}
            onClick={(e) => {
              // диалог закрывает только onSuccess/onError — держим открытым,
              // пока идёт запрос (иначе мутация умирает вместе с компонентом)
              e.preventDefault();
              deleteMutation.mutate(field.id);
            }}
          >
            {deleteMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Удалить поле
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Раздел «Кастомные поля» (ADMIN): таблица реестра + создание/правка/активность. */
export function CustomFieldsView() {
  const { isAdmin } = useRole();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editField, setEditField] = React.useState<CustomFieldItem | null>(null);
  const [toggleField, setToggleField] = React.useState<CustomFieldItem | null>(null);
  const [deleteField, setDeleteField] = React.useState<CustomFieldItem | null>(null);

  // Весь реестр (включая деактивированные) — только админам; запрос не идёт
  // под MANAGER/VIEWER (сервер отдал бы и так — параметр только расширяет выдачу,
  // но раздел им не виден вовсе).
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['custom-fields-admin'],
    queryFn: () => api<{ items: CustomFieldItem[] }>('/api/v1/custom-fields?includeInactive=1'),
    enabled: isAdmin,
  });

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Shapes className="mb-3 size-10 text-zinc-300 dark:text-zinc-600" aria-hidden />
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Раздел доступен только администраторам</p>
        <p className="mt-1 max-w-md text-xs text-zinc-400 dark:text-zinc-500">
          Реестр кастомных полей ведёт ADMIN; значения полей заполняются в карточке
          клиента и из событий ядра
        </p>
      </div>
    );
  }

  const items = data?.items ?? [];
  // Список отсортирован сервером по (isActive, key) — «Обновлено» считаем
  // максимумом updatedAt по реестру, а не первым элементом списка.
  const lastUpdatedAt =
    items.length > 0
      ? items.reduce((acc, f) => (f.updatedAt > acc ? f.updatedAt : acc), items[0].updatedAt)
      : null;

  return (
    <div className="space-y-4">
      {/* Как это работает — короткая инструкция прямо в разделе */}
      <Alert className="border-teal-200 bg-teal-50/60 text-teal-900 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-300">
        <Shapes className="size-4" aria-hidden />
        <AlertTitle>Кастомные поля — доп. данные профиля без доработок ядра</AlertTitle>
        <AlertDescription className="space-y-1 text-xs text-teal-800 dark:text-teal-400">
          <p>
            Переменная в шаблонах/воронках/рассылках:{' '}
            <code className="rounded bg-card/70 px-1 font-mono">{`{{${CF_KEY_PREFIX}ключ}}`}</code>;
            ключ в client_card события:{' '}
            <code className="rounded bg-card/70 px-1 font-mono">{`"${CF_KEY_PREFIX}ключ"`}</code>{' '}
            (или сырой <code className="rounded bg-card/70 px-1 font-mono">ключ</code>) — значение
            применяется автоматически при обработке события.
          </p>
          <p>
            Сегментация — в «Сегментах» (категория «Кастомные», SQL-фильтр по индексам — работает
            и на миллионах строк); значения редактируются в карточке клиента. Выключение поля
            останавливает сбор, но не удаляет данные; удаление — безвозвратно сносит и значения
            (если переменной пользуются шаблоны/воронки/сегменты — сервер не пустит).
          </p>
        </AlertDescription>
      </Alert>

      <Card className="shadow-sm">
        <CardContent className="space-y-3 p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Полей: {items.length}
              {items.some((f) => !f.isActive) ? ` (активных: ${items.filter((f) => f.isActive).length})` : ''}
            </p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden />
              Новое поле
            </Button>
          </div>

          {isPending ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </div>
          ) : error ? (
            <div className="p-3">
              <ErrorState error={error} onRetry={() => void refetch()} />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Shapes className="mb-3 size-10 text-zinc-300 dark:text-zinc-600" aria-hidden />
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Кастомных полей пока нет</p>
              <p className="mt-1 max-w-md text-xs text-zinc-400 dark:text-zinc-500">
                Создайте первое — например, is_credit_line (признак кредитной линии)
                или available_tranche_sum (доступная сумма транша): поле появится в карточке
                клиента, сегментах и подсказках шаблонов
              </p>
              <div className="mt-4">
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" aria-hidden />
                  Создать поле
                </Button>
              </div>
            </div>
          ) : (
            <div className="max-h-[65vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[26%]">Переменная / ключ</TableHead>
                    <TableHead className="w-[22%]">Название</TableHead>
                    <TableHead className="w-[9%]">Тип</TableHead>
                    <TableHead className="w-[9%] text-right">Значений</TableHead>
                    <TableHead className="w-[10%]">Статус</TableHead>
                    <TableHead className="w-[24%]">Описание</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {/* Выключенные поля остаются в реестре и гасятся строкой — значения
                      сохранены (isActive=false обратим, в отличие от DELETE), строку
                      можно снова включить. */}
                  {items.map((f) => (
                    <TableRow key={f.id} className={f.isActive ? undefined : 'opacity-60'}>
                      <TableCell className="font-mono text-xs">
                        <span title={`Ключ: ${f.key}`}>{`{{${f.varName}}}`}</span>
                      </TableCell>
                      <TableCell className="text-sm">{f.label}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="border-border bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                          {CF_TYPE_META[f.type].label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums" title="Клиентов с заполненным значением">
                        {f.values}
                      </TableCell>
                      <TableCell>
                        {f.isActive ? (
                          <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400">
                            активно
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-zinc-200 bg-zinc-100 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-400">
                            выключено
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[240px] truncate text-xs text-zinc-500 dark:text-zinc-400" title={f.description ?? undefined}>
                        {f.description ?? '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`Правка поля ${f.label}`}
                            title="Название и описание"
                            onClick={() => setEditField(f)}
                          >
                            <PencilLine className="size-4" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={f.isActive ? `Выключить поле ${f.label}` : `Включить поле ${f.label}`}
                            title={f.isActive ? 'Выключить (значения сохранятся)' : 'Включить'}
                            onClick={() => setToggleField(f)}
                          >
                            {f.isActive ? <PowerOff className="size-4" aria-hidden /> : <Power className="size-4" aria-hidden />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                            aria-label={`Удалить поле ${f.label}`}
                            title="Удалить поле и все значения (безвозвратно)"
                            onClick={() => setDeleteField(f)}
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {data !== undefined && items.length > 0 && (
            <p className="border-t border-border px-3 py-2 text-xs text-zinc-400 dark:text-zinc-500">
              Обновлено: {fmtDT(lastUpdatedAt)} — счётчик значений и статусы полей обновляются
              при каждом открытии раздела
            </p>
          )}
        </CardContent>
      </Card>

      <CreateFieldDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditFieldDialog field={editField} onOpenChange={() => setEditField(null)} />
      <ToggleActiveConfirm field={toggleField} onOpenChange={() => setToggleField(null)} />
      <DeleteFieldConfirm field={deleteField} onOpenChange={() => setDeleteField(null)} />
    </div>
  );
}
