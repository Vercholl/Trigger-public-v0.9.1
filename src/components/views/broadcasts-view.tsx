'use client';

// Вкладка «Рассылки»: разовые и регулярные SMS по сегментам.
// Время расписания — по местному поясу каждого клиента; защита «не чаще 1 раза
// в N дней» и порционный лимит на запуск; комплаенс срабатывает при отправке.
// API: GET/POST /api/v1/broadcasts, PUT/DELETE /api/v1/broadcasts/{id},
// POST /api/v1/broadcasts/{id}/run|restart|pause|resume|cancel;
// справочники конструктора: GET /api/v1/segments, GET /api/v1/templates.
// Роли: просмотр карточек и истории запусков — любая; все действия — MANAGER+.
import * as React from 'react';
import {
  Ban,
  CalendarClock,
  Filter,
  Megaphone,
  MessageSquareText,
  Pause,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api-client';
import {
  invalidatePanel,
  BROADCAST_KIND_META,
  BROADCAST_STATUS_META,
  EmptyState,
  ErrorState,
  fmtDT,
  REJECT_REASON_TEXT,
  TemplateItem,
  TableSkeleton,
  useRole,
  ViewerGuard,
  WEEKDAYS_FULL,
  WEEKDAYS_SHORT,
  type BroadcastDetail,
  type BroadcastItem,
  type BroadcastRunItem,
  type BroadcastRunStats,
  type Paged,
  type RejectReason,
} from '@/components/views/shared';

/** Минимальный сегмент для выбора в конструкторе рассылки. */
interface SegmentLite {
  id: string;
  name: string;
  mode?: 'dynamic' | 'static';
}

/* ================= Хелперы ================= */

/** Дополнить число до двух знаков (часы/минуты для «ЧЧ:ММ»). */
function pad2(v: number): string {
  return String(v).padStart(2, '0');
}

/** Человекочитаемое расписание для карточки: регулярная — «Каждый пн в 10:00»,
 *  разовая — «В 31.12.2025 10:00» либо «Сразу при создании». */
function scheduleText(b: BroadcastItem): string {
  if (b.kind === 'RECURRING') {
    const wd = b.weekday ? WEEKDAYS_FULL[b.weekday - 1] : '—';
    return `Каждый ${wd} в ${pad2(b.hour ?? 0)}:${pad2(b.minute)}`;
  }
  if (b.runAt === null) return 'Сразу при создании';
  return `В ${fmtDT(b.runAt)}`;
}

/** Подсказка под полями времени (ключевая семантика расписания рассылок). */
function localTimeHint(): string {
  return 'Время — по местному часовому поясу каждого клиента';
}

/** Чипы-счётчики доставки одного запуска (нулевые скрываются при рендере).
 *  Это судьба уже СОЗДАННЫХ сообщений (queued → sent/delivered | rejected |
 *  failed | cancelled); счётчики отбора planned/recipients/skippedGuard/
 *  cappedBy (кого отобрали и кого сняли защиты) рендерятся отдельной строкой —
 *  см. «Подходит по сегменту…» в RunsDialog и в карточках списка. */
function runStatsChips(stats: BroadcastRunStats): Array<{ label: string; value: number; className?: string }> {
  return [
    { label: 'в очереди', value: stats.queued },
    { label: 'доставлено', value: stats.delivered },
    { label: 'отправлено', value: stats.sent },
    { label: 'отказ', value: stats.rejected, className: 'text-orange-700 dark:text-orange-400' },
    { label: 'ошибки', value: stats.failed, className: 'text-red-700 dark:text-red-400' },
    { label: 'отменено', value: stats.cancelled },
  ];
}

/* ================= Диалог создания/редактирования ================= */

/** Способы запуска разовой рассылки: сразу или в указанное время. */
const ONCE_MODES = [
  { value: 'now', label: 'Сейчас' },
  { value: 'at', label: 'В указанное время' },
] as const;

/** Диалог создания/редактирования рассылки. При редактировании расписание
 *  разовой рассылки не меняется — только имя/описание/сегмент/шаблон/защиты. */
function BroadcastDialog({
  open,
  onOpenChange,
  broadcast,
  segments,
  templates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  broadcast: BroadcastItem | null; // null → создание
  segments: SegmentLite[];
  templates: TemplateItem[];
}) {
  const queryClient = useQueryClient();
  const editing = broadcast !== null;
  // В массовых рассылках разрешены только активные маркетинговые шаблоны
  // (сервисные шаблоны отправляют воронки по событиям).
  const marketingTemplates = React.useMemo(
    () => templates.filter((t) => t.isMarketing && t.isActive),
    [templates],
  );

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [segmentId, setSegmentId] = React.useState('');
  const [templateId, setTemplateId] = React.useState('');
  const [kind, setKind] = React.useState<'ONCE' | 'RECURRING'>('ONCE');
  const [onceMode, setOnceMode] = React.useState<'now' | 'at'>('at');
  const [runAtLocal, setRunAtLocal] = React.useState('');
  const [weekday, setWeekday] = React.useState('1');
  const [timeStr, setTimeStr] = React.useState('10:00');
  const [minDaysBetween, setMinDaysBetween] = React.useState('7');
  const [maxRecipients, setMaxRecipients] = React.useState('1000');
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Открытие диалога: сброс ошибки и предзаполнение полей из broadcast
  // (null → дефолты новой рассылки): runAt → datetime-local, hour/minute → «ЧЧ:ММ».
  React.useEffect(() => {
    if (!open) return;
    setServerError(null);
    if (broadcast) {
      setName(broadcast.name);
      setDescription(broadcast.description ?? '');
      setSegmentId(broadcast.segmentId);
      setTemplateId(broadcast.templateId);
      setKind(broadcast.kind);
      setOnceMode(broadcast.runAt === null ? 'now' : 'at');
      setRunAtLocal(broadcast.runAt !== null ? broadcast.runAt.slice(0, 16) : '');
      setWeekday(String(broadcast.weekday ?? 1));
      setTimeStr(`${pad2(broadcast.hour ?? 10)}:${pad2(broadcast.minute)}`);
      setMinDaysBetween(String(broadcast.minDaysBetween));
      setMaxRecipients(String(broadcast.maxRecipients));
    } else {
      setName('');
      setDescription('');
      setSegmentId('');
      setTemplateId('');
      setKind('ONCE');
      setOnceMode('at');
      setRunAtLocal('');
      setWeekday('1');
      setTimeStr('10:00');
      setMinDaysBetween('7');
      setMaxRecipients('1000');
    }
  }, [open, broadcast]);

  // Числовые поля (интервал/лимит) — только неотрицательные целые.
  const numberInvalid = !/^\d+$/.test(minDaysBetween) || !/^\d+$/.test(maxRecipients);

  // Для создания дополнительно требуется расписание (время RECURRING / дата ONCE-at);
  // при редактировании расписание уже задано на сервере.
  const canSubmit =
    name.trim().length > 0 &&
    segmentId !== '' &&
    templateId !== '' &&
    !numberInvalid &&
    (editing ||
      (kind === 'RECURRING' ? timeStr !== '' : onceMode === 'now' ? true : runAtLocal !== ''));

  // Сохранение. Часы/минуты парсятся из «ЧЧ:ММ» и уходят раздельными полями (схема API);
  // при редактировании kind/runAt не пересылаются — расписание разовой неизменно.
  // runAtLocal — локальное время менеджера, сервер переведёт его в стеновое время клиентов.
  // Нюанс: строка datetime-local идёт БЕЗ зоны, сервер трактует её как стеновые ЧЧ:ММ
  // (якорь момента — самая ранняя зона РФ, Europe/Kaliningrad), а отправку каждому
  // клиенту выставит на те же ЧЧ:ММ в ЕГО поясе: «10:00» в поле = «10:00» на часах
  // получателя (createBroadcast/clientSendAt в services/broadcasts).
  const saveMutation = useMutation({
    mutationFn: async () => {
      const [hh, mm] = timeStr.split(':').map((x) => Number.parseInt(x, 10));
      const minute = Number.isFinite(mm) ? mm : 0;
      if (editing && broadcast) {
        return api<BroadcastDetail>(`/api/v1/broadcasts/${broadcast.id}`, {
          method: 'PUT',
          body: {
            name: name.trim(),
            description: description.trim() === '' ? null : description.trim(),
            segmentId,
            templateId,
            weekday: kind === 'RECURRING' ? Number.parseInt(weekday, 10) : null,
            hour: kind === 'RECURRING' ? hh : null,
            minute,
            minDaysBetween: Number.parseInt(minDaysBetween, 10),
            maxRecipients: Number.parseInt(maxRecipients, 10),
          },
        });
      }
      return api<BroadcastItem>('/api/v1/broadcasts', {
        method: 'POST',
        body: {
          name: name.trim(),
          description: description.trim() === '' ? null : description.trim(),
          segmentId,
          templateId,
          kind,
          ...(kind === 'ONCE'
            ? { runNow: onceMode === 'now', runAtLocal: onceMode === 'at' ? runAtLocal : null }
            : {
                weekday: Number.parseInt(weekday, 10),
                hour: Number.isFinite(hh) ? hh : 10,
                minute,
              }),
          minDaysBetween: Number.parseInt(minDaysBetween, 10),
          maxRecipients: Number.parseInt(maxRecipients, 10),
        },
      });
    },
    onSuccess: (_data) => {
      toast.success(editing ? 'Рассылка обновлена' : 'Рассылка создана');
      if (!editing) {
        toast.info('Запуск произойдёт автоматически по расписанию');
      }
      invalidatePanel(queryClient);
      onOpenChange(false);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? err.detail ?? err.title : 'Ошибка';
      setServerError(detail);
      toast.error(`Ошибка: ${detail}`);
    },
  });

  const noSegments = segments.length === 0;
  const noTemplates = marketingTemplates.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Рассылка «${broadcast?.name}»` : 'Новая рассылка'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Расписание разовой рассылки не меняется; остальные параметры — можно'
              : 'SMS по сегменту маркетинговым шаблоном — разово или по расписанию'}
          </DialogDescription>
        </DialogHeader>
        {editing && broadcast?.status === 'DONE' ? (
          <Alert className="border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300">
            <AlertDescription>
              Рассылка завершена. Правки применятся к следующему запуску — после
              сохранения нажмите «Перезапустить».
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bc-name">Название</Label>
              <Input
                id="bc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Преапрув недели"
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bc-desc">Описание (необязательно)</Label>
              <Input
                id="bc-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Для чего эта рассылка"
                maxLength={500}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Сегмент</Label>
              <Select value={segmentId} onValueChange={setSegmentId} disabled={editing && noSegments}>
                <SelectTrigger aria-label="Сегмент">
                  <SelectValue placeholder={noSegments ? 'Сегментов нет' : 'Выберите сегмент'} />
                </SelectTrigger>
                <SelectContent>
                  {segments.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                      {s.mode === 'static' ? ' · фиксированный' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Шаблон (только маркетинговые)</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger aria-label="Шаблон">
                  <SelectValue placeholder={noTemplates ? 'Нет активных маркетинговых' : 'Выберите шаблон'} />
                </SelectTrigger>
                <SelectContent>
                  {marketingTemplates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-zinc-400">
                Сервисные шаблоны отправляют воронки по событиям
              </p>
            </div>
          </div>

          {/* --- Расписание (только при создании): разовая или регулярная.
              «Время» здесь — НЕ момент по календарю, а стеновые ЧЧ:ММ: регулярная
              отправится в это время в поясе КАЖДОГО клиента, у разовой введённое
              время тоже станет стеновым временем получателей. Момент срабатывания
              воркера сервер считает по самой ранней зоне РФ (Europe/Kaliningrad),
              чтобы разбудить рассылку не позже нужного. --- */}
          {!editing ? (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <div className="flex items-center gap-2">
                <CalendarClock className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <h3 className="text-sm font-medium text-foreground">Расписание</h3>
              </div>
              <Tabs value={kind} onValueChange={(v) => setKind(v as 'ONCE' | 'RECURRING')}>
                <TabsList className="w-full">
                  <TabsTrigger value="ONCE" className="flex-1">
                    Разовая
                  </TabsTrigger>
                  <TabsTrigger value="RECURRING" className="flex-1">
                    Регулярная
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {kind === 'ONCE' ? (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Когда отправить</Label>
                      <Select value={onceMode} onValueChange={(v) => setOnceMode(v as 'now' | 'at')}>
                        <SelectTrigger aria-label="Когда отправить">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ONCE_MODES.map((m) => (
                            <SelectItem key={m.value} value={m.value}>
                              {m.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="bc-runat">Дата и время</Label>
                      <Input
                        id="bc-runat"
                        type="datetime-local"
                        value={runAtLocal}
                        onChange={(e) => setRunAtLocal(e.target.value)}
                        disabled={onceMode === 'now'}
                        aria-disabled={onceMode === 'now'}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{localTimeHint()}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>День недели</Label>
                      <Select value={weekday} onValueChange={setWeekday}>
                        <SelectTrigger aria-label="День недели">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WEEKDAYS_SHORT.map((d, i) => (
                            <SelectItem key={d} value={String(i + 1)}>
                              {WEEKDAYS_FULL[i]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="bc-time">Время</Label>
                      <Input
                        id="bc-time"
                        type="time"
                        value={timeStr}
                        onChange={(e) => setTimeStr(e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{localTimeHint()}</p>
                </div>
              )}
            </div>
          ) : null}

          {/* --- Защиты от переспама: интервал — одному клиенту не чаще 1 раза в
              N дней по ЭТОЙ рассылке (нарушители → skippedGuard в статистике
              запуска), лимит — порция получателей за один запуск (излишек →
              cappedBy, остаток снимет следующий запуск регулярной). --- */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bc-interval">Интервал клиенту, дней</Label>
              <Input
                id="bc-interval"
                value={minDaysBetween}
                onChange={(e) => setMinDaysBetween(e.target.value)}
                inputMode="numeric"
                aria-invalid={numberInvalid}
              />
              <p className="text-xs text-zinc-400">
                Клиент получит эту рассылку не чаще 1 раза в N дней
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bc-limit">Лимит получателей за запуск</Label>
              <Input
                id="bc-limit"
                value={maxRecipients}
                onChange={(e) => setMaxRecipients(e.target.value)}
                inputMode="numeric"
                aria-invalid={numberInvalid}
              />
              <p className="text-xs text-zinc-400">Порция на один запуск, сверх — отбрасывается</p>
            </div>
          </div>

          {numberInvalid ? (
            <p className="text-xs text-red-600 dark:text-red-400">Интервал и лимит — целые неотрицательные числа</p>
          ) : null}

          {serverError ? (
            <Alert variant="destructive">
              <AlertTitle>Ошибка сохранения</AlertTitle>
              <AlertDescription>
                <span>{serverError}</span>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            disabled={!canSubmit || saveMutation.isPending}
            onClick={() => void saveMutation.mutate()}
          >
            {saveMutation.isPending ? 'Сохранение…' : editing ? 'Сохранить' : 'Создать'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ================= Диалог запусков ================= */

/** Диалог истории запусков рассылки: карточки запусков со статистикой доставки
 *  и причинами отказов; автообновление каждые 5с. */
function RunsDialog({
  broadcast,
  onOpenChange,
}: {
  broadcast: BroadcastItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['broadcast', broadcast?.id],
    queryFn: () => api<BroadcastDetail>(`/api/v1/broadcasts/${broadcast?.id}`),
    enabled: broadcast !== null,
    refetchInterval: 5000, // живая статистика доставки
  });

  const runs: BroadcastRunItem[] = data?.runs ?? [];

  return (
    <Dialog open={broadcast !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Запуски «{broadcast?.name}»</DialogTitle>
          <DialogDescription>
            Каждому получателю — своё время по местному поясу; статистика обновляется автоматически
          </DialogDescription>
        </DialogHeader>

        {isPending ? (
          <TableSkeleton rows={3} cols={4} />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : runs.length === 0 ? (
          <EmptyState icon={Megaphone} title="Запусков ещё не было" />
        ) : (
          <div className="space-y-3">
            {runs.map((r) => (
              <div key={r.id} className="space-y-2 rounded-lg border border-border p-4">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-foreground">{fmtDT(r.startedAt)}</p>
                  <Badge
                    variant="outline"
                    className={
                      r.status === 'DONE'
                        ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400'
                        : r.status === 'FAILED'
                          ? 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400'
                          : 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400'
                    }
                  >
                    {r.status === 'DONE' ? 'Выполнен' : r.status === 'FAILED' ? 'Ошибка' : 'Выполняется'}
                  </Badge>
                </div>
                {/* Воронка отбора запуска: planned — подходящих по сегменту (до
                    защит), recipients — создано сообщений, skippedGuard — снято
                    интервалом N дней, cappedBy — отброшено лимитом порции. */}
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Подходит по сегменту: {r.planned} · создано сообщений: {r.recipients}
                  {r.skippedGuard > 0 ? ` · пропущено по интервалу: ${r.skippedGuard}` : ''}
                  {r.cappedBy > 0 ? ` · отброшено лимитом: ${r.cappedBy}` : ''}
                </p>
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {runStatsChips(r.stats)
                    .filter((c) => c.value > 0)
                    .map((c) => (
                      <Badge
                        key={c.label}
                        variant="outline"
                        className={`border-border bg-card font-normal ${c.className ?? 'text-zinc-600 dark:text-zinc-400'}`}
                      >
                        {c.value} {c.label}
                      </Badge>
                    ))}
                </div>
                {r.rejectReasons && r.rejectReasons.length > 0 ? (
                  <div className="grid gap-1">
                    <div className="flex min-w-0 flex-wrap gap-1.5">
                      {r.rejectReasons.map((rr) => (
                        <Badge
                          key={rr.reason}
                          variant="outline"
                          className="border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/60 font-normal text-orange-700 dark:text-orange-400"
                        >
                          {REJECT_REASON_TEXT[rr.reason as RejectReason] ?? rr.reason} ×{rr.count}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Причины отказов (по каждому клиенту — в SMS-логе); «пропущено по интервалу» и
                      «отброшено лимитом» в сообщения не попадают — их видно только в счётчиках выше.
                    </p>
                  </div>
                ) : null}
                {r.error ? <p className="text-xs text-red-600 dark:text-red-400">{r.error}</p> : null}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ================= Главная вкладка ================= */

/** Корневой экран вкладки «Рассылки»: сетка карточек + диалоги. */
export function BroadcastsView() {
  const queryClient = useQueryClient();
  const { canWrite } = useRole();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<BroadcastItem | null>(null);
  const [runsTarget, setRunsTarget] = React.useState<BroadcastItem | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<BroadcastItem | null>(null);
  const [cancelTarget, setCancelTarget] = React.useState<BroadcastItem | null>(null);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['broadcasts'],
    queryFn: () => api<Paged<BroadcastItem>>('/api/v1/broadcasts?pageSize=100'),
    refetchInterval: 10_000, // статистика доставки живёт
  });

  // Справочники для конструктора: сегменты и шаблоны (лимит 100 — панельный масштаб).
  const segmentsQuery = useQuery({
    queryKey: ['segments'],
    queryFn: () => api<Paged<SegmentLite>>('/api/v1/segments?pageSize=100'),
  });
  const templatesQuery = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<Paged<TemplateItem>>('/api/v1/templates?pageSize=100'),
  });

  // Локальная обёртка сброса кэша панели (после каждого успешного действия).
  const invalidate = (): void => {
    invalidatePanel(queryClient);
  };

  // Ручной запуск прямо сейчас (для ACTIVE/PAUSED): POST /run — вне расписания.
  const runNowMutation = useMutation({
    mutationFn: async (id: string) =>
      api<{ result: { recipients: number; planned: number } }>(`/api/v1/broadcasts/${id}/run`, {
        method: 'POST',
      }),
    onSuccess: (d) => {
      toast.success(`Запуск создан: получателей ${d.result.recipients} из ${d.result.planned} подходящих`);
      invalidate();
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? err.detail ?? err.title : 'Не удалось запустить';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Перезапуск завершённой: новый запуск в истории, защиты (интервал/лимит) работают
  const restartMutation = useMutation({
    mutationFn: async (id: string) =>
      api<{ result: { recipients: number; planned: number; skippedGuard: number } }>(
        `/api/v1/broadcasts/${id}/restart`,
        { method: 'POST' },
      ),
    onSuccess: (d) => {
      const skipped =
        d.result.skippedGuard > 0
          ? `, по интервалу пропущено ${d.result.skippedGuard}`
          : '';
      toast.success(
        `Повторный запуск создан: получателей ${d.result.recipients} из ${d.result.planned} подходящих${skipped}`,
      );
      invalidate();
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? err.detail ?? err.title : 'Не удалось перезапустить';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Пауза/возобновление: заморозка расписания и очереди / возврат в ACTIVE.
  const pauseMutation = useMutation({
    mutationFn: async (id: string) => api<BroadcastItem>(`/api/v1/broadcasts/${id}/pause`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Рассылка на паузе — запуски и очередь заморожены');
      invalidate();
    },
    onError: (err) => toast.error(`Ошибка: ${err instanceof ApiError ? err.detail ?? err.title : 'Ошибка'}`),
  });

  const resumeMutation = useMutation({
    mutationFn: async (id: string) => api<BroadcastItem>(`/api/v1/broadcasts/${id}/resume`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Рассылка возобновлена');
      invalidate();
    },
    onError: (err) => toast.error(`Ошибка: ${err instanceof ApiError ? err.detail ?? err.title : 'Ошибка'}`),
  });

  // Терминальная отмена: будущие запуски прекращаются, очередь снимается
  const cancelMutation = useMutation({
    mutationFn: async (id: string) => api<BroadcastItem>(`/api/v1/broadcasts/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Рассылка отменена; запланированные сообщения отправлены не будут');
      setCancelTarget(null);
      invalidate();
    },
    onError: (err) => {
      toast.error(`Ошибка: ${err instanceof ApiError ? err.detail ?? err.title : 'Не удалось отменить'}`);
      setCancelTarget(null);
    },
  });

  // Удаление: карточка и история запусков исчезают из панели, очередь снимается,
  // отправленные SMS остаются в логе (с именем рассылки).
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api<void>(`/api/v1/broadcasts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Рассылка удалена; запланированные сообщения отменены');
      setDeleteTarget(null);
      invalidate();
    },
    onError: (err) => {
      toast.error(`Ошибка: ${err instanceof ApiError ? err.detail ?? err.title : 'Не удалось удалить'}`);
      setDeleteTarget(null);
    },
  });

  const items = data?.items ?? [];
  // Доступность главной кнопки: «Запустить» — для ACTIVE/PAUSED, «Перезапустить» — для DONE.
  const canRun = (b: BroadcastItem): boolean =>
    canWrite && (b.status === 'ACTIVE' || b.status === 'PAUSED');
  const canRestart = (b: BroadcastItem): boolean => canWrite && b.status === 'DONE';

  return (
    <div className="space-y-4">
      {/* --- Шапка: описание домена + кнопка «Создать рассылку» --- */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
          Массовые SMS по сегментам: разовые и регулярные («каждый понедельник в 10:00»).
          Время — по местному поясу каждого клиента, тихие часы уважаются, отписавшиеся
          исключаются комплаенсом при отправке.
        </p>
        <ViewerGuard>
          <Button
            className="shrink-0"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-4" aria-hidden />
            Создать рассылку
          </Button>
        </ViewerGuard>
      </div>

      {isPending ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="Рассылок пока нет"
          action={
            <ViewerGuard>
              <Button variant="outline" size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }}>
                <Plus className="size-4" aria-hidden />
                Создать первую рассылку
              </Button>
            </ViewerGuard>
          }
        />
      ) : (
        // --- Сетка карточек рассылок ---
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {items.map((b) => {
            // Бейджи вида/статуса — из общих META-справочников shared.tsx;
            // lr — последний запуск (для мини-итога ниже).
            const kindMeta = BROADCAST_KIND_META[b.kind];
            const statusMeta = BROADCAST_STATUS_META[b.status];
            const lr = b.lastRun;
            return (
              <Card key={b.id} className="flex min-w-0 flex-col shadow-sm">
                <CardContent className="flex min-w-0 flex-1 flex-col gap-3 p-4">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 break-words font-semibold text-foreground" title={b.name}>
                        {b.name}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <Badge variant="outline" className={kindMeta.badge}>
                          {kindMeta.label}
                        </Badge>
                        <Badge variant="outline" className={statusMeta.badge}>
                          {statusMeta.label}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  {b.description ? (
                    <p className="line-clamp-2 break-words text-xs text-zinc-500 dark:text-zinc-400" title={b.description}>
                      {b.description}
                    </p>
                  ) : null}

                  <div className="space-y-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    <p className="flex min-w-0 items-center gap-1.5">
                      <Filter className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                      <span className="truncate" title={b.segmentName ?? undefined}>
                        {b.segmentName ?? 'Сегмент удалён'}
                      </span>
                    </p>
                    <p className="flex min-w-0 items-center gap-1.5">
                      <MessageSquareText className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                      <span className="truncate" title={b.templateName ?? undefined}>
                        {b.templateName ?? 'Шаблон удалён'}
                      </span>
                    </p>
                    <p className="flex min-w-0 items-center gap-1.5">
                      <CalendarClock className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                      <span className="truncate">{scheduleText(b)}</span>
                    </p>
                    <p className="flex min-w-0 items-center gap-1.5">
                      <ShieldCheck className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                      <span className="truncate">
                        Не чаще 1 раза в {b.minDaysBetween} дн. · лимит {b.maxRecipients}/запуск
                      </span>
                    </p>
                  </div>

                  {b.status === 'ACTIVE' && b.nextRunAt ? (
                    <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      Следующий запуск: {fmtDT(b.nextRunAt)}
                    </p>
                  ) : null}

                  {/* Мини-итог последнего запуска — та же воронка отбора, что и в
                      RunsDialog; полный разбор — по кнопке «Запуски» ниже. */}
                  {lr ? (
                    <div className="space-y-1.5 rounded-md bg-muted p-2.5">
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Последний запуск {fmtDT(lr.startedAt)}: подходящих {lr.planned}, сообщений{' '}
                        {lr.recipients}
                        {lr.skippedGuard > 0 ? `, по интервалу пропущено ${lr.skippedGuard}` : ''}
                        {lr.cappedBy > 0 ? `, лимитом отброшено ${lr.cappedBy}` : ''}
                      </p>
                      <div className="flex min-w-0 flex-wrap gap-1">
                        {runStatsChips(lr.stats)
                          .filter((c) => c.value > 0)
                          .map((c) => (
                            <Badge
                              key={c.label}
                              variant="outline"
                              className={`max-w-full min-w-0 border-border bg-card font-normal ${c.className ?? 'text-zinc-600 dark:text-zinc-400'}`}
                            >
                              {c.value} {c.label}
                            </Badge>
                          ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                    <Button variant="outline" size="sm" onClick={() => setRunsTarget(b)}>
                      <CalendarClock className="size-4" aria-hidden />
                      Запуски
                    </Button>
                    {/* Главная кнопка меняет смысл по статусу: DONE → «Перезапустить»
                        (POST /restart — новый запуск в историю, защиты работают),
                        иначе → «Запустить» (POST /run — вне расписания). */}
                    <ViewerGuard>
                      <Button
                        size="sm"
                        disabled={
                          (!canRun(b) && !canRestart(b)) ||
                          runNowMutation.isPending ||
                          restartMutation.isPending
                        }
                        onClick={() =>
                          b.status === 'DONE'
                            ? void restartMutation.mutate(b.id)
                            : void runNowMutation.mutate(b.id)
                        }
                        title={
                          b.status === 'DONE'
                            ? 'Повторить запуск: новый запуск в истории; получавшие недавно пропускаются'
                            : canRun(b)
                              ? 'Запустить прямо сейчас'
                              : 'Недоступно для этого статуса'
                        }
                      >
                        <Play className="size-4" aria-hidden />
                        {b.status === 'DONE' ? 'Перезапустить' : 'Запустить'}
                      </Button>
                    </ViewerGuard>
                    <div className="ml-auto flex gap-1">
                      {/* Пауза (ACTIVE) / возобновление (PAUSED) — одна кнопка:
                          иконка и подпись меняются по статусу. */}
                      <ViewerGuard>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={b.status === 'ACTIVE' ? `Поставить на паузу ${b.name}` : `Возобновить ${b.name}`}
                          disabled={
                            !(
                              (b.status === 'ACTIVE' && !pauseMutation.isPending) ||
                              (b.status === 'PAUSED' && !resumeMutation.isPending)
                            )
                          }
                          onClick={() => {
                            if (b.status === 'ACTIVE') void pauseMutation.mutate(b.id);
                            else void resumeMutation.mutate(b.id);
                          }}
                        >
                          {b.status === 'PAUSED' ? (
                            <Play className="size-4" aria-hidden />
                          ) : (
                            <Pause className="size-4" aria-hidden />
                          )}
                        </Button>
                      </ViewerGuard>
                      <ViewerGuard>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-400"
                          aria-label={`Отменить ${b.name}`}
                          title="Отменить рассылку (необратимо)"
                          disabled={
                            !((b.status === 'ACTIVE' || b.status === 'PAUSED') && !cancelMutation.isPending)
                          }
                          onClick={() => setCancelTarget(b)}
                        >
                          <Ban className="size-4" aria-hidden />
                        </Button>
                      </ViewerGuard>
                      <ViewerGuard>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Редактировать ${b.name}`}
                          disabled={b.status === 'CANCELLED'}
                          onClick={() => {
                            setEditing(b);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="size-4" aria-hidden />
                        </Button>
                      </ViewerGuard>
                      <ViewerGuard>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-red-600 dark:text-red-400 hover:text-red-700 dark:text-red-400"
                          aria-label={`Удалить ${b.name}`}
                          title="Удалить рассылку"
                          onClick={() => setDeleteTarget(b)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </ViewerGuard>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* --- Модалки: редактор, история запусков, подтверждения удаления/отмены --- */}
      <BroadcastDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        broadcast={editing}
        segments={segmentsQuery.data?.items ?? []}
        templates={templatesQuery.data?.items ?? []}
      />

      <RunsDialog broadcast={runsTarget} onOpenChange={(open) => !open && setRunsTarget(null)} />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить рассылку «{deleteTarget?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Рассылка и её запуски удаляются из панели. Очередь снимается; отправленные SMS
              остаются в логе (с именем рассылки).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              // анти-двойной клик: блокируем кнопку, пока идёт запрос
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && void deleteMutation.mutate(deleteTarget.id)}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cancelTarget !== null} onOpenChange={(o) => !o && setCancelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отменить рассылку «{cancelTarget?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Отменить рассылку? Запланированные, но не отправленные сообщения отправлены не будут.
              Действие необратимо; карточка и история запусков останутся в панели.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Оставить</AlertDialogCancel>
            <AlertDialogAction
              className="bg-orange-600 hover:bg-orange-700"
              // анти-двойной клик: блокируем кнопку, пока идёт запрос
              disabled={cancelMutation.isPending}
              onClick={() => cancelTarget && void cancelMutation.mutate(cancelTarget.id)}
            >
              Отменить рассылку
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
