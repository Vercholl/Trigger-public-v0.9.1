'use client';

// Именные короткие ссылки для маркетинга — список, конструктор с UTM,
// статистика переходов. Короткий URL строится от origin панели — в SMS
// попадает ровно то, что скопировал/вставил маркетолог.
// API: GET/POST /api/v1/links, PUT/DELETE /api/v1/links/{id}
// (переход получателя — публичный редирект /r?c={code}, не из этого файла).
// Роли: список — любая; «Новая ссылка»/правка/удаление — MANAGER+ (ViewerGuard).
import * as React from 'react';
import {
  CalendarClock,
  Copy,
  ExternalLink,
  Link2,
  MousePointerClick,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
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
import { buildTargetUrl, countUtmParams, splitTargetUrl, UTM_FIELD_META, type UtmParams } from '@/lib/compliance/link-url';
import {
  invalidatePanel,
  copyText,
  EmptyState,
  ErrorState,
  fmtDate,
  fmtDT,
  relTime,
  ViewerGuard,
  type NamedLinkItem,
  type NamedLinksResponse,
} from '@/components/views/shared';

/**
 * Форма создания/редактирования именной ссылки (UTM-конструктор + превью).
 * При открытии поля пересобираются из link: splitTargetUrl вычленяет UTM-метки
 * из сохранённого targetUrl. Код ссылки не меняется — редактирование не ломает
 * уже отправленные SMS.
 */
function LinkDialog({
  open,
  onOpenChange,
  link,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  link: NamedLinkItem | null; // null = создание
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [utm, setUtm] = React.useState<UtmParams>({});
  const [expiresAt, setExpiresAt] = React.useState('');
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Открытие диалога: сброс ошибки и инициализация полей —
  // из редактируемой ссылки (date-часть expiresAt) или пустая форма создания.
  React.useEffect(() => {
    if (!open) return;
    setServerError(null);
    if (link) {
      setName(link.name);
      const split = splitTargetUrl(link.targetUrl);
      setBaseUrl(split.base);
      setUtm(split.utm);
      setExpiresAt(link.expiresAt ? link.expiresAt.slice(0, 10) : '');
    } else {
      setName('');
      setBaseUrl('');
      setUtm({});
      setExpiresAt('');
    }
  }, [open, link]);

  // Итоговый целевой URL с UTM (null — некорректный http(s)-адрес → блокирует сохранение).
  const finalUrl = React.useMemo(() => buildTargetUrl(baseUrl.trim(), utm), [baseUrl, utm]);
  // Название: непустое, до 80 символов (лимит сервера).
  const nameValid = name.trim().length > 0 && name.trim().length <= 80;

  // Сохранение: PUT для существующей ссылки, POST для новой. UTM сериализуются
  // полным набором из пяти ключей (пустые значения сервер затирает).
  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        targetUrl: baseUrl.trim(),
        utm: {
          utm_source: utm.utm_source ?? '',
          utm_medium: utm.utm_medium ?? '',
          utm_campaign: utm.utm_campaign ?? '',
          utm_content: utm.utm_content ?? '',
          utm_term: utm.utm_term ?? '',
        },
        expiresAt: expiresAt || null,
      };
      if (link) {
        return api<NamedLinkItem>(`/api/v1/links/${link.id}`, { method: 'PUT', body });
      }
      return api<NamedLinkItem>('/api/v1/links', { method: 'POST', body });
    },
    onSuccess: () => {
      toast.success(link ? 'Ссылка обновлена' : 'Ссылка создана');
      invalidatePanel(queryClient);
      onOpenChange(false);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось сохранить ссылку';
      setServerError(detail);
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Блок «Сохранить»: запрос в полёте, имя некорректно, URL пуст или не собрался.
  const submitDisabled =
    saveMutation.isPending || !nameValid || baseUrl.trim().length === 0 || finalUrl === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{link ? 'Редактировать ссылку' : 'Новая короткая ссылка'}</DialogTitle>
          <DialogDescription>
            Короткий код останется прежним при редактировании — SMS и печатные
            материалы не сломаются
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="link-name">Название</Label>
              <Input
                id="link-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Лендинг «Зарплатный заём»"
                maxLength={80}
              />
              {!nameValid && name.length > 0 ? (
                <p className="text-xs text-red-600 dark:text-red-400">Название обязательно, до 80 символов</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="link-expires">Действует до (необязательно)</Label>
              <Input
                id="link-expires"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
              <p className="text-xs text-zinc-400">После этой даты ссылка покажет «акция завершена»</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="link-url">Целевой URL</Label>
            <Input
              id="link-url"
              className="font-mono text-sm"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://example.com/promo"
              inputMode="url"
            />
            {baseUrl.trim().length > 0 && finalUrl === null ? (
              <p className="text-xs text-red-600 dark:text-red-400">
                Адрес должен начинаться с http:// или https:// и быть корректным URL
              </p>
            ) : null}
          </div>

          {/* UTM-конструктор */}
          <div className="space-y-2.5 rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-3">
            <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
              UTM-метки — попадут в целевой URL при переходе из SMS
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {UTM_FIELD_META.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`utm-${f.key}`} className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                    {f.label} <span className="font-mono">{f.key}</span>
                  </Label>
                  <Input
                    id={`utm-${f.key}`}
                    className="h-8 font-mono text-xs"
                    value={utm[f.key] ?? ''}
                    onChange={(e) => setUtm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    maxLength={100}
                  />
                </div>
              ))}
            </div>
            {/* Живое превью итогового targetUrl (buildTargetUrl): непустые UTM
                приклеиваются query-параметрами, одноимённые в базовом URL —
                заменяются; именно этот адрес получит переход после /r?c. */}
            <p className="rounded-md bg-card p-2 font-mono text-xs break-all text-zinc-500 dark:text-zinc-400" title={finalUrl ?? ''}>
              {finalUrl ?? '—'}
            </p>
          </div>

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
          <Button onClick={() => saveMutation.mutate()} disabled={submitDisabled}>
            {saveMutation.isPending ? 'Сохранение…' : link ? 'Сохранить' : 'Создать ссылку'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Корневой экран вкладки «Ссылки»: сводка, список (карточки/таблица), диалоги. */
export function LinksView() {
  const queryClient = useQueryClient();
  const [origin, setOrigin] = React.useState('');
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<NamedLinkItem | null>(null);
  const [deleting, setDeleting] = React.useState<NamedLinkItem | null>(null);

  // Origin панели без хвостового слэша — база показываемого короткого URL
  // {origin}/r?c={code}; пуст до маунта (SSR), затем заполняется.
  React.useEffect(() => {
    setOrigin(window.location.origin.replace(/\/$/, ''));
  }, []);

  // Список именных ссылок — без пагинации (небольшой справочник).
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['links'],
    queryFn: () => api<NamedLinksResponse>('/api/v1/links'),
  });

  // Удаление ссылки: код перестаёт резолвиться (страница «акция завершена»),
  // статистика переходов сохраняется в отчётах.
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api<void>(`/api/v1/links/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      toast.success('Ссылка удалена');
      setDeleting(null);
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось удалить ссылку';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  /** Копирование короткой ссылки {origin}/r?c={code} в буфер обмена
   *  (кнопки «Копировать» в карточках и таблице). */
  async function copyShortUrl(code: string) {
    const url = `${origin}/r?c=${code}`;
    // copyText — общий хелпер с execCommand-фолбэком для http-контура
    const ok = await copyText(url);
    if (ok) toast.success('Скопировано: ' + url);
    else toast.error('Не удалось скопировать — выделите текст вручную');
  }

  // Деривации для сводки: список и сумма переходов по всем ссылкам.
  const items = data?.items ?? [];
  const totalVisits = items.reduce((acc, l) => acc + l.visits, 0);

  return (
    <div className="space-y-4">
      {/* Сводка + создание */}
      <Card className="shadow-sm">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
            <span className="flex items-center gap-1.5">
              <Link2 className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
              {items.length} ссылок
            </span>
            <span className="flex items-center gap-1.5">
              <MousePointerClick className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
              {totalVisits.toLocaleString('ru-RU')} переходов
            </span>
          </div>
          <ViewerGuard>
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="size-4" aria-hidden />
              Новая ссылка
            </Button>
          </ViewerGuard>
        </CardContent>
      </Card>

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
            <EmptyState
              icon={Link2}
              title="Именных ссылок пока нет"
              action={
                <ViewerGuard>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEditing(null);
                      setDialogOpen(true);
                    }}
                  >
                    <Plus className="size-4" aria-hidden />
                    Создать первую ссылку
                  </Button>
                </ViewerGuard>
              }
            />
          ) : (
            <>
              {/* Мобильные карточки (< sm): таблица не влезает — вертикальный список */}
              <div className="max-h-[70vh] space-y-3 overflow-y-auto p-3 sm:hidden">
                {items.map((l) => {
                  // Истёкшая ссылка визуально гасится; клик уже ведёт на «акция завершена»
                  const expired = l.expiresAt !== null && new Date(l.expiresAt).getTime() <= Date.now();
                  const utmCount = countUtmParams(l.targetUrl);
                  return (
                    <div
                      key={l.id}
                      className={`space-y-2.5 rounded-lg border border-border p-3 ${expired ? 'opacity-60' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200" title={l.name}>
                            {l.name}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {utmCount > 0 ? (
                              <Badge variant="outline" className="border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 px-1.5 text-[10px] text-emerald-700 dark:text-emerald-400">
                                UTM ×{utmCount}
                              </Badge>
                            ) : null}
                            {l.expiresAt ? (
                              <Badge
                                variant="outline"
                                className={
                                  expired
                                    ? 'border-border bg-zinc-100 dark:bg-zinc-800 px-1.5 text-[10px] text-zinc-500 dark:text-zinc-400'
                                    : 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 px-1.5 text-[10px] text-amber-700 dark:text-amber-400'
                                }
                              >
                                <CalendarClock className="mr-1 size-3" aria-hidden />
                                {expired ? 'истекла' : `до ${fmtDate(l.expiresAt)}`}
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            asChild
                          >
                            <a
                              href={`${origin}/r?c=${l.code}`}
                              target="_blank"
                              rel="noreferrer"
                              aria-label="Проверить переход"
                            >
                              <ExternalLink className="size-4" aria-hidden />
                            </a>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => {
                              setEditing(l);
                              setDialogOpen(true);
                            }}
                            aria-label="Редактировать"
                          >
                            <Pencil className="size-4" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-red-600 dark:text-red-400 hover:text-red-700 dark:text-red-400"
                            onClick={() => setDeleting(l)}
                            aria-label="Удалить"
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <code className="truncate rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                          /r?c={l.code}
                        </code>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 shrink-0 px-2 text-xs"
                          onClick={() => void copyShortUrl(l.code)}
                        >
                          <Copy className="size-3.5" aria-hidden />
                          Копировать
                        </Button>
                      </div>
                      {/* Счётчики: visits — переходы по /r?c={code} (фиксирует
                          публичный редирект, включая кнопку «Проверить переход»),
                          smsCount — число SMS, ушедших с этой ссылкой;
                          visits/smsCount — фактический CTR кампании. */}
                      <div className="flex items-center justify-between gap-3 text-xs text-zinc-500 dark:text-zinc-400">
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">{l.visits.toLocaleString('ru-RU')} перех.</span>
                        <span>{l.smsCount} SMS</span>
                        <span className="truncate">{l.lastVisitAt ? relTime(l.lastVisitAt) : '—'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Таблица (≥ sm) */}
              <div className="hidden max-h-[62vh] overflow-auto sm:block">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>Название</TableHead>
                    <TableHead>Короткая ссылка</TableHead>
                    <TableHead className="hidden lg:table-cell">Куда ведёт</TableHead>
                    <TableHead className="text-right">Переходы</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">В SMS</TableHead>
                    <TableHead className="hidden xl:table-cell">Последний переход</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((l) => {
                    // Аналогично мобильным карточкам: гасим истёкшие, считаем UTM-метки.
                    // Колонки «Переходы»/«В SMS» — те же счётчики: клики по короткому
                    // коду и охват доставками; их отношение — CTR кампании.
                    const expired = l.expiresAt !== null && new Date(l.expiresAt).getTime() <= Date.now();
                    const utmCount = countUtmParams(l.targetUrl);
                    return (
                      <TableRow key={l.id} className={expired ? 'opacity-60' : undefined}>
                        <TableCell className="py-3">
                          <p
                            className="max-w-[150px] truncate text-sm font-medium text-zinc-800 dark:text-zinc-200 sm:max-w-[220px]"
                            title={l.name}
                          >
                            {l.name}
                          </p>
                          <div className="mt-0.5 flex max-w-[150px] flex-wrap items-center gap-1.5 sm:max-w-[220px]">
                            {utmCount > 0 ? (
                              <Badge variant="outline" className="border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 px-1.5 text-[10px] text-emerald-700 dark:text-emerald-400">
                                UTM ×{utmCount}
                              </Badge>
                            ) : null}
                            {l.expiresAt ? (
                              <Badge
                                variant="outline"
                                className={
                                  expired
                                    ? 'border-border bg-zinc-100 dark:bg-zinc-800 px-1.5 text-[10px] text-zinc-500 dark:text-zinc-400'
                                    : 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 px-1.5 text-[10px] text-amber-700 dark:text-amber-400'
                                }
                                title={`Действует до ${fmtDate(l.expiresAt)}`}
                              >
                                <CalendarClock className="mr-1 size-3" aria-hidden />
                                {expired ? 'истекла' : `до ${fmtDate(l.expiresAt)}`}
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <code className="whitespace-nowrap rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                              /r?c={l.code}
                            </code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              onClick={() => void copyShortUrl(l.code)}
                              aria-label="Скопировать короткую ссылку"
                              title={`Скопировать: ${origin}/r?c=${l.code}`}
                            >
                              <Copy className="size-3.5" aria-hidden />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="hidden max-w-[260px] py-3 lg:table-cell">
                          <a
                            href={l.targetUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate font-mono text-xs text-emerald-700 dark:text-emerald-400 hover:underline"
                            title={l.targetUrl}
                          >
                            {l.targetUrl}
                          </a>
                        </TableCell>
                        <TableCell className="py-3 text-right text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                          {l.visits.toLocaleString('ru-RU')}
                        </TableCell>
                        <TableCell className="hidden py-3 text-right text-sm text-zinc-600 dark:text-zinc-400 sm:table-cell">
                          {l.smsCount}
                        </TableCell>
                        <TableCell className="hidden py-3 text-xs text-zinc-500 dark:text-zinc-400 xl:table-cell">
                          {l.lastVisitAt ? (
                            <span title={fmtDT(l.lastVisitAt)}>{relTime(l.lastVisitAt)}</span>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell className="py-3">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="hidden size-7 sm:inline-flex"
                              asChild
                            >
                              <a
                                href={`${origin}/r?c=${l.code}`}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="Проверить переход"
                                title="Проверить переход (учитается в статистике)"
                              >
                                <ExternalLink className="size-3.5" aria-hidden />
                              </a>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              onClick={() => {
                                setEditing(l);
                                setDialogOpen(true);
                              }}
                              aria-label="Редактировать"
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-red-600 dark:text-red-400 hover:text-red-700 dark:text-red-400"
                              onClick={() => setDeleting(l)}
                              aria-label="Удалить"
                            >
                              <Trash2 className="size-3.5" aria-hidden />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* --- Модалки: редактор ссылки + подтверждение удаления --- */}
      <LinkDialog open={dialogOpen} onOpenChange={setDialogOpen} link={editing} />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => (open ? null : setDeleting(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить ссылку «{deleting?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Отправленные SMS продолжат открывать страницу «акция завершена», а
              статистика переходов сохранится в отчётах. Это действие нельзя
              отменить.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) deleteMutation.mutate(deleting.id);
              }}
            >
              {deleteMutation.isPending ? 'Удаление…' : 'Удалить'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
