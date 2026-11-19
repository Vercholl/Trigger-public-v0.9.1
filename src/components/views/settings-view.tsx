'use client';

// «Настройки» — центр управления с поднавигацией (Task 58): «Общие» (глобальные
// параметры: провайдер SMS, часовой пояс, приписка, короткие ссылки, комплаенс,
// retention + журнал аудита), «Безопасность» (сессии, состояние защиты, политика),
// «Кастомные поля» (реестр дополнительных полей, ADMIN) и «Ссылки» (именные
// короткие ссылки) — бывшие вкладки сайдбара переехали сюда.
// Домен: settings. API: GET/PUT /api/v1/settings (PUT — ADMIN),
// GET /api/v1/short-links/stats, GET /api/v1/audit (ADMIN). Роли: «Настройки»
// открывают все (Общие — чтение для не-админов, поля disabled); изменение —
// только ADMIN; вкладка «Кастомные поля» видна только ADMIN (сервер дублирует
// RBAC). Секреты провайдеров здесь НЕ редактируются — «Интеграции» и .env.
// Активный раздел хранится в view из Zustand-стора (setView('security') и т.д.),
// поэтому раздел шарится ссылкой (?view=security) и переживает F5.
import * as React from 'react';
import { Fingerprint, History, Link2, Lock, MousePointerClick, RefreshCw, Shapes, SlidersHorizontal } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { analyzeSms } from '@/lib/sms-utils';
import { useAppStore, type View } from '@/lib/store';
import { CustomFieldsView } from '@/components/views/custom-fields-view';
import { LinksView } from '@/components/views/links-view';
import { SecurityView } from '@/components/views/security-view';
import {
  DEFAULT_DISCLAIMER_TEMPLATE,
  renderDisclaimerText,
  validateDisclaimerTemplate,
} from '@/lib/compliance/disclaimer-text';
import {
  invalidatePanel,
  ErrorState,
  TIMEZONES,
  fmtDT,
  timezoneOptionLabel,
  useRole,
  useSettings,
  type AppSettings,
  type ShortLinkStatsResponse,
} from '@/components/views/shared';

/** Часы 0..23 для Select «тихие часы». */
const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** Строка журнала аудита: действие, объект, пользователь/IP, детали (JSON). */
interface AuditEntryRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  userEmail: string | null;
  ip: string | null;
  details: string | null;
  createdAt: string;
}

interface AuditResponse {
  items: AuditEntryRow[];
  total: number;
}

/** Короткая подпись объекта аудита: «CLIENT · cc49eebd» */
function auditEntityLabel(e: AuditEntryRow): string {
  if (!e.entityId) return e.entityType;
  return `${e.entityType} · ${e.entityId.slice(0, 8)}`;
}

/** Превью деталей: JSON без секретов → компактные «ключ: значение», до ~80 символов. */
function auditDetailsPreview(details: string | null): string {
  if (!details) return '—';
  try {
    const parsed = JSON.parse(details) as Record<string, unknown>;
    const flat = Object.entries(parsed)
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('; ');
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat || '—';
  } catch {
    return details.length > 80 ? `${details.slice(0, 80)}…` : details;
  }
}

/** Карточка «Журнал аудита» — просмотр записей, которые сервисы пишут в audit_log
 *  (перенос преимущества альтернативной линии 22.10: аудит писался из 47 точек,
 *  но нигде не показывался). Только для ADMIN. */
function AuditJournal() {
  const auditQuery = useQuery({
    queryKey: ['audit'],
    queryFn: () => api<AuditResponse>('/api/v1/audit?limit=30'),
  });

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            <History className="size-4" aria-hidden />
            Журнал аудита
            {auditQuery.data ? (
              <Badge variant="secondary">всего: {auditQuery.data.total}</Badge>
            ) : null}
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void auditQuery.refetch()}
            disabled={auditQuery.isFetching}
          >
            <RefreshCw className="size-4" aria-hidden />
            Обновить
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {auditQuery.isError ? (
          <ErrorState error={auditQuery.error} onRetry={() => void auditQuery.refetch()} />
        ) : auditQuery.isLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Загрузка журнала аудита">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        ) : (auditQuery.data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Действий пока не записано</p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>Время</TableHead>
                  <TableHead>Действие</TableHead>
                  <TableHead>Объект</TableHead>
                  <TableHead>Пользователь</TableHead>
                  <TableHead>Детали</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditQuery.data?.items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-xs">{fmtDT(e.createdAt)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs font-medium">{e.action}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{auditEntityLabel(e)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {e.userEmail ?? '—'}
                      {e.ip ? <span className="text-zinc-400"> · {e.ip}</span> : null}
                    </TableCell>
                    <TableCell
                      className="max-w-72 truncate text-xs text-zinc-500 dark:text-zinc-400"
                      title={auditDetailsPreview(e.details)}
                    >
                      {auditDetailsPreview(e.details)}
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

/** Раздел «Настроек» (значение поднавигации; 'general' живёт в view='settings'). */
type SettingsTab = 'general' | 'security' | 'custom-fields' | 'links';

/** Активный раздел по view из стора (?view=security и т.д. — рабочие ссылки). */
const SETTINGS_TAB_BY_VIEW: Partial<Record<View, SettingsTab>> = {
  settings: 'general',
  security: 'security',
  'custom-fields': 'custom-fields',
  links: 'links',
};

/** Экран «Настройки»: поднавигация из четырёх разделов. Выбор раздела пишется
 *  в стор (setView) — URL остаётся шаримым (?view=links) и переживает F5;
 *  несохранённый черновик «Общих» не теряется при переключении раздела
 *  (forceMount + скрытие неактивных). */
export function SettingsView() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const { isAdmin } = useRole();
  const tab: SettingsTab = SETTINGS_TAB_BY_VIEW[view] ?? 'general';

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setView(v === 'general' ? 'settings' : (v as View))}
    >
      <TabsList className="h-auto w-full flex-wrap justify-start gap-1 sm:w-auto">
        <TabsTrigger value="general" className="gap-2">
          <SlidersHorizontal className="size-4" aria-hidden />
          Общие
        </TabsTrigger>
        <TabsTrigger value="security" className="gap-2">
          <Fingerprint className="size-4" aria-hidden />
          Безопасность
        </TabsTrigger>
        {isAdmin ? (
          <TabsTrigger value="custom-fields" className="gap-2">
            <Shapes className="size-4" aria-hidden />
            Кастомные поля
          </TabsTrigger>
        ) : null}
        <TabsTrigger value="links" className="gap-2">
          <Link2 className="size-4" aria-hidden />
          Ссылки
        </TabsTrigger>
      </TabsList>

      {/* «Общие» — forceMount: черновик настроек переживает уход в другой раздел */}
      <TabsContent forceMount value="general" className="mt-4 data-[state=inactive]:hidden">
        <GeneralSettingsSection />
      </TabsContent>
      <TabsContent value="security" className="mt-4">
        <SecurityView />
      </TabsContent>
      <TabsContent value="custom-fields" className="mt-4">
        <CustomFieldsView />
      </TabsContent>
      <TabsContent value="links" className="mt-4">
        <LinksView />
      </TabsContent>
    </Tabs>
  );
}

/** Раздел «Общие»: черновик draft (копия ответа GET) редактируется инлайн;
 *  «Сохранить» активна при dirty и отправляет PUT целиком. MANAGER/VIEWER —
 *  только просмотр (поля disabled + Alert). */
function GeneralSettingsSection() {
  const { isAdmin } = useRole();
  const queryClient = useQueryClient();
  const settingsQuery = useSettings();
  const disclaimerRef = React.useRef<HTMLTextAreaElement | null>(null);

  // Статистика коротких ссылок (переходы/отписки) — живёт рядом с припиской
  const statsQuery = useQuery({
    queryKey: ['short-link-stats'],
    queryFn: () => api<ShortLinkStatsResponse>('/api/v1/short-links/stats'),
  });

  // Черновик инициализируется из ответа сервера один раз и дальше не
  // перезатирается (чтобы refetch не снёс несохранённые правки).
  const [draft, setDraft] = React.useState<AppSettings | null>(null);
  React.useEffect(() => {
    if (settingsQuery.data && !draft) {
      setDraft({ ...settingsQuery.data });
    }
  }, [settingsQuery.data, draft]);

  // PUT отправляет черновик целиком; ответ (сохранённые настройки) становится
  // новым baseline для dirty.
  const saveMutation = useMutation({
    mutationFn: async () =>
      api<AppSettings>('/api/v1/settings', { method: 'PUT', body: draft }),
    onSuccess: (res) => {
      toast.success('Настройки сохранены');
      setDraft({ ...res });
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось сохранить';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  if (settingsQuery.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (settingsQuery.error || !settingsQuery.data) {
    return <ErrorState error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />;
  }

  if (!draft) return null;

  /** Универсальный типизированный сеттер поля черновика. */
  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  // Живой предпросмотр итогового рекламного SMS (тело + приписка)
  const disclaimerError = validateDisclaimerTemplate(draft.marketingDisclaimer);
  const exampleBase = (draft.unsubscribeBaseUrl ?? '').trim() || 'http://localhost:3000';
  // Пример ссылки отписки: короткий код /?u=… либо полный подписанный токен /?unsub=…
  const exampleLink = draft.useShortLinks
    ? `${exampleBase}/?u=Xk3fQ9a`
    : `${exampleBase}/?unsub=bWZrLkNMSTAubS4wMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMC4xNzYzMjQwMDAwMDA.c2ltDWxhdGVk`;
  const exampleBody = 'Анна, ждём вас снова! До 25 000 ₽ до 15.11.2026';
  const exampleSms = `${exampleBody} ${renderDisclaimerText(
    draft.marketingDisclaimer,
    draft.advertiserName,
    exampleLink,
  )}`;
  const exampleAnalysis = analyzeSms(exampleSms);

  /** Вставка плейсхолдера ({link}/{advertiser}) в позицию курсора в Textarea
   *  (без DOM-ссылки — в конец строки); фокус и курсор возвращаются после рендера. */
  function insertPlaceholder(text: string) {
    const el = disclaimerRef.current;
    if (!el) {
      set('marketingDisclaimer', `${draft?.marketingDisclaimer ?? ''}${text}`);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`;
    set('marketingDisclaimer', next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + text.length;
    });
  }

  // dirty: черновик отличается от сервера (только для ADMIN);
  // saveBlocked: приписка без {link} — сервер такой PUT не примет.
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(settingsQuery.data) && isAdmin;
  const saveBlocked = Boolean(disclaimerError);

  return (
    <div className="max-w-3xl space-y-4">
      {/* --- Заглушка для не-админов --- */}
      {!isAdmin ? (
        <Alert>
          <Lock className="size-4" aria-hidden />
          <AlertTitle>Только просмотр</AlertTitle>
          <AlertDescription>
            Изменение настроек доступно администраторам.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* --- Карточка «Рассылки»: рекламодатель, провайдер, пояс, имя отправителя, URL отписки --- */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Рассылки</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="set-advertiser">Название рекламодателя</Label>
            <Input
              id="set-advertiser"
              value={draft.advertiserName}
              onChange={(e) => set('advertiserName', e.target.value)}
              disabled={!isAdmin}
              placeholder="ДемоКомпания"
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Название рекламодателя для дисклеймера</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Провайдер SMS</Label>
              <Select
                value={draft.provider}
                onValueChange={(v) => set('provider', v as AppSettings['provider'])}
                disabled={!isAdmin}
              >
                <SelectTrigger className="w-full" aria-label="Провайдер SMS">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sandbox">Песочница (без реальной отправки)</SelectItem>
                  <SelectItem value="smstech">SMS.Tech — агрегатор (боевой)</SelectItem>
                  <SelectItem value="t2">Т2 «Бизнес SMS» — оператор (боевой)</SelectItem>
                  <SelectItem value="mts">МТС OmniChannel — оператор (боевой)</SelectItem>
                </SelectContent>
              </Select>
              {draft.provider === 'smstech' ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Токен доступа сохраняется на странице «Интеграции» (поле «Токен доступа SMS.Tech»)
                </p>
              ) : null}
              {draft.provider === 't2' ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Логин/пароль подключения сохраняются на странице «Интеграции» (поля «Логин/Пароль Т2»)
                </p>
              ) : null}
              {draft.provider === 'mts' ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Логин/пароль (system_id из договора) сохраняются на странице «Интеграции» (поля «Логин/Пароль МТС»)
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label>Часовой пояс по умолчанию</Label>
              <Select
                value={draft.defaultTimezone}
                onValueChange={(v) => set('defaultTimezone', v)}
                disabled={!isAdmin}
              >
                <SelectTrigger className="w-full" aria-label="Часовой пояс по умолчанию">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {timezoneOptionLabel(tz)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Назначается новым клиентам без явного пояса</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="set-sender">Имя отправителя SMS (по умолчанию)</Label>
            <Input
              id="set-sender"
              value={draft.defaultSenderName}
              onChange={(e) => set('defaultSenderName', e.target.value)}
              disabled={!isAdmin}
              placeholder="DEMO-BRAND"
              maxLength={20}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Используется, если имя не задано в шаблоне или SMS-узле воронки; латиница/цифры/дефис,
              до 20 символов. Боевое имя согласуется с провайдером
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="set-unsub-url">Базовый URL ссылки отписки</Label>
            <Input
              id="set-unsub-url"
              value={draft.unsubscribeBaseUrl ?? ''}
              onChange={(e) => set('unsubscribeBaseUrl', e.target.value || null)}
              disabled={!isAdmin}
              placeholder="https://trigger.internal"
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Базовый URL ссылки отписки; пусто — определяется автоматически
            </p>
          </div>
        </CardContent>
      </Card>

      {/* --- Приписка к рекламным SMS + короткие ссылки + живой пример --- */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Приписка к рекламным SMS и короткие ссылки
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="set-disclaimer">Текст приписки</Label>
            <Textarea
              id="set-disclaimer"
              ref={disclaimerRef}
              value={draft.marketingDisclaimer}
              onChange={(e) => set('marketingDisclaimer', e.target.value)}
              disabled={!isAdmin}
              placeholder={DEFAULT_DISCLAIMER_TEMPLATE}
              rows={3}
              maxLength={300}
              className="font-mono text-sm"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!isAdmin}
                onClick={() => insertPlaceholder('{link}')}
              >
                <Link2 className="size-3.5" aria-hidden /> {'{link}'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!isAdmin}
                onClick={() => insertPlaceholder('{advertiser}')}
              >
                {'{advertiser}'}
              </Button>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {'{link}'} — ссылка отписки (обязательно), {'{advertiser}'} — название рекламодателя.
                Пусто — стандартный текст
              </span>
            </div>
            {disclaimerError ? (
              <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                {disclaimerError}
              </p>
            ) : null}
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-border p-3">
            <Switch
              id="set-short-links"
              checked={draft.useShortLinks}
              onCheckedChange={(v) => set('useShortLinks', v)}
              disabled={!isAdmin}
              aria-label="Короткие ссылки отписки"
            />
            <div className="min-w-0 space-y-1">
              <Label htmlFor="set-short-links" className="cursor-pointer">
                Короткие ссылки отписки
              </Label>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Вместо полного токена — код из 7 символов ({'{'}link{'}'} вида «…/?u=Xk3fQ9a»).
                Экономия ~80 символов на каждом рекламном SMS — обычно минус одна часть.
                Код персональный, срок 180 дней, переходы считаются
              </p>
            </div>
          </div>

          <div className="space-y-2 rounded-lg bg-muted p-3">
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Пример итогового SMS</p>
            <p className="break-words font-mono text-xs text-zinc-800 dark:text-zinc-200">{exampleSms}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {exampleAnalysis.chars} симв · {exampleAnalysis.segments}{' '}
              {exampleAnalysis.segments === 1 ? 'часть' : 'частей'} · {exampleAnalysis.encoding}
            </p>
          </div>

          {statsQuery.data ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <MousePointerClick className="size-3.5 text-zinc-400" aria-hidden />
              <span>
                Ссылок создано: <strong>{statsQuery.data.total}</strong>
              </span>
              <Badge variant="secondary">переходов: {statsQuery.data.visits}</Badge>
              <Badge variant="secondary">отписок всего: {statsQuery.data.unsubscribedTotal}</Badge>
              <Badge variant="secondary">за 30 дней: {statsQuery.data.unsubscribed30d}</Badge>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* --- Комплаенс: тихие часы, лимиты, retention --- */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Комплаенс</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Тихие часы — начало</Label>
              <Select
                value={String(draft.quietHoursStart)}
                onValueChange={(v) => set('quietHoursStart', Number(v))}
                disabled={!isAdmin}
              >
                <SelectTrigger className="w-full" aria-label="Начало тихих часов">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {String(h).padStart(2, '0')}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Тихие часы — окончание</Label>
              <Select
                value={String(draft.quietHoursEnd)}
                onValueChange={(v) => set('quietHoursEnd', Number(v))}
                disabled={!isAdmin}
              >
                <SelectTrigger className="w-full" aria-label="Окончание тихих часов">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {String(h).padStart(2, '0')}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Тихие часы (по часовому поясу клиента): с{' '}
            {String(draft.quietHoursStart).padStart(2, '0')}:00 до{' '}
            {String(draft.quietHoursEnd).padStart(2, '0')}:00
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="set-client-limit">SMS в сутки на клиента</Label>
              <Input
                id="set-client-limit"
                type="number"
                min={1}
                max={100}
                value={draft.dailyClientLimit}
                onChange={(e) => set('dailyClientLimit', Number(e.target.value))}
                disabled={!isAdmin}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-system-limit">SMS в сутки на систему</Label>
              <Input
                id="set-system-limit"
                type="number"
                min={1}
                max={100000}
                value={draft.systemDailyLimit}
                onChange={(e) => set('systemDailyLimit', Number(e.target.value))}
                disabled={!isAdmin}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="set-retention">Хранить обработанные события и задачи, дней</Label>
            <Input
              id="set-retention"
              type="number"
              min={0}
              max={3650}
              value={draft.inboxRetentionDays}
              onChange={(e) => set('inboxRetentionDays', Number(e.target.value))}
              disabled={!isAdmin}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Авто-архивация: воркер удаляет обработанные события и завершённые задачи старше
              этого срока (0 — не удалять). Упавшие события не удаляются автоматически — их
              перезапускают кнопкой «Повторить» в журнале событий
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="set-me-retention">Хранить журнал событий доставки, дней</Label>
            <Input
              id="set-me-retention"
              type="number"
              min={0}
              max={3650}
              value={draft.messageEventRetentionDays}
              onChange={(e) => set('messageEventRetentionDays', Number(e.target.value))}
              disabled={!isAdmin}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Журнал доставки SMS (MessageEvent): события старше срока выгружаются в
              gz-архив (db/message-events-archive) и удаляются из БД; 0 — не удалять. При
              включённой интеграции с системой данных события, ещё не доставленные в
              приёмник, не удаляются. Рекомендуемое окно на боевых объёмах — 180–365 дней
            </p>
          </div>
        </CardContent>
      </Card>

      {/* --- Памятка: где живут секреты --- */}
      <Alert>
        <Lock className="size-4" aria-hidden />
        <AlertTitle>Секреты хранятся на сервере</AlertTitle>
        <AlertDescription>
          Токен SMS.Tech, логин/пароль Т2 и логин/пароль МТС OmniChannel сохраняются в формах
          подключения на странице «Интеграции»; остальные секреты (SESSION_SECRET,
          UNSUBSCRIBE_SECRET) задаются в .env на сервере. В панели значения не отображаются.
        </AlertDescription>
      </Alert>

      {/* --- Журнал аудита (только ADMIN) --- */}
      {isAdmin ? <AuditJournal /> : null}

      {/* --- Сохранение (ADMIN; блокируется при ошибке приписки) --- */}
      {isAdmin ? (
        <div className="flex items-center justify-end gap-3">
          {saveBlocked ? (
            <span className="text-xs text-red-600 dark:text-red-400" role="alert">
              Исправьте текст приписки — без {'{link}'} сохранить нельзя
            </span>
          ) : null}
          <div className="flex justify-end">
            <Button
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={!dirty || saveBlocked || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              Сохранить
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
