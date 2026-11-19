'use client';

// «Интеграции» (Task 59): два раздела-поднавигации — всё об обмене данными
// с внешней системой собрано в одном месте. «Интеграция с системой данных» —
// мониторинг трубы событий (бывшая карточка «Приём событий из системы данных»),
// API-ключи приёма (бывший отдельный экран сайдбара), «Захват событий» и
// «Обратный поток событий». «SMS-провайдеры» — предустановленные
// подключения: SMS.Tech — по документации «HTTP API шлюза отправки сообщений»
// v2.0 (токен в поле «Токен доступа»); Т2 — по документу «Услуга "Бизнес
// SMS". Использование протоколов HTTP/SMTP» (логин/пароль рассылки в полях
// «Логин/Пароль Т2»); МТС — по документу «МТС OMNIСHANNEL HTTP API SMS
// V.1.14» (system_id/пароль в полях «Логин/Пароль МТС»). Секреты шифруются
// на сервере (AES-256-GCM), в панель не возвращаются — только маска и факт
// сохранения; удаление — через диалог. Экран открывает только ADMIN (пункт
// меню adminOnly в app-shell), кнопки дополнительно гвардятся isAdmin из
// useRole(). API: GET /api/v1/integrations (карточки провайдеров);
// POST /integrations/smstech/token, /integrations/t2/credentials,
// /integrations/mts/credentials, /integrations/activate,
// /integrations/smstech|t2|mts/check, /integrations/smstech|t2|mts/test;
// карточка «Захват событий»: GET/PUT /api/v1/hooks, POST /api/v1/hooks/token,
// POST /api/v1/hooks/test; блок «API-ключи»: GET/POST /api/v1/api-keys
// (см. api-keys-view). После мутаций — invalidatePanel (сброс кэша TanStack
// Query). Активный раздел = view из Zustand-стора ('integrations'/'api-keys'
// → «Интеграция с системой данных», 'sms-providers' → провайдеры) — URL
// шарится (?view=sms-providers) и переживает F5.
import * as React from 'react';
import {
  BadgeCheck,
  Check,
  CircleAlert,
  Copy,
  Database,
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  Loader2,
  Plug,
  Radio,
  Send,
  ServerCog,
  ShieldCheck,
  Smartphone,
  Trash2,
  Webhook,
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, ApiError } from '@/lib/api-client';
import { useAppStore, type View } from '@/lib/store';
import { ApiKeysView } from '@/components/views/api-keys-view';
import {
  invalidatePanel,
  copyText,
  ErrorState,
  useRole,
  type ActivateProviderResponse,
  type IntegrationCard,
  type IntegrationsResponse,
  type SaveSmstechTokenResponse,
  type SaveT2CredentialsResponse,
  type SaveMtsCredentialsResponse,
  type SmstechCheckResponse,
  type SmstechTestResponse,
  type T2CheckResponse,
  type T2TestResponse,
  type MtsCheckResponse,
  type MtsTestResponse,
} from '@/components/views/shared';
import { cn } from '@/lib/utils';

/* ---------- Карточка-«логотип» провайдера ---------- */

/** Цветной бейдж-«логотип»: SMS Tech / T2 / МТС / колба для прочих (песочница). */
function ProviderGlyph({ id }: { id: IntegrationCard['id'] }) {
  const base =
    'flex size-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold tracking-tight';
  if (id === 'smstech') {
    return (
      <div className={cn(base, 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400')} aria-hidden>
        <span className="text-[11px] leading-none">
          SMS
          <br />
          Tech
        </span>
      </div>
    );
  }
  if (id === 't2') {
    return (
      <div className={cn(base, 'bg-amber-500/20 text-amber-700 dark:text-amber-400')} aria-hidden>
        <span className="text-sm leading-none">T2</span>
      </div>
    );
  }
  if (id === 'mts') {
    // Фирменный красный МТС (OmniChannel)
    return (
      <div className={cn(base, 'bg-red-600/15 text-red-700 dark:text-red-400')} aria-hidden>
        <span className="text-[11px] leading-none">МТС</span>
      </div>
    );
  }
  return (
    <div className={cn(base, 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300')} aria-hidden>
      <FlaskConical className="size-5" />
    </div>
  );
}

/**
 * Бейджи статуса карточки: «Активен» (активный провайдер) → «Подключён»
 * (секреты сохранены) → «Требует настройки»; плюс тип — агрегатор/оператор/dev.
 */
function StatusBadges({ card }: { card: IntegrationCard }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {card.active ? (
        <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400">
          <BadgeCheck className="mr-1 size-3" aria-hidden /> Активен
        </Badge>
      ) : card.configured ? (
        <Badge className="border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-400">
          Подключён
        </Badge>
      ) : (
        <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-400">
          <CircleAlert className="mr-1 size-3" aria-hidden /> Требует настройки
        </Badge>
      )}
      {card.kind === 'aggregator' ? <Badge variant="secondary">агрегатор</Badge> : null}
      {card.kind === 'operator' ? <Badge variant="secondary">оператор</Badge> : null}
      {card.kind === 'sandbox' ? <Badge variant="secondary">dev</Badge> : null}
    </div>
  );
}

/** Копирование в clipboard с обратной связью «Скопировано» (1,5 с); при недоступности clipboard — тост об ошибке. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={() => {
        // copyText — общий хелпер: на http-контуре без navigator.clipboard
        // уходит в execCommand-фолбэк, а не в необработанное исключение
        void copyText(value).then((ok) => {
          if (ok) {
            setCopied(true);
            toast.success(`${label} скопирован`);
            setTimeout(() => setCopied(false), 1500);
          } else {
            // clipboard недоступен (нет фокуса/разрешения) — не молчим
            toast.error('Не удалось скопировать — скопируйте вручную');
          }
        });
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {copied ? 'Скопировано' : 'Копировать'}
    </Button>
  );
}

/** Разворачивает ApiError/Error в строку для toast-уведомления. */
function errorDetail(err: unknown): string {
  if (err instanceof ApiError) return err.detail ?? err.title;
  if (err instanceof Error) return err.message;
  return 'Неизвестная ошибка';
}

/* ---------- Форма подключения SMS.Tech (упрощённая, по документации v2.0) ---------- */

/**
 * Форма подключения SMS.Tech — 4 шага: токен доступа → альфа-имя → webhook
 * статусов → проверка/тест. Черновики (tokenDraft/senderDraft/…) — локальный
 * стейт, в БД попадают только по кнопкам (мутации ниже); секрет в панель не
 * возвращается — вместо него card.configured и card.secret.hint (маска).
 * isAdmin блокирует все контролы для не-ADMIN (сервер дублирует RBAC).
 */
function SmstechSetup({ card, isAdmin }: { card: IntegrationCard; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [tokenDraft, setTokenDraft] = React.useState('');
  const [showToken, setShowToken] = React.useState(false);
  const [checkPhone, setCheckPhone] = React.useState('');
  const [testPhone, setTestPhone] = React.useState('');
  const [testText, setTestText] = React.useState('');
  const [senderDraft, setSenderDraft] = React.useState(card.defaultSenderName ?? '');
  const [checkResult, setCheckResult] = React.useState<SmstechCheckResponse | null>(null);
  const [testResult, setTestResult] = React.useState<SmstechTestResponse | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // Приход карточки с сервера обновляет черновик имени отправителя
  // (например, после activate с другим senderName или загрузки карточки).
  React.useEffect(() => {
    setSenderDraft(card.defaultSenderName ?? '');
  }, [card.defaultSenderName]);

  // Сброс всего кэша запросов панели (invalidatePanel): карточки интеграций,
  // счётчики и логи перевчитываются после мутации.
  const invalidate = () => {
    invalidatePanel(queryClient);
      };

  // Сохранение токена доступа: поле → БД (на сервере), в панель не возвращается.
  // Пустая строка — очистить сохранённый токен.
  const saveTokenMutation = useMutation({
    mutationFn: (token: string) =>
      api<SaveSmstechTokenResponse>('/api/v1/integrations/smstech/token', {
        method: 'POST',
        body: { token },
      }),
    onSuccess: (res) => {
      setTokenDraft('');
      setConfirmDelete(false);
      toast.success(res.tokenSet ? 'Токен сохранён — интеграция SMS.Tech настроена' : 'Токен удалён');
      if (!res.tokenSet && card.active) {
        toast.info('SMS.Tech остался активным провайдером — для тестов без риска включите «Песочницу»');
      }
      invalidate();
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  // Назначение SMS.Tech активным провайдером; senderName уходит в теле,
  // только если черновик непустой (иначе сервер оставит прежнее имя).
  const activateMutation = useMutation({
    mutationFn: () =>
      api<ActivateProviderResponse>('/api/v1/integrations/activate', {
        method: 'POST',
        body: { provider: 'smstech', ...(senderDraft.trim() ? { senderName: senderDraft.trim() } : {}) },
      }),
    onSuccess: () => {
      toast.success('SMS.Tech назначен активным провайдером');
      invalidate();
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  // «Проверить подключение» — без отправки SMS: телефон заполнен → узнать
  // оператора по номеру, пусто → просто проверить токен шлюзом.
  const checkMutation = useMutation({
    mutationFn: () =>
      api<SmstechCheckResponse>('/api/v1/integrations/smstech/check', {
        method: 'POST',
        body: checkPhone.trim() ? { phone: checkPhone.trim() } : {},
      }),
    onSuccess: (res) => setCheckResult(res),
    onError: (err) => setCheckResult({ ok: false, detail: errorDetail(err) }),
  });

  // Тестовая отправка РЕАЛЬНОГО SMS реальному абоненту (проходит весь конвейер,
  // попадает в SMS-лог; успех — smsId/сегменты шлюза, статус придёт webhook-ом).
  const testMutation = useMutation({
    mutationFn: () =>
      api<SmstechTestResponse>('/api/v1/integrations/smstech/test', {
        method: 'POST',
        body: {
          phone: testPhone.trim(),
          ...(testText.trim() ? { text: testText.trim() } : {}),
          ...(senderDraft.trim() ? { sender: senderDraft.trim() } : {}),
        },
      }),
    onSuccess: (res) => {
      setTestResult(res);
      if (res.ok) {
        toast.success('Тестовое SMS отправлено');
        invalidatePanel(queryClient);
      } else {
        toast.error(`Отправка не удалась: ${res.error ?? 'ошибка'}`);
      }
    },
    onError: (err) => setTestResult({ ok: false, code: null, segments: 0, smsId: '', error: errorDetail(err) }),
  });

  const tokenSet = card.configured;
  const webhookUrl = card.webhook?.url ?? '';
  const limits = card.limits;

  return (
    <div className="space-y-5">
      {/* Шаг 1 — токен доступа (поле + сохранение на сервере) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-full bg-emerald-600/15 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
            1
          </span>
          <Label htmlFor="st-token">Токен доступа SMS.Tech</Label>
        </div>
        {tokenSet ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 dark:border-emerald-900 dark:bg-emerald-950/60">
            <ShieldCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
              Токен сохранён — интеграция настроена
            </span>
            {card.secret?.hint ? (
              <code className="rounded bg-emerald-100/80 px-1.5 py-0.5 font-mono text-xs text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300">
                {card.secret.hint}
              </code>
            ) : null}
          </div>
        ) : null}
        {card.secret?.stored === 'env' ? (
          <p className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
            Токен сейчас берётся из переменной окружения {card.secret.envName} — из панели он не
            удаляется (очистите переменную на сервере)
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-64">
            <Input
              id="st-token"
              type={showToken ? 'text' : 'password'}
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              disabled={!isAdmin || saveTokenMutation.isPending}
              placeholder={tokenSet ? 'Новый токен — заменит сохранённый' : 'Вставьте токен из кабинета hub.sms.tech'}
              autoComplete="off"
              spellCheck={false}
              maxLength={512}
              className="pr-10 font-mono"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              disabled={!isAdmin || saveTokenMutation.isPending || tokenDraft.length === 0}
              aria-label={showToken ? 'Скрыть токен' : 'Показать токен'}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-zinc-400 transition-colors hover:text-zinc-600 disabled:pointer-events-none dark:hover:text-zinc-300"
            >
              {showToken ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </div>
          <Button
            type="button"
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={!isAdmin || saveTokenMutation.isPending || tokenDraft.trim().length === 0}
            onClick={() => saveTokenMutation.mutate(tokenDraft.trim())}
          >
            {saveTokenMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <KeyRound className="size-4" aria-hidden />
            )}
            {tokenSet ? 'Заменить токен' : 'Сохранить токен'}
          </Button>
          {tokenSet && card.secret?.stored !== 'env' ? (
            <Button
              type="button"
              variant="outline"
              className="text-red-700 hover:bg-red-50 hover:text-red-800 dark:text-red-400 dark:hover:bg-red-950"
              disabled={!isAdmin || saveTokenMutation.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              {saveTokenMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="size-4" aria-hidden />
              )}
              Удалить
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Токен создаётся в личном кабинете{' '}
          <a
            href={card.cabinetUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2"
          >
            hub.sms.tech
          </a>{' '}
          (раздел «Интеграции» → «Токен пользователя»). Перед сохранением шифруется
          (AES-256-GCM), хранится только на сервере и передаётся шлюзу в теле запроса
          (meta.access_token); в панель не возвращается — видны лишь последние символы.
        </p>
      </div>

      {/* Шаг 2 — имя отправителя */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-full bg-emerald-600/15 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
            2
          </span>
          <Label htmlFor="st-sender">Альфа-имя отправителя (по умолчанию)</Label>
        </div>
        <div className="flex gap-2">
          <Input
            id="st-sender"
            value={senderDraft}
            onChange={(e) => setSenderDraft(e.target.value)}
            disabled={!isAdmin || activateMutation.isPending}
            placeholder="MyBrand"
            maxLength={20}
            className="max-w-[240px] font-mono"
          />
          {card.active ? (
            <Badge variant="secondary" className="h-9">
              активно для всех SMS
            </Badge>
          ) : (
            <Button
              type="button"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={!isAdmin || activateMutation.isPending || !tokenSet}
              onClick={() => activateMutation.mutate()}
            >
              {activateMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Plug className="size-4" aria-hidden />
              )}
              Сделать активным
            </Button>
          )}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Альфа-имя «{card.registeredSenderName ?? 'DemoBrand'}» уже зарегистрировано у операторов и
          привязано к аккаунту SMS.Tech. Латиница, до 20 символов
        </p>
      </div>

      {/* Шаг 3 — webhook статусов */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-full bg-emerald-600/15 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
            3
          </span>
          <Label>Webhook статусов доставки</Label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-muted px-2.5 py-1.5 font-mono text-xs text-zinc-700 dark:text-zinc-300">
            {webhookUrl}
          </code>
          <CopyButton value={webhookUrl} label="URL webhook" />
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Передайте этот URL в поддержку SMS.Tech (метод POST, событие «статус сообщения изменился»).
          {card.webhook?.secretSet
            ? ' Заголовок Authorization включён — сообщите его значение вместе с URL.'
            : ' Значение заголовка Authorization задайте в .env (SMSTECH_WEBHOOK_SECRET) и сообщите в поддержку — без него проверка подписи выключена.'}
        </p>
      </div>

      {/* Шаг 4 — проверка и тест */}
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          <ServerCog className="size-4 text-zinc-400" aria-hidden />
          Проверка и тестовая отправка
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="st-check-phone">Номер для проверки (необязательно)</Label>
            <Input
              id="st-check-phone"
              value={checkPhone}
              onChange={(e) => setCheckPhone(e.target.value)}
              disabled={!isAdmin || checkMutation.isPending}
              placeholder="+79001234567 — оператор по номеру, без отправки SMS"
              className="font-mono"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={!isAdmin || checkMutation.isPending || !tokenSet}
            onClick={() => {
              setCheckResult(null);
              checkMutation.mutate();
            }}
          >
            {checkMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Webhook className="size-4" aria-hidden />
            )}
            Проверить подключение
          </Button>
        </div>
        {checkResult ? (
          <p
            className={cn(
              'rounded-lg px-3 py-2 text-sm',
              checkResult.ok
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400',
            )}
            role="status"
          >
            {checkResult.ok ? <Check className="mr-1 inline size-4" aria-hidden /> : null}
            {checkResult.detail}
          </p>
        ) : null}

        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="st-test-phone">Тестовое SMS на номер</Label>
              <Input
                id="st-test-phone"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                disabled={!isAdmin || testMutation.isPending}
                placeholder="+79001234567"
                className="font-mono"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="st-test-text">Текст (необязательно)</Label>
              <Input
                id="st-test-text"
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                disabled={!isAdmin || testMutation.isPending}
                placeholder="Тестовое сообщение Trigger"
                maxLength={480}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Реальная отправка реальному абоненту — попадает в SMS-лог
            </p>
            <Button
              type="button"
              disabled={!isAdmin || testMutation.isPending || !testPhone.trim() || !tokenSet}
              onClick={() => {
                setTestResult(null);
                testMutation.mutate();
              }}
            >
              {testMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Send className="size-4" aria-hidden />
              )}
              Отправить тест
            </Button>
          </div>
          {testResult ? (
            testResult.ok ? (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" role="status">
                SMS принято шлюзом — code <code className="font-mono">{testResult.code}</code>,{' '}
                {testResult.segments} сегм. Статус доставки придёт webhook-ом и появится в SMS-логе
              </p>
            ) : (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-400" role="status">
                {testResult.error ?? 'Отправка не удалась'}
              </p>
            )
          ) : null}
        </div>
      </div>

      {/* Справка по шлюзу — из разделов 9/11/14 документации */}
      {limits ? (
        <div className="space-y-2 rounded-lg bg-muted p-3">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Параметры шлюза SMS.Tech</p>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400 sm:grid-cols-2">
            <div className="flex justify-between gap-2">
              <dt>Сегмент GSM-7 / UCS-2</dt>
              <dd className="text-right font-mono">
                {limits.segmentGsm7} · {limits.segmentUcs2}
              </dd>
            </div>
            {limits.perPhonePerHour ? (
              <div className="flex justify-between gap-2">
                <dt>Сообщений на номер</dt>
                <dd className="text-right font-mono">≤ {limits.perPhonePerHour}/час</dd>
              </div>
            ) : null}
            {limits.recommendedRps ? (
              <div className="flex justify-between gap-2">
                <dt>Рекомендуемый RPS</dt>
                <dd className="text-right font-mono">≤ {limits.recommendedRps}</dd>
              </div>
            ) : null}
            {limits.statusWaitDays ? (
              <div className="flex justify-between gap-2">
                <dt>Ожидание статуса</dt>
                <dd className="text-right font-mono">{limits.statusWaitDays} дня</dd>
              </div>
            ) : null}
          </dl>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
            Один символ кириллицы переводит SMS в UCS-2. Доставка подтверждается webhook-ом;
            при отсутствии статуса 3 дня шлюз фиксирует ошибку
          </p>
        </div>
      ) : null}

      {/* Подтверждение удаления токена: секрет стирается из БД — на время
          тестов можно не рисковать реальной отправкой */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить токен SMS.Tech?</AlertDialogTitle>
            <AlertDialogDescription>
              Токен будет стёрт из базы данных (хранится зашифрованным). Отправка через SMS.Tech
              станет недоступной — на время тестов включите «Песочницу» на её карточке.
              {card.active ? ' Сейчас SMS.Tech — активный провайдер.' : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={saveTokenMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                saveTokenMutation.mutate('');
              }}
            >
              {saveTokenMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ---------- Форма подключения Т2 (упрощённая, по документу «Бизнес SMS») ---------- */

/**
 * Форма подключения Т2 — зеркальна SmstechSetup, но креды — пара логин/пароль
 * HTTP-рассылки (POST /integrations/t2/credentials, пустые оба поля = удаление).
 * Проверка без списаний: сервер запрашивает статус несуществующей транзакции —
 * по ответу отличают «креды неверны» от «креды приняты».
 */
function T2Setup({ card, isAdmin }: { card: IntegrationCard; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [loginDraft, setLoginDraft] = React.useState('');
  const [passwordDraft, setPasswordDraft] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [checkResult, setCheckResult] = React.useState<T2CheckResponse | null>(null);
  const [testPhone, setTestPhone] = React.useState('');
  const [testText, setTestText] = React.useState('');
  const [senderDraft, setSenderDraft] = React.useState(card.defaultSenderName ?? '');
  const [testResult, setTestResult] = React.useState<T2TestResponse | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // Приход карточки с сервера обновляет черновик имени отправителя
  // (например, после activate с другим senderName или загрузки карточки).
  React.useEffect(() => {
    setSenderDraft(card.defaultSenderName ?? '');
  }, [card.defaultSenderName]);

  // Сброс всего кэша запросов панели (invalidatePanel): карточки интеграций,
  // счётчики и логи перевчитываются после мутации.
  const invalidate = () => {
    invalidatePanel(queryClient);
      };

  // Сохранение логина/пароля подключения: поля → БД (на сервере), в панель не
  // возвращаются. Пустые значения в обоих полях — очистить креды.
  const saveCredsMutation = useMutation({
    mutationFn: (payload: { login: string; password: string }) =>
      api<SaveT2CredentialsResponse>('/api/v1/integrations/t2/credentials', {
        method: 'POST',
        body: payload,
      }),
    onSuccess: (res) => {
      setLoginDraft('');
      setPasswordDraft('');
      setConfirmDelete(false);
      toast.success(
        res.credentialsSet ? 'Логин/пароль сохранены — интеграция Т2 настроена' : 'Логин/пароль удалены',
      );
      if (!res.credentialsSet && card.active) {
        toast.info('Т2 остался активным провайдером — для тестов без риска включите «Песочницу»');
      }
      invalidate();
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  // Назначение Т2 активным провайдером (senderName — опционально, shortcode до 11 символов).
  const activateMutation = useMutation({
    mutationFn: () =>
      api<ActivateProviderResponse>('/api/v1/integrations/activate', {
        method: 'POST',
        body: {
          provider: 't2',
          ...(senderDraft.trim() ? { senderName: senderDraft.trim() } : {}),
        },
      }),
    onSuccess: () => {
      toast.success('Т2 назначен активным провайдером');
      invalidate();
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  // Проверка кредов «запросом статуса несуществующей транзакции» — без списаний.
  const checkMutation = useMutation({
    mutationFn: () => api<T2CheckResponse>('/api/v1/integrations/t2/check', { method: 'POST', body: {} }),
    onSuccess: (res) => setCheckResult(res),
    onError: (err) => setCheckResult({ ok: false, detail: errorDetail(err) }),
  });

  // Тестовая отправка реального SMS через Т2 (SMS-лог, статус придёт webhook-ом).
  const testMutation = useMutation({
    mutationFn: () =>
      api<T2TestResponse>('/api/v1/integrations/t2/test', {
        method: 'POST',
        body: {
          phone: testPhone.trim(),
          ...(testText.trim() ? { text: testText.trim() } : {}),
          ...(senderDraft.trim() ? { sender: senderDraft.trim() } : {}),
        },
      }),
    onSuccess: (res) => {
      setTestResult(res);
      if (res.ok) {
        toast.success('Тестовое SMS отправлено');
        invalidatePanel(queryClient);
      } else {
        toast.error(`Отправка не удалась: ${res.error ?? 'ошибка'}`);
      }
    },
    onError: (err) => setTestResult({ ok: false, code: null, segments: 0, smsId: '', error: errorDetail(err) }),
  });

  const credsSet = card.configured;
  const webhookUrl = card.webhook?.url ?? '';
  const limits = card.limits;
  const canSaveCreds = loginDraft.trim().length >= 2 && passwordDraft.trim().length >= 4;

  return (
    <div className="space-y-5">
      {/* Шаг 1 — логин и пароль подключения (поля + сохранение на сервере) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-full bg-amber-500/20 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
            1
          </span>
          <Label>Логин и пароль подключения Т2</Label>
        </div>
        {credsSet ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 dark:border-emerald-900 dark:bg-emerald-950/60">
            <ShieldCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
              Креды сохранены — интеграция настроена
            </span>
            {card.secret?.hint ? (
              <code className="rounded bg-emerald-100/80 px-1.5 py-0.5 font-mono text-xs text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300">
                {card.secret.hint}
              </code>
            ) : null}
          </div>
        ) : null}
        {card.secret?.stored === 'env' ? (
          <p className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
            Логин/пароль сейчас берутся из переменных окружения {card.secret.envName} — из панели
            они не удаляются (очистите переменные на сервере)
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-44">
            <Input
              id="t2-login"
              value={loginDraft}
              onChange={(e) => setLoginDraft(e.target.value)}
              disabled={!isAdmin || saveCredsMutation.isPending}
              placeholder={credsSet ? 'Новый логин — заменит сохранённый' : 'Логин HTTP-рассылки'}
              autoComplete="off"
              spellCheck={false}
              maxLength={128}
              className="font-mono"
            />
          </div>
          <div className="relative min-w-0 flex-1 basis-44">
            <Input
              id="t2-password"
              type={showPassword ? 'text' : 'password'}
              value={passwordDraft}
              onChange={(e) => setPasswordDraft(e.target.value)}
              disabled={!isAdmin || saveCredsMutation.isPending}
              placeholder="Пароль"
              autoComplete="off"
              spellCheck={false}
              maxLength={128}
              className="pr-10 font-mono"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              disabled={!isAdmin || saveCredsMutation.isPending || passwordDraft.length === 0}
              aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-zinc-400 transition-colors hover:text-zinc-600 disabled:pointer-events-none dark:hover:text-zinc-300"
            >
              {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </div>
          <Button
            type="button"
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={!isAdmin || saveCredsMutation.isPending || !canSaveCreds}
            onClick={() => saveCredsMutation.mutate({ login: loginDraft.trim(), password: passwordDraft.trim() })}
          >
            {saveCredsMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <KeyRound className="size-4" aria-hidden />
            )}
            {credsSet ? 'Заменить' : 'Сохранить'}
          </Button>
          {credsSet && card.secret?.stored !== 'env' ? (
            <Button
              type="button"
              variant="outline"
              className="text-red-700 hover:bg-red-50 hover:text-red-800 dark:text-red-400 dark:hover:bg-red-950"
              disabled={!isAdmin || saveCredsMutation.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              {saveCredsMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="size-4" aria-hidden />
              )}
              Удалить
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Выдаются в личном кабинете{' '}
          <a
            href={card.cabinetUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2"
          >
            bsms.t2.ru
          </a>{' '}
          при создании HTTP-рассылки (подраздел «Создать HTTP-рассылку» после согласования с Т2).
          Перед сохранением шифруются (AES-256-GCM), хранятся только на сервере и передаются
          шлюзу в каждом запросе; в панель не возвращаются.
        </p>
      </div>

      {/* Шаг 2 — имя отправителя (shortcode) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-full bg-amber-500/20 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
            2
          </span>
          <Label htmlFor="t2-sender">Имя отправителя (shortcode, по умолчанию)</Label>
        </div>
        <div className="flex gap-2">
          <Input
            id="t2-sender"
            value={senderDraft}
            onChange={(e) => setSenderDraft(e.target.value)}
            disabled={!isAdmin || activateMutation.isPending}
            placeholder="MyBrand"
            maxLength={11}
            className="max-w-[240px] font-mono"
          />
          {card.active ? (
            <Badge variant="secondary" className="h-9">
              активно для всех SMS
            </Badge>
          ) : (
            <Button
              type="button"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={!isAdmin || activateMutation.isPending || !credsSet}
              onClick={() => activateMutation.mutate()}
            >
              {activateMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Plug className="size-4" aria-hidden />
              )}
              Сделать активным
            </Button>
          )}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Разрешённое имя отправителя из договора с Т2: латиница/цифры без пробелов, до 11 символов
        </p>
      </div>

      {/* Шаг 3 — webhook статусов */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-full bg-amber-500/20 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
            3
          </span>
          <Label>Webhook статусов доставки</Label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-muted px-2.5 py-1.5 font-mono text-xs text-zinc-700 dark:text-zinc-300">
            {webhookUrl}
          </code>
          <CopyButton value={webhookUrl} label="URL webhook" />
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Передайте этот URL в поддержку Т2 для подключения автоматических уведомлений (GET-запрос с
          параметрами status/id/…).
          {card.webhook?.secretSet
            ? ' Значение параметра secret задано в .env (T2_WEBHOOK_SECRET) — добавьте ?secret=… к URL для Т2.'
            : ' Секрет не задан: коллбэки принимаются без проверки — для продакшена задайте T2_WEBHOOK_SECRET в .env и добавьте ?secret=… к URL.'}
        </p>
      </div>

      {/* Шаг 4 — проверка и тест */}
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          <ServerCog className="size-4 text-zinc-400" aria-hidden />
          Проверка и тестовая отправка
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Проверка без списаний: запрос статуса по несуществующей транзакции отличает
            «логин/пароль неверны» от «креды приняты»
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={!isAdmin || checkMutation.isPending || !credsSet}
            onClick={() => {
              setCheckResult(null);
              checkMutation.mutate();
            }}
          >
            {checkMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Webhook className="size-4" aria-hidden />
            )}
            Проверить подключение
          </Button>
        </div>
        {checkResult ? (
          <p
            className={cn(
              'rounded-lg px-3 py-2 text-sm',
              checkResult.ok
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400',
            )}
            role="status"
          >
            {checkResult.ok ? <Check className="mr-1 inline size-4" aria-hidden /> : null}
            {checkResult.detail}
          </p>
        ) : null}

        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="t2-test-phone">Тестовое SMS на номер</Label>
              <Input
                id="t2-test-phone"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                disabled={!isAdmin || testMutation.isPending}
                placeholder="+79001234567"
                className="font-mono"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="t2-test-text">Текст (необязательно)</Label>
              <Input
                id="t2-test-text"
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                disabled={!isAdmin || testMutation.isPending}
                placeholder="Тестовое сообщение Trigger"
                maxLength={480}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Реальная отправка реальному абоненту — попадает в SMS-лог
            </p>
            <Button
              type="button"
              disabled={!isAdmin || testMutation.isPending || !testPhone.trim() || !credsSet}
              onClick={() => {
                setTestResult(null);
                testMutation.mutate();
              }}
            >
              {testMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Send className="size-4" aria-hidden />
              )}
              Отправить тест
            </Button>
          </div>
          {testResult ? (
            testResult.ok ? (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" role="status">
                SMS принято шлюзом Т2 — транзакция <code className="font-mono">{testResult.code}</code>,{' '}
                {testResult.segments} сегм. Статус доставки придёт webhook-ом и появится в SMS-логе
              </p>
            ) : (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-400" role="status">
                {testResult.error ?? 'Отправка не удалась'}
              </p>
            )
          ) : null}
        </div>
      </div>

      {/* Справка — из документа «Бизнес SMS» (разделы 4/6/OMS) */}
      {limits ? (
        <div className="space-y-2 rounded-lg bg-muted p-3">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Параметры шлюза Т2</p>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400 sm:grid-cols-2">
            <div className="flex justify-between gap-2">
              <dt>Сегмент GSM-7 / UCS-2</dt>
              <dd className="text-right font-mono">
                {limits.segmentGsm7} · {limits.segmentUcs2}
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
            Один символ кириллицы переводит SMS в UCS-2. Для отладки клиентского ПО у Т2 есть
            симулятор API без реальной отправки — параметры идентичны боевым
          </p>
        </div>
      ) : null}

      {/* Подтверждение удаления доступов: секреты стираются из БД — на время
          тестов можно не рисковать реальной отправкой */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить доступы Т2?</AlertDialogTitle>
            <AlertDialogDescription>
              Логин и пароль будут стёрты из базы данных (хранятся зашифрованными). Отправка
              через Т2 станет недоступной — на время тестов включите «Песочницу» на её карточке.
              {card.active ? ' Сейчас Т2 — активный провайдер.' : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={saveCredsMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                saveCredsMutation.mutate({ login: '', password: '' });
              }}
            >
              {saveCredsMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ---------- Форма подключения МТС OmniChannel (HTTP API SMS V.1.14) ---------- */

/**
 * Форма подключения МТС OmniChannel — 4 шага: логин/пароль (system_id из
 * договора, Basic Auth) → нейминг sms_address → webhook статусов →
 * проверка/тест. Черновики — локальный стейт, в БД попадают только по кнопкам;
 * секреты в панель не возвращаются — card.configured и card.secret.hint (маска).
 * isAdmin блокирует все контролы для не-ADMIN (сервер дублирует RBAC).
 */
function MtsSetup({ card, isAdmin }: { card: IntegrationCard; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [loginDraft, setLoginDraft] = React.useState('');
  const [passwordDraft, setPasswordDraft] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [checkResult, setCheckResult] = React.useState<MtsCheckResponse | null>(null);
  const [testPhone, setTestPhone] = React.useState('');
  const [testText, setTestText] = React.useState('');
  const [senderDraft, setSenderDraft] = React.useState(card.defaultSenderName ?? '');
  const [testResult, setTestResult] = React.useState<MtsTestResponse | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // Приход карточки с сервера обновляет черновик имени отправителя
  // (например, после activate с другим senderName или загрузки карточки).
  React.useEffect(() => {
    setSenderDraft(card.defaultSenderName ?? '');
  }, [card.defaultSenderName]);

  // Сброс всего кэша запросов панели (invalidatePanel): карточки интеграций,
  // счётчики и логи перевчитываются после мутации.
  const invalidate = () => {
    invalidatePanel(queryClient);
  };

  // Сохранение логина/пароля подключения: поля → БД (на сервере), в панель не
  // возвращаются. Пустые значения в обоих полях — очистить креды.
  const saveCredsMutation = useMutation({
    mutationFn: (payload: { login: string; password: string }) =>
      api<SaveMtsCredentialsResponse>('/api/v1/integrations/mts/credentials', {
        method: 'POST',
        body: payload,
      }),
    onSuccess: (res) => {
      setLoginDraft('');
      setPasswordDraft('');
      setConfirmDelete(false);
      toast.success(
        res.credentialsSet ? 'Логин/пароль сохранены — интеграция МТС настроена' : 'Логин/пароль удалены',
      );
      if (!res.credentialsSet && card.active) {
        toast.info('МТС остался активным провайдером — для тестов без риска включите «Песочницу»');
      }
      invalidate();
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  // Назначение МТС активным провайдером (senderName — опционально, нейминг ≤11).
  const activateMutation = useMutation({
    mutationFn: () =>
      api<ActivateProviderResponse>('/api/v1/integrations/activate', {
        method: 'POST',
        body: {
          provider: 'mts',
          ...(senderDraft.trim() ? { senderName: senderDraft.trim() } : {}),
        },
      }),
    onSuccess: () => {
      toast.success('МТС OmniChannel назначен активным провайдером');
      invalidate();
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  // Проверка кредов «запросом статусов с пустым int_ids» — без списаний:
  // авторизация выполняется до валидации тела (см. mts.ts checkMtsConnection).
  const checkMutation = useMutation({
    mutationFn: () => api<MtsCheckResponse>('/api/v1/integrations/mts/check', { method: 'POST', body: {} }),
    onSuccess: (res) => setCheckResult(res),
    onError: (err) => setCheckResult({ ok: false, detail: errorDetail(err) }),
  });

  // Тестовая отправка реального SMS через МТС (SMS-лог, статусы придут
  // коллбэком / реконсиляцией /messages/info).
  const testMutation = useMutation({
    mutationFn: () =>
      api<MtsTestResponse>('/api/v1/integrations/mts/test', {
        method: 'POST',
        body: {
          phone: testPhone.trim(),
          ...(testText.trim() ? { text: testText.trim() } : {}),
          ...(senderDraft.trim() ? { sender: senderDraft.trim() } : {}),
        },
      }),
    onSuccess: (res) => {
      setTestResult(res);
      if (res.ok) {
        toast.success('Тестовое SMS отправлено');
        invalidatePanel(queryClient);
      } else {
        toast.error(`Отправка не удалась: ${res.error ?? 'ошибка'}`);
      }
    },
    onError: (err) => setTestResult({ ok: false, code: null, segments: 0, smsId: '', error: errorDetail(err) }),
  });

  const credsSet = card.configured;
  const webhookUrl = card.webhook?.url ?? '';
  const limits = card.limits;
  const canSaveCreds = loginDraft.trim().length >= 2 && passwordDraft.trim().length >= 4;
  // Акцент шагов — фирменный красный МТС
  const step = 'flex size-5 items-center justify-center rounded-full bg-red-600/15 text-[11px] font-semibold text-red-700 dark:text-red-400';

  return (
    <div className="space-y-5">
      {/* Шаг 1 — логин и пароль подключения (system_id из договора) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={step}>1</span>
          <Label>Логин и пароль подключения МТС (system_id)</Label>
        </div>
        {credsSet ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 dark:border-emerald-900 dark:bg-emerald-950/60">
            <ShieldCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
              Креды сохранены — интеграция настроена
            </span>
            {card.secret?.hint ? (
              <code className="rounded bg-emerald-100/80 px-1.5 py-0.5 font-mono text-xs text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300">
                {card.secret.hint}
              </code>
            ) : null}
          </div>
        ) : null}
        {card.secret?.stored === 'env' ? (
          <p className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <CircleAlert className="size-3.5 shrink-0" aria-hidden />
            Логин/пароль сейчас берутся из переменных окружения {card.secret.envName} — из панели
            они не удаляются (очистите переменные на сервере)
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-44">
            <Input
              id="mts-login"
              value={loginDraft}
              onChange={(e) => setLoginDraft(e.target.value)}
              disabled={!isAdmin || saveCredsMutation.isPending}
              placeholder={credsSet ? 'Новый логин — заменит сохранённый' : 'system_id из договора'}
              autoComplete="off"
              spellCheck={false}
              maxLength={128}
              className="font-mono"
            />
          </div>
          <div className="relative min-w-0 flex-1 basis-44">
            <Input
              id="mts-password"
              type={showPassword ? 'text' : 'password'}
              value={passwordDraft}
              onChange={(e) => setPasswordDraft(e.target.value)}
              disabled={!isAdmin || saveCredsMutation.isPending}
              placeholder="Пароль"
              autoComplete="off"
              spellCheck={false}
              maxLength={128}
              className="pr-10 font-mono"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              disabled={!isAdmin || saveCredsMutation.isPending || passwordDraft.length === 0}
              aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-zinc-400 transition-colors hover:text-zinc-600 disabled:pointer-events-none dark:hover:text-zinc-300"
            >
              {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </div>
          <Button
            type="button"
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={!isAdmin || saveCredsMutation.isPending || !canSaveCreds}
            onClick={() => saveCredsMutation.mutate({ login: loginDraft.trim(), password: passwordDraft.trim() })}
          >
            {saveCredsMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <KeyRound className="size-4" aria-hidden />
            )}
            {credsSet ? 'Заменить' : 'Сохранить'}
          </Button>
          {credsSet && card.secret?.stored !== 'env' ? (
            <Button
              type="button"
              variant="outline"
              className="text-red-700 hover:bg-red-50 hover:text-red-800 dark:text-red-400 dark:hover:bg-red-950"
              disabled={!isAdmin || saveCredsMutation.isPending}
              onClick={() => setConfirmDelete(true)}
            >
              {saveCredsMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Trash2 className="size-4" aria-hidden />
              )}
              Удалить
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Выдаются при заключении договора с МТС. <strong>Логин = system_id</strong> — технический
          логин интеграции из договора: это НЕ логин личного кабинета omnichannel.mts.ru и НЕ
          имя отправителя (нейминг). Авторизация — Basic Authentication в каждом запросе. Перед
          сохранением креды шифруются (AES-256-GCM), хранятся только на сервере; в панель не
          возвращаются.
        </p>
      </div>

      {/* Шаг 2 — имя отправителя (нейминг sms_address) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={step}>2</span>
          <Label htmlFor="mts-sender">Имя отправителя (нейминг sms_address, по умолчанию)</Label>
        </div>
        <div className="flex gap-2">
          <Input
            id="mts-sender"
            value={senderDraft}
            onChange={(e) => setSenderDraft(e.target.value)}
            disabled={!isAdmin || activateMutation.isPending}
            placeholder="MyBrand"
            maxLength={11}
            className="max-w-[240px] font-mono"
          />
          {card.active ? (
            <Badge variant="secondary" className="h-9">
              активно для всех SMS
            </Badge>
          ) : (
            <Button
              type="button"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={!isAdmin || activateMutation.isPending || !credsSet}
              onClick={() => activateMutation.mutate()}
            >
              {activateMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Plug className="size-4" aria-hidden />
              )}
              Сделать активным
            </Button>
          )}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Сервисный номер (нейминг), выделенный МТС по заявлению: латиница/цифры/дефис, до 11 символов
        </p>
      </div>

      {/* Шаг 3 — webhook статусов (коллбэк МТС) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={step}>3</span>
          <Label>Webhook статусов доставки (коллбэк)</Label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-muted px-2.5 py-1.5 font-mono text-xs text-zinc-700 dark:text-zinc-300">
            {webhookUrl}
          </code>
          <CopyButton value={webhookUrl} label="URL webhook" />
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Передайте этот URL вашему персональному менеджеру МТС (поддерживаются доменные имена,
          порты 80/443/5070). Платформа шлёт POST-запросы c JSON-телом {'{items:[…]}'} — наш ответ 200 OK.
          {card.webhook?.secretSet
            ? ' Значение параметра secret задано в .env (MTS_WEBHOOK_SECRET) — добавьте ?secret=… к URL для МТС.'
            : ' Секрет НЕ задан: коллбэки принимаются без проверки — задайте MTS_WEBHOOK_SECRET в .env и добавьте ?secret=… к URL, иначе любой, знающий URL, сможет влиять на статусы доставки.'}
        </p>
      </div>

      {/* Шаг 4 — проверка и тест */}
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          <ServerCog className="size-4 text-zinc-400" aria-hidden />
          Проверка и тестовая отправка
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Проверка без списаний: запрос статусов с пустым списком идентификаторов —
            авторизация проверяется до валидации тела
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={!isAdmin || checkMutation.isPending || !credsSet}
            onClick={() => {
              setCheckResult(null);
              checkMutation.mutate();
            }}
          >
            {checkMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Webhook className="size-4" aria-hidden />
            )}
            Проверить подключение
          </Button>
        </div>
        {checkResult ? (
          <p
            className={cn(
              'rounded-lg px-3 py-2 text-sm',
              checkResult.ok
                ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300'
                : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400',
            )}
            role="status"
          >
            {checkResult.ok ? <Check className="mr-1 inline size-4" aria-hidden /> : null}
            {checkResult.detail}
          </p>
        ) : null}
        {checkResult && !checkResult.ok && checkResult.detail.includes('отклонены') ? (
          <div className="space-y-1.5 rounded-lg border border-red-200 bg-red-50/60 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            <p className="text-[13px] font-semibold">Что проверить</p>
            <ol className="ml-4 list-decimal space-y-1">
              <li>
                Логин — это <strong className="font-semibold">system_id из договора</strong> с МТС.
                Не логин личного кабинета omnichannel.mts.ru, не имя отправителя (нейминг) и не
                название компании.
              </li>
              <li>
                Пароль — без опечаток и лишних символов (поле не обрезается, значение видно
                кнопкой «глаз»; пробелы по краям снимаются автоматически).
              </li>
              <li>
                Активация: уточните у персонального менеджера МТС, заведён ли system_id и
                включена ли HTTP-интеграция — после подписания договора заведение занимает
                время.
              </li>
              <li>
                IP-ограничения: если МТС ограничил шлюз списком ваших адресов, проверка из этой
                песочницы всегда даст отказ — финальную приёмку выполняйте кнопкой «Отправить
                тест» с боевого сервера.
              </li>
            </ol>
            <p className="text-red-700/80 dark:text-red-400/80">
              Код 804 в этом ответе — особенность живого шлюза МТС: в документации V.1.14 код
              804 означает «content is required», а отказ кредов описан кодом 802; реальный
              шлюз на запросе статусов отвечает 804 с сообщением «Bad credentials» —
              доверяйте сообщению, а не коду.
            </p>
          </div>
        ) : null}

        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="mts-test-phone">Тестовое SMS на номер</Label>
              <Input
                id="mts-test-phone"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                disabled={!isAdmin || testMutation.isPending}
                placeholder="+79001234567"
                className="font-mono"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="mts-test-text">Текст (необязательно)</Label>
              <Input
                id="mts-test-text"
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                disabled={!isAdmin || testMutation.isPending}
                placeholder="Тестовое сообщение Trigger"
                maxLength={480}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Реальная отправка реальному абоненту — попадает в SMS-лог
            </p>
            <Button
              type="button"
              disabled={!isAdmin || testMutation.isPending || !testPhone.trim() || !credsSet}
              onClick={() => {
                setTestResult(null);
                testMutation.mutate();
              }}
            >
              {testMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Send className="size-4" aria-hidden />
              )}
              Отправить тест
            </Button>
          </div>
          {testResult ? (
            testResult.ok ? (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" role="status">
                SMS принято платформой МТС — идентификатор <code className="font-mono">{testResult.code}</code>,{' '}
                {testResult.segments} сегм. Статус доставки придёт коллбэком и появится в SMS-логе
              </p>
            ) : (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-400" role="status">
                {testResult.error ?? 'Отправка не удалась'}
              </p>
            )
          ) : null}
        </div>
      </div>

      {/* Справка — из документа V.1.14 (разделы «Лимиты и ограничения»/«Получение статусов») */}
      {limits ? (
        <div className="space-y-2 rounded-lg bg-muted p-3">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Параметры платформы МТС</p>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400 sm:grid-cols-2">
            <div className="flex justify-between gap-2">
              <dt>Сегмент GSM-7 / UCS-2</dt>
              <dd className="text-right font-mono">
                {limits.segmentGsm7} · {limits.segmentUcs2}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Ожидание статуса доставки</dt>
              <dd className="text-right font-mono">до {limits.statusWaitDays} сут. (ttl_sec)</dd>
            </div>
          </dl>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-500">
            Рекомендация платформы: до 10 сегментов на SMS (670 симв. кириллицы / 1530 латиницы),
            до 1000 получателей в одном запросе, до 500 идентификаторов в запросе статусов.
            Для отладки доступно STAGE-окружение с эмулятором (задаётся переменной MTS_BASE_URL на сервере).
          </p>
        </div>
      ) : null}

      {/* Подтверждение удаления доступов: секреты стираются из БД — на время
          тестов можно не рисковать реальной отправкой */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить доступы МТС?</AlertDialogTitle>
            <AlertDialogDescription>
              Логин и пароль будут стёрты из базы данных (хранятся зашифрованными). Отправка
              через МТС станет недоступной — на время тестов включите «Песочницу» на её карточке.
              {card.active ? ' Сейчас МТС — активный провайдер.' : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={saveCredsMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                saveCredsMutation.mutate({ login: '', password: '' });
              }}
            >
              {saveCredsMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ---------- Формы прочих провайдеров ---------- */

/**
 * Упрощённая форма для прочих карточек (фактически — «Песочница»): заметка
 * note + webhook (если есть) + кнопка «Сделать активным»; тело активации
 * передаётся снаружи (activateBody), т.к. секретов форма не сохраняет.
 */
function GenericSetup({
  card,
  isAdmin,
  activateBody,
  note,
}: {
  card: IntegrationCard;
  isAdmin: boolean;
  activateBody: Record<string, unknown>;
  note: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const activateMutation = useMutation({
    mutationFn: () =>
      api<ActivateProviderResponse>('/api/v1/integrations/activate', {
        method: 'POST',
        body: activateBody,
      }),
    onSuccess: () => {
      toast.success(`«${card.displayName}» назначен активным провайдером`);
      invalidatePanel(queryClient);
          },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  return (
    <div className="space-y-4">
      {note}
      {card.webhook?.url ? (
        <div className="space-y-1.5">
          <Label>Webhook статусов доставки</Label>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg border border-border bg-muted px-2.5 py-1.5 font-mono text-xs text-zinc-700 dark:text-zinc-300">
              {card.webhook.url}
            </code>
            <CopyButton value={card.webhook.url} label="URL webhook" />
          </div>
        </div>
      ) : null}
      {!card.active ? (
        <Button
          type="button"
          variant={card.kind === 'sandbox' ? 'outline' : 'default'}
          className={card.kind === 'sandbox' ? undefined : 'bg-emerald-600 text-white hover:bg-emerald-700'}
          disabled={!isAdmin || activateMutation.isPending}
          onClick={() => activateMutation.mutate()}
        >
          {activateMutation.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Plug className="size-4" aria-hidden />
          )}
          Сделать активным
        </Button>
      ) : null}
    </div>
  );
}

/* ---------- Экран «Интеграции» ---------- */

/* ---------- «Захват событий»: тумблер + приёмник + тест ---------- */

/** Конфигурация «Захвата событий» из GET /api/v1/hooks: тумблер, токен, URL приёмника, статистика журнала. */
interface HooksConfig {
  enabled: boolean;
  token: string;
  tokenSet: boolean;
  path: string;
  url: string;
  method: string;
  eventsTotal: number;
  lastEventAt: string | null;
  tokenGenerated?: boolean;
}

/* ---------- Карточка «Интеграция с системой данных» (наблюдаемость, G7) ---------- */

/** Ответ GET /api/v1/integrations/status (см. services/integration-status.ts). */
interface IntegrationStatus {
  generatedAt: string;
  inbox: {
    new: number;
    processing: number;
    failed: number;
    processed24h: number;
    failed24h: number;
    lastIngestAt: string | null;
    lastIngestEvent: string | null;
    oldestNewAt: string | null;
    lagSeconds: number | null;
  };
  imports: { pending: number; processed24h: number };
  funnels: { active: number };
  broadcasts: { active: number; smsQueued: number; smsSending: number; smsDue: number };
  sms: { sent24h: number; delivered24h: number; failed24h: number };
  forwarder: {
    pending: number;
    skipped: number;
    inRetry: number;
    forwarded24h: number;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    lastError: string | null;
  };
  worker: { lastTickAt: string | null; tickCount: number; lastTickAgoSeconds: number | null };
  provider: string;
}

/** Лаг-бейдж: <15 с — норма (тик воркера), <60 — внимание, ≥60 — голод. */
function LagBadge({ seconds }: { seconds: number | null }) {
  if (seconds === null) {
    return (
      <Badge variant="outline" className="border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        очередь пуста
      </Badge>
    );
  }
  const tone =
    seconds < 15
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400'
      : seconds < 60
        ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-400'
        : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-400';
  return <Badge className={tone}>лаг {seconds.toLocaleString('ru-RU')} с</Badge>;
}

/**
 * Карточка «Интеграция с системой данных» (G7; бывшая «Приём событий из системы
 * данных» — переименована в Task 59): здоровье конвейера «ядро → Trigger →
 * провайдер → BI» — глубина/лаг приёма событий, поток импорта, очереди
 * рассылок, обороты SMS, свежесть воркера. Обновление раз в 15 с (refetch).
 * Эндпоинты приёма — справка для команды адаптера ядра (URL копируемый).
 * Имя и строка-пояснение «что это за поток» — по мотивам вопроса владельца
 * (Task 57): это мониторинг существующей трубы событий из системы данных,
 * а не новая разработка.
 */
function IntegrationStatusCard() {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['integration-status'],
    queryFn: () => api<IntegrationStatus>('/api/v1/integrations/status'),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  if (isPending) {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-4">
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-4">
          <ErrorState error={error} onRetry={() => void refetch()} />
        </CardContent>
      </Card>
    );
  }

  const workerOk = data.worker.lastTickAgoSeconds !== null && data.worker.lastTickAgoSeconds <= 15;
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-600 dark:text-teal-400"
            aria-hidden
          >
            <ServerCog className="size-5" />
          </div>
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Интеграция с системой данных
              <LagBadge seconds={data.inbox.lagSeconds} />
              {data.inbox.failed > 0 ? (
                <Badge className="border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-400">
                  упавших: {data.inbox.failed.toLocaleString('ru-RU')}
                </Badge>
              ) : null}
            </CardTitle>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Обмен с внешней системой данных: статусы клиентов из внешней системы
              обновляют карточки и запускают
              воронки — тот же поток, которым питалась legacy-платформа
            </p>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Здоровье конвейера «ядро → Trigger → провайдер → BI» · обновление 15 с
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Метрики конвейера */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {[
            { label: 'События в очереди', value: data.inbox.new, hint: 'NEW, ждут воркера' },
            { label: 'Обработано за 24 ч', value: data.inbox.processed24h, hint: 'триггерные + импорт' },
            { label: 'Импорт в очереди', value: data.imports.pending, hint: 'skip_triggers-строки' },
            { label: 'Активных воронок', value: data.funnels.active, hint: 'запущены маркетологами' },
            { label: 'SMS к отправке', value: data.broadcasts.smsQueued + data.broadcasts.smsSending + data.broadcasts.smsDue, hint: 'очередь + в полёте' },
            { label: 'Отправлено (24ч)', value: data.sms.sent24h, hint: `доставлено: ${data.sms.delivered24h.toLocaleString('ru-RU')}` },
          ].map((m) => (
            <div key={m.label} className="rounded-lg border bg-muted/40 p-3">
              <p className="text-lg font-semibold tabular-nums text-foreground">
                {m.value.toLocaleString('ru-RU')}
              </p>
              <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{m.label}</p>
              <p className="mt-0.5 text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">{m.hint}</p>
            </div>
          ))}
        </div>

        {/* Воркер + последние события */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="flex items-center gap-1.5">
            <span
              className={cn('size-2 rounded-full', workerOk ? 'bg-emerald-500' : 'bg-amber-500')}
              aria-hidden
            />
            Воркер: тик {data.worker.lastTickAgoSeconds !== null ? `${data.worker.lastTickAgoSeconds} с назад` : 'не запускался'}
            {' · '}№{data.worker.tickCount.toLocaleString('ru-RU')}
          </span>
          {data.inbox.lastIngestAt ? (
            <span>
              Последнее событие: {new Date(data.inbox.lastIngestAt).toLocaleString('ru-RU')}
              {data.inbox.lastIngestEvent ? ` (${data.inbox.lastIngestEvent})` : ''}
            </span>
          ) : (
            <span>События ещё не приходили</span>
          )}
          {data.inbox.failed24h > 0 ? (
            <span className="text-red-600 dark:text-red-400">
              Ошибок обработки за 24 ч: {data.inbox.failed24h.toLocaleString('ru-RU')} — см. «События»
            </span>
          ) : null}
        </div>

        {/* Эндпоинты приёма — справка для команды адаптера внешней системы */}
        <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
            Эндпоинты приёма (для команды адаптера внешней системы данных)
          </p>
          {[
            { path: '/api/v1/events', note: 'одно событие · 202 {eventId, duplicate} · дедуп idempotency_key' },
            { path: '/api/v1/events/batch', note: 'батч ≤10 000 строк / ≤10 МБ · skip_triggers — импорт карточек без запуска воронок' },
          ].map((e) => (
            <div key={e.path} className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs">
                POST {baseUrl}
                {e.path}
              </code>
              <CopyButton value={`${baseUrl}${e.path}`} label="URL эндпоинта" />
            </div>
          ))}
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Авторизация: заголовок <code className="font-mono">X-Api-Key</code> (ключи — блок
            «API-ключи» ниже на этой вкладке, там же повышенный лимит запросов/мин для
            интеграционного ключа). Контракт — «Документация» в панели.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/* ---------- Карточка «Обратный поток событий» (форвардер, G3) ---------- */

/** Ответ GET/PUT /api/v1/integrations/forwarder. */
interface ForwarderConfig {
  enabled: boolean;
  url: string;
  tokenSet: boolean;
  tokenHint: string | null;
  batchSize: number;
  eventTypes: string[];
  authHeader: string;
  pending: number;
  skipped: number;
  inRetry: number;
  forwarded24h: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

/**
 * Карточка «Обратный поток»: отправка событий send/deliv/undel_sms во внешний
 * приёмник (messenger → BI-отчёты), формат обмена событиями. Тумблер (включение
 * чистит накопленную очередь — в BI летит с момента включения), URL/токен/
 * размер батча (PUT), проверка связности (POST /forwarder/test), статистика
 * доставки (обновление 15 с).
 */
function ForwarderCard({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { canWrite } = useRole();
  const [urlDraft, setUrlDraft] = React.useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = React.useState('');
  const [batchDraft, setBatchDraft] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<string | null>(null);
  const [enableOpen, setEnableOpen] = React.useState(false);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['forwarder'],
    queryFn: () => api<ForwarderConfig>('/api/v1/integrations/forwarder'),
    refetchInterval: 15_000,
    staleTime: 10_000,
    enabled: canWrite,
  });

  function invalidateForwarder() {
    void queryClient.invalidateQueries({ queryKey: ['forwarder'] });
    void queryClient.invalidateQueries({ queryKey: ['integration-status'] });
  }

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ForwarderConfig>('/api/v1/integrations/forwarder', { method: 'PUT', body }),
    onSuccess: () => {
      toast.success('Настройки обратного потока сохранены');
      setTokenDraft('');
      invalidateForwarder();
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ enabled: boolean; skippedBacklog?: number }>('/api/v1/integrations/forwarder', {
        method: 'POST',
        body: { enabled },
      }),
    onSuccess: (res) => {
      toast.success(
        res.enabled
          ? `Обратный поток включён${res.skippedBacklog ? ` (накопленные ${res.skippedBacklog.toLocaleString('ru-RU')} событий пропущены — в BI летят новые)` : ''}`
          : 'Обратный поток выключен — очередь замирает до следующего включения',
      );
      invalidateForwarder();
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  const testMutation = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; url: string; tokenAttached: boolean; error: string | null }>(
        '/api/v1/integrations/forwarder/test',
        { method: 'POST', body: {} },
      ),
    onSuccess: (res) => {
      if (res.ok) {
        setTestResult(`Приёмник ответил успехом (2xx) на тестовое событие send_sms`);
        toast.success('Связность с приёмником подтверждена');
      } else {
        setTestResult(`Приёмник отклонил тестовое событие: ${res.error ?? 'нет ответа'}`);
        toast.error('Тест обратного потока не прошёл');
      }
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  if (!canWrite) {
    return null; // конфигурация недоступна VIEWER — карточка скрыта
  }
  if (isPending) {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-4">
          <Skeleton className="h-48 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-4">
          <ErrorState error={error} onRetry={() => void refetch()} />
        </CardContent>
      </Card>
    );
  }

  const urlValue = urlDraft ?? data.url;
  const batchValue = batchDraft ?? String(data.batchSize);
  const batchDirty = batchValue !== String(data.batchSize);
  const urlDirty = urlValue !== data.url;
  const saveDisabled = !isAdmin || saveMutation.isPending || (!urlDirty && !batchDirty && tokenDraft.trim() === '');

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-600 dark:text-cyan-400"
              aria-hidden
            >
              <Send className="size-5" />
            </div>
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Обратный поток событий
                {data.enabled ? (
                  <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400">
                    <BadgeCheck className="mr-1 size-3" aria-hidden /> Включён
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                    Выключен
                  </Badge>
                )}
                {data.pending > 0 ? (
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-400">
                    в очереди: {data.pending.toLocaleString('ru-RU')}
                  </Badge>
                ) : null}
              </CardTitle>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                События отправок и доставок → внешний приёмник → BI-отчёты · формат «Захвата событий» 1:1
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={data.enabled}
              disabled={!isAdmin || toggleMutation.isPending || !data.url}
              onCheckedChange={(checked) => {
                if (checked) setEnableOpen(true);
                else toggleMutation.mutate(false);
              }}
              aria-label="Тумблер обратного потока"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.url ? (
          <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Укажите endpoint приёмника (URL и токен выдаст владелец внешней системы) и сохраните — затем включайте поток.
          </p>
        ) : null}

        {/* Настройки: URL / токен / размер батча */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="forwarder-url">URL приёмника</Label>
            <Input
              id="forwarder-url"
              value={urlValue}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://…/v1/altcraft/sms"
              disabled={!isAdmin}
              className="font-mono text-xs"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="forwarder-token">
              Токен приёмника {data.tokenSet ? `(задан: ${data.tokenHint ?? '•••'})` : '(не задан)'}
            </Label>
            <Input
              id="forwarder-token"
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder={data.tokenSet ? 'новый токен — оставьте пустым, чтобы не менять' : 'Bearer-токен приёмника'}
              disabled={!isAdmin}
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="forwarder-batch">Событий в батче (10–2000)</Label>
            <Input
              id="forwarder-batch"
              inputMode="numeric"
              value={batchValue}
              onChange={(e) => setBatchDraft(e.target.value)}
              disabled={!isAdmin}
              className="max-w-40"
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              size="sm"
              onClick={() =>
                saveMutation.mutate({
                  url: urlValue.trim(),
                  ...(tokenDraft.trim() !== '' ? { token: tokenDraft.trim() } : {}),
                  ...(batchDirty ? { batchSize: Number.parseInt(batchValue, 10) || data.batchSize } : {}),
                })
              }
              disabled={saveDisabled}
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
              ) : (
                <Check className="mr-1.5 size-3.5" aria-hidden />
              )}
              Сохранить настройки
            </Button>
          </div>
        </div>

        {/* Статистика доставки */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: 'В очереди', value: data.pending },
            { label: 'Доставлено за 24 ч', value: data.forwarded24h },
            { label: 'Ожидают ретрая', value: data.inRetry },
            { label: 'Пропущено (до включения)', value: data.skipped },
          ].map((m) => (
            <div key={m.label} className="rounded-lg border bg-muted/40 p-3">
              <p className="text-lg font-semibold tabular-nums text-foreground">
                {m.value.toLocaleString('ru-RU')}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{m.label}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          {data.lastSuccessAt ? (
            <span>Успешная доставка: {new Date(data.lastSuccessAt).toLocaleString('ru-RU')}</span>
          ) : data.enabled ? (
            <span>Доставок ещё не было — очередь наполнится первой реальной отправкой</span>
          ) : (
            <span>Поток выключен</span>
          )}
          {data.lastError ? (
            <span className="text-red-600 dark:text-red-400">
              Последняя ошибка: {data.lastError.slice(0, 160)}
            </span>
          ) : null}
        </div>

        {testResult ? (
          <p
            className={cn(
              'rounded-lg border px-3 py-2 text-xs',
              testResult.includes('успехом')
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300'
                : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300',
            )}
          >
            {testResult}
          </p>
        ) : null}

        {/* Действия */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => testMutation.mutate()}
            disabled={!isAdmin || !data.url || testMutation.isPending}
          >
            {testMutation.isPending ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
            ) : (
              <FlaskConical className="mr-1.5 size-3.5" aria-hidden />
            )}
            Проверить связность
          </Button>
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Типы событий: send_sms / deliv_sms / undeliv_sms · авторизация:{' '}
          <code className="font-mono">{data.authHeader}</code> · доставка at-least-once
          (ретраи 15 с ×4 → 5/15/60 мин), дедуп на стороне приёмника по event_type+message_id ·
          песочница и внешние события не форвардятся.
        </p>

        {/* Подтверждение включения */}
        <AlertDialog open={enableOpen} onOpenChange={setEnableOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Включить обратный поток?</AlertDialogTitle>
              <AlertDialogDescription>
                В BI начнут поступать события с момента включения. Накопленные ранее
                события (песочница, период до включения) будут помечены пропущенными и не
                отправятся. Убедитесь, что URL и токен проверены кнопкой «Проверить связность».
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Отмена</AlertDialogCancel>
              <AlertDialogAction
                disabled={toggleMutation.isPending}
                onClick={() => toggleMutation.mutate(true)}
              >
                Включить
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

/**
 * Карточка «Захват событий» (журнал «кому какие СМС отправили и что с ними
 * стало»): тумблер записи (PUT /api/v1/hooks), URL приёмника с токеном,
 * чек-лист настройки у отправителя, тестовое событие (POST /api/v1/hooks/test)
 * и ротация токена (POST /api/v1/hooks/token). Переход к журналу —
 * setView('delivery').
 */
function EventCaptureCard({ isAdmin }: { isAdmin: boolean }) {
  const setView = useAppStore((s) => s.setView);
  const queryClient = useQueryClient();
  const { canWrite } = useRole();
  const [rotateOpen, setRotateOpen] = React.useState(false);
  const [testResult, setTestResult] = React.useState<string | null>(null);

  // Конфигурация (с токеном приёмника) доступна MANAGER+ — сервер отдаёт её
  // только с ролью не ниже Менеджера (токен = write-креденшл приёмника);
  // VIEWER'у не запрашиваем вовсе (иначе ErrorState-403 вместо понятного текста).
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['hooks'],
    queryFn: () => api<HooksConfig>('/api/v1/hooks'),
    staleTime: 30_000,
    enabled: canWrite,
  });

  // После мутаций обновляем и конфигурацию hooks, и счётчики журнала
  // «События доставки» (message-events).
  function invalidateHooks() {
    void queryClient.invalidateQueries({ queryKey: ['hooks'] });
    void queryClient.invalidateQueries({ queryKey: ['message-events'] });
  }

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api<HooksConfig>('/api/v1/hooks', { method: 'PUT', body: { enabled } }),
    onSuccess: (res) => {
      toast.success(
        res.enabled
          ? 'Захват событий включён'
          : 'Захват событий выключен — события не записываются, приёмник отвечает OK',
      );
      invalidateHooks();
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  const rotateMutation = useMutation({
    mutationFn: () => api<HooksConfig>('/api/v1/hooks/token', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Токен перегенерирован — обновите URL в настройках отправителя');
      invalidateHooks();
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  const testMutation = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; summary: { created: number; duplicates: number }; sms: { id: string; status: string } | null; phone: string }>(
        '/api/v1/hooks/test',
        { method: 'POST', body: {} },
      ),
    onSuccess: (res) => {
      invalidateHooks();
      if (res.ok) {
        setTestResult(
          `Событие deliv_sms прошло весь конвейер: записано в журнал, SMS ${res.phone} → ${res.sms?.status ?? 'без изменений'}`,
        );
        toast.success('Тестовое событие обработано — см. «События доставки»');
      } else {
        setTestResult('Событие не записано (дубль ретрая) — повторите через минуту');
        toast.info('Тестовое событие не создано (дубль) — повторите через минуту');
      }
    },
    onError: (err) => toast.error(`Ошибка: ${errorDetail(err)}`),
  });

  // VIEWER: конфигурация недоступна на уровне сервера — рендерим понятное
  // пояснение вместо ErrorState-403 (после всех хуков — правила React).
  if (!canWrite) {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Конфигурация «Захвата событий» доступна ролям «Менеджер» и «Администратор»
            (URL приёмника содержит токен записи). Журнал событий доставки — вкладка
            «События доставки».
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isPending) {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-4">
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-4">
          <ErrorState error={error} onRetry={() => void refetch()} />
        </CardContent>
      </Card>
    );
  }

  // Полный URL приёмника с токеном в query — только если токен есть;
  // копируется как одна строка для вставки в настройки отправителя.
  const receiverUrl = data.tokenSet && data.token ? `${data.url}?token=${data.token}` : '';

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-600 dark:text-violet-400"
              aria-hidden
            >
              <Radio className="size-5" />
            </div>
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Захват событий
                {data.enabled ? (
                  <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400">
                    <BadgeCheck className="mr-1 size-3" aria-hidden /> Включён
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                    Выключен
                  </Badge>
                )}
              </CardTitle>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                Журнал «кому какие СМС отправили и что с ними стало» — панель, шлюзы и внешние системы
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={data.enabled}
              disabled={!isAdmin || toggleMutation.isPending}
              onCheckedChange={(checked) => toggleMutation.mutate(checked)}
              aria-label="Тумблер захвата событий"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.enabled ? (
          <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Захват выключен: приёмник подтверждает приём (OK), но события не записываются; журналирование
            webhook-ов и реконсиляция остановлены. Статусы доставки в SMS-логе работают как раньше.
          </p>
        ) : null}

        {/* URL приёмника + токен */}
        <div className="space-y-1.5">
          <Label>URL приёмника (для внешних систем)</Label>
          {receiverUrl ? (
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2.5 py-2 font-mono text-xs">
                {receiverUrl}
              </code>
              <CopyButton value={receiverUrl} label="URL приёмника" />
            </div>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Токен не сгенерирован — включите тумблер (токен создастся автоматически) или перегенерируйте.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span>Событий в журнале: {data.eventsTotal.toLocaleString('ru-RU')}</span>
            {data.lastEventAt ? <span>· последнее: {new Date(data.lastEventAt).toLocaleString('ru-RU')}</span> : null}
          </div>
        </div>

        {/* Чек-лист настройки захвата в платформе рассылок */}
        <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
            Настройка в личном кабинете платформы рассылок (Интеграции → Захват событий)
          </p>
          <ul className="space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <li className="flex gap-1.5">
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              Имя — например <code className="font-mono">SMS_Send_Hook</code>, база — «1 — API JM», действие — Send
              SMS (send_sms), фильтры не применять
            </li>
            <li className="flex gap-1.5">
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              Тип запроса «Отправить JSON-запрос батчем», URL — выше, без авторизации
            </li>
            <li className="flex gap-1.5">
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              Опция «Добавить содержимое сообщений» — активировать (текст SMS и отправитель придут в content)
            </li>
            <li className="flex gap-1.5">
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              {/* min-w-0: инлайн-контент (текст + code) единым блоком — переносится
                  на мобильном, а не расползается анонимными flex-item в hScroll */}
              <span className="min-w-0">
                custom_data: <code className="font-mono">client_id</code>,{' '}
                <code className="font-mono">campaign_name: &#123;&#123;campaign_name&#125;&#125;</code>,{' '}
                <code className="font-mono">message_name: &#123;&#123;message_name&#125;&#125;</code>
              </span>
            </li>
            <li className="flex gap-1.5">
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              «Успех если найдена строка»: <code className="font-mono">.*OK.*</code> (или пусто — любой 200)
            </li>
            <li className="flex gap-1.5">
              <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              Ретраи отправителя (4 раза / 15 с) не создают дублей — идемпотентный приём
            </li>
          </ul>
        </div>

        {testResult ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300">
            {testResult}
          </p>
        ) : null}

        {/* Действия */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => testMutation.mutate()}
            disabled={!isAdmin || !data.enabled || testMutation.isPending}
          >
            {testMutation.isPending ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
            ) : (
              <FlaskConical className="mr-1.5 size-3.5" aria-hidden />
            )}
            Отправить тестовое событие
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setView('delivery')}>
            <Send className="mr-1.5 size-3.5" aria-hidden />
            Журнал «События доставки»
          </Button>
          {isAdmin ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-zinc-500"
              onClick={() => setRotateOpen(true)}
              disabled={!data.tokenSet || rotateMutation.isPending}
            >
              <KeyRound className="mr-1.5 size-3.5" aria-hidden />
              Перегенерировать токен
            </Button>
          ) : null}
        </div>

        {/* Подтверждение ротации токена */}
        <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Перегенерировать токен приёмника?</AlertDialogTitle>
              <AlertDialogDescription>
                Старый URL перестанет работать сразу: отправитель начнёт получать 401 и повторять
                отправку. После ротации скопируйте новый URL и обновите его в настройках захвата.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Отмена</AlertDialogCancel>
              <AlertDialogAction
                // анти-двойной клик: блокируем кнопку, пока идёт запрос
                disabled={rotateMutation.isPending}
                onClick={() => rotateMutation.mutate()}
              >
                Перегенерировать
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

/** Раздел «Интеграций» (значение поднавигации; 'data-system' живёт в view='integrations'). */
type IntegrationsTab = 'data-system' | 'providers';

/** Активный раздел по view из стора (?view=api-keys и ?view=sms-providers — рабочие ссылки). */
const INTEGRATIONS_TAB_BY_VIEW: Partial<Record<View, IntegrationsTab>> = {
  integrations: 'data-system',
  'api-keys': 'data-system',
  'sms-providers': 'providers',
};

/**
 * Раздел «SMS-провайдеров»: сетка карточек провайдеров (выбор кликом,
 * selected — локальный стейт, дефолт SMS.Tech, сбой выбора откатывается
 * к первой карточке) + форма выбранного подключения (Smstech/T2/МТС/
 * Generic) + контакты шлюзов. Данные — один GET /api/v1/integrations
 * (staleTime 30 с); loading → Skeleton, ошибка → ErrorState с retry.
 */
function ProvidersSection({ isAdmin }: { isAdmin: boolean }) {
  const [selected, setSelected] = React.useState<string>('smstech');
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api<IntegrationsResponse>('/api/v1/integrations'),
    staleTime: 30_000,
  });

  if (isPending) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (error || !data) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  const cards = data.providers;
  const activeCard = cards.find((c) => c.id === selected) ?? cards[0];

  return (
    <div className="space-y-4">
      {/* Карточки провайдеров — маркетплейс подключений */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => {
          const isSelected = card.id === activeCard.id;
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => setSelected(card.id)}
              aria-pressed={isSelected}
              className={cn(
                'flex flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:shadow',
                isSelected
                  ? 'border-emerald-500 ring-1 ring-emerald-500/40'
                  : 'border-border hover:border-zinc-300 dark:hover:border-zinc-700',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <ProviderGlyph id={card.id} />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">{card.displayName}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{card.description}</p>
              </div>
              <StatusBadges card={card} />
            </button>
          );
        })}
      </div>

      {/* Форма выбранного подключения */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {activeCard.title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activeCard.id === 'smstech' ? (
            <SmstechSetup card={activeCard} isAdmin={isAdmin} />
          ) : activeCard.id === 't2' ? (
            <T2Setup card={activeCard} isAdmin={isAdmin} />
          ) : activeCard.id === 'mts' ? (
            <MtsSetup card={activeCard} isAdmin={isAdmin} />
          ) : (
            <GenericSetup
              card={activeCard}
              isAdmin={isAdmin}
              activateBody={{ provider: 'sandbox' }}
              note={
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Песочница всегда «настроена»: сообщения мгновенно получают статус «доставлено»,
                  реальной отправки и списаний нет. Используется для разработки, приёмки и демо.
                </p>
              }
            />
          )}
        </CardContent>
      </Card>

      {/* Куда идти дальше — контакты шлюзов */}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Личные кабинеты: SMS.Tech —{' '}
        <a
          href="https://hub.sms.tech"
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-2"
        >
          hub.sms.tech
        </a>{' '}
        (поддержка info@sms.tech) · Т2 —{' '}
        <a
          href="https://bsms.t2.ru"
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-2"
        >
          bsms.t2.ru
        </a>{' '}
        · МТС OmniChannel —{' '}
        <a
          href="https://omnichannel.mts.ru"
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-2"
        >
          omnichannel.mts.ru
        </a>
      </p>
    </div>
  );
}

/**
 * Экран «Интеграции» (Task 59): поднавигация из двух разделов. «Интеграция
 * с системой данных» — всё об обмене с внешней системой в одном месте:
 * мониторинг трубы событий, API-ключи приёма (бывший отдельный экран),
 * «Захват событий» и «Обратный поток событий». «SMS-провайдеры» —
 * подключения отправки. Выбор раздела пишется в стор (setView) — URL
 * остаётся шаримым (?view=sms-providers, ?view=api-keys) и переживает F5;
 * forceMount + скрытие неактивных — черновики форм и открытые диалоги
 * не теряются при переключении раздела.
 */
export function IntegrationsView() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const { isAdmin } = useRole();
  const tab: IntegrationsTab = INTEGRATIONS_TAB_BY_VIEW[view] ?? 'data-system';

  return (
    <div className="max-w-4xl">
      <Tabs
        value={tab}
        onValueChange={(v) => setView(v === 'data-system' ? 'integrations' : 'sms-providers')}
      >
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 sm:w-auto">
          <TabsTrigger value="data-system" className="gap-2">
            <Database className="size-4" aria-hidden />
            Интеграция с системой данных
          </TabsTrigger>
          <TabsTrigger value="providers" className="gap-2">
            <Smartphone className="size-4" aria-hidden />
            SMS-провайдеры
          </TabsTrigger>
        </TabsList>

        {/* forceMount: черновики форм и диалоги переживают уход в другой раздел */}
        <TabsContent
          forceMount
          value="data-system"
          className="mt-4 space-y-4 data-[state=inactive]:hidden"
        >
          {/* «Интеграция с системой данных» — мониторинг трубы (G7) */}
          <IntegrationStatusCard />

          {/* Ключи приёма событий — креденты той же трубы (бывший экран сайдбара) */}
          <ApiKeysView />

          {/* «Захват событий» — приёмник вебхуков отправок и доставок */}
          <EventCaptureCard isAdmin={isAdmin} />

          {/* «Обратный поток» — форвардер событий во внешний приёмник (G3) */}
          <ForwarderCard isAdmin={isAdmin} />
        </TabsContent>
        <TabsContent forceMount value="providers" className="mt-4 data-[state=inactive]:hidden">
          <ProvidersSection isAdmin={isAdmin} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
