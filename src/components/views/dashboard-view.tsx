'use client';

// «Дашборд» — главный экран статистики (домашняя вкладка панели).
// Домен: stats. API: GET /api/v1/stats?days={7|14|30|90|365} (автообновление
// 15с). Роли: любая аутентифицированная.
// Разметка: 8 KPI-карточек (эффективность коммуникаций + здоровье системы),
// график динамики по дням (recharts AreaChart), последние события,
// топ воронок и топ шаблонов.
import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  Ban,
  CalendarRange,
  CheckCheck,
  Clock,
  MousePointerClick,
  Send,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api-client';
import {
  ErrorState,
  EventBadge,
  EventStatusBadge,
  fmtDT,
  fmtChartDate,
  type StatsResponse,
} from '@/components/views/shared';

/** Доступные периоды дашборда (дни → подпись). */
const PERIODS: Array<{ days: number; label: string; short: string }> = [
  { days: 7, label: '7 дней', short: '7д' },
  { days: 14, label: '14 дней', short: '14д' },
  { days: 30, label: '30 дней', short: '30д' },
  { days: 90, label: '90 дней', short: '90д' },
  { days: 365, label: 'год', short: 'Год' },
];

/** Подпись периода для заголовков; незадекларированное значение — «N дней». */
function periodLabel(days: number): string {
  return PERIODS.find((p) => p.days === days)?.label ?? `${days} дней`;
}

/** Процент с одним знаком, локаль ru-RU. */
function fmtPct(value: number): string {
  return `${(Math.round(value * 10) / 10).toLocaleString('ru-RU')}%`;
}

/** KPI-карточка: подпись, крупное число (number → toLocaleString ru-RU),
 *  опциональный сабтекст и иконка. emphasized — акцентная изумрудная рамка. */
function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  iconClass,
  emphasized = false,
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
  sub?: string;
  iconClass: string;
  emphasized?: boolean;
}) {
  return (
    <Card className={`shadow-sm ${emphasized ? 'border-emerald-200 dark:border-emerald-900/70' : ''}`}>
      <CardContent className="flex items-center justify-between p-4">
        <div className="min-w-0">
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
          <p
            className={`mt-1 text-2xl font-bold ${
              emphasized ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground'
            }`}
          >
            {typeof value === 'number' ? value.toLocaleString('ru-RU') : value}
          </p>
          {sub ? <p className="mt-0.5 truncate text-[11px] text-zinc-400">{sub}</p> : null}
        </div>
        <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${iconClass}`}>
          <Icon className="size-5" aria-hidden />
        </div>
      </CardContent>
    </Card>
  );
}

/** Метаданные серий графика: подпись в тултипе + цвет (единый источник
 *  для линий и тултипа). */
const SERIES_META: Record<string, { label: string; color: string }> = {
  sent: { label: 'Отправлено', color: '#10b981' },
  delivered: { label: 'Доставлено', color: '#0d9488' },
  failed: { label: 'Ошибки', color: '#f87171' },
  rejected: { label: 'Отказы комплаенса', color: '#fb923c' },
  clicks: { label: 'Переходы по ссылкам', color: '#a855f7' },
};

/** Кастомный HTML-тултип recharts (вместо дефолтного): дата + строки серий
 *  с цветовыми точками; dataKey без SERIES_META не показывается. */
function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-card p-2 text-xs shadow-sm">
      <p className="mb-1 font-medium text-foreground">{fmtChartDate(String(label ?? ''))}</p>
      <div className="space-y-0.5">
        {payload.map((p) => {
          const meta = SERIES_META[String(p.dataKey ?? '')];
          if (!meta) return null;
          return (
            <div key={String(p.dataKey)} className="flex items-center justify-between gap-6">
              <span className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: meta.color }}
                  aria-hidden
                />
                {meta.label}
              </span>
              <span className="font-medium text-foreground">{Number(p.value ?? 0)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Экран дашборда: выбор периода → stats-запрос → KPI/график/списки. */
export function DashboardView() {
  const [days, setDays] = React.useState(14);
  // Цвета сетки/осей графика зависят от темы (recharts не умеет CSS-классы)
  const { resolvedTheme } = useTheme();
  const chartTheme = React.useMemo(
    () => ({
      grid: resolvedTheme === 'dark' ? '#27272a' : '#f4f4f5',
      axis: resolvedTheme === 'dark' ? '#3f3f46' : '#e4e4e7',
      tick: resolvedTheme === 'dark' ? '#a1a1aa' : '#71717a',
    }),
    [resolvedTheme],
  );

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['stats', days],
    queryFn: () => api<StatsResponse>(`/api/v1/stats?days=${days}`),
    refetchInterval: 15_000,
  });

  // Дата «сегодня» — фиксируем один раз на монтирование (для шапки).
  const today = React.useMemo(
    () =>
      new Date().toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
    [],
  );

  const periodText = days === 365 ? 'за последний год' : `за последние ${periodLabel(days)}`;

  // Переключатель периода (Tabs): мобильным — короткие подписи (short),
  // десктопу — полные. Используется и в скелетоне, и в основном рендере.
  const periodPicker = (
    <div className="flex items-center gap-2">
      <CalendarRange className="hidden size-4 text-zinc-400 sm:block" aria-hidden />
      <Tabs
        value={String(days)}
        onValueChange={(v) => setDays(Number.parseInt(v, 10))}
        aria-label="Период статистики"
      >
        <TabsList className="h-9">
          {PERIODS.map((p) => (
            <TabsTrigger key={p.days} value={String(p.days)} className="px-2.5 py-1 text-xs sm:px-3">
              <span className="sm:hidden">{p.short}</span>
              <span className="hidden sm:inline">{p.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );

  // --- Состояние загрузки: скелетоны повторяют финальную раскладку ---
  if (isPending) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{periodText} · {today}</p>
          {periodPicker}
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={`p${i}`} className="h-[86px]" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={`s${i}`} className="h-[76px]" />
          ))}
        </div>
        <Skeleton className="h-[300px]" />
      </div>
    );
  }

  // --- Состояние ошибки: только ретрай, без частичного рендера ---
  if (error || !data) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  const t = data.totals;
  const chartData = data.byDay ?? [];
  // Есть ли вообще точки для графика (полные нули → заглушка «Нет данных»).
  const hasChartData = chartData.some(
    (d) => d.sent > 0 || d.delivered > 0 || d.failed > 0 || d.rejected > 0 || d.clicks > 0,
  );
  // Топ воронок — максимум 5 строк (шкала считается от maxCount).
  const topFunnels = (data.topFunnels ?? []).slice(0, 5);
  const topTemplates = data.topTemplates ?? [];
  const maxCount = Math.max(1, ...topFunnels.map((f) => f.count));
  // Шаг делений оси X: не больше ~12 подписей даже на годовом графике
  const tickInterval = Math.max(0, Math.floor(chartData.length / 12) - 1);

  // Производные метрики: доставляемость, CTR коротких ссылок
  const deliveryRate = t.sent > 0 ? (t.delivered / t.sent) * 100 : null;
  const ctr = t.delivered > 0 ? (t.linkClicks / t.delivered) * 100 : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{periodText} · {today}</p>
        {periodPicker}
      </div>

      {/* Первая линия — эффективность коммуникаций */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Send} label="Отправлено" value={t.sent} iconClass="bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400" />
        <StatCard
          icon={CheckCheck}
          label="Доставлено"
          value={t.delivered}
          sub={deliveryRate !== null ? `доставляемость ${fmtPct(deliveryRate)}` : undefined}
          iconClass="bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400"
          emphasized
        />
        <StatCard
          icon={MousePointerClick}
          label="Переходы по ссылкам"
          value={t.linkClicks}
          sub={
            ctr !== null
              ? `CTR ${fmtPct(ctr)} от доставленных`
              : t.linkClicks > 0
                ? 'нет доставленных для CTR'
                : undefined
          }
          iconClass="bg-purple-50 text-purple-600"
          emphasized
        />
        <StatCard
          icon={Ban}
          label="Отписки"
          value={t.unsubscribed}
          sub={
            t.unsubscribedInPeriod > 0
              ? `+${t.unsubscribedInPeriod.toLocaleString('ru-RU')} за период`
              : 'новых за период нет'
          }
          iconClass="bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
        />
      </div>

      {/* Вторая линия — здоровье системы */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={AlertTriangle} label="Ошибки" value={t.failed} iconClass="bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400" />
        <StatCard
          icon={ShieldAlert}
          label="Отказы комплаенса"
          value={t.rejected}
          iconClass="bg-orange-50 dark:bg-orange-950/60 text-orange-600 dark:text-orange-400"
        />
        <StatCard
          icon={Activity}
          label="Активные экземпляры"
          value={t.activeInstances}
          iconClass="bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
        />
        <StatCard icon={Clock} label="Задач в очереди" value={t.waitingJobs} iconClass="bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400" />
      </div>

      {/* --- График динамики по дням --- */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Динамика отправок и переходов {days === 365 ? 'за год' : `за ${periodLabel(days)}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {hasChartData ? (
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gSent" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="gDelivered" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0d9488" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#0d9488" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="gFailed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f87171" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#f87171" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="gRejected" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#fb923c" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#fb923c" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="gClicks" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#a855f7" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#a855f7" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartTheme.grid} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(v: string) => fmtChartDate(v)}
                    tick={{ fontSize: 11, fill: chartTheme.tick }}
                    tickLine={false}
                    axisLine={{ stroke: chartTheme.axis }}
                    interval={tickInterval}
                    minTickGap={16}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: chartTheme.tick }}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Area type="monotone" dataKey="sent" stroke="#10b981" strokeWidth={2} fill="url(#gSent)" />
                  <Area
                    type="monotone"
                    dataKey="delivered"
                    stroke="#0d9488"
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    fill="url(#gDelivered)"
                  />
                  <Area type="monotone" dataKey="clicks" stroke="#a855f7" strokeWidth={2} fill="url(#gClicks)" />
                  <Area type="monotone" dataKey="failed" stroke="#f87171" strokeWidth={1.5} fill="url(#gFailed)" />
                  <Area type="monotone" dataKey="rejected" stroke="#fb923c" strokeWidth={1.5} fill="url(#gRejected)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-[260px] flex-col items-center justify-center text-center">
              <Send className="mb-3 size-10 text-zinc-300 dark:text-zinc-600" aria-hidden />
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Нет данных за период</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* --- Последние события (поток внешних триггеров) + топ воронок --- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Последние события</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(data.recentEvents ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">Событий пока нет</p>
            ) : (
              (data.recentEvents ?? []).slice(0, 5).map((ev) => (
                <div
                  key={ev.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <EventBadge event={ev.event} />
                    <span className="truncate font-mono text-xs text-zinc-600 dark:text-zinc-400">{ev.externalId}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <EventStatusBadge status={ev.status} />
                    <span className="text-xs text-zinc-400">{fmtDT(ev.createdAt)}</span>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Топ воронок</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {topFunnels.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">Запусков воронок пока нет</p>
            ) : (
              topFunnels.map((f) => (
                <div key={f.name} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-zinc-700 dark:text-zinc-300">{f.name}</span>
                    <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{f.count}</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-900/50">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${Math.max(4, Math.round((f.count / maxCount) * 100))}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Топ шаблонов — эффективность текстов за период */}
      <Card className="shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Топ шаблонов {days === 365 ? 'за год' : `за ${periodLabel(days)}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {topTemplates.length === 0 ? (
            <p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">Отправок по шаблонам за период нет</p>
          ) : (
            <div className="space-y-2.5">
              {topTemplates.map((tpl) => {
                const rate = tpl.sent > 0 ? (tpl.delivered / tpl.sent) * 100 : 0;
                const maxSent = Math.max(1, topTemplates[0]?.sent ?? 1);
                return (
                  <div key={tpl.name} className="space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                      <span className="truncate text-sm text-zinc-700 dark:text-zinc-300" title={tpl.name}>
                        {tpl.name}
                      </span>
                      <span className="flex items-center gap-2 text-xs">
                        <span className="font-medium text-zinc-600 dark:text-zinc-400">
                          {tpl.sent.toLocaleString('ru-RU')} отпр.
                        </span>
                        <span className="text-zinc-400">·</span>
                        <span className="text-emerald-700 dark:text-emerald-400">{fmtPct(rate)} дост.</span>
                        {tpl.rejected > 0 ? (
                          <>
                            <span className="text-zinc-400">·</span>
                            <span className="text-orange-600 dark:text-orange-400">
                              {tpl.rejected.toLocaleString('ru-RU')} отказов
                            </span>
                          </>
                        ) : null}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-emerald-500"
                        style={{ width: `${Math.max(4, Math.round((tpl.sent / maxSent) * 100))}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
