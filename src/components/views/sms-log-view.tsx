'use client';

// «Журнал SMS» — таблица всех исходящих сообщений (массовые рассылки и
// триггерные воронки) с фильтрами и карточкой подробностей. Домен: sms-log.
// API: GET /api/v1/sms (пагинация + фильтры status/search/from/to,
// автообновление 15с) и GET /api/v1/sms/export (выгрузка CSV текущей выборки).
// Роли: любая аутентифицированная (раздел только на чтение, VIEWER включён).
import * as React from 'react';
import { Download, Search, Send } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

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
import { api, downloadCsv } from '@/lib/api-client';
import { useDebounced } from '@/lib/hooks/use-debounced';
import {
  EmptyState,
  ErrorState,
  fmtDT,
  PROVIDER_LABELS,
  REJECT_REASON_TEXT,
  SMS_STATUS_META,
  SmsBadge,
  SmsVarsSnapshot,
  TablePagination,
  type Paged,
  type SmsMessage,
  type SmsStatus,
} from '@/components/views/shared';


/** Цена из тарификации шлюза (копейки → ₽ с копейками). */
function fmtPrice(kopecks?: number | null): string {
  if (!kopecks || kopecks <= 0) return '—';
  return `${(kopecks / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ₽`;
}

/** Ячейка «Провайдер»: песочница — серый Badge, боевое имя — подпись из
 *  PROVIDER_LABELS + Badge кода оператора (operatorCode), если шлюз его вернул. */
function providerCell(m: SmsMessage): React.ReactNode {
  if (m.provider === 'sandbox') {
    return (
      <Badge variant="outline" className="border-border bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        песочница
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {PROVIDER_LABELS[m.provider] ?? m.provider}
      </span>
      {m.operatorCode ? (
        <Badge variant="secondary" className="text-[10px]">
          {m.operatorCode}
        </Badge>
      ) : null}
    </span>
  );
}

/** Экран журнала: фильтры → таблица (клик по тексту SMS открывает карточку) →
 *  пагинация. */
export function SmsLogView() {
  // Фильтры; searchInput проходит через debounce, смена любого фильтра
  // сбрасывает страницу на 1.
  const [status, setStatus] = React.useState('all');
  const [searchInput, setSearchInput] = React.useState('');
  const search = useDebounced(searchInput, 400);
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [detail, setDetail] = React.useState<SmsMessage | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const pageSize = 25;

  // Новый фильтр — всегда с первой страницы.
  React.useEffect(() => {
    setPage(1);
  }, [search, status, from, to]);

  // query-string запроса списка из активных фильтров (пустые значения не идут).
  const params = React.useMemo(() => {
    const p = new URLSearchParams();
    if (status !== 'all') p.set('status', status);
    if (search.trim().length > 0) p.set('search', search.trim());
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    return p.toString();
  }, [status, search, from, to, page]);

  // Автообновление 15с: статусы доставки приходят от шлюзов асинхронно.
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['sms', params],
    queryFn: () => api<Paged<SmsMessage>>(`/api/v1/sms?${params}`),
    refetchInterval: 15_000,
  });

  /** Выгрузка CSV той же выборки (те же фильтры, без пагинации — все строки). */
  async function exportCsv() {
    setExporting(true);
    try {
      const p = new URLSearchParams();
      if (status !== 'all') p.set('status', status);
      if (search.trim().length > 0) p.set('search', search.trim());
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      await downloadCsv(`/api/v1/sms/export?${p.toString()}`, 'sms_log.csv');
      toast.success('Экспорт CSV запущен');
    } catch (err) {
      const detailMsg = err instanceof Error ? err.message : 'Ошибка экспорта';
      toast.error(`Ошибка: ${detailMsg}`);
    } finally {
      setExporting(false);
    }
  }

  const items = data?.items ?? [];

  // Свежая версия открытой карточки: автообновление каждые 15 с меняет статусы
  // в таблице — диалог не должен застревать на снапшоте момента клика (в таблице
  // уже «Доставлено», в диалоге — «Отправляется»: расхождение на одном экране).
  const freshDetail = detail !== null ? (items.find((m) => m.id === detail.id) ?? detail) : null;

  return (
    <div className="space-y-4">
      {/* --- Секция: фильтры + экспорт --- */}
      <Card className="shadow-sm">
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:flex-wrap xl:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="sms-status">Статус</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="sms-status" className="w-[190px]" aria-label="Фильтр статуса SMS">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все статусы</SelectItem>
                  {(Object.keys(SMS_STATUS_META) as SmsStatus[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {SMS_STATUS_META[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex-1 space-y-1.5">
              <Label htmlFor="sms-search">Поиск</Label>
              <div className="relative">
                <Search
                  className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400"
                  aria-hidden
                />
                <Input
                  id="sms-search"
                  className="pl-8"
                  placeholder="Телефон или текст сообщения…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sms-from">С</Label>
              <Input
                id="sms-from"
                type="date"
                className="w-[150px]"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sms-to">По</Label>
              <Input
                id="sms-to"
                type="date"
                className="w-[150px]"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>

            <Button variant="outline" onClick={() => void exportCsv()} disabled={exporting}>
              <Download className="size-4" aria-hidden />
              Экспорт CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* --- Таблица журнала --- */}
      <Card className="shadow-sm">
        <CardContent className="p-0">
          {isPending ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : error ? (
            <div className="p-4">
              <ErrorState error={error} onRetry={() => void refetch()} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Send}
              title={search || status !== 'all' || from || to ? 'Сообщений по фильтрам не найдено' : 'SMS ещё не отправлялись'}
            />
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>Время</TableHead>
                    <TableHead>Телефон</TableHead>
                    <TableHead>Текст</TableHead>
                    <TableHead>Сегм</TableHead>
                    <TableHead className="hidden lg:table-cell">Провайдер</TableHead>
                    <TableHead className="hidden lg:table-cell">Шаблон</TableHead>
                    <TableHead>Статус</TableHead>
                    <TableHead className="hidden xl:table-cell">Причина</TableHead>
                    <TableHead className="hidden xl:table-cell">Доставлено</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((m) => (
                    <TableRow key={m.id} className="cursor-pointer hover:bg-muted">
                      <TableCell className="py-3 text-xs text-zinc-500 dark:text-zinc-400">
                        <span title={fmtDT(m.createdAt)}>{fmtDT(m.sentAt ?? m.createdAt)}</span>
                      </TableCell>
                      <TableCell className="py-3 font-mono text-sm text-zinc-700 dark:text-zinc-300">{m.phone}</TableCell>
                      <TableCell className="max-w-lg py-3" onClick={() => setDetail(m)}>
                        <p className="truncate text-sm text-zinc-600 dark:text-zinc-400" title={m.body}>
                          {m.body}
                        </p>
                      </TableCell>
                      <TableCell className="py-3 text-sm text-zinc-600 dark:text-zinc-400">{m.segments}</TableCell>
                      <TableCell className="hidden py-3 lg:table-cell">{providerCell(m)}</TableCell>
                      <TableCell className="hidden max-w-[160px] py-3 lg:table-cell">
                        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{m.templateName ?? '—'}</p>
                      </TableCell>
                      <TableCell className="py-3">
                        <SmsBadge status={m.status} />
                      </TableCell>
                      <TableCell className="hidden py-3 text-xs text-zinc-500 dark:text-zinc-400 xl:table-cell">
                        {m.rejectReason ? REJECT_REASON_TEXT[m.rejectReason] : '—'}
                      </TableCell>
                      <TableCell className="hidden py-3 text-xs text-zinc-500 dark:text-zinc-400 xl:table-cell">
                        {m.deliveredAt ? fmtDT(m.deliveredAt) : '—'}
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

      {/* --- Диалог подробностей SMS (карточка сообщения) --- */}
      <Dialog open={detail !== null} onOpenChange={(open) => (open ? null : setDetail(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-base">{freshDetail?.phone}</DialogTitle>
            <DialogDescription>
              {freshDetail ? (
                <span className="flex flex-wrap items-center gap-2">
                  <SmsBadge status={freshDetail.status} />
                  <span>{freshDetail.segments} сегм</span>
                  <span>· провайдер: {freshDetail.provider === 'sandbox' ? 'песочница' : (PROVIDER_LABELS[freshDetail.provider] ?? freshDetail.provider)}</span>
                  {freshDetail.operatorCode ? <span>· оператор: {freshDetail.operatorCode}</span> : null}
                  {freshDetail.priceKopecks ? <span>· стоимость: {fmtPrice(freshDetail.priceKopecks)}</span> : null}
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          {freshDetail ? (
            <div className="space-y-3">
              <div className="rounded-2xl border border-border bg-muted p-4">
                {/* wrap-anywhere (а не break-words): учитывается в min-content грида —
                    длинные URL-трекеры в тексте SMS не распирают диалог */}
                <p className="whitespace-pre-wrap wrap-anywhere font-mono text-sm text-zinc-800 dark:text-zinc-200">
                  {freshDetail.body}
                </p>
              </div>
              {/* Снимок переменных (P6): что подставилось в момент рендера */}
              <SmsVarsSnapshot vars={freshDetail.varsSnapshot} />
              <div className="space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                {freshDetail.templateName ? <p>Шаблон: {freshDetail.templateName}</p> : null}
                {freshDetail.broadcastName ? <p>Рассылка: {freshDetail.broadcastName}</p> : null}
                {freshDetail.providerMessageId ? (
                  <p className="font-mono">ID провайдера: {freshDetail.providerMessageId}</p>
                ) : null}
                {freshDetail.priceKopecks ? <p>Стоимость (по шлюзу): {fmtPrice(freshDetail.priceKopecks)}</p> : null}
                {freshDetail.rejectReason ? (
                  <p className="text-orange-600 dark:text-orange-400">Причина: {REJECT_REASON_TEXT[freshDetail.rejectReason]}</p>
                ) : null}
                {freshDetail.error ? <p className="text-red-600 dark:text-red-400">Ошибка: {freshDetail.error}</p> : null}
                <p>Создано: {fmtDT(freshDetail.createdAt)}</p>
                <p>Отправлено: {fmtDT(freshDetail.sentAt)}</p>
                <p>Доставлено: {fmtDT(freshDetail.deliveredAt)}</p>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
