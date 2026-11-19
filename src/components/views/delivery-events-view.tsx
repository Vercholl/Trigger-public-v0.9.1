'use client';

// «События доставки»: журнал событий отправок/доставок/недоставок/кликов/
// отписок со всех источников (панель, шлюзы SMS.Tech и Т2, внешний захват)
// + статистика доставляемости. Сырой payload каждого события — в диалоге
// подробностей.
// API: GET /api/v1/message-events (пагинация + фильтры type/source/period/q;
// ответ содержит агрегаты stats). Роли: любая аутентифицированная,
// автообновление 15с.
import * as React from 'react';
import { Activity, Clock, Inbox, Search, TrendingUp } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
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
import { api } from '@/lib/api-client';
import { useDebounced } from '@/lib/hooks/use-debounced';
import {
  EmptyState,
  ErrorState,
  fmtDT,
  SmsBadge,
  TablePagination,
  type Paged,
  type SmsStatus,
} from '@/components/views/shared';

/* ---------- Типы ---------- */

/** Запись журнала message_events: нормализованные поля + маппинг внешнего
 *  события (campaignName/personId/undeliv*) + сырой payload источника. */
interface MessageEventItem {
  id: string;
  source: string;
  eventType: string;
  eventDate: string;
  receivedAt: string;
  phone: string | null;
  provider: string | null;
  smsMessageId: string | null;
  smsStatus: string | null;
  smsBody: string | null;
  broadcastName: string | null;
  templateName: string | null;
  // Поля внешнего события (маппинг external_message)
  campaignName: string | null;
  messageSender: string | null;
  personId: string | null;
  undelivCode: string | null;
  undelivMessage: string | null;
  clientId: string | null;
  clientExternalId: string | null;
  clientName: string | null;
  status: string;
  result: string | null;
  externalIds: string | null;
  payload: string;
}

/** Агрегаты из того же ответа: объём журнала, разбивки по типам/источникам,
 *  доставляемость за 30 дней (null — нет отправок). */
interface DeliveryStats {
  total: number;
  last24h: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  lastEventAt: string | null;
  delivery: {
    sent30: number;
    delivered30: number;
    failed30: number;
    inFlight30: number;
    deliverability: number | null;
  };
}

/** Ответ /message-events: постраничный список + блок stats одним запросом. */
interface EventsResponse extends Paged<MessageEventItem> {
  stats: DeliveryStats;
}

/* ---------- Метаданные событий ---------- */

/** Метаданные типов событий (eventType внешнего потока): подпись + цвета Badge. */
const TYPE_META: Record<string, { label: string; className: string }> = {
  send_sms: { label: 'Отправлено', className: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-400' },
  deliv_sms: { label: 'Доставлено', className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400' },
  undeliv_sms: { label: 'Не доставлено', className: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-400' },
  click_sms: { label: 'Клик', className: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-400' },
  uclick_sms: { label: 'Уник. клик', className: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-400' },
  unsub_sms: { label: 'Отписка', className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-400' },
  update: { label: 'Обновление', className: 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400' },
};

/** Подписи источников: где событие родилось (панель / шлюз / внешний захват). */
const SOURCE_LABELS: Record<string, string> = {
  panel: 'Панель',
  smstech: 'SMS.Tech',
  t2: 'Т2',
  mts: 'МТС',
  external: 'Захват (внешн.)',
};

/** Badge типа события; неизвестный eventType показывается «как есть». */
function TypeBadge({ type }: { type: string }) {
  const meta = TYPE_META[type];
  if (!meta) {
    return <Badge variant="outline">{type}</Badge>;
  }
  return <Badge variant="outline" className={meta.className}>{meta.label}</Badge>;
}

/** Источник: «внешний захват» — второстепенный Badge, остальные — текст. */
function SourceBadge({ source }: { source: string }) {
  const label = SOURCE_LABELS[source] ?? source;
  if (source === 'external') {
    return <Badge variant="secondary" className="font-normal">{label}</Badge>;
  }
  return <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>;
}

/** JSON.parse для pretty-вывода; не-JSON (битая строка) — как есть. */
function parseJson(raw: string | null): unknown {
  if (raw === null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/* ---------- Компонент ---------- */

/** Экран «События доставки»: 4 KPI-карточки статистики → фильтры → журнал
 *  (клик по строке — диалог с сырым payload). */
export function DeliveryEventsView() {
  // Фильтры ('ALL'/'0' = «не задан»); смена любого — сброс на страницу 1.
  const [type, setType] = React.useState('ALL');
  const [source, setSource] = React.useState('ALL');
  const [period, setPeriod] = React.useState('0');
  const [searchInput, setSearchInput] = React.useState('');
  const search = useDebounced(searchInput, 400);
  const [page, setPage] = React.useState(1);
  const [detail, setDetail] = React.useState<MessageEventItem | null>(null);
  const pageSize = 25;

  React.useEffect(() => {
    setPage(1);
  }, [search, type, source, period]);

  // query-string запроса из фильтров (q — поиск по телефону).
  const params = React.useMemo(() => {
    const p = new URLSearchParams();
    if (type !== 'ALL') p.set('type', type);
    if (source !== 'ALL') p.set('source', source);
    if (period !== '0') p.set('period', period);
    if (search.trim().length > 0) p.set('q', search.trim());
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    return p.toString();
  }, [type, source, period, search, page]);

  // Автообновление 15с: события приходят из шлюзов асинхронно.
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['message-events', params],
    queryFn: () => api<EventsResponse>(`/api/v1/message-events?${params}`),
    refetchInterval: 15_000,
  });

  // Блок агрегатов приходит вместе со списком (одним запросом).
  const stats = data?.stats;

  return (
    <div className="space-y-6">
      {/* Статистика */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>
              <Inbox className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Событий в журнале</p>
              {isPending ? (
                <Skeleton className="mt-1 h-6 w-16" />
              ) : (
                <p className="truncate text-xl font-semibold tabular-nums">
                  {(stats?.total ?? 0).toLocaleString('ru-RU')}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    +{(stats?.last24h ?? 0).toLocaleString('ru-RU')} за 24 ч
                  </span>
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-600/10 text-emerald-600 dark:text-emerald-400" aria-hidden>
              <TrendingUp className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Доставляемость (30 дней)</p>
              {isPending ? (
                <Skeleton className="mt-1 h-6 w-20" />
              ) : (
                <p className="truncate text-xl font-semibold tabular-nums">
                  {stats?.delivery.deliverability !== null && stats?.delivery.deliverability !== undefined
                    ? `${stats.delivery.deliverability}%`
                    : '—'}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {stats?.delivery.delivered30 ?? 0} из {stats?.delivery.sent30 ?? 0}
                  </span>
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400" aria-hidden>
              <Activity className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Не доставлено / в полёте</p>
              {isPending ? (
                <Skeleton className="mt-1 h-6 w-24" />
              ) : (
                <p className="truncate text-xl font-semibold tabular-nums">
                  <span className="text-rose-600 dark:text-rose-400">{stats?.delivery.failed30 ?? 0}</span>
                  <span className="mx-1 text-muted-foreground">/</span>
                  <span className="text-amber-600 dark:text-amber-400">{stats?.delivery.inFlight30 ?? 0}</span>
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-zinc-500/10 text-zinc-500 dark:text-zinc-400" aria-hidden>
              <Clock className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Последнее событие</p>
              {isPending ? (
                <Skeleton className="mt-1 h-6 w-32" />
              ) : (
                <p className="truncate text-sm font-medium tabular-nums">
                  {stats?.lastEventAt ? fmtDT(stats.lastEventAt) : '—'}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Фильтры */}
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="ev-type">Тип события</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="ev-type" aria-label="Тип события">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Все типы</SelectItem>
                <SelectItem value="send_sms">Отправлено</SelectItem>
                <SelectItem value="deliv_sms">Доставлено</SelectItem>
                <SelectItem value="undeliv_sms">Не доставлено</SelectItem>
                <SelectItem value="click_sms">Клики</SelectItem>
                <SelectItem value="uclick_sms">Уник. клики</SelectItem>
                <SelectItem value="unsub_sms">Отписки</SelectItem>
                <SelectItem value="update">Обновления</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-source">Источник</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger id="ev-source" aria-label="Источник события">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Все источники</SelectItem>
                <SelectItem value="panel">Панель</SelectItem>
                <SelectItem value="smstech">SMS.Tech</SelectItem>
                <SelectItem value="t2">Т2</SelectItem>
                <SelectItem value="external">Захват (внешние)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-period">Период</Label>
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger id="ev-period" aria-label="Период">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Всё время</SelectItem>
                <SelectItem value="1">24 часа</SelectItem>
                <SelectItem value="7">7 дней</SelectItem>
                <SelectItem value="30">30 дней</SelectItem>
                <SelectItem value="90">90 дней</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ev-search">Телефон</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id="ev-search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Поиск по номеру…"
                className="pl-8"
              />
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Обновить
        </Button>
      </div>

      {/* Журнал */}
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="Событий пока нет — отправьте SMS или нажмите «Отправить тестовое событие» в «Интеграциях»"
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="max-h-[65vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead>Дата события</TableHead>
                    <TableHead>Тип</TableHead>
                    <TableHead>Источник</TableHead>
                    <TableHead>Телефон</TableHead>
                    <TableHead className="hidden lg:table-cell">Клиент</TableHead>
                    <TableHead className="hidden xl:table-cell">SMS</TableHead>
                    <TableHead>Обработка</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((ev) => (
                    <TableRow
                      key={ev.id}
                      className="cursor-pointer"
                      onClick={() => setDetail(ev)}
                    >
                      <TableCell
                        className="whitespace-nowrap font-mono text-xs tabular-nums"
                        title={`Принято панелью: ${fmtDT(ev.receivedAt)}`}
                      >
                        {fmtDT(ev.eventDate)}
                      </TableCell>
                      <TableCell>
                        <TypeBadge type={ev.eventType} />
                      </TableCell>
                      <TableCell>
                        <SourceBadge source={ev.source} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {ev.phone ?? '—'}
                      </TableCell>
                      <TableCell className="hidden max-w-40 truncate text-xs lg:table-cell">
                        {ev.clientName ?? (ev.clientExternalId ? `ID ${ev.clientExternalId}` : '—')}
                      </TableCell>
                      {/* SMS-лог: связанное сообщение панели или «внешнее» (событие без нашего SMS) */}
                      <TableCell className="hidden xl:table-cell">
                        {ev.smsMessageId ? (
                          <span className="inline-flex items-center gap-1.5">
                            {ev.smsStatus ? <SmsBadge status={ev.smsStatus as SmsStatus} /> : null}
                            {ev.broadcastName ? (
                              <span className="max-w-32 truncate text-xs text-muted-foreground" title={ev.broadcastName}>
                                {ev.broadcastName}
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <Badge variant="outline" className="border-dashed text-muted-foreground">
                              внешнее
                            </Badge>
                            {ev.campaignName ? (
                              <span className="max-w-32 truncate text-xs text-muted-foreground" title={ev.campaignName}>
                                {ev.campaignName}
                              </span>
                            ) : null}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {ev.status === 'PROCESSED' ? 'обработано' : ev.status === 'IGNORED' ? 'игнор' : ev.status}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {data && data.total > pageSize ? (
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={data.total}
          onPage={setPage}
        />
      ) : null}

      {/* Диалог подробностей */}
      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  <TypeBadge type={detail.eventType} />
                  <SourceBadge source={detail.source} />
                  <span className="font-mono text-sm font-normal text-muted-foreground">
                    {fmtDT(detail.eventDate)}
                  </span>
                </DialogTitle>
                <DialogDescription>
                  Событие захвата доставки{detail.phone ? ` · ${detail.phone}` : ''}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 text-sm">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Принято</p>
                    <p className="font-mono text-xs tabular-nums">{fmtDT(detail.receivedAt)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Канал</p>
                    <p>{detail.provider ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Клиент</p>
                    <p className="truncate">
                      {detail.clientName ?? (detail.clientExternalId ? `ID ${detail.clientExternalId}` : '—')}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Клиент ядра (person_id)</p>
                    <p className="truncate font-mono text-xs">{detail.personId ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">SMS-лог</p>
                    <p className="flex items-center gap-1.5">
                      {detail.smsMessageId ? (
                        detail.smsStatus ? <SmsBadge status={detail.smsStatus as SmsStatus} /> : detail.smsMessageId.slice(0, 8)
                      ) : (
                        'внешнее сообщение'
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Отправитель</p>
                    <p className="truncate">{detail.messageSender ?? '—'}</p>
                  </div>
                </div>
                {detail.campaignName || detail.templateName ? (
                  <div>
                    <p className="text-xs text-muted-foreground">Кампания · шаблон</p>
                    <p className="text-xs">
                      {[detail.campaignName ?? detail.broadcastName, detail.templateName].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                ) : null}
                {detail.undelivCode !== null || detail.undelivMessage !== null ? (
                  <div>
                    <p className="text-xs text-muted-foreground">Причина недоставки</p>
                    <p className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300">
                      {detail.undelivCode !== null ? `Код ${detail.undelivCode}` : ''}
                      {detail.undelivCode !== null && detail.undelivMessage ? ' — ' : ''}
                      {detail.undelivMessage ?? ''}
                    </p>
                  </div>
                ) : null}
                {detail.smsBody ? (
                  <div>
                    <p className="text-xs text-muted-foreground">Текст SMS</p>
                    <p className="rounded-md bg-muted p-2 text-xs">{detail.smsBody}</p>
                  </div>
                ) : null}
                {/* Итог обработки воркером и сырой payload — отладка интеграций */}
                <div>
                  <p className="text-xs text-muted-foreground">Итог обработки</p>
                  <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs">
                    {JSON.stringify(parseJson(detail.result), null, 2)}
                  </pre>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Сырой payload источника</p>
                  <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
                    {JSON.stringify(parseJson(detail.payload), null, 2)}
                  </pre>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
