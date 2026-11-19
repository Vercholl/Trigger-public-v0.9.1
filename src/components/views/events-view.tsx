'use client';

// Вью «События»: три вкладки — ручная отправка события (dev-инструмент до
// интеграции с системой данных), журнал входящих событий (с «радаром» неизвестных
// полей client_card — доработки ядра вне нашей схемы) и экземпляры воронок
// с таймлайном (шторка справа).
// Домен: триггерные цепочки. API: POST /api/v1/events/test, GET /api/v1/events,
// POST /api/v1/events/{id}/retry, GET /api/v1/events/unknown-fields (радар),
// DELETE /api/v1/events/unknown-fields/{fieldName} (ADMIN), GET /api/v1/instances,
// GET /api/v1/instances/{id}, POST /api/v1/instances/{id}/cancel,
// GET /api/v1/clients.
// Роли: чтение — любая; отправка/ретрай/отмена — MANAGER+ (ViewerGuard/canWrite);
// удаление наблюдений радара — ADMIN.
import * as React from 'react';
import {
  AlarmClock,
  AlertTriangle,
  BellRing,
  CheckCircle2,
  ChevronRight,
  Flag,
  Info,
  Loader2,
  Play,
  MessageSquare,
  Plus,
  Radar,
  RotateCcw,
  Search,
  ShieldX,
  X,
  XCircle,
  Zap,
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
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { useDebounced } from '@/lib/hooks/use-debounced';
import {
  invalidatePanel,
  clientFullName,
  EmptyState,
  ErrorState,
  EventBadge,
  EVENT_META,
  EVENT_STATUS_META,
  EventStatusBadge,
  fmtDT,
  INSTANCE_STATUS_META,
  InstanceBadge,
  relTime,
  REJECT_REASON_TEXT,
  SmsBadge,
  TablePagination,
  useRole,
  ViewerGuard,
  type ClientItem,
  type CustomFieldItem,
  type EventItem,
  type EventStatus,
  type EventType,
  type InstanceEventItem,
  type InstanceItem,
  type InstanceStatus,
  type Paged,
  type SmsMessage,
  type UnknownFieldItem,
} from '@/components/views/shared';

/* ============================ Вкладка 1: ручная отправка ============================ */

/** Вкладка 1 «Отправить событие»: имитация вебхука системы данных — выбор типа,
 *  клиента, payload и необязательной карточки; POST /api/v1/events/test → eventId. */
function SendEventTab({ onGoToInstances }: { onGoToInstances: () => void }) {
  const queryClient = useQueryClient();
  const [event, setEvent] = React.useState<EventType>('LOAN_OVERDUE');
  const [externalId, setExternalId] = React.useState('');
  const [payload, setPayload] = React.useState(EVENT_META.LOAN_OVERDUE.payloadExample);
  const [jsonError, setJsonError] = React.useState<string | null>(null);
  const [clientCard, setClientCard] = React.useState(EVENT_META.LOAN_OVERDUE.cardExample ?? '');
  const [cardError, setCardError] = React.useState<string | null>(null);
  const [lastEventId, setLastEventId] = React.useState<string | null>(null);

  // Список клиентов для селектора (externalId — ключ события): СЕРВЕРНЫЙ поиск —
  // без него селектор показывал только свежайшие 100 клиентов базы, клиента
  // из старой выгрузки нельзя было выбрать вовсе (dev-инструмент «отправить
  // событие» для него не работал). Дебаунс — как везде в панели.
  const [clientSearchInput, setClientSearchInput] = React.useState('');
  const clientSearch = useDebounced(clientSearchInput, 400);
  const clientsQuery = useQuery({
    queryKey: ['clients', 'for-events', clientSearch],
    queryFn: () =>
      api<Paged<ClientItem>>(
        `/api/v1/clients?pageSize=50${
          clientSearch.trim() ? `&search=${encodeURIComponent(clientSearch.trim())}` : ''
        }`,
      ),
  });
  const clients = clientsQuery.data?.items ?? [];

  // Отправка тестового события: payload и необязательная client_card парсятся
  // прямо здесь (валидация JSON — в onChange-обработчиках ниже).
  const sendMutation = useMutation({
    mutationFn: async () => {
      let payloadObj: Record<string, unknown> = {};
      const trimmed = payload.trim();
      if (trimmed.length > 0) {
        payloadObj = JSON.parse(trimmed) as Record<string, unknown>;
      }
      const body: Record<string, unknown> = {
        event,
        external_id: externalId,
        payload: payloadObj,
      };
      const cardTrimmed = clientCard.trim();
      if (cardTrimmed.length > 0) {
        // Событие с client_card обновит карточку клиента и запустит воронки
        body.client_card = JSON.parse(cardTrimmed) as Record<string, unknown>;
      }
      return api<{ eventId: string }>('/api/v1/events/test', {
        method: 'POST',
        body,
      });
    },
    onSuccess: (res) => {
      setLastEventId(res.eventId);
      toast.success('Событие принято (202). Экземпляр появится в течение ~5 сек');
      // Мгновенное применение: журнал событий, экземпляры, SMS-лог и дашборд
      // обновятся сразу (воркер допишет результаты в течение секунд).
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail =
        err instanceof ApiError
          ? err.detail ?? err.title
          : err instanceof Error
            ? err.message
            : 'Не удалось отправить событие';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  /** Живая валидация payload: JSON-объект или пусто (иначе кнопка отправки заблокирована). */
  function onPayloadChange(v: string) {
    setPayload(v);
    if (v.trim().length === 0) {
      setJsonError(null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('Payload должен быть JSON-объектом');
      } else {
        setJsonError(null);
      }
    } catch {
      setJsonError('Некорректный JSON');
    }
  }

  /** Живая валидация карточки клиента: JSON-объект или пусто. */
  function onCardChange(v: string) {
    setClientCard(v);
    if (v.trim().length === 0) {
      setCardError(null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setCardError('Карточка должна быть JSON-объектом');
      } else {
        setCardError(null);
      }
    } catch {
      setCardError('Некорректный JSON');
    }
  }

  return (
    <Card className="shadow-sm">
      <CardContent className="space-y-4 p-4 md:p-6">
        <Alert className="border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-800">
          <AlertTitle className="text-xs">Ручная отправка — dev-инструмент</AlertTitle>
          <AlertDescription className="text-xs">
            Ручная отправка — dev-инструмент до интеграции с системой данных. Для боевого приёма
            используйте <code className="rounded bg-card/60 px-1 font-mono">POST /api/v1/events</code>{' '}
            с заголовком <code className="rounded bg-card/60 px-1 font-mono">X-Api-Key</code> (см.
            README)
          </AlertDescription>
        </Alert>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Событие</Label>
            <Select
              value={event}
              onValueChange={(v) => {
                const ev = v as EventType;
                setEvent(ev);
                setPayload(EVENT_META[ev].payloadExample);
                setClientCard(EVENT_META[ev].cardExample ?? '');
                setCardError(null);
              }}
            >
              <SelectTrigger className="w-full" aria-label="Тип события">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(EVENT_META) as EventType[]).map((ev) => (
                  <SelectItem key={ev} value={ev}>
                    {EVENT_META[ev].label} ({ev})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{EVENT_META[event].payloadHint}</p>
          </div>

          <div className="space-y-1.5">
            <Label>Клиент</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400" aria-hidden />
              <Input
                value={clientSearchInput}
                onChange={(e) => setClientSearchInput(e.target.value)}
                placeholder="Поиск: externalId, ФИО, телефон…"
                className="mb-2 pl-9"
                aria-label="Поиск клиента для события"
              />
            </div>
            <Select value={externalId} onValueChange={setExternalId}>
              <SelectTrigger className="w-full" aria-label="Клиент">
                <SelectValue placeholder={clientsQuery.isPending ? 'Загрузка…' : 'Выберите клиента'} />
              </SelectTrigger>
              <SelectContent>
                {clients.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {clientSearch.trim()
                      ? 'Ничего не найдено — уточните поиск (externalId, ФИО или телефон)'
                      : 'Клиентов нет — добавьте в разделе «Клиенты»'}
                  </div>
                ) : (
                  clients.map((c) => {
                    // ФИО из карточки клиента (фолбэк — легаси data.name)
                    const cardName = clientFullName(c);
                    const displayName =
                      cardName !== c.externalId
                        ? cardName
                        : typeof c.data?.name === 'string' && c.data.name
                          ? c.data.name
                          : 'без имени';
                    return (
                      <SelectItem key={c.id} value={c.externalId}>
                        {c.externalId} · {displayName} · {c.phone}
                      </SelectItem>
                    );
                  })
                )}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ev-payload">Payload (JSON)</Label>
          <Textarea
            id="ev-payload"
            className="font-mono text-sm"
            rows={4}
            value={payload}
            onChange={(e) => onPayloadChange(e.target.value)}
          />
          {jsonError ? <p className="text-xs text-red-600 dark:text-red-400">{jsonError}</p> : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ev-card">Карточка клиента (JSON, необязательно)</Label>
          <Textarea
            id="ev-card"
            className="font-mono text-sm"
            rows={5}
            value={clientCard}
            onChange={(e) => onCardChange(e.target.value)}
            placeholder='{"client_first_name": "Иван", "phone": "+79001234567", "agreement_actual_status": 16}'
          />
          {cardError ? <p className="text-xs text-red-600 dark:text-red-400">{cardError}</p> : null}
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Поля карточки клиента (client_first_name, loan_amount, person_offer_*…). Событие
            сперва обновит/создаст карточку клиента, затем запустит воронки.
          </p>
        </div>

        {lastEventId ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
            <span>Событие отправлено. Наблюдайте за экземпляром воронки:</span>
            <Button variant="link" size="sm" className="h-auto p-0 text-emerald-700 dark:text-emerald-400" onClick={onGoToInstances}>
              Перейти к экземплярам
            </Button>
          </div>
        ) : null}

        <div className="flex justify-end">
          <ViewerGuard>
            <Button
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={
                externalId.length === 0 || jsonError !== null || cardError !== null || sendMutation.isPending
              }
              onClick={() => sendMutation.mutate()}
            >
              {sendMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Zap className="size-4" aria-hidden />
              )}
              Отправить событие
            </Button>
          </ViewerGuard>
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================ Вкладка 2: журнал ============================ */

/** Тултип статуса: итог обработки — result приходит из API JSON-объектом
 *  (флаги карточки, экземпляры, причины пропуска), для атрибута title
 *  приводим к компактной строке целиком. */
function resultTitle(result: EventItem['result']): string | undefined {
  if (result === null || result === undefined) return undefined;
  return JSON.stringify(result);
}

/** «Радар» доработок ядра — сводка наблюдений: поля client_card вне схемы
 *  карточки. Светится, только когда есть что показать; onDismiss (удаление
 *  наблюдения) и onCreateField (создать кастомное поле с этим ключом —
 *  дальше ядро сможет передавать значение в client_card) доступны только
 *  ADMIN — у остальных чипы без действий. */
function UnknownFieldsAlert({ items, onDismiss, dismissing, onCreateField, creating }: {
  items: UnknownFieldItem[];
  onDismiss?: (fieldName: string) => void;
  dismissing: boolean;
  onCreateField?: (fieldName: string) => void;
  creating: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
      <Radar className="size-4" aria-hidden />
      <AlertTitle>Ядро передаёт поля вне схемы карточки ({items.length})</AlertTitle>
      <AlertDescription className="space-y-2 text-amber-800 dark:text-amber-400">
        <p className="text-xs">
          Эти ключи client_card не входят в схему карточки (единый реестр полей) и
          не сохраняются в клиенте — ядро дорабатывает выгрузку. Оцените: подключить
          поле в реестр или убрать наблюдение из сводки (пока поля нет в схеме,
          радар загорится снова).
        </p>
        <div className="flex flex-wrap gap-1.5">
          {items.map((o) => {
            // Ключ для создания поля: наблюдение «cf_x» → x, сырой ключ — как есть
            const cfKey = o.fieldName.startsWith('cf_') ? o.fieldName.slice(3) : o.fieldName;
            const canCreateField = cfKey.length >= 2 && /^[a-z][a-z0-9_]{1,39}$/.test(cfKey);
            return (
            <span
              key={o.fieldName}
              title={`вне схемы карточки: ×${o.count}, впервые ${fmtDT(o.firstSeenAt)}, последнее ${fmtDT(o.lastSeenAt)}${o.lastEventName ? ` (событие ${o.lastEventName})` : ''}`}
              className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-card/60 px-2.5 py-1 font-mono text-xs text-amber-900 dark:border-amber-800 dark:text-amber-300"
            >
              {o.fieldName}
              <span className="font-sans text-amber-700 dark:text-amber-400/80">×{o.count}</span>
              {onCreateField && canCreateField ? (
                <button
                  type="button"
                  disabled={creating}
                  onClick={() => onCreateField(o.fieldName)}
                  aria-label={`Создать кастомное поле ${cfKey} (переменная {{cf_${cfKey}}})`}
                  title={`Создать кастомное поле ${cfKey}: переменная {{cf_${cfKey}}}, заполнение из client_card и в карточке клиента`}
                  className="text-amber-600 transition-colors hover:text-amber-900 disabled:opacity-50 dark:text-amber-500 dark:hover:text-amber-300"
                >
                  {creating ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Plus className="size-3" aria-hidden />}
                </button>
              ) : null}
              {onDismiss ? (
                <button
                  type="button"
                  disabled={dismissing}
                  onClick={() => onDismiss(o.fieldName)}
                  aria-label={`Убрать наблюдение ${o.fieldName} из сводки`}
                  className="text-amber-600 transition-colors hover:text-amber-900 disabled:opacity-50 dark:text-amber-500 dark:hover:text-amber-300"
                >
                  {dismissing ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <X className="size-3" aria-hidden />}
                </button>
              ) : null}
            </span>
            );
          })}
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** Вкладка 2 «Журнал событий»: таблица входящих событий с фильтром статуса,
 *  автообновление 5с; ретрай упавших — POST /api/v1/events/{id}/retry;
 *  «радар» — сводка неизвестных полей client_card + амбер-пометки в строках. */
function EventsLogTab() {
  const { canWrite, isAdmin } = useRole();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = React.useState('ALL');

  // Последние 50 событий (фильтр статуса; 'ALL' — без параметра).
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['events-log', statusFilter],
    queryFn: () =>
      api<Paged<EventItem>>(
        statusFilter === 'ALL'
          ? '/api/v1/events?pageSize=50'
          : `/api/v1/events?pageSize=50&status=${statusFilter}`,
      ),
    refetchInterval: 5000,
  });

  // «Радар» неизвестных полей: агрегат наблюдений (свежие сверху), 30с опрос.
  const radarQuery = useQuery({
    queryKey: ['unknown-fields'],
    queryFn: () => api<{ items: UnknownFieldItem[] }>('/api/v1/events/unknown-fields'),
    refetchInterval: 30000,
  });

  // Удаление наблюдения — «убрать из сводки» (ADMIN): после подключения поля
  // в реестр или решения игнорировать. Новое наблюдение воссоздаст строку.
  const dismissMutation = useMutation({
    mutationFn: async (fieldName: string) =>
      api<void>(`/api/v1/events/unknown-fields/${encodeURIComponent(fieldName)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      toast.success('Наблюдение убрано из сводки');
      void queryClient.invalidateQueries({ queryKey: ['unknown-fields'] });
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось убрать наблюдение';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Создание кастомного поля прямо из наблюдения (ADMIN): «+» на чипе —
  // ключ без префикса cf_ (наблюдение «cf_x» → x), тип text; сервис заодно
  // поглощает наблюдение (радар гаснет), значение начнёт применяться из
  // client_card со следующего события. Пользовательский кэш — invalidatePanel.
  const createFieldMutation = useMutation({
    mutationFn: async (fieldName: string) => {
      const key = fieldName.startsWith('cf_') ? fieldName.slice(3) : fieldName;
      return api<CustomFieldItem>('/api/v1/custom-fields', {
        method: 'POST',
        body: { key, label: key, type: 'text' },
      });
    },
    onSuccess: (field) => {
      toast.success(`Поле {{${field.varName}}} создано — значения начнут применяться из client_card`);
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось создать поле';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Ретрай упавшего события — сброс в NEW, воркер подхватит в ближайший тик
  const retryMutation = useMutation({
    mutationFn: async (id: string) =>
      api<EventItem>(`/api/v1/events/${id}/retry`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Событие снова в очереди — воркер обработает его в течение нескольких секунд');
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось перезапустить';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  const items = data?.items ?? [];
  const radarItems = radarQuery.data?.items ?? [];

  return (
    <Card className="shadow-sm">
      <CardContent className="space-y-3 p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[170px]" aria-label="Фильтр по статусу события">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Все статусы</SelectItem>
              {Object.entries(EVENT_STATUS_META).map(([value, meta]) => (
                <SelectItem key={value} value={value}>
                  {meta.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Упавшие события можно перезапустить — данные сохранены, воркер обработает их заново
          </p>
        </div>
        {/* «Радар»: сводка по полям вне схемы (пусто — не показываем) */}
        {radarItems.length > 0 ? (
          <div className="px-3 pt-3">
            <UnknownFieldsAlert
              items={radarItems}
              onDismiss={isAdmin ? (fieldName) => dismissMutation.mutate(fieldName) : undefined}
              dismissing={dismissMutation.isPending}
              onCreateField={isAdmin ? (fieldName) => createFieldMutation.mutate(fieldName) : undefined}
              creating={createFieldMutation.isPending}
            />
          </div>
        ) : null}
        {isPending ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : error ? (
          <div className="p-4">
            <ErrorState error={error} onRetry={() => void refetch()} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Zap}
            title={statusFilter === 'ALL' ? 'Событий пока нет' : 'Событий с этим статусом нет'}
          />
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-muted">
                <TableRow>
                  <TableHead>Событие</TableHead>
                  <TableHead>Клиент</TableHead>
                  <TableHead>Статус</TableHead>
                  {/* Мобильный: «Источник» скрыт — таблица не сжимается на 375px */}
                  <TableHead className="hidden md:table-cell">Источник</TableHead>
                  <TableHead className="text-right">Время</TableHead>
                  <TableHead className="w-12" aria-label="Действия" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((e) => (
                  <TableRow key={e.id} className="hover:bg-muted">
                    <TableCell className="py-3">
                      <EventBadge event={e.event} />
                    </TableCell>
                    <TableCell className="py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">{e.externalId}</TableCell>
                    <TableCell className="py-3">
                      <div className="space-y-1">
                        <span title={resultTitle(e.result)}>
                          <EventStatusBadge status={e.status} />
                        </span>
                        {e.status === 'FAILED' && e.error ? (
                          <p
                            className="max-w-[280px] truncate text-xs text-red-600 dark:text-red-400"
                            title={e.error}
                          >
                            {e.error}
                          </p>
                        ) : null}
                        {e.unknownFields && e.unknownFields.length > 0 ? (
                          <p
                            className="max-w-[280px] truncate text-xs text-amber-600 dark:text-amber-400"
                            title={`Поля client_card вне схемы карточки (не сохраняются): ${e.unknownFields.join(', ')}`}
                          >
                            вне схемы: {e.unknownFields.join(', ')}
                          </p>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden py-3 md:table-cell">
                      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                        {e.source === 'API' ? 'API' : 'Панель'}
                      </span>
                    </TableCell>
                    <TableCell className="py-3 text-right text-xs text-zinc-500 dark:text-zinc-400">
                      <span title={fmtDT(e.createdAt)}>{relTime(e.createdAt)}</span>
                    </TableCell>
                    <TableCell className="py-3">
                      {e.status === 'FAILED' && canWrite ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1 px-2 text-emerald-700 dark:text-emerald-400 hover:text-emerald-800 dark:text-emerald-300"
                          disabled={retryMutation.isPending}
                          onClick={() => retryMutation.mutate(e.id)}
                          aria-label="Перезапустить событие"
                        >
                          {retryMutation.isPending ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                          ) : (
                            <RotateCcw className="size-4" aria-hidden />
                          )}
                          <span className="hidden sm:inline">Повторить</span>
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================ Вкладка 3: экземпляры ============================ */

/** Иконка и цвет кружка для каждого типа записи таймлайна (InstanceEventItem.type). */
const TIMELINE_ICON: Record<string, { icon: typeof Flag; className: string }> = {
  STATUS_CHANGE: { icon: Flag, className: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400' },
  NODE_START: { icon: Play, className: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400' },
  NODE_DONE: { icon: CheckCircle2, className: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400' },
  SMS_SENT: { icon: MessageSquare, className: 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400' },
  SMS_REJECTED: { icon: ShieldX, className: 'bg-orange-50 dark:bg-orange-950/60 text-orange-600 dark:text-orange-400' },
  SMS_FAILED: { icon: XCircle, className: 'bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400' },
  ERROR: { icon: AlertTriangle, className: 'bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400' },
  INFO: { icon: Info, className: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400' },
  WAIT_EVENT_RECEIVED: { icon: BellRing, className: 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400' },
  WAIT_EVENT_TIMEOUT: { icon: AlarmClock, className: 'bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400' },
};

/** Ответ GET /api/v1/instances/{id}: экземпляр + воронка + клиент + таймлайн + сообщения. */
interface InstanceDetail {
  instance: InstanceItem;
  funnel: { id: string; name: string };
  client: InstanceItem['client'];
  timeline: InstanceEventItem[];
  messages: SmsMessage[];
}

/** Одна запись таймлайна: кружок-иконка, сообщение, время; для SMS_* записей —
 *  раскрывающаяся деталь сообщения (тело, статус, причина отказа). */
function TimelineItem({
  item,
  isLast,
  sms,
}: {
  item: InstanceEventItem;
  isLast: boolean;
  sms?: SmsMessage;
}) {
  const meta = TIMELINE_ICON[item.type] ?? TIMELINE_ICON.INFO;
  const Icon = meta.icon;
  const [expanded, setExpanded] = React.useState(false);
  const isSms = item.type === 'SMS_SENT' || item.type === 'SMS_REJECTED' || item.type === 'SMS_FAILED';

  return (
    <li className="relative flex gap-3 pb-4">
      {!isLast ? (
        <div className="absolute bottom-0 left-[15px] top-9 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden />
      ) : null}
      <div
        className={`z-10 flex size-8 shrink-0 items-center justify-center rounded-full ${meta.className}`}
      >
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm text-zinc-800 dark:text-zinc-200">{item.message}</p>
          <span className="shrink-0 text-xs text-zinc-400">{fmtDT(item.createdAt)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          {item.nodeId ? (
            <span className="font-mono text-xs text-zinc-400">{item.nodeId}</span>
          ) : null}
          {isSms ? (
            <button
              type="button"
              className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Свернуть' : 'Подробнее…'}
            </button>
          ) : null}
        </div>
        {expanded && isSms ? (
          sms ? (
            <div className="mt-2 space-y-2">
              <div className="max-w-[420px] rounded-2xl border border-border bg-card p-3 shadow-sm">
                <p className="whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-200">{sms.body}</p>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                <SmsBadge status={sms.status} />
                <span>{sms.segments} сегм</span>
                {sms.rejectReason ? (
                  <span className="text-orange-600 dark:text-orange-400">{REJECT_REASON_TEXT[sms.rejectReason]}</span>
                ) : null}
                {sms.error ? <span className="text-red-600 dark:text-red-400">{sms.error}</span> : null}
              </div>
            </div>
          ) : (
            <div className="mt-2 rounded-2xl border border-border bg-card p-3 shadow-sm">
              <p className="whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-200">{item.message}</p>
              <p className="mt-1 text-xs text-zinc-400">
                Узел: <span className="font-mono">{item.nodeId ?? '—'}</span>
                {item.nodeType ? ` · ${item.nodeType}` : ''}
              </p>
            </div>
          )
        ) : null}
      </div>
    </li>
  );
}

/** Правая шторка экземпляра воронки: статус, ошибка, таймлайн, отправленные SMS;
 *  опрос 5с, пока статус RUNNING/WAITING; отмена — POST /instances/{id}/cancel. */
function InstanceSheet({
  instanceId,
  onClose,
}: {
  instanceId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { canWrite } = useRole();
  const [cancelConfirm, setCancelConfirm] = React.useState(false);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['instance', instanceId],
    queryFn: () => api<InstanceDetail>(`/api/v1/instances/${instanceId}`),
    enabled: instanceId !== null,
    // Опрашивать только «живые» экземпляры; терминальные статусы не обновляются.
    refetchInterval: (query) => {
      const st = query.state.data?.instance.status;
      return st === 'RUNNING' || st === 'WAITING' ? 5000 : false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: string) => api<InstanceItem>(`/api/v1/instances/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Экземпляр отменён');
      setCancelConfirm(false);
      invalidatePanel(queryClient);
      void refetch();
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось отменить экземпляр';
      toast.error(`Ошибка: ${detail}`);
      setCancelConfirm(false);
    },
  });

  const inst = data?.instance;
  const isActive = inst?.status === 'RUNNING' || inst?.status === 'WAITING';

  // SMS_* события таймлайна ↔ отправленные сообщения (точное совпадение по providerMessageId,
  // фолбэк — ближайшее сообщение, созданное не позже события).
  const smsByEvent = React.useMemo(() => {
    const map = new Map<string, SmsMessage>();
    if (!data) return map;
    for (const ev of data.timeline) {
      if (ev.type !== 'SMS_SENT' && ev.type !== 'SMS_REJECTED' && ev.type !== 'SMS_FAILED') continue;
      const pm =
        ev.payload && typeof ev.payload === 'object' && 'providerMessageId' in ev.payload
          ? (ev.payload as { providerMessageId?: unknown }).providerMessageId
          : null;
      if (typeof pm === 'string' && pm.length > 0) {
        const exact = data.messages.find((m) => m.providerMessageId === pm);
        if (exact) {
          map.set(ev.id, exact);
          continue;
        }
      }
      const evT = new Date(ev.createdAt).getTime();
      const candidate = data.messages.find(
        (m) => new Date(m.createdAt).getTime() <= evT + 1000,
      );
      if (candidate) map.set(ev.id, candidate);
    }
    return map;
  }, [data]);

  return (
    <Sheet open={instanceId !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:w-[560px] sm:max-w-none"
      >
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle className="text-base">
            {data?.funnel.name ?? 'Экземпляр воронки'}
            {inst ? <span className="ml-2 text-xs font-normal text-zinc-400">v{inst.funnelVersion}</span> : null}
          </SheetTitle>
          <SheetDescription>
            {inst ? (
              <span className="flex flex-wrap items-center gap-2">
                <InstanceBadge status={inst.status} />
                <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{inst.client.externalId}</span>
                <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{inst.client.phone}</span>
              </span>
            ) : (
              'Загрузка…'
            )}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 p-4">
          {isPending ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : error || !data ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : (
            <>
              {inst?.error ? (
                <Alert variant="destructive">
                  <AlertTitle>Экземпляр завершился с ошибкой</AlertTitle>
                  <AlertDescription>{inst.error}</AlertDescription>
                </Alert>
              ) : null}

              {isActive && canWrite ? (
                <div className="flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => setCancelConfirm(true)}>
                    <XCircle className="size-4 text-red-500 dark:text-red-400" aria-hidden />
                    Отменить экземпляр
                  </Button>
                </div>
              ) : null}

              <section aria-label="Таймлайн экземпляра">
                <h3 className="mb-3 text-sm font-medium text-foreground">Таймлайн</h3>
                {data.timeline.length === 0 ? (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">События пока не записаны</p>
                ) : (
                  <ol>
                    {data.timeline.map((item, i) => (
                      <TimelineItem
                        key={item.id}
                        item={item}
                        isLast={i === data.timeline.length - 1}
                        sms={smsByEvent.get(item.id)}
                      />
                    ))}
                  </ol>
                )}
              </section>

              <section aria-label="Сообщения экземпляра">
                <h3 className="mb-3 text-sm font-medium text-foreground">
                  Сообщения ({data.messages.length})
                </h3>
                {data.messages.length === 0 ? (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">SMS ещё не отправлялись</p>
                ) : (
                  <div className="space-y-2">
                    {data.messages.map((m) => (
                      <div
                        key={m.id}
                        className="rounded-lg border border-border bg-card p-3 shadow-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono text-sm text-zinc-800 dark:text-zinc-200">{m.phone}</span>
                          <SmsBadge status={m.status} />
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-300">
                          {m.body}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                          <span>{m.segments} сегм</span>
                          <span>{fmtDT(m.sentAt ?? m.createdAt)}</span>
                          {m.rejectReason ? (
                            <span className="text-orange-600 dark:text-orange-400">
                              {REJECT_REASON_TEXT[m.rejectReason]}
                            </span>
                          ) : null}
                          {m.error ? <span className="text-red-600 dark:text-red-400">{m.error}</span> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </SheetContent>

      <AlertDialog open={cancelConfirm} onOpenChange={setCancelConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отменить экземпляр воронки?</AlertDialogTitle>
            <AlertDialogDescription>
              Дальнейшие шаги выполняться не будут. Отменить действие нельзя.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              // анти-двойной клик: блокируем кнопку, пока идёт запрос
              disabled={cancelMutation.isPending}
              onClick={() => {
                if (instanceId) cancelMutation.mutate(instanceId);
              }}
            >
              Отменить экземпляр
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

/** Вкладка 3 «Экземпляры воронок»: пагинированная таблица + фильтр статуса;
 *  клик по строке открывает шторку таймлайна (onOpenDetail). */
function InstancesTab({ onOpenDetail }: { onOpenDetail: (id: string) => void }) {
  const queryClient = useQueryClient();
  const { canWrite } = useRole();
  const [status, setStatus] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const [cancelTarget, setCancelTarget] = React.useState<InstanceItem | null>(null);
  const pageSize = 20;

  // Смена фильтра сбрасывает страницу — не показывать пустые страницы.
  React.useEffect(() => {
    setPage(1);
  }, [status]);

  // query-string списка: статус (кроме 'all') + пагинация.
  const params = React.useMemo(() => {
    const p = new URLSearchParams();
    if (status !== 'all') p.set('status', status);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    return p.toString();
  }, [status, page]);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['instances', params],
    queryFn: () => api<Paged<InstanceItem>>(`/api/v1/instances?${params}`),
    // Чаще опрашивать, если на странице есть активные экземпляры.
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((i) => i.status === 'RUNNING' || i.status === 'WAITING') ? 5000 : 15000;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: string) =>
      api<InstanceItem>(`/api/v1/instances/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Экземпляр отменён');
      setCancelTarget(null);
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось отменить экземпляр';
      toast.error(`Ошибка: ${detail}`);
      setCancelTarget(null);
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger size="sm" className="w-[200px]" aria-label="Фильтр статуса экземпляра">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Статус: все</SelectItem>
            {(Object.keys(INSTANCE_STATUS_META) as InstanceStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {INSTANCE_STATUS_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-0">
          {isPending ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : error ? (
            <div className="p-4">
              <ErrorState error={error} onRetry={() => void refetch()} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Zap}
              title={status !== 'all' ? 'Нет экземпляров с этим статусом' : 'Экземпляров пока нет'}
            />
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>Воронка</TableHead>
                    <TableHead>Клиент</TableHead>
                    <TableHead>Статус</TableHead>
                    <TableHead>Текущий узел</TableHead>
                    <TableHead className="hidden lg:table-cell">Ошибка</TableHead>
                    <TableHead className="hidden xl:table-cell">Обновлён</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((i) => (
                    <TableRow key={i.id} className="cursor-pointer hover:bg-muted">
                      <TableCell className="py-3" onClick={() => onOpenDetail(i.id)}>
                        <p className="text-sm font-medium text-foreground">{i.funnelName}</p>
                        <p className="text-xs text-zinc-400">v{i.funnelVersion}</p>
                      </TableCell>
                      <TableCell className="py-3" onClick={() => onOpenDetail(i.id)}>
                        <p className="font-mono text-xs text-zinc-600 dark:text-zinc-400">{i.client.externalId}</p>
                        <p className="font-mono text-xs text-zinc-400">{i.client.phone}</p>
                      </TableCell>
                      <TableCell className="py-3" onClick={() => onOpenDetail(i.id)}>
                        <InstanceBadge status={i.status} />
                      </TableCell>
                      <TableCell className="py-3" onClick={() => onOpenDetail(i.id)}>
                        {i.currentNodeId ? (
                          <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">{i.currentNodeId}</span>
                        ) : (
                          <span className="text-sm text-zinc-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden max-w-[200px] py-3 lg:table-cell">
                        {i.error ? (
                          <p className="truncate text-xs text-red-600 dark:text-red-400" title={i.error}>
                            {i.error}
                          </p>
                        ) : (
                          <span className="text-sm text-zinc-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden py-3 text-xs text-zinc-500 dark:text-zinc-400 xl:table-cell">
                        <span title={fmtDT(i.updatedAt)}>{relTime(i.updatedAt)}</span>
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onOpenDetail(i.id)}
                            aria-label="Таймлайн экземпляра"
                          >
                            <ChevronRight className="size-4" aria-hidden />
                          </Button>
                          {canWrite && (i.status === 'RUNNING' || i.status === 'WAITING') ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-red-500 dark:text-red-400 hover:text-red-600 dark:text-red-400"
                              disabled={cancelMutation.isPending}
                              onClick={() => setCancelTarget(i)}
                              aria-label={`Отменить экземпляр ${i.funnelName}`}
                            >
                              <XCircle className="size-4" aria-hidden />
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
          {data ? (
            <div className="px-4 pb-4">
              <TablePagination page={page} pageSize={pageSize} total={data.total} onPage={setPage} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <AlertDialog
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Отменить экземпляр «{cancelTarget?.funnelName}»?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Клиент {cancelTarget?.client.externalId ?? ''} больше не получит сообщения этой
              воронки. Действие необратимо.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              // анти-двойной клик: блокируем кнопку, пока идёт запрос
              disabled={cancelMutation.isPending}
              onClick={() => {
                if (cancelTarget) cancelMutation.mutate(cancelTarget.id);
              }}
            >
              Отменить экземпляр
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ============================ Корневой компонент ============================ */

/** Корневой экран вкладки «События»: переключение трёх вкладок + шторка экземпляра. */
export function EventsView() {
  const [tab, setTab] = React.useState('send');
  const [detailId, setDetailId] = React.useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        {/* Мобильный: короткие подписи — вкладки не обрезаются на узком экране */}
        <TabsList className="w-full overflow-x-auto sm:w-auto">
          <TabsTrigger value="send" className="flex-1">
            <span className="sm:hidden">Отправить</span>
            <span className="hidden sm:inline">Отправить событие</span>
          </TabsTrigger>
          <TabsTrigger value="log" className="flex-1">
            <span className="sm:hidden">Журнал</span>
            <span className="hidden sm:inline">Журнал событий</span>
          </TabsTrigger>
          <TabsTrigger value="instances" className="flex-1">
            <span className="sm:hidden">Экземпляры</span>
            <span className="hidden sm:inline">Экземпляры воронок</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="send">
          <SendEventTab onGoToInstances={() => setTab('instances')} />
        </TabsContent>
        <TabsContent value="log">
          <EventsLogTab />
        </TabsContent>
        <TabsContent value="instances">
          <InstancesTab onOpenDetail={(id) => setDetailId(id)} />
        </TabsContent>
      </Tabs>

      <InstanceSheet instanceId={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
