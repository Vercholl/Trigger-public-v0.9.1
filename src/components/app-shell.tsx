'use client';

// Оболочка панели (AppShell): сайдбар-навигация + липкая шапка + контентная область.
// Домен: каркас всего UI. Переключение экранов — НЕ роутингом Next.js, а через
// Zustand-стор (src/lib/store.ts, поле view): ViewSwitch ниже читает view и
// рендерит нужный *-view компонент, sidebar пишет setView. Сеть — только
// POST /api/v1/auth/logout при выходе (смена пароля — в ChangePasswordDialog).
// Открывают все роли (ADMIN/MANAGER/VIEWER); пункты меню с adminOnly
// (Пользователи, Интеграции) видны только ADMIN. Разделы «Настроек»
// (Безопасность/Кастомные поля/Ссылки) — отдельные значения view
// внутри SettingsView (поднавигация), в сайдбаре их нет; разделы «Интеграций»
// (Интеграция с системой данных/API-ключи/SMS-провайдеры) — аналогично
// внутри IntegrationsView (Task 59).
import * as React from 'react';
import {
  Ban,
  BookOpen,
  ChevronDown,
  Filter,
  GitBranch,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  MessageSquareText,
  Moon,
  Plug,
  Radio,
  Send,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';

import { TriggerLogo } from '@/components/logo';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { api, clearStoredBearer } from '@/lib/api-client';
import { useAppStore, type View } from '@/lib/store';
import { initialsOf, RoleBadge } from '@/components/views/shared';
import { ChangePasswordDialog } from '@/components/views/change-password';
import { DashboardView } from '@/components/views/dashboard-view';
import { FunnelsView } from '@/components/views/funnels-view';
import { TemplatesView } from '@/components/views/templates-view';
import { ClientsView } from '@/components/views/clients-view';
import { SegmentsView } from '@/components/views/segments-view';
import { BroadcastsView } from '@/components/views/broadcasts-view';
import { LinksView } from '@/components/views/links-view';
import { EventsView } from '@/components/views/events-view';
import { SmsLogView } from '@/components/views/sms-log-view';
import { DeliveryEventsView } from '@/components/views/delivery-events-view';
import { UnsubscribedView } from '@/components/views/unsubscribed-view';
import { UsersView } from '@/components/views/users-view';
import { IntegrationsView } from '@/components/views/integrations-view';
import { SettingsView } from '@/components/views/settings-view';
import { DocsView } from '@/components/views/docs-view';

/** Пункт меню сайдбара: view — значение из Zustand-стора; adminOnly — виден только ADMIN. */
interface NavItem {
  view: View;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

// Значения view, которые рендерятся РАЗДЕЛАМИ «Настроек» (Task 58: Безопасность,
// Кастомные поля и Ссылки переехали из сайдбара внутрь «Настроек» — вкладок
// на главном экране стало меньше). Используются подсветкой пункта «Настройки»
// и выводом заголовка шапки; ?view=security и т.п. остаются рабочими ссылками.
const SETTINGS_SECTION_VIEWS: ReadonlySet<View> = new Set([
  'settings',
  'security',
  'custom-fields',
  'links',
]);

// Мета «Настроек» — общая для всех четырёх значений view (шапка показывает
// один и тот же заголовок, активный раздел виден в поднавигации SettingsView).
const SETTINGS_META = {
  title: 'Настройки',
  description: 'Рассылки, комплаенс, безопасность, кастомные поля и ссылки',
};

// Значения view, которые рендерятся РАЗДЕЛАМИ «Интеграций» (Task 59: «API-ключи»
// переехали из сайдбара внутрь «Интеграций» — раздел «Интеграция с системой
// данных»; 'sms-providers' — раздел подключения провайдеров). Используются
// подсветкой пункта «Интеграции» и выводом заголовка шапки; ?view=api-keys и
// ?view=sms-providers остаются рабочими ссылками.
const INTEGRATIONS_SECTION_VIEWS: ReadonlySet<View> = new Set([
  'integrations',
  'api-keys',
  'sms-providers',
]);

// Мета «Интеграций» — общая для всех трёх значений view (шапка показывает
// один и тот же заголовок, активный раздел виден в поднавигации IntegrationsView).
const INTEGRATIONS_META = {
  title: 'Интеграции',
  description: 'Интеграция с внешней системой данных и подключения SMS-провайдеров',
};

// Статическое меню в порядке разделов панели; роли фильтруются на лету в
// SidebarNav (adminOnly-пункты скрыты от MANAGER/VIEWER — это UI-гвард,
// сервер проверяет RBAC повторно на каждом /api/v1-запросе).
const NAV: NavItem[] = [
  { view: 'dashboard', label: 'Дашборд', icon: LayoutDashboard },
  { view: 'funnels', label: 'Воронки', icon: GitBranch },
  { view: 'templates', label: 'Шаблоны', icon: MessageSquareText },
  { view: 'clients', label: 'Клиенты', icon: Users },
  { view: 'segments', label: 'Сегменты', icon: Filter },
  { view: 'broadcasts', label: 'Рассылки', icon: Megaphone },
  { view: 'events', label: 'События', icon: Zap },
  { view: 'sms', label: 'SMS-лог', icon: Send },
  { view: 'delivery', label: 'События доставки', icon: Radio },
  { view: 'unsubscribed', label: 'Отписки', icon: Ban },
  { view: 'users', label: 'Пользователи', icon: ShieldCheck, adminOnly: true },
  { view: 'integrations', label: 'Интеграции', icon: Plug, adminOnly: true },
  { view: 'settings', label: 'Настройки', icon: Settings },
  { view: 'docs', label: 'Документация', icon: BookOpen },
];

// Заголовок (h1 шапки) и краткое описание для каждого экрана; ключи = View из стора.
const VIEW_META: Record<View, { title: string; description: string }> = {
  dashboard: { title: 'Дашборд', description: 'Ключевые метрики SMS-коммуникаций' },
  funnels: { title: 'Воронки', description: 'Конструктор автоматических SMS-цепочек по событиям' },
  templates: { title: 'Шаблоны SMS', description: 'Тексты сообщений с переменными {{var}}' },
  clients: { title: 'Клиенты', description: 'База клиентов, согласия и отписки' },
  segments: {
    title: 'Сегменты',
    description: 'Группы клиентов по полям карточки — для рассылок и аналитики',
  },
  broadcasts: {
    title: 'Рассылки',
    description: 'Массовые SMS по сегментам: разовые и регулярные, с защитой от спама',
  },
  events: {
    title: 'События',
    description: 'Отправка тестовых событий, журнал и экземпляры воронок',
  },
  sms: { title: 'SMS-лог', description: 'История отправленных сообщений' },
  delivery: {
    title: 'События доставки',
    description: 'Захват событий: отправки, доставки, клики и отписки — со всех источников',
  },
  unsubscribed: { title: 'Отписавшиеся', description: 'Номера, исключённые из рекламных рассылок' },
  users: { title: 'Пользователи', description: 'Учётные записи и роли панели' },
  links: SETTINGS_META,
  'custom-fields': SETTINGS_META,
  integrations: INTEGRATIONS_META,
  'api-keys': INTEGRATIONS_META,
  'sms-providers': INTEGRATIONS_META,
  security: SETTINGS_META,
  settings: SETTINGS_META,
  docs: {
    title: 'Документация',
    description: 'Руководство пользователя: правила отправки, шаблоны, воронки, рассылки',
  },
};

// Юридическая строка-футер (152-ФЗ: данные синтетические, внутренний контур) — одна на все экраны.
// Номер релиза не дублируется: актуальная версия дистрибутива — в «Документации»
// (карточка «Дистрибутив», из манифеста download/latest.json), чтобы не плодить
// рассинхрон ярлыков при сборке.
const FOOTER_TEXT =
  'Trigger · Внутренний инструмент компании · Данные синтетические (152-ФЗ) · Внутренний контур: доступ только через VPN/allowlist';

/**
 * Меню сайдбара. Используется дважды: в десктопном <aside> и в мобильной
 * шторке Sheet (onNavigate закрывает её после выбора пункта). Клик пишет
 * view в стор — перерисовку делает AppShell/ViewSwitch, не роутер.
 */
function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const isAdmin = useAppStore((s) => s.user?.role === 'ADMIN');
  const items = NAV.filter((item) => !item.adminOnly || isAdmin);

  return (
    <nav aria-label="Основная навигация" className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
      {items.map((item) => {
        // Разделы «Настроек» (security/custom-fields/links) подсвечивают
        // пункт «Настройки»; разделы «Интеграций» (api-keys/sms-providers) —
        // пункт «Интеграции» (Task 59): своего пункта в сайдбаре у них нет.
        const active =
          view === item.view ||
          (item.view === 'settings' && SETTINGS_SECTION_VIEWS.has(view)) ||
          (item.view === 'integrations' && INTEGRATIONS_SECTION_VIEWS.has(view));
        return (
          <button
            key={item.view}
            type="button"
            onClick={() => {
              setView(item.view);
              onNavigate?.();
            }}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex w-full items-center gap-3 rounded-md border-l-2 px-3 py-2 text-left text-sm transition-colors',
              active
                ? 'border-emerald-500 bg-emerald-600/15 font-medium text-emerald-400'
                : 'border-transparent text-zinc-400 hover:bg-zinc-800 hover:text-white',
            )}
          >
            <item.icon className="size-4 shrink-0" aria-hidden />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

function SidebarLogo() {
  // Высота строго h-14 = высоте шапки: нижние границы блока и header
  // образуют одну непрерывную линию (без «лесенки» — фикс из V2).
  return (
    <div className="flex h-14 items-center border-b border-zinc-800 px-4">
      <TriggerLogo />
    </div>
  );
}

/**
 * Меню пользователя в шапке: аватар с инициалами, RoleBadge, смена пароля
 * (ChangePasswordDialog) и выход. logout дергает POST /api/v1/auth/logout;
 * при ошибке сети всё равно уходим на экран входа (сброс user в finally),
 * параллельно чистится Bearer-фолбэк из localStorage.
 */
function UserMenu() {
  const user = useAppStore((s) => s.user);
  const setUser = useAppStore((s) => s.setUser);
  const [pwOpen, setPwOpen] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);

  if (!user) return null;

  async function logout() {
    setLoggingOut(true);
    try {
      await api<void>('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      /* сессия могла истечь — всё равно уходим на экран входа */
    } finally {
      clearStoredBearer(); // чистим и Bearer-фолбэк (если использовался)
      setUser(null);
      setLoggingOut(false);
      toast.success('Вы вышли из системы');
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-9 gap-2 px-2" aria-label="Меню пользователя">
            <Avatar className="size-7">
              <AvatarFallback className="bg-emerald-600/15 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                {initialsOf(user.name, user.email)}
              </AvatarFallback>
            </Avatar>
            <span className="hidden max-w-[160px] truncate text-sm text-zinc-700 dark:text-zinc-300 sm:block">
              {user.email}
            </span>
            <ChevronDown className="size-4 text-zinc-400" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>
            <p className="truncate text-sm font-medium text-foreground">{user.email}</p>
            <div className="mt-1.5">
              <RoleBadge role={user.role} />
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setPwOpen(true)}>
            <Settings className="size-4" aria-hidden />
            Сменить пароль
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              void logout();
            }}
            disabled={loggingOut}
            className="text-red-600 focus:text-red-600"
          >
            <LogOut className="size-4" aria-hidden />
            Выйти
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </>
  );
}

/** Переключатель светлой/тёмной темы (класс на <html>, выбор в localStorage). */
function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  if (!mounted) {
    // серверный рендер — заглушка той же геометрии (исключает скачок вёрстки)
    return (
      <Button
        variant="ghost"
        size="icon"
        className="size-9"
        aria-label="Переключить тему оформления"
      />
    );
  }
  const dark = resolvedTheme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-9"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Включить светлую тему' : 'Включить тёмную тему'}
      title={dark ? 'Светлая тема' : 'Тёмная тема'}
    >
      {dark ? <Sun className="size-5" aria-hidden /> : <Moon className="size-5" aria-hidden />}
    </Button>
  );
}

/**
 * «Клиентский роутер» SPA: по view из Zustand-стора возвращает компонент
 * активного экрана. Все представления панели живут в этом switch — новый
 * экран добавляется сюда + в NAV/VIEW_META + в тип View (store.ts).
 * Разделы «Настроек» (settings/security/custom-fields/links) рендерятся
 * одним компонентом SettingsView — он сам читает view из стора и показывает
 * нужную поднавигацию (см. views/settings-view.tsx); разделы «Интеграций»
 * (integrations/api-keys/sms-providers) — одним компонентом IntegrationsView
 * (см. views/integrations-view.tsx).
 */
function ViewSwitch() {
  const view = useAppStore((s) => s.view);
  switch (view) {
    case 'dashboard':
      return <DashboardView />;
    case 'funnels':
      return <FunnelsView />;
    case 'templates':
      return <TemplatesView />;
    case 'clients':
      return <ClientsView />;
    case 'segments':
      return <SegmentsView />;
    case 'broadcasts':
      return <BroadcastsView />;
    case 'events':
      return <EventsView />;
    case 'sms':
      return <SmsLogView />;
    case 'delivery':
      return <DeliveryEventsView />;
    case 'unsubscribed':
      return <UnsubscribedView />;
    case 'users':
      return <UsersView />;
    case 'integrations':
    case 'api-keys':
    case 'sms-providers':
      return <IntegrationsView />;
    case 'settings':
    case 'security':
    case 'custom-fields':
    case 'links':
      return <SettingsView />;
    case 'docs':
      return <DocsView />;
    default:
      return <DashboardView />;
  }
}

/**
 * Корневая оболочка после входа: тёмный сайдбар (десктоп) или шторка Sheet
 * (мобильные), липкая шапка с заголовком из VIEW_META + ThemeToggle +
 * UserMenu, контентная область с ViewSwitch и общий футер. Высоты блоков
 * (h-14 лого/шапки, футеры) выровнены в одну линию — см. инлайн-комментарии.
 */
export function AppShell() {
  const view = useAppStore((s) => s.view);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const meta = VIEW_META[view];

  return (
    <div className="flex min-h-screen flex-col bg-muted dark:bg-background">
      <div className="flex flex-1">
        {/* Сайдбар (десктоп) */}
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col bg-zinc-900 text-zinc-300 md:flex">
          <SidebarLogo />
          <SidebarNav />
          {/* Та же высота, что у футера (py-2 + text-[11px]) — верхние границы
              совпадают одной линией, без «лесенки». */}
          <div className="border-t border-zinc-800 px-4 py-2">
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">Данные: синтетические</p>
          </div>
        </aside>

        {/* Основная колонка */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* Высота строго h-14 = высоте лого-блока сайдбара — одна линия */}
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background/80 px-4 backdrop-blur md:px-6">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={() => setMobileOpen(true)}
                aria-label="Открыть меню навигации"
              >
                <Menu className="size-5" aria-hidden />
              </Button>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold text-foreground">{meta.title}</h1>
                <p className="hidden truncate text-xs text-zinc-500 dark:text-zinc-400 sm:block">
                  {meta.description}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <UserMenu />
            </div>
          </header>

          <div className="flex-1 p-4 md:p-6">
            <ViewSwitch />
          </div>

          <footer className="mt-auto border-t border-border bg-background px-4 py-2 text-center text-[11px] text-zinc-400">
            {FOOTER_TEXT}
          </footer>
        </main>
      </div>

      {/* Мобильная навигация */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-72 gap-0 border-r-0 bg-zinc-900 p-0 text-zinc-300 sm:max-w-none"
          aria-describedby={undefined}
        >
          <SheetTitle className="sr-only">Навигация</SheetTitle>
          <SidebarLogo />
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
          <div className="border-t border-zinc-800 px-4 py-2">
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">Данные: синтетические</p>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
