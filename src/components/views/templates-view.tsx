'use client';

// Вью «Шаблоны»: каталог SMS-шаблонов и редактор с живым превью —
// переменные/фильтры/директивы, чипы UTM-ссылок, приписка для рекламы,
// лимит частей; финальная проверка — серверным превью.
// Домен: контент сообщений (комплаенс-правила применяются при отправке).
// API: GET/POST /api/v1/templates, PUT/DELETE /api/v1/templates/{id},
// POST /api/v1/templates/preview, GET /api/v1/links, GET /api/v1/settings.
// Роли: каталог — любая; создание/клонирование/правка/удаление — MANAGER+.
import * as React from 'react';
import { Braces, CheckCircle2, Copy, Link2, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
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
import { analyzeSms, extractVariables, renderPreview, sampleValueFor, KNOWN_TEMPLATE_VARS, customTemplateVars } from '@/lib/sms-utils';
import { renderDisclaimerText } from '@/lib/compliance/disclaimer-text';
import {
  invalidatePanel,
  EmptyState,
  ErrorState,
  fmtDT,
  useRole,
  useSettings,
  useCustomFields,
  ViewerGuard,
  type NamedLinkItem,
  type NamedLinksResponse,
  type Paged,
  type TemplateItem,
  type TemplatePreviewResponse,
} from '@/components/views/shared';

// Фолбэк имени рекламодателя, пока настройки (GET /api/v1/settings) не загружены.
const DEFAULT_ADVERTISER = 'ДемоКомпания';

// Чипы известных переменных (группы card/payload из UI-реестра sms-utils).
const CARD_VARS = KNOWN_TEMPLATE_VARS.filter((v) => v.group === 'card');
const PAYLOAD_VARS = KNOWN_TEMPLATE_VARS.filter((v) => v.group === 'payload');

/**
 * Клик по чипу — вставить произвольный токен (переменную/директиву) в позицию курсора.
 * Если textarea недоступна — токен дописывается в конец. После вставки курсор
 * ставится сразу за токеном (requestAnimationFrame — после применения state).
 */
function useInsertToken(
  bodyRef: React.RefObject<HTMLTextAreaElement | null>,
  body: string,
  setBody: (v: string) => void,
): (token: string) => void {
  return (token: string) => {
    const el = bodyRef.current;
    if (!el) {
      setBody(`${body}${token}`);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };
}

/** Диалог создания/редактирования шаблона: слева форма с конструкторами токенов,
 *  справа живое превью (локальный рендер sms-utils + факультативная серверная
 *  проверка POST /api/v1/templates/preview). */
function TemplateEditorDialog({
  open,
  onOpenChange,
  template,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: TemplateItem | null;
}) {
  const queryClient = useQueryClient();
  const settingsQuery = useSettings();

  const [name, setName] = React.useState('');
  const [body, setBody] = React.useState('');
  const [isMarketing, setIsMarketing] = React.useState(false);
  const [description, setDescription] = React.useState('');
  const [maxSegments, setMaxSegments] = React.useState(0);
  const [vars, setVars] = React.useState<Record<string, string>>({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [serverPreview, setServerPreview] = React.useState<TemplatePreviewResponse | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [showAllVars, setShowAllVars] = React.useState(false);
  const [showSyntaxHelp, setShowSyntaxHelp] = React.useState(false);
  const bodyRef = React.useRef<HTMLTextAreaElement | null>(null);
  const insertToken = useInsertToken(bodyRef, body, setBody);

  // Кастомные поля профиля — чипы {{cf_*}} и демо-значения (динамический реестр)
  const cfQuery = useCustomFields();
  const cfVars = React.useMemo(
    () => customTemplateVars(cfQuery.data?.items ?? []),
    [cfQuery.data],
  );
  const cfSampleMap = React.useMemo(
    () => new Map(cfVars.map((v) => [v.name, v.sample])),
    [cfVars],
  );

  // Именные короткие ссылки — чипы для вставки в тело шаблона
  // (грузятся только при открытом диалоге, кэш 60с)
  const linksQuery = useQuery({
    queryKey: ['links'],
    queryFn: () => api<NamedLinksResponse>('/api/v1/links'),
    staleTime: 60_000,
    enabled: open,
  });
  const namedLinks = linksQuery.data?.items ?? [];

  // Открытие диалога: сброс ошибок/превью и инициализация полей
  // (template=null → пустая форма нового шаблона).
  React.useEffect(() => {
    if (!open) return;
    setServerError(null);
    setServerPreview(null);
    setPreviewError(null);
    if (template) {
      setName(template.name);
      setBody(template.body);
      setIsMarketing(template.isMarketing);
      setDescription(template.description ?? '');
      setMaxSegments(template.maxSegments ?? 0);
    } else {
      setName('');
      setBody('');
      setIsMarketing(false);
      setDescription('');
      setMaxSegments(0);
    }
    setVars({});
  }, [open, template]);

  // Переменные, реально использованные в тексте (для таблицы демо-значений).
  const variables = React.useMemo(() => extractVariables(body), [body]);

  // Синхронизация демо-значений: сохранять введённое вручную для существующих
  // переменных, новым — подставлять сэмплы (CF — из реестра); исчезнувшие — вычищать.
  React.useEffect(() => {
    setVars((prev) => {
      const next: Record<string, string> = {};
      for (const v of variables) {
        next[v] = v in prev ? prev[v] : (cfSampleMap.get(v) ?? sampleValueFor(v));
      }
      return next;
    });
  }, [variables, cfSampleMap]);

  // Локальный анализ (символы/сегменты/кодировка) и предпросмотр на демо-данных —
  // те же утилиты, что на сервере (sms-utils); истина остаётся за серверным рендером.
  const analysis = React.useMemo(() => analyzeSms(body), [body]);
  const rendered = React.useMemo(() => renderPreview(body, vars), [body, vars]);

  // Рекламодатель и база отписки — из настроек (фолбэки: имя компании, origin панели).
  const advertiser = settingsQuery.data?.advertiserName?.trim() || DEFAULT_ADVERTISER;
  const baseUrl =
    settingsQuery.data?.unsubscribeBaseUrl?.trim() ||
    (typeof window !== 'undefined' ? window.location.origin : '');
  // Приписка — из настроек ({link}/{advertiser}), ссылка — короткая
  // (пример кода Xk3fQ9a, как в серверном превью) или полная с токеном.
  const useShortLinks = settingsQuery.data?.useShortLinks ?? true;
  const exampleLink = useShortLinks
    ? `${baseUrl}/?u=Xk3fQ9a`
    : `${baseUrl}/?unsub=<токен ~86 симв.>`;
  const disclaimerText = ` ${renderDisclaimerText(
    settingsQuery.data?.marketingDisclaimer ?? '',
    advertiser,
    exampleLink,
  )}`;
  // Для рекламных шаблонов превью дополняется припиской об отписке — так же,
  // как это сделает сервер при реальной отправке.
  const previewBodyText = rendered.cancelled ? '' : rendered.text;
  const withDisclaimer = isMarketing && !rendered.cancelled ? previewBodyText + disclaimerText : previewBodyText;
  const disclaimerAnalysis = React.useMemo(
    () => (isMarketing && !rendered.cancelled ? analyzeSms(withDisclaimer) : null),
    [isMarketing, withDisclaimer, rendered.cancelled],
  );
  // Живая проверка лимита частей: maxSegments=0 — «без лимита». Для рекламы
  // считаем ИТОГ с дисклеймером — при отправке сервер допишет приписку и
  // отклонит сообщение целиком по SMS_TOO_LONG, поэтому проверяем то, что
  // уйдёт в эфир, а не голый шаблон.
  const liveOverLimit =
    maxSegments > 0 &&
    !rendered.cancelled &&
    disclaimerAnalysis !== null &&
    disclaimerAnalysis.segments > maxSegments;

  // Сохранение: PUT для существующего шаблона, POST для нового.
  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        body,
        isMarketing,
        description: description.trim() || null,
        // Отправитель не задаётся на уровне шаблона: отправка всегда от имени
        // компании (Настройки). null вычищает
        // унаследованные значения у старых шаблонов при редактировании.
        senderName: null,
        maxSegments,
      };
      if (template) {
        return api<TemplateItem>(`/api/v1/templates/${template.id}`, { method: 'PUT', body: payload });
      }
      return api<TemplateItem>('/api/v1/templates', { method: 'POST', body: payload });
    },
    onSuccess: () => {
      toast.success('Шаблон сохранён');
      invalidatePanel(queryClient);
      onOpenChange(false);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось сохранить шаблон';
      setServerError(detail);
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Серверная проверка рендера: POST /preview с текущими демо-данными —
  // подтверждает те же параметры, что будет использовать движок при отправке.
  // Вызывается ТОЛЬКО по кнопке «Проверить на сервере» (не автоматически):
  // локальный рендер и так живой на каждый ввод, а гонять оригинальный движок
  // на каждое нажатие незачем. Ответ (симв./сегм/кодировка, итог с дисклеймером,
  // overLimit) выводится под кнопкой; расхождение сегментов с локальным
  // счётчиком, если появится, — рядом с локальным итогом.
  const serverPreviewMutation = useMutation({
    mutationFn: async () =>
      api<TemplatePreviewResponse>('/api/v1/templates/preview', {
        method: 'POST',
        body: { body, sampleData: vars, isMarketing, maxSegments },
      }),
    onSuccess: (res) => {
      setServerPreview(res);
      setPreviewError(null);
    },
    onError: (err) => {
      setServerPreview(null);
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Ошибка предпросмотра';
      setPreviewError(detail);
    },
  });

  // Клиентская валидация кнопки «Сохранить» (финальную проверку делает сервер).
  const invalid =
    name.trim().length === 0 ||
    body.trim().length === 0 ||
    body.length > 1000 ||
    name.trim().length > 100 ||
    rendered.syntaxError !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{template ? `Редактирование «${template.name}»` : 'Новый шаблон'}</DialogTitle>
          <DialogDescription>
            Переменные <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1 font-mono text-xs">{'{{имя}}'}</code> подставляются
            из карточки клиента, data и payload события. Поддерживаются условия{' '}
            <code className="font-mono text-xs">{'{{#if}}'}</code>, дефолты{' '}
            <code className="font-mono text-xs">{'{{var|default:…}}'}</code>, случайные варианты{' '}
            <code className="font-mono text-xs">{'{{#variant}}'}</code> и отмена отправки{' '}
            <code className="font-mono text-xs">{'{{#cancel}}'}</code>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Левая колонка — форма */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">Название</Label>
              <Input
                id="tpl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Просрочка — напоминание"
                maxLength={100}
              />
            </div>

            <div className="flex items-start gap-3 rounded-md border border-border p-3">
              <Switch
                id="tpl-marketing"
                checked={isMarketing}
                onCheckedChange={setIsMarketing}
                aria-label="Рекламное сообщение"
              />
              <div>
                <Label htmlFor="tpl-marketing" className="text-sm">
                  Рекламное сообщение
                </Label>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Требуется согласие, дисклеймер, тихие часы
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tpl-description">Описание (не рассылается)</Label>
              <Input
                id="tpl-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Для чего шаблон, кому, какие кампании"
                maxLength={500}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Лимит частей SMS</Label>
              <Select
                value={String(maxSegments)}
                onValueChange={(v) => setMaxSegments(Number(v))}
              >
                <SelectTrigger className="w-full" aria-label="Лимит частей SMS">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Без лимита</SelectItem>
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      До {n} {n === 1 ? 'части' : 'частей'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">Превышение — сообщение не отправляется</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tpl-body">Текст</Label>
              <Textarea
                id="tpl-body"
                ref={bodyRef}
                className="font-mono text-sm"
                rows={8}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={1000}
                placeholder="{{client_first_name|default:клиент|ucfirst}}, просрочка {{overdue_days}} дн."
              />
              {/* Живой счётчик под полем считает сам ШАБЛОН (токены {{…}}
                  как есть) — грубая оценка при наборе; точный итог по демо-данным
                  — справа в превью. Части/кодировку считает analyzeSms: GSM-7
                  (латиница) — 160 симв./часть (153 в склейке), UCS-2 (кириллица,
                  «₽», «ё») — 70/67; тот же подсчёт повторит сервер при отправке. */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={analysis.segments > 1 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400'}>
                  {analysis.chars} симв · {analysis.segments} сегм · {analysis.encoding}
                </span>
                {analysis.segments > 1 ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    Будет отправлено {analysis.segments} SMS-сегментов
                  </span>
                ) : null}
                {rendered.syntaxError ? (
                  <span className="font-medium text-red-600 dark:text-red-400">⚠ {rendered.syntaxError}</span>
                ) : null}
              </div>
            </div>

            {/* Конструктор синтаксиса (П6): директивы и фильтры — клик вставляет в курсор */}
            <div className="space-y-2 rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  <Braces className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                  Конструктор: условия, варианты, фильтры
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => setShowSyntaxHelp((v) => !v)}
                >
                  {showSyntaxHelp ? 'Скрыть примеры' : 'Примеры'}
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { token: '{{#if }}…{{#else}}…{{#end}}', label: '{{#if}} условие' },
                  { token: '{{#variant}}…{{#or}}…{{#end}}', label: '{{#variant}} варианты' },
                  { token: '{{#cancel}}', label: '{{#cancel}} отмена' },
                  { token: '|default:клиент', label: 'дефолт' },
                  { token: '|money', label: 'сумма ₽' },
                  { token: '|number', label: 'число' },
                  { token: '|date', label: 'дата' },
                  { token: '|upper', label: 'ВЕРХНИЙ' },
                  { token: '|ucfirst', label: 'Первая' },
                  { token: '|urlencode', label: 'urlencode' },
                ].map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    onClick={() => insertToken(chip.token)}
                    title={`Вставить: ${chip.token}`}
                    className="rounded-full border border-emerald-200 dark:border-emerald-900 bg-card px-2.5 py-1 font-mono text-xs text-emerald-700 dark:text-emerald-400 transition-colors hover:border-emerald-400 hover:bg-emerald-100 dark:bg-emerald-900/50"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
              {showSyntaxHelp ? (
                <div className="space-y-1.5 rounded-md bg-card p-2.5 text-xs text-zinc-600 dark:text-zinc-400">
                  <p className="font-mono">{'{{#if overdue_days >= 3}}Срочно! Долг {{overdue_days}} дн.{{#else}}Не забудьте про платёж.{{#end}}'}</p>
                  <p className="font-mono">{'{{#variant}}Подарок{{#or}}Бонус{{#or}}Сюрприз{{#end}} — промо-код {{promo_code|default:BDAY}}'}</p>
                  <p className="font-mono">{'{{#if client_first_name}}{{client_first_name}}{{#else}}{{#cancel}}{{#end}} — без имени не отправляем'}</p>
                  <p className="font-mono">{'Вам одобрено {{person_offer_approve_money|money}} до {{person_offer_date_expired|date}}'}</p>
                  <p className="text-zinc-400">
                    Операторы условий: == != &gt; &gt;= &lt; &lt;= ~= (содержит). Отсутствующая переменная в
                    условии = ложь; в тексте без дефолта — ошибка рендера; фильтры соединяются через |.
                  </p>
                </div>
              ) : null}
            </div>

            {/* Известные переменные (карточка клиента + кастомные + payload) с демо-значениями */}
            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Переменные карточки — нажмите, чтобы вставить
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => setShowAllVars((v) => !v)}
                >
                  {showAllVars ? 'Скрыть все' : 'Показать все'}
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(showAllVars ? [...CARD_VARS, ...cfVars, ...PAYLOAD_VARS] : [...CARD_VARS.slice(0, 12), ...cfVars]).map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    onClick={() => insertToken(`{{${v.name}}}`)}
                    title={`${v.label}${v.group === 'custom' ? ' (кастомное поле)' : ''} — пример: ${v.sample}`}
                    className={`rounded-full border px-2.5 py-1 font-mono text-xs transition-colors ${
                      v.group === 'custom'
                        ? 'border-teal-200 bg-teal-50/60 text-teal-700 hover:border-teal-400 hover:bg-teal-100 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-400'
                        : 'border-border bg-muted text-zinc-700 hover:border-emerald-300 hover:bg-emerald-50 dark:bg-emerald-950/60 hover:text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    {`{{${v.name}}}`}
                  </button>
                ))}
              </div>
              {showAllVars ? (
                <p className="text-xs text-zinc-400">
                  Серые примеры значений подставляются в предпросмотр автоматически;
                  бирюзовые — кастомные поля профиля (<code className="font-mono">{'{{cf_*}}'}</code>,
                  раздел «Настройки» → «Кастомные поля»); приоритет: кастомные поля → payload события → данные
                  клиента (data) → карточка.
                </p>
              ) : null}
            </div>

            {/* Именные короткие ссылки — вставка в позицию курсора. В отличие от
                чипов переменных клик вставляет не токен, а ГОТОВЫЙ короткий URL
                ({baseUrl}/r?c=код) с UTM-метками цели — он так и уйдёт в текст
                SMS, клики посчитает раздел «Ссылки». */}
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Короткие ссылки — нажмите, чтобы вставить в текст
              </p>
              {linksQuery.isPending ? (
                <p className="text-xs text-zinc-400">Загрузка ссылок…</p>
              ) : namedLinks.length === 0 ? (
                <p className="text-xs text-zinc-400">
                  Именных ссылок пока нет — создайте их в разделе «Настройки» → «Ссылки»: короткий
                  код {`${baseUrl}/r?c=…`} с UTM-метками и подсчётом переходов
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {namedLinks.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => insertToken(`${baseUrl}/r?c=${l.code}`)}
                      title={`Вставить: ${baseUrl}/r?c=${l.code} → ${l.targetUrl}`}
                      className="flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-zinc-700 dark:text-zinc-300 transition-colors hover:border-emerald-300 hover:bg-emerald-50 dark:bg-emerald-950/60 hover:text-emerald-700 dark:text-emerald-400"
                    >
                      <Link2 className="size-3 text-zinc-400" aria-hidden />
                      {l.name}
                      <span className="font-mono text-[10px] text-zinc-400">{l.code}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {serverError ? (
              <Alert variant="destructive">
                <AlertTitle>Ошибка сохранения</AlertTitle>
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          {/* Правая колонка — предпросмотр */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground">Предпросмотр</h3>

            {variables.length > 0 ? (
              <div className="space-y-2">
                {/* Демо-значения — то, что подставит и локальный рендер превью,
                    и серверная проверка (уходят в sampleData POST /preview). */}
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Переменные (демо-значения):</p>
                <div className="grid max-h-40 gap-2 overflow-y-auto pr-1">
                  {variables.map((v) => (
                    <div key={v} className="flex items-center gap-2">
                      <span className="w-32 shrink-0 truncate font-mono text-xs text-zinc-600 dark:text-zinc-400">
                        {`{{${v}}}`}
                      </span>
                      <Input
                        className="h-8 flex-1 text-sm"
                        value={vars[v] ?? ''}
                        onChange={(e) => setVars((prev) => ({ ...prev, [v]: e.target.value }))}
                        aria-label={`Значение переменной ${v}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {rendered.cancelled ? (
              <Alert className="border-amber-300 bg-amber-50 dark:bg-amber-950/60 text-amber-800">
                <AlertTitle>Отправка отменена шаблоном</AlertTitle>
                <AlertDescription>
                  Сработал <code className="font-mono text-xs">{'{{#cancel}}'}</code> при демо-данных —
                  реальное SMS не будет отправлено (не ошибка)
                </AlertDescription>
              </Alert>
            ) : (
              <div className="rounded-2xl border border-border bg-muted p-4">
                <div className="mx-auto max-w-[320px] rounded-2xl border border-border bg-card p-4 shadow-sm">
                  <p className="whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-200">
                    {previewBodyText.length > 0 ? previewBodyText : '—'}
                  </p>
                </div>
                {rendered.missing.length > 0 ? (
                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                    Не заполнены (без дефолта — ошибка при отправке):{' '}
                    {rendered.missing.map((m) => `{{${m}}}`).join(', ')}
                  </p>
                ) : null}
              </div>
            )}

            {isMarketing && !rendered.cancelled ? (
              <div className="space-y-2 rounded-2xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/50 p-4">
                <h4 className="text-xs font-medium text-amber-800">Итог с дисклеймером (авто)</h4>
                <div className="mx-auto max-w-[320px] rounded-2xl border border-border bg-card p-4 shadow-sm">
                  <p className="whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-200">
                    {previewBodyText}
                    <span className="italic text-zinc-400">{disclaimerText}</span>
                  </p>
                </div>
                {disclaimerAnalysis ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Итог: {disclaimerAnalysis.chars} симв · {disclaimerAnalysis.segments} сегм ·{' '}
                    {disclaimerAnalysis.encoding}
                    {serverPreview?.segmentsWithDisclaimer !== undefined &&
                    serverPreview.segmentsWithDisclaimer !== disclaimerAnalysis.segments
                      ? ` · сервер: ${serverPreview.segmentsWithDisclaimer} сегм`
                      : ''}
                  </p>
                ) : null}
                {liveOverLimit ? (
                  <Alert variant="destructive" className="py-2">
                    <AlertDescription>
                      Превышен лимит частей: {disclaimerAnalysis?.segments} &gt; {maxSegments} — при отправке
                      сообщение будет отклонено (SMS_TOO_LONG)
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => serverPreviewMutation.mutate()}
                disabled={serverPreviewMutation.isPending || body.trim().length === 0}
              >
                <CheckCircle2 className="size-4" aria-hidden />
                {serverPreviewMutation.isPending ? 'Проверяем…' : 'Проверить на сервере'}
              </Button>

              {serverPreview ? (
                <Alert
                  className={
                    serverPreview.cancelled || serverPreview.overLimit
                      ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/60 text-amber-800'
                      : 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300'
                  }
                >
                  <AlertTitle>
                    {serverPreview.cancelled
                      ? 'Отправка будет отменена шаблоном'
                      : serverPreview.overLimit
                        ? 'Превышен лимит частей — отправки не будет'
                        : 'Проверка пройдена'}
                  </AlertTitle>
                  <AlertDescription>
                    {serverPreview.cancelled ? (
                      <p>Шаблон вернул <code className="font-mono text-xs">{'{{#cancel}}'}</code> при заданных демо-данных</p>
                    ) : (
                      <>
                        <p className="whitespace-pre-wrap break-words">{serverPreview.rendered}</p>
                        <p className="mt-1">
                          {serverPreview.chars} симв · {serverPreview.segments} сегм ·{' '}
                          {serverPreview.encoding}
                          {serverPreview.segmentsWithDisclaimer !== serverPreview.segments
                            ? ` · с дисклеймером: ${serverPreview.segmentsWithDisclaimer} сегм`
                            : ''}
                          {serverPreview.maxSegments > 0
                            ? ` · лимит: ${serverPreview.maxSegments}`
                            : ' · лимит частей не задан'}
                        </p>
                        {serverPreview.overLimit ? (
                          <p className="mt-1 font-medium">
                            Частей {serverPreview.segmentsWithDisclaimer} &gt; лимита {serverPreview.maxSegments}:
                            при реальной отправке сообщение будет отклонено целиком
                          </p>
                        ) : null}
                      </>
                    )}
                  </AlertDescription>
                </Alert>
              ) : null}

              {previewError ? (
                <Alert variant="destructive">
                  <AlertTitle>Ошибка рендера</AlertTitle>
                  <AlertDescription>{previewError}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saveMutation.isPending}>
            Отмена
          </Button>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={invalid || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Корневой экран вкладки «Шаблоны»: каталог-таблица + диалоги (редактор/удаление). */
export function TemplatesView() {
  const queryClient = useQueryClient();
  const { canWrite } = useRole();
  // Архив (soft-deleted) скрыт по умолчанию — переключатель показывает его
  const [showDeleted, setShowDeleted] = React.useState(false);

  // Каталог шаблонов (pageSize=100 — пагинация UI не предусмотрена);
  // showDeleted добавляет includeDeleted=1 (soft-deleted записи).
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['templates', showDeleted],
    queryFn: () =>
      api<Paged<TemplateItem>>(
        showDeleted
          ? '/api/v1/templates?pageSize=100&includeDeleted=1'
          : '/api/v1/templates?pageSize=100',
      ),
  });

  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<TemplateItem | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<TemplateItem | null>(null);

  // Клонирование — копия тела/настроек под новым именем
  const cloneMutation = useMutation({
    mutationFn: async (t: TemplateItem) =>
      api<TemplateItem>('/api/v1/templates', {
        method: 'POST',
        body: {
          name: `${t.name} (копия)`.slice(0, 100),
          body: t.body,
          isMarketing: t.isMarketing,
          description: t.description ?? undefined,
          senderName: null,
          maxSegments: t.maxSegments,
        },
      }),
    onSuccess: () => {
      toast.success('Копия шаблона создана');
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось скопировать';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Удаление — soft-delete (isActive=false); сервер отклонит его (409),
  // если шаблон используется активной воронкой.
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api<void>(`/api/v1/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Шаблон удалён');
      setDeleteTarget(null);
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось удалить шаблон';
      toast.error(`Ошибка: ${detail}`);
      setDeleteTarget(null);
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Рекламные шаблоны требуют согласия клиента и автоматически дополняются дисклеймером
          </p>
          <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <Switch
              checked={showDeleted}
              onCheckedChange={setShowDeleted}
              aria-label="Показать удалённые шаблоны"
            />
            Показать удалённые
          </label>
        </div>
        <ViewerGuard>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => {
              setEditTarget(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="size-4" aria-hidden />
            Создать шаблон
          </Button>
        </ViewerGuard>
      </div>

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
              icon={Plus}
              title="Шаблонов пока нет — создайте первый"
              action={
                canWrite ? (
                  <Button
                    className="bg-emerald-600 text-white hover:bg-emerald-700"
                    onClick={() => {
                      setEditTarget(null);
                      setEditorOpen(true);
                    }}
                  >
                    <Plus className="size-4" aria-hidden />
                    Создать шаблон
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="max-h-[60vh] overflow-y-auto overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>Название</TableHead>
                    <TableHead>Текст</TableHead>
                    <TableHead>Тип</TableHead>
                    <TableHead>Части</TableHead>
                    <TableHead>Обновлён</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((t) => (
                    <TableRow key={t.id} className="hover:bg-muted">
                      <TableCell className="max-w-[220px] py-3 font-medium text-foreground">
                        <p className="truncate" title={t.description ?? undefined}>
                          {t.name}
                        </p>
                        {t.description ? (
                          <p className="line-clamp-2 text-xs font-normal text-zinc-400" title={t.description}>
                            {t.description}
                          </p>
                        ) : null}
                        {!t.isActive ? (
                          <Badge
                            variant="outline"
                            className="ml-0 mt-1 border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
                          >
                            удалён
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-md py-3">
                        <p className="truncate text-zinc-600 dark:text-zinc-400">{t.body}</p>
                      </TableCell>
                      <TableCell className="py-3">
                        {t.isMarketing ? (
                          <Badge
                            variant="outline"
                            className="border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400"
                            title="Требуется согласие, дисклеймер, тихие часы"
                          >
                            Реклама
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                          >
                            Информационное
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="py-3">
                        {t.maxSegments > 0 ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400"
                            title={`Не отправлять, если частей больше ${t.maxSegments}`}
                          >
                            ≤{t.maxSegments}
                          </Badge>
                        ) : (
                          <span className="text-xs text-zinc-400">∞</span>
                        )}
                      </TableCell>
                      <TableCell className="py-3 text-xs text-zinc-500 dark:text-zinc-400">{fmtDT(t.updatedAt)}</TableCell>
                      <TableCell className="py-3">
                        <div className="flex items-center justify-end gap-1">
                          <ViewerGuard>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => cloneMutation.mutate(t)}
                              disabled={cloneMutation.isPending}
                              aria-label={`Клонировать шаблон ${t.name}`}
                              title="Создать копию с тем же текстом и настройками"
                            >
                              <Copy className="size-4" aria-hidden />
                            </Button>
                          </ViewerGuard>
                          <ViewerGuard>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setEditTarget(t);
                                setEditorOpen(true);
                              }}
                              aria-label={`Редактировать шаблон ${t.name}`}
                            >
                              <Pencil className="size-4" aria-hidden />
                            </Button>
                          </ViewerGuard>
                          <ViewerGuard>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-red-500 dark:text-red-400 hover:text-red-600 dark:text-red-400"
                              onClick={() => setDeleteTarget(t)}
                              aria-label={`Удалить шаблон ${t.name}`}
                            >
                              <Trash2 className="size-4" aria-hidden />
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
        </CardContent>
      </Card>

      <TemplateEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        template={editTarget}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить шаблон «{deleteTarget?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Шаблон помечается неактивным. Если он используется активной воронкой, удаление будет
              отклонено.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              // анти-двойной клик: блокируем кнопку, пока идёт запрос
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
