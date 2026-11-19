'use client';

// Вкладка «Документация»: встроенное руководство пользователя (20 карточек-
// разделов) + карточка «Дистрибутив» (только ADMIN). Домен: справка/онбординг.
// Данные: GET /api/v1/settings (значения комплаенса подставляются в текст
// «Правил отправки») и GET /api/v1/distributive/info (версия/размер/sha256);
// скачивание архива — GET /api/v1/distributive[?type=src|repo|public] через
// fetch → blob.
// Содержимое разделов — статический JSX-текст (строки-литералы документации);
// активный раздел подсвечивается scrollspy, клик по оглавлению — плавная
// прокрутка. Открывают все роли; раздел «Дистрибутив» — только ADMIN.
import * as React from 'react';
import {
  BookOpen,
  Ban,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FileArchive,
  FileCode,
  Filter,
  GitBranch,
  Github,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Link2,
  ListChecks,
  Loader2,
  Lock,
  Megaphone,
  MessageSquareText,
  Package,
  Plug,
  Radio,
  Send,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError, authHeaders } from '@/lib/api-client';
import { useRole, useSettings, copyText } from '@/components/views/shared';

/* ================= Оглавление ================= */

interface SectionMeta {
  id: string;
  title: string;
  icon: LucideIcon;
  /** Дистрибутив — только ADMIN (архив содержит полный серверный код панели). */
  adminOnly?: boolean;
}

// Реестр разделов руководства: порядок массива = порядок карточек на странице.
// id — якорь для прокрутки и scrollspy; adminOnly-раздел скрыт для MANAGER/VIEWER
// и в оглавлении, и в контенте (visibleSections в DocsView).
const SECTIONS: SectionMeta[] = [
  { id: 'doc-overview', title: 'Обзор', icon: BookOpen },
  { id: 'doc-dashboard', title: 'Дашборд', icon: LayoutDashboard },
  { id: 'doc-rules', title: 'Правила отправки', icon: ShieldCheck },
  { id: 'doc-clients', title: 'Клиенты', icon: Users },
  { id: 'doc-segments', title: 'Сегменты', icon: Filter },
  { id: 'doc-templates', title: 'Шаблоны', icon: MessageSquareText },
  { id: 'doc-funnels', title: 'Воронки', icon: GitBranch },
  { id: 'doc-broadcasts', title: 'Рассылки', icon: Megaphone },
  { id: 'doc-events', title: 'События и API', icon: Zap },
  { id: 'doc-sms', title: 'SMS-лог', icon: Send },
  { id: 'doc-capture', title: 'Захват событий', icon: Radio },
  { id: 'doc-delivery', title: 'События доставки', icon: Inbox },
  { id: 'doc-links', title: 'Ссылки', icon: Link2 },
  { id: 'doc-unsubscribed', title: 'Отписки', icon: Ban },
  { id: 'doc-users', title: 'Пользователи и роли', icon: UserCog },
  { id: 'doc-apikeys', title: 'API-ключи', icon: KeyRound },
  { id: 'doc-integrations', title: 'Интеграции', icon: Plug },
  { id: 'doc-settings', title: 'Настройки', icon: Settings },
  { id: 'doc-security', title: 'Безопасность', icon: Lock },
  { id: 'doc-distributive', title: 'Дистрибутив', icon: Package, adminOnly: true },
];

/** Плавная прокрутка к разделу по id (scroll-mt-20 у карточек — отступ под липкую шапку). */
function scrollToSection(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ================= Мелкие элементы ================= */

/** Инлайн-код в тексте документации (моноширинный бейдж). */
function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[12px] text-zinc-700 [overflow-wrap:anywhere] dark:bg-zinc-800 dark:text-zinc-300">
      {children}
    </code>
  );
}

/**
 * Карточка раздела руководства: заголовок с иконкой + тело. id — якорь
 * оглавления (scrollIntoView/scrollspy); scroll-mt-20 компенсирует липкую шапку.
 */
function DocCard({
  id,
  title,
  icon: Icon,
  children,
  className,
}: {
  id: string;
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card id={id} className={`scroll-mt-20 ${className ?? ''}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
        {children}
      </CardContent>
    </Card>
  );
}

/** Пункт списка с стрелкой-буллетом — единый стиль перечней во всей документации. */
function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <ChevronRight className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** Малый подзаголовок внутри карточки раздела. */
function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="pt-1 text-[13px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {children}
    </h3>
  );
}

/* ================= Дистрибутив ================= */

/** Метаданные лёгкого исходного архива (только код, без зависимостей). */
interface DistributiveSrcInfo {
  filename: string;
  sizeBytes: number;
  sha256: string;
}

/** Метаданные git-бандла репозитория (чистый снапшот кода для публикации). */
interface DistributiveRepoInfo {
  filename: string;
  sizeBytes: number;
  sha256: string;
}

/** Метаданные публичного архива для GitHub (снапшот + каталог .git). */
interface DistributivePublicInfo {
  filename: string;
  sizeBytes: number;
  sha256: string;
}

/** Ответ GET /api/v1/distributive/info: полный, исходный архивы, git-бандл
 *  репозитория и публичный архив для GitHub (все — чистые снапшоты без истории
 *  разработки); exists=false — дистрибутив ещё не собран. */
interface DistributiveInfo {
  version: string;
  date: string;
  sizeBytes: number;
  sha256: string;
  exists: boolean;
  /** Лёгкий исходный архив (только код, без зависимостей). */
  src: DistributiveSrcInfo | null;
  /** Git-бандл репозитория (чистый снапшот; свежие сборки). */
  repo: DistributiveRepoInfo | null;
  /** Публичный архив для GitHub: тот же снапшот + каталог .git (push-ready). */
  public: DistributivePublicInfo | null;
}

/** Байты → человекочитаемо (МБ/КБ/Б) для карточки дистрибутива. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${bytes} Б`;
}

/** Дата сборки для карточки дистрибутива; битая/не-ISO дата → прочерк. */
function formatBuildDate(s: string): string {
  // гвард: невалидная дата не должна рендерить «Invalid Date»
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU');
}

/** Тип скачиваемого артефакта карточки «Дистрибутив»: полный standalone-архив,
 *  лёгкие исходники, git-бандл репозитория или публичный архив для GitHub. */
type DownloadKind = 'full' | 'src' | 'repo' | 'public';

/** Подписи тоста «скачано» по типу артефакта. */
const DOWNLOAD_TOAST: Record<DownloadKind, string> = {
  full: 'Дистрибутив скачан',
  src: 'Исходный код скачан',
  repo: 'Репозиторий скачан',
  public: 'Публичный архив для GitHub скачан',
};

/**
 * Карточка «Дистрибутив» (рендерится только для ADMIN — условие в DocsView):
 * метаданные свежего архива, копирование sha256, скачивание полного архива,
 * лёгких исходников, git-бандла репозитория и публичного архива для GitHub
 * (download ниже), раскрывающийся чек-лист развёртывания из 5 шагов.
 * Не-ADMIN видит заглушку «Недостаточно прав».
 */
function DistributiveSection() {
  const { isAdmin } = useRole();
  const [downloadingKind, setDownloadingKind] = React.useState<DownloadKind | null>(null);
  const [deployOpen, setDeployOpen] = React.useState(false);

  // Сведения о сборке: enabled только для ADMIN (MANAGER/VIEWER запрос не шлют
  // вовсе — иначе сервер ответил бы 403); retry выключен, чтобы ошибка не
  // сыпала повторные тосты.
  const infoQuery = useQuery({
    queryKey: ['distributive-info'],
    queryFn: () => api<DistributiveInfo>('/api/v1/distributive/info'),
    enabled: isAdmin,
    staleTime: 60_000,
    retry: false,
  });

  const info = infoQuery.data;

  /**
   * Скачивание артефакта (kind: 'full' — боевой дистрибутив, 'src' — лёгкие
   * исходники, 'repo' — git-бандл — чистый снапшот кода для публикации,
   * 'public' — архив для GitHub — тот же снапшот + каталог .git, «push-ready»)
   * через fetch → blob → временный <a download> с авточисткой URL.
   * Коды ошибок различаются: 401 — сессия истекла, 403 — не ADMIN, прочие —
   * title из problem+json-тела. Крошечный blob (<1 КБ) = архив не собран.
   */
  async function download(kind: DownloadKind = 'full'): Promise<void> {
    setDownloadingKind(kind);
    try {
      // authHeaders — обязательны: в iframe предпросмотра браузер блокирует cookie-сессию,
      // и без Bearer-фолбэка сервер отклонял скачивание с «сессия истекла» (хотя она валидна).
      const res = await fetch(`/api/v1/distributive${kind === 'full' ? '' : `?type=${kind}`}`, {
        headers: authHeaders(),
        credentials: 'same-origin',
      });
      if (!res.ok) {
        let title = `HTTP ${res.status}`;
        try {
          const parsed: unknown = await res.json();
          if (parsed && typeof parsed === 'object' && typeof (parsed as { title?: unknown }).title === 'string') {
            title = (parsed as { title: string }).title;
          }
        } catch {
          /* тело не JSON */
        }
        if (res.status === 401) {
          toast.error('Сессия истекла — войдите в панель заново');
        } else if (res.status === 403) {
          toast.error('Недостаточно прав: скачивание доступно только роли «Администратор»');
        } else {
          toast.error(`Ошибка скачивания: ${title}`);
        }
        return;
      }
      const blob = await res.blob();
      if (blob.size < 1024) {
        toast.error('Архив недоступен — соберите дистрибутив (deploy/build-archive.sh)');
        return;
      }
      // Имя файла — из content-disposition ответа (фолбэк — стандартное имя артефакта)
      const cd = res.headers.get('content-disposition') ?? '';
      const match = /filename="?([^";]+)"?/i.exec(cd);
      const filename = match?.[1] ?? 'trigger.tar.gz';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      // Подпись тоста — из карты DOWNLOAD_TOAST (4 вида артефактов)
      toast.success(`${DOWNLOAD_TOAST[kind]} (${formatBytes(blob.size)})`);
    } catch (err) {
      toast.error(err instanceof Error ? `Ошибка скачивания: ${err.message}` : 'Ошибка скачивания');
    } finally {
      setDownloadingKind(null);
    }
  }

  return (
    <DocCard id="doc-distributive" title="Дистрибутив" icon={Package}>
      <p>
        Автономный архив системы (standalone-сервер Next.js, схема БД, скрипты установки и
        обновления) для развёртывания на сервере компании. Сборка —{' '}
        <Code>deploy/build-archive.sh</Code> в каталоге проекта; сведения о свежей сборке —
        ниже.
      </p>

      {!isAdmin ? (
        <Alert>
          <Download className="size-4" aria-hidden />
          <AlertTitle>Недостаточно прав</AlertTitle>
          <AlertDescription>
            Скачивание дистрибутива доступно только роли «Администратор» (архив содержит
            серверный код). Разделы руководства выше доступны для чтения.
          </AlertDescription>
        </Alert>
      ) : infoQuery.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-5 w-64" />
        </div>
      ) : infoQuery.error || !info ? (
        <Alert variant="destructive">
          <Download className="size-4" aria-hidden />
          <AlertTitle>Архив недоступен</AlertTitle>
          <AlertDescription>
            {infoQuery.error instanceof ApiError
              ? infoQuery.error.detail ?? infoQuery.error.title
              : 'Не удалось получить сведения о дистрибутиве. Соберите архив: deploy/build-archive.sh.'}
          </AlertDescription>
        </Alert>
      ) : !info.exists ? (
        <Alert variant="destructive">
          <Download className="size-4" aria-hidden />
          <AlertTitle>Архив не собран</AlertTitle>
          <AlertDescription>
            Выполните <Code>bash deploy/build-archive.sh</Code> на сервере разработки и
            повторите попытку.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
            <span className="font-medium text-foreground">Версия {info.version}</span>
            <span className="text-zinc-500 dark:text-zinc-400">сборка {formatBuildDate(info.date)}</span>
            <span className="text-zinc-500 dark:text-zinc-400">
              полный архив: {formatBytes(info.sizeBytes)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
              sha256: {info.sha256.slice(0, 24)}…
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                // copyText — общий хелпер с http-фолбэком (navigator.clipboard
                // есть только в secure context, иначе было необработанное исключение)
                void copyText(info.sha256).then((ok) =>
                  ok ? toast.success('SHA-256 скопирован') : toast.error('Не удалось скопировать'),
                )
              }
              aria-label="Скопировать SHA-256"
              title="Скопировать SHA-256"
              className="h-7 gap-1 px-2"
            >
              <Copy className="size-3" aria-hidden />
            </Button>
          </div>
          <Button
            type="button"
            onClick={() => void download('full')}
            disabled={downloadingKind !== null}
            className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {downloadingKind === 'full' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <FileArchive className="size-4" aria-hidden />
            )}
            {downloadingKind === 'full' ? 'Скачивание…' : 'Скачать дистрибутив'}
          </Button>

          {info.src ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  исходники: {formatBytes(info.src.sizeBytes)} · sha256:{' '}
                  {info.src.sha256.slice(0, 24)}…
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    // копирование через copyText — с execCommand-фолбэком для http-контура
                    void copyText(info.src!.sha256).then((ok) =>
                      ok
                        ? toast.success('SHA-256 исходников скопирован')
                        : toast.error('Не удалось скопировать'),
                    )
                  }
                  aria-label="Скопировать SHA-256 исходников"
                  title="Скопировать SHA-256 исходников"
                  className="h-7 gap-1 px-2"
                >
                  <Copy className="size-3" aria-hidden />
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void download('src')}
                disabled={downloadingKind !== null}
                className="w-full gap-2 sm:w-auto"
              >
                {downloadingKind === 'src' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <FileCode className="size-4" aria-hidden />
                )}
                {downloadingKind === 'src' ? 'Скачивание…' : 'Скачать исходники (для разработки)'}
              </Button>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Лёгкий архив: только исходный код, конфиги и документация — без
                зависимостей. Для развёртывания нужны bun и интернет
                (<Code>bun install &amp;&amp; bun run build</Code>); полный архив выше содержит
                готовый сервер со всеми зависимостями и ставится без интернета.
              </p>
            </div>
          ) : null}

          {info.repo ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  git-бандл: {formatBytes(info.repo.sizeBytes)} · sha256:{' '}
                  {info.repo.sha256.slice(0, 24)}…
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    // копирование через copyText — с execCommand-фолбэком для http-контура
                    void copyText(info.repo!.sha256).then((ok) =>
                      ok
                        ? toast.success('SHA-256 бандла скопирован')
                        : toast.error('Не удалось скопировать'),
                    )
                  }
                  aria-label="Скопировать SHA-256 git-бандла"
                  title="Скопировать SHA-256 git-бандла"
                  className="h-7 gap-1 px-2"
                >
                  <Copy className="size-3" aria-hidden />
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void download('repo')}
                disabled={downloadingKind !== null}
                className="w-full gap-2 sm:w-auto"
              >
                {downloadingKind === 'repo' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <GitBranch className="size-4" aria-hidden />
                )}
                {downloadingKind === 'repo' ? 'Скачивание…' : 'Скачать репозиторий (git-бандл)'}
              </Button>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Чистый снапшот исходников без истории разработки — для публикации
                на GitHub и т.п. Клонирование:
                <Code>git clone trigger-repo-v*.bundle</Code>; для GitHub — затем
                <Code>git remote add origin &lt;URL&gt;</Code> и
                <Code>git push -u origin main</Code>. Состав тот же, что в архиве
                исходников выше.
              </p>
            </div>
          ) : null}

          {info.public ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  для GitHub: {formatBytes(info.public.sizeBytes)} · sha256:{' '}
                  {info.public.sha256.slice(0, 24)}…
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    // копирование через copyText — с execCommand-фолбэком для http-контура
                    void copyText(info.public!.sha256).then((ok) =>
                      ok
                        ? toast.success('SHA-256 публичного архива скопирован')
                        : toast.error('Не удалось скопировать'),
                    )
                  }
                  aria-label="Скопировать SHA-256 публичного архива"
                  title="Скопировать SHA-256 публичного архива"
                  className="h-7 gap-1 px-2"
                >
                  <Copy className="size-3" aria-hidden />
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void download('public')}
                disabled={downloadingKind !== null}
                className="w-full gap-2 sm:w-auto"
              >
                {downloadingKind === 'public' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Github className="size-4" aria-hidden />
                )}
                {downloadingKind === 'public' ? 'Скачивание…' : 'Скачать для GitHub (публичный архив)'}
              </Button>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Тот же чистый снапшот исходников, но <strong>вместе с каталогом
                .git</strong> (свежий репозиторий с initial commit) —
                «push-ready»: распакуйте, добавьте remote и загрузите на GitHub
                — без консольного git (подходит GitHub Desktop:
                <Code>Add local repository</Code> → <Code>Publish</Code>). Веб-интерфейсу
                GitHub достаточно и архива исходников выше (загрузка файлов
                через браузер).
              </p>
            </div>
          ) : null}
        </div>
      )}

      <Collapsible open={deployOpen} onOpenChange={setDeployOpen} className="rounded-lg border border-border">
        <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted/60">
          <span className="flex items-center gap-2">
            <ListChecks className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            Как развернуть (5 шагов)
          </span>
          <ChevronRight
            className={`size-4 shrink-0 text-zinc-400 transition-transform ${deployOpen ? 'rotate-90' : ''}`}
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4">
          <ol className="space-y-2.5 text-sm">
            <li className="flex gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-600/15 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                1
              </span>
              <span>
                Скачайте архив кнопкой выше и распакуйте на целевом сервере:{' '}
                <Code>tar xzf trigger-v*.tar.gz</Code> — появится каталог{' '}
                <Code>trigger-v*/</Code>.
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-600/15 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                2
              </span>
              <span>
                Установите <strong className="text-foreground">Bun</strong> и выполните{' '}
                <Code>bash deploy/install.sh</Code> в каталоге архива: скрипт поставит
                зависимости, создаст <Code>.env</Code> со сгенерированными секретами, базу
                SQLite и администратора (логин/пароль задаются в <Code>.env</Code>).
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-600/15 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                3
              </span>
              <span>
                Запустите сервер: <Code>PORT=3000 node .next/standalone/server.js</Code>{' '}
                (порт — переменной <Code>PORT</Code>). Для постоянной работы — PM2:{' '}
                <Code>pm2 start .next/standalone/server.js --name trigger</Code> или
                systemd-юнит (пример — в README архива).
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-600/15 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                4
              </span>
              <span>
                Откройте панель по адресу сервера, войдите администратором, смените пароль и
                подключите SMS-провайдера во вкладке «Интеграции» (раздел «SMS-провайдеры»).
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-600/15 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                5
              </span>
              <span>
                Обновление версии: положите новый архив рядом и выполните{' '}
                <Code>bash deploy/update.sh &lt;архив&gt;.tar.gz</Code> — скрипт сохранит
                резервные копии <Code>.env</Code> и базы, заменит код и перезапустит сервер.
              </span>
            </li>
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </DocCard>
  );
}

/* ================= Оглавление (левая колонка — как в V2) ================= */

/** Ссылка раздела: клик — плавная прокрутка; активный подсвечен. */
function TocItem({
  sec,
  active,
  onClick,
}: {
  sec: SectionMeta;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'location' : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
        active
          ? 'bg-emerald-50 font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
          : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
      }`}
    >
      {/* Неактивным пунктам — невидимый спейсер шириной с полоску: выравнивание
          текста не меняется при переключении активного раздела. */}
      {active ? (
        <span aria-hidden className="h-4 w-0.5 shrink-0 rounded-full bg-emerald-500" />
      ) : (
        <span aria-hidden className="h-4 w-0.5 shrink-0" />
      )}
      <span className="min-w-0 truncate">{sec.title}</span>
    </button>
  );
}

/**
 * Оглавление: список ссылок-разделов. variant='sidebar' — левая липкая колонка
 * (desktop); 'mobile' — внутри свёрнутого <details> (с верхней границей).
 */
function TableOfContents({
  sections,
  active,
  onNavigate,
  variant,
}: {
  sections: SectionMeta[];
  active: string;
  onNavigate: (id: string) => void;
  variant: 'sidebar' | 'mobile';
}) {
  return (
    <nav aria-label="Содержание документации">
      {variant === 'sidebar' ? (
        <p className="mb-2 px-2.5 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Содержание
        </p>
      ) : null}
      <div className={variant === 'sidebar' ? 'grid gap-0.5' : 'grid gap-0.5 border-t border-zinc-200 pt-3 dark:border-zinc-800'}>
        {sections.map((sec) => (
          <TocItem
            key={sec.id}
            sec={sec}
            active={active === sec.id}
            onClick={() => onNavigate(sec.id)}
          />
        ))}
      </div>
    </nav>
  );
}

/* ================= Главный компонент ================= */

/**
 * Экран «Документация»: двухколоночная раскладка — липкое оглавление (240px,
 * desktop) или свёрнутый <details> (мобильные) + колонка карточек-разделов.
 * Значения комплаенса для «Правил отправки» — из useSettings()
 * (GET /api/v1/settings), с дефолтами схемы на случай незагруженных настроек.
 * Активный раздел отслеживает scrollspy (эффект ниже); «Дистрибутив» — ADMIN.
 */
export function DocsView() {
  const { isAdmin } = useRole();
  const settingsQuery = useSettings();
  const s = settingsQuery.data;
  // <details> мобильного оглавления — закрывается после выбора раздела (navigate).
  const mobileTocRef = React.useRef<HTMLDetailsElement | null>(null);

  // Разделы текущей роли: adminOnly («Дистрибутив») остаётся только у ADMIN —
  // фильтруется и оглавление, и scrollspy (набор id совпадает с карточками).
  const visibleSections = React.useMemo(
    () => SECTIONS.filter((sec) => !sec.adminOnly || isAdmin),
    [isAdmin],
  );

  // id активного раздела (подсветка в оглавлении) — старт с первого раздела.
  const [active, setActive] = React.useState<string>(SECTIONS[0]?.id ?? 'doc-overview');

  React.useEffect(() => {
    // Scrollspy: активен последний раздел, чей заголовок поднялся
    // к шапке (80px — scroll-mt, 160 — с запасом). Особый случай: страница
    // домотана до конца — активен ПОСЛЕДНИЙ раздел (его заголовок может
    // не дотянуться до верха, и без этого правила подсвечивался бы предыдущий).
    const onScroll = () => {
      const doc = document.documentElement;
      const maxScroll = doc.scrollHeight - window.innerHeight;
      if (maxScroll > 4 && window.scrollY >= maxScroll - 2) {
        setActive(visibleSections[visibleSections.length - 1]?.id ?? SECTIONS[0].id);
        return;
      }
      let current = visibleSections[0]?.id ?? 'doc-overview';
      for (const sec of visibleSections) {
        const node = document.getElementById(sec.id);
        if (node && node.getBoundingClientRect().top <= 160) current = sec.id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [visibleSections]);

  /** Клик по пункту оглавления: плавная прокрутка + сворачивание мобильного списка. */
  function navigate(id: string): void {
    scrollToSection(id);
    // В мобильном виде сворачиваем раскрытый список после выбора
    if (mobileTocRef.current?.open) mobileTocRef.current.open = false;
  }

  // Текущие значения комплаенса (fallback — дефолты схемы: 21:00–09:00, 3, 5000)
  const quietFrom = String(s?.quietHoursStart ?? 21).padStart(2, '0');
  const quietTo = String(s?.quietHoursEnd ?? 9).padStart(2, '0');
  const clientLimit = s?.dailyClientLimit ?? 3;
  const systemLimit = s?.systemDailyLimit ?? 5000;
  const advertiser = s?.advertiserName ?? 'ДемоКомпания';

  return (
    <div className="grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
      {/* ===== Оглавление: липкое (desktop) / свёрнутое (мобильное) ===== */}
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <details ref={mobileTocRef} className="group rounded-lg border border-zinc-200 dark:border-zinc-800 lg:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Содержание
            <ChevronRight
              className="size-4 text-zinc-500 transition-transform group-open:rotate-90"
              aria-hidden
            />
          </summary>
          <div className="p-3 pt-0">
            <TableOfContents sections={visibleSections} active={active} onNavigate={navigate} variant="mobile" />
          </div>
        </details>

        <div className="hidden lg:grid">
          <TableOfContents sections={visibleSections} active={active} onNavigate={navigate} variant="sidebar" />
        </div>
      </aside>

      {/* ===== Контент ===== */}
      <div className="min-w-0 max-w-3xl space-y-4">
        {/* 1. Обзор */}
        <DocCard id="doc-overview" title="Обзор" icon={BookOpen}>
          <p>
            <strong className="text-foreground">Trigger</strong> — внутренний инструмент компании для
            автоматизированных триггерных SMS-коммуникаций. По входящему событию от системы данных
            (просрочка, приближение платежа, поступление платежа, закрытие займа, день рождения,
            преапрув и др.) платформа запускает <strong className="text-foreground">воронки</strong>{' '}
            — цепочки шагов, которые отправляют клиенту SMS с задержками и ветвлением по условиям.
            Отдельно доступны массовые <strong className="text-foreground">рассылки</strong> по
            сегментам клиентов.
          </p>
          <SubTitle>Два вида сообщений</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Сервисные</strong> — по факту события
              (напоминание о платеже, подтверждение поступления платежа, статус заявки):
              доставляются круглосуточно, без рекламной приписки.
            </Li>
            <Li>
              <strong className="text-foreground">Маркетинговые</strong> — предложения и промо:
              требуют согласие клиента, тихие часы и обязательную приписку «Реклама.{' '}
              {advertiser}. Отказаться: &lt;ссылка&gt;».
            </Li>
          </ul>
          <SubTitle>Ключевые сущности</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Клиенты</strong> — база с карточкой клиента
              (ФИО, договор, преапрув, день рождения…), телефоном, таймзоной, согласием на
              рекламу и статусом отписки. Импорт — CSV.
            </Li>
            <Li>
              <strong className="text-foreground">События</strong> — входящие сигналы о клиенте;
              каждое проверяется комплаенсом и запускает воронку. Повторы отсекаются ключом
              идемпотентности.
            </Li>
            <Li>
              <strong className="text-foreground">Воронки</strong> — конструктор цепочек: SMS,
              паузы (относительные и абсолютные), условия, ожидание события.
            </Li>
            <Li>
              <strong className="text-foreground">Шаблоны</strong> — тексты SMS с переменными,
              вариантами, фильтрами и лимитом частей.
            </Li>
            <Li>
              <strong className="text-foreground">Сегменты</strong> — группы клиентов по
              условиям карточки, для рассылок и аналитики.
            </Li>
            <Li>
              <strong className="text-foreground">Рассылки</strong> — разовые и регулярные
              массовые SMS по сегменту, по местному времени клиента.
            </Li>
            <Li>
              <strong className="text-foreground">SMS-лог</strong> — история всех сообщений:
              статусы доставки, провайдер, стоимость, причина отказа, привязка к воронке/рассылке.
            </Li>
            <Li>
              <strong className="text-foreground">Захват событий</strong> и журнал{' '}
              <strong className="text-foreground">«События доставки»</strong> — полная история
              «кому какие СМС отправили и что с ними стало»: собственные отправки, уведомления
              шлюзов, внешние события (приёмник) и реконсиляция.
            </Li>
            <Li>
              Также: короткие ссылки с UTM и подсчётом переходов, стоп-лист отписки, API-ключи,
              интеграции SMS-провайдеров, пользователи и роли, настройки комплаенса.
            </Li>
          </ul>
          <SubTitle>Как всё связано</SubTitle>
          <p>
            Событие ядра → обновление карточки клиента → запуск активной воронки → шаги
            (SMS/паузы/условия) → комплаенс-проверка каждого сообщения → провайдер (SMS.Tech /
            Т2 / МТС OmniChannel / Песочница) → статусы доставки вебхуками → SMS-лог, журнал «События доставки»
            и дашборд. Отправка всегда
            от имени <strong className="text-foreground">вашей компании</strong> — зарегистрированного
            альфа-имени (см. «Настройки»).
          </p>
        </DocCard>

        {/* 2. Дашборд */}
        <DocCard id="doc-dashboard" title="Дашборд" icon={LayoutDashboard}>
          <p>
            Главная вкладка — сводка SMS-коммуникаций за выбранный период. Переключатель
            периодов: <strong className="text-foreground">7 / 14 / 30 / 90 дней и год</strong>.
          </p>
          <SubTitle>Метрики периода</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Отправлено</strong> — все исходящие сообщения
              (включая многочастевые SMS — по частям).
            </Li>
            <Li>
              <strong className="text-foreground">Доставлено</strong> — подтверждённые провайдером
              статусы доставки.
            </Li>
            <Li>
              <strong className="text-foreground">Ошибки</strong> — технические сбои отправки
              (после 5 повторных попыток).
            </Li>
            <Li>
              <strong className="text-foreground">Отказы комплаенса</strong> — сообщения,
              заблокированные правилами (нет согласия, лимиты, отписка) — см. «Правила отправки».
            </Li>
            <Li>
              <strong className="text-foreground">Переходы по ссылкам</strong> — клики по коротким
              ссылкам из SMS (именным и отписочным); рядом — CTR: доля переходов от доставленных.
            </Li>
            <Li>
              <strong className="text-foreground">Отписки</strong> — сколько клиентов отписались
              за период (страница отписки из SMS).
            </Li>
          </ul>
          <SubTitle>График</SubTitle>
          <p>
            Столбики по дням: отправлено / доставлено / отказы комплаенса + линия переходов по
            ссылкам. Наведите курсор на столбик — точные значения дня. Метрики пересчитываются
            сразу после любых изменений: сохранение правок, запуск рассылки и появление новых
            сообщений обновляют дашборд мгновенно.
          </p>
        </DocCard>

        {/* 3. Правила отправки — ГЛАВНЫЙ раздел, выделенная карточка */}
        <Card
          id="doc-rules"
          className="scroll-mt-20 border-2 border-emerald-500/60 bg-emerald-50/50 shadow-sm dark:border-emerald-600/50 dark:bg-emerald-950/25"
        >
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base text-emerald-900 dark:text-emerald-200">
              <ShieldCheck className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              Правила отправки
              <Badge className="border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300">
                Главное — прочитайте первым
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <ul className="space-y-2.5">
              <li className="flex gap-2">
                <Clock className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <span>
                  <strong className="text-foreground">Тихие часы — по местному времени клиента.</strong>{' '}
                  Маркетинговые SMS не отправляются в окно тихих часов{' '}
                  <strong className="text-foreground">
                    {quietFrom}:00–{quietTo}:00
                  </strong>{' '}
                  (таймзона берётся из карточки клиента; окно настраивается в «Настройках»).
                  Попавшее в окно сообщение <em>переносится</em> на ближайшее разрешённое время,
                  воронка продолжает работу. <strong className="text-foreground">Сервисные</strong>{' '}
                  SMS (напоминания об оплате, статусы, коды) доставляются{' '}
                  <strong className="text-foreground">круглосуточно</strong>.
                </span>
              </li>
              <li className="flex gap-2">
                <Zap className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <span>
                  <strong className="text-foreground">Лимиты на сутки</strong> (считаются по
                  фактическим отправкам за текущие UTC-сутки; отменённые и не ушедшие сообщения
                  лимит не расходуют):
                  <br />• на клиента — <strong className="text-foreground">{clientLimit} SMS/сутки</strong>{' '}
                  (0 = без лимита);
                  <br />• системный —{' '}
                  <strong className="text-foreground">
                    {systemLimit.toLocaleString('ru-RU')} SMS/сутки
                  </strong>{' '}
                  на всю систему.
                </span>
              </li>
              <li className="flex gap-2">
                <Check className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <span>
                  <strong className="text-foreground">Согласие обязательно для рекламы.</strong>{' '}
                  Маркетинговые SMS отправляются только при согласии клиента (статус «Дано»).
                  Отписка и выключенные рекламные уведомления в карточке блокируют{' '}
                  <em>только маркетинговые</em> сообщения — сервисные доставляются всегда.
                </span>
              </li>
              <li className="flex gap-2">
                <Ban className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <span>
                  <strong className="text-foreground">Стоп-лист отписки.</strong> Каждое рекламное
                  SMS содержит персональную ссылку отписки: HMAC-токен со сроком{' '}
                  <strong className="text-foreground">180 дней</strong> (полная ссылка) или
                  короткий код <Code>?u=XXXXXXX</Code>. Переход по ссылке — страница отписки;
                  клиент попадает в стоп-лист, рекламные отправки ему прекращаются. Номер можно
                  внести вручную: «Отписки» → «Внести номер».
                </span>
              </li>
              <li className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                <span>
                  <strong className="text-foreground">Обязательный дисклеймер.</strong> К каждому
                  рекламному SMS добавляется приписка:{' '}
                  <em className="text-foreground">
                    «Реклама. {advertiser}. Отказаться: &lt;ссылка&gt;»
                  </em>{' '}
                  — текст редактируется в «Настройках» (плейсхолдеры <Code>{'{link}'}</Code> и{' '}
                  <Code>{'{advertiser}'}</Code>; <Code>{'{link}'}</Code> обязателен).
                </span>
              </li>
            </ul>

            <SubTitle>Порядок проверок перед отправкой</SubTitle>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-emerald-200/70 bg-background/70 dark:border-emerald-900/70">
              <table className="w-full text-[13px]">
                <caption className="sr-only">Порядок проверок комплаенса и причины отказа</caption>
                <thead className="sticky top-0 bg-muted/90 text-left text-zinc-500 backdrop-blur dark:text-zinc-400">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Шаг</th>
                    <th scope="col" className="px-3 py-2 font-medium">Проверка</th>
                    <th scope="col" className="px-3 py-2 font-medium">Причина отказа в логе</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr>
                    <td className="px-3 py-2 align-top">1</td>
                    <td className="px-3 py-2 align-top">Валидность телефона (E.164) — все сообщения</td>
                    <td className="px-3 py-2 align-top text-red-700 dark:text-red-400">Недопустимый номер телефона</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 align-top">2</td>
                    <td className="px-3 py-2 align-top">Клиент отписался (стоп-лист) — только маркетинг</td>
                    <td className="px-3 py-2 align-top text-red-700 dark:text-red-400">Клиент отписался</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 align-top">3</td>
                    <td className="px-3 py-2 align-top">Рекламные уведомления выключены в карточке — только маркетинг</td>
                    <td className="px-3 py-2 align-top text-red-700 dark:text-red-400">Клиент отключил рекламные SMS</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 align-top">4</td>
                    <td className="px-3 py-2 align-top">Нет согласия на рекламу — только маркетинг</td>
                    <td className="px-3 py-2 align-top text-red-700 dark:text-red-400">Нет согласия на рекламную рассылку</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 align-top">5</td>
                    <td className="px-3 py-2 align-top">Дневной лимит клиента</td>
                    <td className="px-3 py-2 align-top text-red-700 dark:text-red-400">Превышен дневной лимит для клиента</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 align-top">6</td>
                    <td className="px-3 py-2 align-top">Системный дневной лимит</td>
                    <td className="px-3 py-2 align-top text-red-700 dark:text-red-400">Превышен системный дневной лимит</td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 align-top">7</td>
                    <td className="px-3 py-2 align-top">Тихие часы — только маркетинг (не отказ, а перенос)</td>
                    <td className="px-3 py-2 align-top text-amber-700 dark:text-amber-400">Отправка перенесена до конца окна</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <SubTitle>Интервалы повторных отправок</SubTitle>
            <ul className="space-y-1.5">
              <Li>
                Временная ошибка провайдера (таймаут, сеть, троттлинг) — повторная попытка через{' '}
                <strong className="text-foreground">2 минуты</strong>, не более{' '}
                <strong className="text-foreground">5 попыток</strong>, затем сообщение получает
                статус «Ошибка».
              </Li>
              <Li>
                Рассылки: защита от спама «не чаще 1 раза в N дней» на клиента в рамках одной
                рассылки (учитываются доставленные и ожидающие отправки сообщения).
              </Li>
              <Li>
                Дубликаты входящих событий отсекаются ключом идемпотентности — клиент не получит
                повторную цепочку из-за ретрая на стороне системы данных.
              </Li>
            </ul>
          </CardContent>
        </Card>

        {/* 4. Клиенты */}
        <DocCard id="doc-clients" title="Клиенты" icon={Users}>
          <p>
            Вкладка «Клиенты» — база получателей. У каждого клиента: идентификатор{' '}
            <Code>external_id</Code> из системы данных, телефон, таймзона и карточка клиента —
            она же источник переменных для шаблонов и условий сегментов.
          </p>
          <SubTitle>Карточка клиента</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Персона</strong>: ФИО, день рождения.
            </Li>
            <Li>
              <strong className="text-foreground">Договор</strong>: номер, статус, сумма, продукт
              (PDL/Installment), дата закрытия, просрочка (дни).
            </Li>
            <Li>
              <strong className="text-foreground">Преапрув</strong>: доступная сумма, срок, до
              какой даты действует.
            </Li>
            <Li>
              <strong className="text-foreground">Коммуникации</strong>: согласие на рекламу
              (дано/нет), флаг «рекламные уведомления», статус отписки, счётчик отправленных SMS.
            </Li>
          </ul>
          <SubTitle>Карточка клиента (просмотр + история SMS)</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Клик по ФИО клиента в списке (или кнопка «глаз») открывает карточку: бейджи
              статусов (согласие, договор, продукт, отписка), профиль (e-mail, день
              рождения, таймзона, займ, заявка, договоры) и{' '}
              <strong className="text-foreground">историю отправок SMS</strong> — все
              сообщения этому клиенту с текстом, статусом, рассылкой/шаблоном и временем.
            </Li>
            <Li>
              Сводка истории: всего сообщений, доставлено, ошибки, отклонено и дата
              последней отправки. Клик по строке показывает полный текст сообщения,
              провайдера, тарификацию и причину отказа.
            </Li>
            <Li>Карточка доступна всем ролям (VIEWER — просмотр без правок).</Li>
          </ul>
          <SubTitle>Импорт CSV</SubTitle>
          <p>
            Кнопка «Импорт CSV» на панели списка. Два формата:{' '}
            <strong className="text-foreground">легаси-позиции</strong>{' '}
            (<Code>external_id;phone;timezone;name;consent</Code>) или{' '}
            <strong className="text-foreground">имена колонок</strong> как в карточке
            (<Code>external_id;phone;client_first_name;client_last_name;agreement_actual_status;loan_amount;…</Code>).
            Существующие клиенты обновляются по <Code>external_id</Code> (upsert), новые —
            создаются. Результат импорта — отчёт: создано / обновлено / пропущено (с ошибками).
          </p>
          <SubTitle>Правки</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Редактирование карточки — диалог «Изменить»: поля персоны, договора, преапрува и
              коммуникаций. Правки применяются мгновенно: сегменты и рассылки увидят новые данные
              при следующем расчёте.
            </Li>
            <Li>
              Удаление клиента — вместе с историей сообщений; вместо удаления для «не беспокоить»
              используйте отписку или флаг рекламных уведомлений.
            </Li>
          </ul>
          <SubTitle>Кастомные поля профиля</SubTitle>
          <p>
            Дополнительные данные о клиенте, которые компания заводит <strong className="text-foreground">без доработки системы данных</strong>:
            реестр ведёт ADMIN в разделе «Настройки» → «Кастомные поля» (ключ латиницей, тип:
            текст / число /
            дата / да-нет). Выключение поля обратимо (значения сохраняются, живые шаблоны
            продолжают работать), удаление — безвозвратно и защищено гвардами. В карточке
            клиента поля появляются отдельной секцией, а по всей панели работают под
            именем <Code>cf_ключ</Code>. Живой пример — переменные продукта «Кредитная линия»:
            <Code>is_credit_line</Code> (признак подключённой кредитной линии),
            <Code>available_tranche_sum</Code> (доступная сумма транша),{' '}
            <Code>grace_period_days</Code> (дни грейс-периода):
          </p>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Выключение</strong> — поле исчезает из
              конструкторов, значения не удаляются; включаете обратно — всё на месте.
              Предпочтительный путь, если поле просто не нужно прямо сейчас.
            </Li>
            <Li>
              <strong className="text-foreground">Удаление</strong> (корзина в строке, только
              ADMIN) — безвозвратное: поле и все его значения клиентов удаляются из базы.
              Пока переменную <Code>{'{{cf_ключ}}'}</Code> используют шаблоны, воронки или
              сегменты, панель откажет с 409 «Поле используется» и перечислит, где именно
              встречается переменная — сначала уберите ссылки. Если ядро продолжит слать
              ключ в <Code>client_card</Code>, «радар» снова подсветит его как неизвестный.
            </Li>
            <Li>
              переменная шаблона <Code>{'{{cf_is_credit_line}}'}</Code> — в шаблонах, воронках и
              рассылках (даты — «дд.мм.гггг»);
            </Li>
            <Li>
              ключ <Code>client_card</Code> события <Code>cf_is_credit_line</Code>, сырой{' '}
              <Code>is_credit_line</Code> или camelCase-написание контракта ядра{' '}
              <Code>isCreditLine</Code> — значение применяется к профилю автоматически при
              обработке события;
            </Li>
            <Li>
              критерий сегмента <Code>cf_is_credit_line</Code> (категория «Кастомные») — SQL-фильтр по
              индексам, работает и на миллионах клиентов.
            </Li>
          </ul>
        </DocCard>

        {/* 5. Сегменты */}
        <DocCard id="doc-segments" title="Сегменты" icon={Filter}>
          <p>
            Сегмент — сохранённая группа клиентов по условиям карточки. Используется как аудитория
            рассылок и для быстрой выборки. В базе уже есть готовые сегменты (созданы при
            развёртывании): «действующие договоры PDL», «доступен преапрув», «лояльные клиенты»,
            «ближайшие дни рождения», «реклама запрещена».
          </p>
          <ul className="space-y-1.5">
            <Li>
              Конструктор условий: поля карточки (статус договора, сумма, преапрув, день рождения,
              согласие, отписка и др.) плюс кастомные поля профиля <Code>cf_*</Code> (категория
              «Кастомные»), операторы (равно, не равно, больше/меньше, содержит, «в
              списке») и режим объединения <strong className="text-foreground">«все условия» (И)</strong>{' '}
              или <strong className="text-foreground">«любое условие» (ИЛИ)</strong>.
            </Li>
            <Li>
              Предпросмотр размера сегмента — сразу в конструкторе, без сохранения.
            </Li>
            <Li>
              «Клиенты сегмента» — просмотр списка попавших клиентов с карточками.
            </Li>
            <Li>
              Сегмент вычисляется в момент запуска рассылки: изменения базы (импорт, отписки)
              учитываются автоматически — пересохранять сегмент не нужно.
            </Li>
          </ul>
        </DocCard>

        {/* 6. Шаблоны */}
        <DocCard id="doc-templates" title="Шаблоны" icon={MessageSquareText}>
          <p>
            Вкладка «Шаблоны» — тексты сообщений с подстановкой данных клиента. У шаблона есть
            признак «маркетинговый» (реклама — с дисклеймером, согласием и тихими часами) или
            «сервисный», описание для маркетолога и лимит частей. Отправка всегда от имени{' '}
            <strong className="text-foreground">вашей компании</strong> — альфа-имя задаётся глобально в
            «Настройках», на уровне шаблона не переопределяется.
          </p>
          <SubTitle>Переменные и синтаксис</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <Code>{'{{имя}}'}</Code> — переменная из карточки клиента (например{' '}
              <Code>{'{{client_first_name}}'}</Code>). Отсутствующая переменная без дефолта —
              ошибка рендера, SMS не отправляется.
            </Li>
            <Li>
              <Code>{'{{сумма|default:5000}}'}</Code> — значение по умолчанию; фильтры:{' '}
              <Code>|money</Code> («25 000 ₽»), <Code>|number</Code>, <Code>|date</Code>{' '}
              («дд.мм.гггг»), <Code>|upper</Code>, <Code>|lower</Code>, <Code>|ucfirst</Code>,{' '}
              <Code>|urlencode</Code>.
            </Li>
            <Li>
              <Code>{'{{#if …}}…{{#else}}…{{#end}}'}</Code> — условие (операторы{' '}
              <Code>== != &gt; &gt;= &lt; &lt;= ~= !~</Code>; «содержит/не содержит»).
            </Li>
            <Li>
              <Code>{'{{#variant}}…{{#or}}…{{#end}}'}</Code> — случайный вариант текста («крутилка»
              против приедания).
            </Li>
            <Li>
              <Code>{'{{#cancel}}'}</Code> — тихая отмена отправки (сообщение не уходит, воронка
              продолжается).
            </Li>
          </ul>
          <SubTitle>Кодировка и части SMS</SubTitle>
          <p>
            Латиница в GSM-7: 160 символов на сообщение, 153 на часть при разбивке. Кириллица и
            эмодзи (UCS-2): 70 и 67 символов. Редактор показывает счётчик «символов / частей» с
            учётом приписки рекламного дисклеймера. У шаблона есть «Лимит частей» (0 = без лимита):
            если итоговое сообщение длиннее — оно не отправляется вовсе (причина в логе — «Превышен
            лимит частей SMS»).
          </p>
          <SubTitle>Предпросмотр, клонирование, архив</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Живой предпросмотр справа от редактора: подстановка примеров значений, приписка с
              реальным рекламодателем и короткой ссылкой, серверная проверка рендера — как будет
              выглядеть SMS у клиента.
            </Li>
            <Li>
              «Клонировать» — копия тела и настроек под новым именем (удобно для A/B-вариантов).
            </Li>
            <Li>
              Удаление шаблона переносит его в архив (переключатель «Показать удалённые» над
              списком); в архиве шаблон не участвует в отправках, но доступен для просмотра и
              восстановления.
            </Li>
          </ul>
        </DocCard>

        {/* 7. Воронки */}
        <DocCard id="doc-funnels" title="Воронки" icon={GitBranch}>
          <p>
            Воронка связана с одним триггерным событием (например «Платёж получен») и определяет,
            что происходит после него: последовательность шагов с ветвлением. В списке воронок
            видна полная цепочка шагов — бейджи всех узлов (SMS, паузы, условия, ожидания).
          </p>
          <SubTitle>Типы шагов (узлов)</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">SMS</strong> — отправка шаблона клиенту.
            </Li>
            <Li>
              <strong className="text-foreground">Пауза</strong> — относительная («ждать N часов /
              минут») или абсолютная: «до ЧЧ:ММ», «до даты», «до дня рождения» — по местному
              времени клиента.
            </Li>
            <Li>
              <strong className="text-foreground">Условие</strong> — выражение по данным карточки и
              payload события; ветки «да»/«нет» ведут к разным шагам.
            </Li>
            <Li>
              <strong className="text-foreground">Ждать событие</strong> — пауза до прихода события
              клиента (например «Заявка одобрена») с таймаутом и двумя ветками: «событие пришло» /
              «таймаут истёк».
            </Li>
          </ul>
          <SubTitle>Запуск и управление</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Активация/деактивация — тумблером на карточке воронки; активная воронка запускается
              на каждое новое событие.
            </Li>
            <Li>
              Режим повтора при новом событии: «один раз навсегда», «пока выполняется — пропуск»
              (по умолчанию), «отменить и перезапустить», «параллельно».
            </Li>
            <Li>
              Журнал экземпляров — вкладка «События»: таймлайн шагов, статусы, сообщения; активный
              экземпляр можно <strong className="text-foreground">отменить</strong> (дальнейшие
              шаги не выполнятся, запланированные SMS отменяются).
            </Li>
            <Li>
              Сохранённые правки применяются мгновенно: новый клиентский экземпляр пойдёт по
              обновлённой схеме; уже идущие экземпляры продолжают по схеме своей версии запуска.
            </Li>
          </ul>
        </DocCard>

        {/* 8. Рассылки */}
        <DocCard id="doc-broadcasts" title="Рассылки" icon={Megaphone}>
          <p>
            Рассылка — массовая отправка маркетингового шаблона по сегменту. Шаблон — только
            активный маркетинговый; переменные должны быть в карточке клиента (или иметь дефолт).
          </p>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Запуск вручную</strong> — кнопка «Запустить
              сейчас» (разовая рассылка «сейчас») или{' '}
              <strong className="text-foreground">по расписанию</strong>: разовая в указанное время
              либо регулярная — «каждый выбранный день недели в заданное время». Время — по
              местному поясу каждого клиента.
            </Li>
            <Li>
              Защита от спама: интервал «не чаще 1 раза в N дней» на клиента и порционный лимит
              получателей на запуск.
            </Li>
            <Li>
              <strong className="text-foreground">Окно «Запуски»</strong> — история с планом/фактом,
              статистикой доставки и <strong className="text-foreground">причинами отказов</strong>{' '}
              (разбивка «Реклама отключена ×2» и т.п.). Причины по каждому клиенту — в SMS-логе с
              фильтром по рассылке.
            </Li>
            <Li>
              Пауза замораживает очередь (новые запуски не создаются), возобновление пересчитывает
              расписание.
            </Li>
            <Li>
              <strong className="text-foreground">Удаление</strong> — очередь непосланных сообщений
              отменяется, карточка рассылки и запуски исчезают, а SMS-история{' '}
              <em>сохраняет имя рассылки</em> в деталях каждого сообщения.
            </Li>
          </ul>
        </DocCard>

        {/* 9. События и API */}
        <DocCard id="doc-events" title="События и API" icon={Zap}>
          <p>
            Система данных отправляет события в Trigger по HTTP — они запускают воронки и обновляют
            карточку клиента. Вкладка «События» состоит из трёх подтабов:{' '}
            <strong className="text-foreground">«Отправить событие»</strong>,{' '}
            <strong className="text-foreground">«Журнал событий»</strong> и{' '}
            <strong className="text-foreground">«Экземпляры воронок»</strong>.
          </p>
          <ul className="space-y-1.5">
            <Li>
              Endpoint: <Code>POST /api/v1/events</Code> с заголовком{' '}
              <Code>X-Api-Key</Code> (ключ создаётся в «Интеграции» → «Интеграция с системой
              данных» → блок «API-ключи»; для ключа можно ограничить список IP).
            </Li>
            <Li>
              Тело: тип события, идентификатор клиента (<Code>external_id</Code>), полезная нагрузка
              и <Code>idempotency_key</Code>. Повтор события с тем же ключом не создаёт дубликат —
              в ответе <Code>duplicate: true</Code>, клиент не получит SMS дважды.
            </Li>
            <Li>
              Девять типов событий: просрочка займа, приближение платежа, платёж получен, заём
              закрыт, день рождения, заявка одобрена, срок преапрува истёк, заявка отклонена,
              выдан преапрув.
            </Li>
            <Li>
              <strong className="text-foreground">Тестовое событие из панели</strong> — подтаб
              «Отправить событие»: выберите тип, клиента и payload — событие пройдёт полный путь
              (воронка → SMS → лог). Можно приложить и <Code>client_card</Code> — карточка
              клиента обновится, как при боевой отправке.
            </Li>
            <Li>
              <strong className="text-foreground">Повтор упавших</strong> — события со статусом
              «Ошибка» можно повторить кнопкой повтора в журнале.
            </Li>
            <Li>
              <strong className="text-foreground">Экземпляры воронок</strong> — кто и когда вошёл в
              воронку, на каком шаге находится, таймлайн шагов и сообщений; активный экземпляр
              можно отменить.
            </Li>
            <Li>Ограничение: не более 120 запросов в минуту с одного IP.</Li>
          </ul>
        </DocCard>

        {/* 10. SMS-лог */}
        <DocCard id="doc-sms" title="SMS-лог" icon={Send}>
          <p>
            История всех сообщений системы — триггерных (из воронок) и массовых (из рассылок),
            включая отменённые комплаенсом и упавшие. Каждая строка: время, клиент и номер,
            статус, текст, источник (воронка/рассылка/тест).
          </p>
          <SubTitle>Статусы</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Доставлено / Отправлено</strong> — провайдер
              подтвердил доставку / принял сообщение (статус обновляется вебхуком автоматически).
            </Li>
            <Li>
              <strong className="text-foreground">Ошибка</strong> — не удалось доставить после
              повторных попыток (детали — в поле причины).
            </Li>
            <Li>
              <strong className="text-foreground">Отказ комплаенса</strong> — сообщение не
              отправлялось: см. причину («Нет согласия», «Клиент отписался», «Лимит», «Тихие
              часы» и др. — полный список в «Правилах отправки»).
            </Li>
          </ul>
          <SubTitle>Фильтры и детали</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Фильтры: статус, воронка, рассылка, период (даты «с/по»), поиск по номеру и тексту.
            </Li>
            <Li>
              Детали сообщения (клик по строке): полная причина отказа, провайдер и ID сообщения у
              провайдера, части и стоимость, привязка к воронке/рассылке.
            </Li>
            <Li>
              «Экспорт CSV» — выгрузка текущей выборки (с учётом фильтров) для отчётности.
            </Li>
          </ul>
        </DocCard>

        {/* 11. Захват событий */}
        <DocCard id="doc-capture" title="Захват событий" icon={Radio}>
          <p>
            <strong className="text-foreground">Захват событий</strong> — механизм, который
            собирает в базу панель полную историю SMS-коммуникаций:{' '}
            <em>кому какие сообщения отправили и что с ними стало</em>. Работает по четырём
            направлениям одновременно:
          </p>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Панель</strong> — каждая отправка воронки или
              рассылки (и мгновенная доставка песочницы) пишется в журнал.
            </Li>
            <Li>
              <strong className="text-foreground">Шлюзы</strong> — уведомления SMS.Tech, Т2 и МТС (те
              же, что обновляют статусы SMS-лога) дублируются событиями журнала.
            </Li>
            <Li>
              <strong className="text-foreground">Внешние системы</strong> — события о
              сообщениях, отправленных за пределами панели, принимает публичный приёмник.
            </Li>
            <Li>
              <strong className="text-foreground">Реконсиляция</strong> — воркер сам опрашивает
              провайдеров о «зависших» сообщениях (страховка от потерянных уведомлений).
            </Li>
          </ul>
          <p>
            Всё складывается в единый журнал — вкладку{' '}
            <strong className="text-foreground">«События доставки»</strong> (следующий раздел).
            Результат: доставляемость и её динамика, причины недоставок, отписки из любых
            сообщений и полный реестр отправок — включая те, что ушли мимо панели.
          </p>

          <SubTitle>Приёмник внешних событий</SubTitle>
          <p>
            Публичный адрес приёмника:{' '}
            <Code>POST /api/v1/hooks/events?token=&lt;токен&gt;</Code>. Токен можно передавать и заголовком{' '}
            <Code>Authorization: Bearer &lt;токен&gt;</Code> — это предпочтительно: значение не остаётся в логах
            доступа, а query-вариант сохранён для совместимости с уже настроенным отправителем. Тело —
            JSON-массив событий (батч) или одиночный объект. Ответ — <Code>200</Code> с телом{' '}
            <Code>OK</Code>
            (совпадает с типовой проверкой «успех, если найдена строка»{' '}
            <Code>.*OK.*</Code>); счётчики принятых/записанных/дублей — в заголовках{' '}
            <Code>X-Trigger-Events-*</Code>. Пример события доставки:
          </p>
          <pre className="overflow-auto rounded-md bg-muted p-2 text-[11px] leading-relaxed">{`[
  {
    "event_type": "deliv_sms",
    "event_date": "2026-10-26T09:00:00.123456789Z",
    "account_id": 1,
    "profile_id": 12345,
    "subscription": { "channel": "sms", "phone": "+79001234567" },
    "event_data": {
      "message_id": 987,
      "campaign_id": 55,
      "send_message_id": "abc-123",
      "undeliv_code": 0,
      "undeliv_message": ""
    },
    "custom_data": {
      "client_id": "12345",
      "campaign_name": "DPD_7_SMS",
      "message_name": "Reminder_DPD7"
    },
    "content": { "sms": "Текст сообщения", "fromnamesms": "DemoBrand" }
  }
]`}</pre>
          <ul className="space-y-1.5">
            <Li>
              <Code>event_type</Code> — <Code>send_sms</Code> (отправлено),{' '}
              <Code>deliv_sms</Code> (доставлено), <Code>undeliv_sms</Code> (не доставлено, с
              кодом и текстом причины), <Code>click_sms</Code>/<Code>uclick_sms</Code> (клики),{' '}
              <Code>unsub_sms</Code> (отписка из сообщения).
            </Li>
            <Li>
              <Code>event_date</Code> — момент события (RFC 3339, наносекунды — нормально).
            </Li>
            <Li>
              <Code>subscription</Code> — канал и телефон адресата; приходит и объектом, и
              массивом таких объектов — приёмник понимает оба варианта.
            </Li>
            <Li>
              <Code>event_data</Code> — идентификаторы сообщения и кампании:
              message_id, campaign_id, launch_id, send_message_id, full_message_id, undeliv_code,
              undeliv_message.
            </Li>
            <Li>
              <Code>custom_data</Code> — произвольные поля: <Code>client_id</Code> (ID клиента в
              системе данных), имена кампании/шаблона.
            </Li>
            <Li>
              <Code>content</Code> — текст SMS и имя отправителя: top-level или внутри{' '}
              <Code>custom_data</Code> — проверяются оба места.
            </Li>
            <Li>
              <Code>is_test</Code> — пометка «тестовое событие» (инструмент предтеста платформы):
              записывается в журнал, но побочных эффектов не даёт — отписка, статусы SMS и корреляция
              пропускаются.
            </Li>
          </ul>

          <SubTitle>Обработка события</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Журнал без изменений (append-only)</strong>:
              событие записывается целиком — сырой payload плюс разобранные поля — и никогда не
              перезаписывается.
            </Li>
            <Li>
              <strong className="text-foreground">Идемпотентность</strong>: дедуп по ключу «тип +
              идентификаторы (включая message_id) + event_date» — повторная доставка ретрая не создаёт
              дублей и не трогает статусы повторно; разные события одного клиента даже в одну секунду
              не склеиваются.
            </Li>
            <Li>
              <strong className="text-foreground">Отписка</strong>: <Code>unsub_sms</Code> вносит
              номер в стоп-лист — валидно и для сообщений, отправленных вне панели; у клиента
              ставится отметка отписки (маркетинг блокируется, сервисные продолжают уходить).
            </Li>
            <Li>
              <strong className="text-foreground">Статус нашей SMS</strong>: если в{' '}
              <Code>custom_data.tg_sms_id</Code> передан идентификатор сообщения панели —
              событие обновляет его статус (send → «Отправлено», deliv → «Доставлено» с временем,
              undeliv → «Ошибка» с кодом и текстом причины).
            </Li>
            <Li>
              Телефонная корреляция <em>наших</em> SMS по номеру сознательно не выполняется: при
              параллельной отправке через другой сервис ложные совпадения испортили бы статусы.
              Внешние события пишутся как реестр, привязка к клиенту — по{' '}
              <Code>client_id</Code> (внешний ID в системе данных), иначе по телефону.
            </Li>
          </ul>

          <SubTitle>Реконсиляция</SubTitle>
          <p>
            Каждые 3 минуты воркер ищет сообщения в статусе «Отправлено», которые висят без
            уведомления шлюза дольше 2 часов (webhook потерян или не настроен), и напрямую
            опрашивает статус у провайдера. Финальный статус («Доставлено»/«Ошибка»)
            применяется, разбор фиксируется событием в журнал с пометкой{' '}
            <Code>via: reconciliation</Code>.
          </p>

          <SubTitle>Как настроить</SubTitle>
          <ol className="ml-1 space-y-1.5">
            <Li>
              <strong className="text-foreground">Включите</strong>: «Интеграции» → карточка
              «Захват событий» → тумблер (только ADMIN). Токен сгенерируется автоматически.
            </Li>
            <Li>
              <strong className="text-foreground">Скопируйте URL приёмника</strong> — уже с
              токеном, кнопкой копирования в карточке. Это единственный адрес приёмника:
              укажите его в настройках отправителя событий.
            </Li>
            <Li>
              <strong className="text-foreground">Настройте отправителя</strong> в личном кабинете
              платформы рассылок (Интеграции → Захват событий): тип запроса — «Отправить
              JSON-запрос батчем», действие — Send SMS, URL — приёмник, без авторизации;
              включите опцию «Добавить содержимое сообщений» (текст и отправитель придут в{' '}
              <Code>content</Code>); в custom_data добавьте <Code>client_id</Code>,{' '}
              <Code>campaign_name</Code> с шаблоном{' '}
              <Code>{'{{campaign_name}}'}</Code> и <Code>message_name</Code> с{' '}
              <Code>{'{{message_name}}'}</Code>; «Успех, если найдена строка»:{' '}
              <Code>.*OK.*</Code> (или пусто — тогда подходит любой 200).
            </Li>
            <Li>
              <strong className="text-foreground">Проверьте</strong>: кнопка «Отправить тестовое
              событие» прогоняет событие доставки через весь конвейер — запись в журнал и
              обновление статуса SMS — и показывает итог (цель — свежая SMS в полёте или последняя
              отправлявшаяся; можно указать конкретную SMS по её идентификатору). GET-запрос к
              приёмнику в браузере — самодиагностика (состояние тумблера и токена).
            </Li>
            <Li>
              <strong className="text-foreground">Ротация при необходимости</strong>:
              «Перегенерировать токен» — старый URL перестаёт работать сразу, после ротации
              обновите URL в настройках отправителя.
            </Li>
          </ol>

          <SubTitle>Тумблер и безопасность</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Выключенный захват</strong>: приёмник
              подтверждает приём (<Code>OK</Code>), но ничего не записывает; журналирование
              уведомлений шлюзов и реконсиляция остановлены. Статусы доставки в SMS-логе
              работают как раньше — они от тумблера не зависят.
            </Li>
            <Li>
              Токен передаётся заголовком <Code>Authorization: Bearer</Code> (предпочтительно — не
              остаётся в логах доступа) или в query-параметре URL; неверный или отсутствующий → 401.
              Сравнение токена защищено от timing-атак. Приёмник без токена закрыт.
            </Li>
            <Li>
              Мусорное тело → 400 (отправитель не повторяет бесконечно); батч больше 5000 событий →
              413 с подсказкой разбить отправку — идемпотентность делает ретрай меньшими батчами
              безопасным.
            </Li>
            <Li>
              Журнал хранит сырой payload целиком (для разбора спорных случаев); в аудите
              телефоны маскируются (<Code>+7***1234</Code>).
            </Li>
          </ul>
        </DocCard>

        {/* 12. События доставки */}
        <DocCard id="doc-delivery" title="События доставки" icon={Inbox}>
          <p>
            Отдельная вкладка панели — журнал всех событий «Захвата» в человекочитаемом виде:
            каждая строка — одно событие (отправка, доставка, недоставка, клик, отписка или
            обновление) с привязкой к клиенту и SMS. Список обновляется автоматически каждые 15
            секунд.
          </p>
          <SubTitle>Сводка сверху</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Событий в журнале</strong> — всего и прирост за
              24 часа.
            </Li>
            <Li>
              <strong className="text-foreground">Доставляемость (30 дней)</strong> — доля
              доставленных из отправленных: «103 из 134 → 77%».
            </Li>
            <Li>
              <strong className="text-foreground">Не доставлено / в полёте</strong> — ошибки
              доставок и сообщения без финального статуса (красное / янтарное числа).
            </Li>
            <Li>
              <strong className="text-foreground">Последнее событие</strong> — время самой свежей
              записи: индикатор «живого» потока событий от отправителей.
            </Li>
          </ul>
          <SubTitle>Фильтры и таблица</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Фильтры: тип события, источник (Панель / SMS.Tech / Т2 / МТС / Захват (внешние)), период
              (24 часа … 90 дней, всё время) и поиск по телефону.
            </Li>
            <Li>
              Колонки: дата события, тип, источник, телефон, клиент, SMS — статус связанного
              сообщения из SMS-лога и имя рассылки — и итог обработки.
            </Li>
            <Li>
              Бейдж <strong className="text-foreground">«внешнее»</strong> — сообщение было
              отправлено вне панели: событие не связано со строкой SMS-лога, рядом показывается
              имя внешней кампании.
            </Li>
          </ul>
          <SubTitle>Диалог подробностей</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Клик по строке открывает карточку события: когда произошло и когда принято, канал,
              клиент (и <Code>person_id</Code> — внешний ID клиента в системе данных), статус связанной
              SMS, отправитель, «кампания · шаблон».
            </Li>
            <Li>
              Для недоставок — <strong className="text-foreground">причина с кодом</strong>{' '}
              (например, «Код 400 — Invalid Caller ID») отдельной плашкой.
            </Li>
            <Li>
              Текст SMS — наш или из внешнего события; итог обработки (какой статус применили,
              отписка, реестр) и <strong className="text-foreground">сырой payload источника</strong>{' '}
              — как есть, для разбора спорных случаев.
            </Li>
          </ul>
          <p>
            Настройка источника событий — в «Интеграции» → «Интеграция с системой данных»
            (карточка «Захват событий»);
            механика подробно описана в предыдущем разделе.
          </p>
          <SubTitle>Срок хранения журнала</SubTitle>
          <p>
            Журнал растёт с потоком доставки (на боевых объёмах — гигабайты в месяц), поэтому
            в «Настройках» задаётся окно «Хранить журнал событий доставки, дней» (0 — не
            удалять). События старше окна перед удалением выгружаются в gz-архив{' '}
            <Code>db/message-events-archive</Code> на сервере — данные для разбора спорных
            случаев остаются доступными администратору сервера. Очередь событий, ещё не
            доставленных во внешнюю систему данных, не удаляется, пока не уйдёт в приёмник.
          </p>
        </DocCard>

        {/* 13. Ссылки */}
        <DocCard id="doc-links" title="Ссылки" icon={Link2}>
          <p>
            Короткие ссылки экономят символы SMS и считают переходы. Два вида — оба живут в
            таблице <Code>short_link</Code> с 7-символьным кодом (алфавит без похожих глифов).
          </p>
          <SubTitle>Как это работает</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Именные ссылки</strong> (создаются вручную в
              разделе «Настройки» → «Ссылки»): имя, целевой URL, UTM-метки, срок действия. В SMS попадает{' '}
              <Code>https://…/r?c=КОД</Code> — при переходе платформа фиксирует клик и делает
              <strong className="text-foreground"> 302-редирект</strong> на целевой URL с
              приписанными UTM-метками (источник кампании виден в аналитике сайта).
            </Li>
            <Li>
              <strong className="text-foreground">Отписочные ссылки</strong> (создаются
              автоматически в каждом рекламном SMS): в приписке{' '}
              <Code>https://…/?u=КОД</Code>. Переход открывает страницу отписки; нажатие «Не
              хочу получать рекламу» вносит номер в стоп-лист.
            </Li>
            <Li>
              <strong className="text-foreground">Подсчёт переходов</strong>: в момент резолва
              кода платформа в одной транзакции увеличивает счётчик <Code>visits</Code> у ссылки,
              ставит отметку «последний переход» и пишет строку в{' '}
              <strong className="text-foreground">редирект-лог</strong> (каждый клик с точностью
              до секунды). Из лога строятся «Переходы по ссылкам» на дашборде (по дням) и CTR.
            </Li>
            <Li>
              Защита: публичные эндпоинты ссылок ограничены 60 запросами в минуту с одного IP;
              протухшие ссылки удаляются воркером через 30 дней после истечения (статистика и
              аудит сохраняются).
            </Li>
          </ul>
          <SubTitle>Раздел «Настройки» → «Ссылки»</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Список с итогами: всего ссылок, сумма переходов; по каждой — короткий URL (копируется
              кнопкой), счётчики «переходов» и «SMS» (в скольких отправленных сообщениях встречается
              код), последний переход.
            </Li>
            <Li>
              В редакторе шаблонов именные ссылки появляются чипами — клик вставляет готовый URL в
              текст сообщения.
            </Li>
            <Li>
              «Проверить переход» открывает ссылку в новой вкладке — тестовый клик учитывается в
              статистике.
            </Li>
          </ul>
        </DocCard>

        {/* 14. Отписки */}
        <DocCard id="doc-unsubscribed" title="Отписки" icon={Ban}>
          <p>
            Стоп-лист номеров, исключённых из <em>маркетинговых</em> отправок. Сервисные сообщения
            (платежи, статусы) продолжают уходить — требование 152-ФЗ касается рекламы.
          </p>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Автоматически</strong>: клиент переходит по
              персональной ссылке отписки из SMS и подтверждает отказ.
            </Li>
            <Li>
              <strong className="text-foreground">Вручную</strong>: «Внести номер» — по запросу
              клиента (звонок/обращение); укажите номер и причину.
            </Li>
            <Li>
              <strong className="text-foreground">Возврат</strong>: удаление записи из стоп-листа
              (например, клиент сам попросил возобновить рассылки) — маркетинговые отправки
              возобновляются при наличии согласия.
            </Li>
            <Li>
              Отписка не отменяет уже идущие воронки: рекламные шаги в них будут отклонены
              комплаенсом, сервисные — доставлены.
            </Li>
          </ul>
        </DocCard>

        {/* 15. Пользователи и роли */}
        <DocCard id="doc-users" title="Пользователи и роли" icon={UserCog}>
          <p>Три роли с нарастающими правами; учётные записи создаёт администратор.</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <Badge className="mb-1.5 border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-400">
                ADMIN
              </Badge>
              <p className="text-[13px]">
                Полный доступ: пользователи и роли, API-ключи, интеграции провайдеров, настройки
                комплаенса, все операции с данными, дистрибутив.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <Badge className="mb-1.5 border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-400">
                MANAGER
              </Badge>
              <p className="text-[13px]">
                Операционная работа: клиенты и импорт CSV, шаблоны, воронки и активация, сегменты,
                рассылки, события и повторы, внесение номеров в стоп-лист, скачивание
                дистрибутива. Без доступа к пользователям, API-ключам, интеграциям и изменению
                настроек.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <Badge className="mb-1.5 border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-800 dark:text-zinc-400">
                VIEWER
              </Badge>
              <p className="text-[13px]">
                Только просмотр: дашборд, клиенты, шаблоны, воронки, рассылки, логи, события и эта
                документация. Кнопки операций заблокированы; дистрибутив недоступен.
              </p>
            </div>
          </div>
          <ul className="space-y-1.5">
            <Li>
              Смена своего пароля — меню пользователя (справа вверху); администратор может
              принудительно запросить смену пароля пользователю.
            </Li>
            <Li>
              Все значимые действия пишутся в <strong className="text-foreground">журнал аудита</strong>{' '}
              (просмотр — «Настройки» → карточка «Журнал аудита», только ADMIN): входы, правки,
              удаления, запуски — с пользователем, IP и деталями.
            </Li>
            <Li>
              Отключение пользователя (не удаление) мгновенно лишает его входа; история его
              действий в аудите сохраняется.
            </Li>
          </ul>
        </DocCard>

        {/* 16. API-ключи */}
        <DocCard id="doc-apikeys" title="API-ключи" icon={KeyRound}>
          <p>
            Ключи для приёма событий от системы данных: заголовок <Code>X-Api-Key</Code> в запросах{' '}
            <Code>POST /api/v1/events</Code>. Создание и отзыв — только администратором; раздел —
            «Интеграции» → «Интеграция с системой данных», блок «API-ключи» (рядом с
            мониторингом трубы и настройками обратного потока — всё об обмене данными с
            внешней системой в одном месте).
          </p>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Создание</strong>: имя (для аудита) и,
              опционально, список IP-адресов ядра — тогда ключ принимает события только с них.
            </Li>
            <Li>
              Секретное значение показывается <strong className="text-foreground">один раз</strong>{' '}
              при создании — сохраните его в хранилище секретов ядра. Префикс ключа виден в списке
              для сопоставления.
            </Li>
            <Li>
              <strong className="text-foreground">Отзыв</strong> мгновенно прекращает приём событий
              по ключу (для ротации: создайте новый, переключите ядро, отзовите старый).
            </Li>
            <Li>
              Ключ и его использование видны в журнале аудита; события отозванным ключом
              отклоняются с 401.
            </Li>
          </ul>
        </DocCard>

        {/* 17. Интеграции */}
        <DocCard id="doc-integrations" title="Интеграции" icon={Plug}>
          <p>
            Вкладка «Интеграции» — два раздела. «Интеграция с системой данных» — всё об обмене
            с внешней системой данных: мониторинг трубы событий (глубина/лаг очереди, обороты SMS),
            API-ключи приёма, «Захват событий» и «Обратный поток событий» (события отправок
            в BI). «SMS-провайдеры» — подключения отправки. Секреты шифруются при сохранении
            (AES-256-GCM), хранятся только на сервере и не отображаются в панели — видны лишь
            последние символы; активный провайдер один, переключение — кнопкой «Сделать
            активным».
          </p>
          <SubTitle>SMS.Tech — агрегатор (рекомендуется)</SubTitle>
          <ol className="ml-1 space-y-1.5">
            <Li>
              Возьмите токен в кабинете{' '}
              <strong className="text-foreground">hub.sms.tech</strong> («Интеграции» → «Токен
              пользователя»).
            </Li>
            <Li>
              Вкладка «Интеграции» → раздел «SMS-провайдеры» → карточка SMS.Tech → поле{' '}
              <strong className="text-foreground">«Токен доступа»</strong> → вставьте токен →{' '}
              <strong className="text-foreground">«Сохранить»</strong> → статус карточки станет{' '}
              <strong className="text-foreground">«Подключён»</strong>.
            </Li>
            <Li>
              Альфа-имя <strong className="text-foreground">вашей компании</strong> уже зарегистрировано
              в SMS.Tech — все отправки идут от него.
            </Li>
            <Li>
              «Проверить подключение» — бесплатная проверка токена; «Отправить тест» — реальное SMS
              с записью в лог.
            </Li>
            <Li>
              «Сделать активным» — все SMS пойдут через SMS.Tech. Вебхук статусов доставки{' '}
              <Code>/api/v1/webhooks/smstech</Code> подключается через поддержку SMS.Tech — URL
              виден на экране интеграции.
            </Li>
          </ol>
          <SubTitle>Т2 «Бизнес SMS» — оператор</SubTitle>
          <ol className="ml-1 space-y-1.5">
            <Li>
              Получите логин/пароль HTTP-рассылки в кабинете{' '}
              <strong className="text-foreground">bsms.t2.ru</strong> (после согласования с Т2).
            </Li>
            <Li>
              Карточка Т2 → поля <strong className="text-foreground">«Логин» и «Пароль»</strong> →{' '}
              «Сохранить» → статус «Подключён».
            </Li>
            <Li>
              Задайте <strong className="text-foreground">shortcode</strong> (имя отправителя,
              латиница/цифры до 11 символов; по умолчанию — ваше имя) → «Сделать активным».
            </Li>
          </ol>
          <SubTitle>МТС OmniChannel — оператор</SubTitle>
          <ol className="ml-1 space-y-1.5">
            <Li>
              Логин (system_id) и пароль выдаются при заключении договора с МТС; авторизация —
              Basic Authentication в каждом запросе к{' '}
              <strong className="text-foreground">omnichannel.mts.ru</strong>.
            </Li>
            <Li>
              Карточка МТС → поля <strong className="text-foreground">«Логин» и «Пароль»</strong> →{' '}
              «Сохранить» → статус «Подключён». Проверка без списаний — кнопка «Проверить
              подключение» (запрос статусов с пустым списком идентификаторов).
            </Li>
            <Li>
              Если проверка отвечает «логин/пароль отклонены (код 804: Bad credentials)» — шлюз
              МТС отверг именно креды (проверено прямым зондом: полный запрос отправки с
              неверными кредами получает документированный 802). Код 804 здесь — особенность
              живого шлюза: в документации V.1.14 коду 804 соответствует «content is required»,
              а отказ кредов описан кодом 802 — доверяйте сообщению. Убедитесь, что логин — это{' '}
              <strong className="text-foreground">system_id из договора</strong> (не логин
              кабинета МТС и не нейминг), уточните у менеджера МТС активацию HTTP-интеграции и
              IP-ограничения шлюза; при IP-ограничениях финальную приёмку выполняйте кнопкой
              «Отправить тест» с боевого сервера.
            </Li>
            <Li>
              Задайте <strong className="text-foreground">нейминг</strong> sms_address (имя
              отправителя, латиница/цифры/дефис до 11 символов; по умолчанию — ваше имя) → «Сделать
              активным».
            </Li>
            <Li>
              Коллбэк статусов доставки <Code>/api/v1/webhooks/mts</Code> — URL передаётся вашему
              менеджеру МТС (доменные имена, порты 80/443/5070); статус также уточняется
              запросом <Code>/messages/info</Code> из реконсиляции воркера.
            </Li>
          </ol>
          <SubTitle>Защита секретов и удаление на время тестов</SubTitle>
          <ul className="ml-1 space-y-1.5">
            <Li>
              Токен SMS.Tech, логин/пароль Т2 и логин/пароль МТС перед записью в БД шифруются (AES-256-GCM, ключ —
              только в <Code>.env</Code> на сервере): даже копия файла базы не раскрывает доступы.
            </Li>
            <Li>
              В браузер секреты не возвращаются вообще: панель показывает только факт сохранения и
              маску («•••••••9f2c»). В журнал аудита пишется лишь факт сохранения/удаления — без
              значений.
            </Li>
            <Li>
              Кнопка <strong className="text-foreground">«Удалить»</strong> на карточке провайдера
              стирает секрет из базы полностью — удобно на время тестов, чтобы исключить реальную
              отправку (после удаления включите «Песочницу»). Операции с секретами ограничены 20
              в минуту с одного IP.
            </Li>
          </ul>
          <SubTitle>Песочница</SubTitle>
          <p>
            Провайдер «Песочница» (включён по умолчанию) имитирует отправку без реальных SMS —
            используйте его для тестов воронок и рассылок до подключения боевого канала.
          </p>
          <SubTitle>Захват событий</SubTitle>
          <p>
            Карточка в разделе «Интеграция с системой данных» вкладки «Интеграции»: тумблер
            включения, URL приёмника с токеном, чек-лист настройки у отправителя и тестовое
            событие. Как это работает и как настраивать — подробно в разделе{' '}
            <strong className="text-foreground">«Захват событий»</strong> этой документации.
          </p>
        </DocCard>

        {/* 18. Настройки */}
        <DocCard id="doc-settings" title="Настройки" icon={Settings}>
          <p>
            Параметры комплаенса и работы панели (только ADMIN; VIEWER и MANAGER видят
            значения только для чтения). После «Сохранить» новые значения применяются{' '}
            <strong className="text-foreground">мгновенно</strong> — все превью и следующие
            отправки используют их сразу.
          </p>
          <SubTitle>Реклама и отправитель</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              <strong className="text-foreground">Рекламодатель</strong> — сейчас «{advertiser}»:
              подставляется в приписку «Реклама. {'{advertiser}'}. Отказаться: …» каждого
              маркетингового SMS.
            </Li>
            <Li>
              <strong className="text-foreground">Отправитель по умолчанию</strong> — ваше имя:
              зарегистрированное альфа-имя; с уровня шаблона и шага воронки не переопределяется.
            </Li>
            <Li>
              <strong className="text-foreground">Шаблон приписки</strong> — редактируемый текст с
              плейсхолдерами <Code>{'{advertiser}'}</Code> и <Code>{'{link}'}</Code> (второй
              обязателен); живой предпросмотр с подсчётом символов.
            </Li>
          </ul>
          <SubTitle>Комплаенс</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Тихие часы (сейчас {quietFrom}:00–{quietTo}:00), лимиты «SMS в сутки на клиента» и
              «на систему», удержание обработанных событий (дней).
            </Li>
            <Li>
              <strong className="text-foreground">Хранить журнал событий доставки, дней</strong> —
              ретеншн журнала доставки SMS: события старше срока выгружаются в gz-архив
              (db/message-events-archive) и удаляются из БД; <Code>0</Code> — не удалять.
              При включённой интеграции с системой данных недоставленные в приёмник события
              не удаляются. Рекомендуемое окно на боевых объёмах — 180–365 дней.
            </Li>
            <Li>
              Короткие ссылки: включены/выключены; при выключении в приписку подставляется полная
              ссылка с токеном (~86 символов — дороже по частям SMS).
            </Li>
            <Li>
              Статистика отписочных ссылок рядом с настройкой: создано ссылок, из них с
              переходами, всего переходов, за 30 дней.
            </Li>
          </ul>
          <SubTitle>Журнал аудита</SubTitle>
          <p>
            Карточка внизу вкладки: последние 30 значимых действий (входы, правки, удаления,
            запуски) с пользователем, IP и деталями; кнопка «Обновить» подтягивает свежие записи.
            Полная история хранится в БД и доступна SQL-запросом при расследованиях.
          </p>
        </DocCard>

        {/* 19. Безопасность */}
        <DocCard id="doc-security" title="Безопасность" icon={Lock}>
          <p>
            Панель хранит персональные данные клиентов и подключается к платёжно-значимым
            каналам связи, поэтому защита построена послойно. Ниже — что уже реализовано;
            полное описание и чек-лист развёртывания — файл{' '}
            <Code>docs/security.md</Code> в дистрибутиве.
          </p>

          <SubTitle>Аутентификация и сессии</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Пароли — bcrypt (cost 12), политика «буквы + цифры, от 10 символов, не
              email и не популярный пароль»; нельзя повторить один из 5 последних.
              Первый вход под стартовым админом требует смены пароля.
            </Li>
            <Li>
              Сессии — случайные 256-битные токены; в БД только sha256-хеш.
              Cookie <Code>tg_sid</Code> — HttpOnly (недоступен JavaScript), SameSite;
              idle-таймаут 7 дней без активности (абсолютный лимит — 30).
            </Li>
            <Li>
              Защита от брутфорса: 30 попыток / 5 мин с одного IP + блокировка аккаунта
              на 15 минут после 5 неудач. Ответ на неверный email и неверный пароль
              одинаков (защита от перечисления сотрудников).
            </Li>
            <Li>Смена пароля и «Завершить все прочие» аннулируют другие сессии.</Li>
          </ul>

          <SubTitle>Права доступа (RBAC)</SubTitle>
          <p>
            VIEWER — только чтение; MANAGER — работа с доменом (клиенты, шаблоны, воронки,
            рассылки); ADMIN — плюс пользователи, API-ключи, настройки, интеграции,
            журнал аудита и скачивание дистрибутива. Проверка выполняется на сервере
            для каждого запроса — роль нельзя подделать параметром.
          </p>

          <SubTitle>Защита каналов и секретов</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Кросс-сайтовые мутации (CSRF) отклоняются гейтом Sec-Fetch-Site / Origin;
              API доступен только с своего origin (CORS не включён).
            </Li>
            <Li>
              Секреты провайдеров (токен SMS.Tech, логин/пароль Т2, логин/пароль МТС) хранятся в БД
              зашифрованными AES-256-GCM; в панель отдаются только маски — даже
              администратор не видит их целиком.
            </Li>
            <Li>
              Все публичные приёмники защищены: «Захват событий» — токен приёмника;
              события ядра — X-Api-Key с IP-allowlist; webhook-и провайдеров —
              секретами (SMS.Tech/T2 — задать в .env, см. ниже) и лимитом 300/мин;
              отписочные ссылки — HMAC-подписью и лимитом 60/мин.
            </Li>
            <Li>Сверки секретов/токенов — за постоянное время (анти-тайминг).</Li>
          </ul>

          <SubTitle>Данные и след</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Валидация всех входов (zod); доступ к БД — только через ORM
              (параметризованные запросы, SQL-инъекции невозможны).
            </Li>
            <Li>
              Публичные приёмники ограничивают размер тела (webhook-и и события —
              2–5 МБ, сверх — 413) — «толстый» POST не монополизирует сервер.
            </Li>
            <Li>
              Экспорт CSV и все значимые действия — в журнале аудита (кто, когда,
              с какого IP); неудачные попытки входа по секретам приёмников —
              отдельными SECURITY-записями.
            </Li>
            <Li>
              Раздел «Настройки» → «Безопасность»: активные сессии с завершением
              (все роли) и
              «Состояние защиты» — живой чек-лист конфигурации для отдела ИБ
              (ADMIN).
            </Li>
            <Li>
              HTTP-заголовки безопасности (nosniff, Referrer-Policy, CSP, HSTS,
              no-store для API) выставляются автоматически в production-режиме.
            </Li>
          </ul>

          <SubTitle>При развёртывании на сервере компании</SubTitle>
          <ul className="space-y-1.5">
            <Li>
              Заполнить <Code>.env</Code> сгенерированными секретами и выставить{' '}
              <Code>chmod 600</Code> (чек-лист — <Code>docs/security.md</Code>).</Li>
            <Li>
              Задать <Code>SMSTECH_WEBHOOK_SECRET</Code> и <Code>T2_WEBHOOK_SECRET</Code> и
              сообщить провайдерам — webhook-и станут подписанными.
            </Li>
            <Li>
              Включить <Code>FRAME_PROTECTION=1</Code> в <Code>.env</Code> (запрет встраивания
              панели в чужие iframe — применяется на лету, без пересборки) и терминировать
              HTTPS на корпоративном reverse-proxy.
            </Li>
            <Li>
              Открыть наружу только приёмные эндпоинты; саму панель — сотрудникам
              через VPN/корпоративную сеть.
            </Li>
          </ul>
        </DocCard>

        {/* 20. Дистрибутив */}
        {isAdmin ? <DistributiveSection /> : null}
      </div>
    </div>
  );
}
