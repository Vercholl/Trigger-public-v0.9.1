'use client';

// Zustand-стор панели — единственное глобальное состояние фронтенда (SPA без
// React Router: вся навигация через состояние view).
//
// Срезы: (1) сессия — user + authChecked; (2) навигация — активный экран view
// (AppShell рендерит по нему разделы сайдбара).
//
// Пишут: app/page.tsx (первичная проверка сессии /auth/me и восстановление
// ?view= из URL), views/login-view (вход/выход), views/change-password,
// lib/api-client (сброс user при 401 — во вне-React-контексте через getState),
// components/app-shell (переключение экранов). Читают: page.tsx (решение
// «логин или оболочка»), app-shell и все *-view (подписка селекторами).
//
// Персистентности нет: после перезагрузки страницы сессия восстанавливается
// запросом /api/v1/auth/me (см. app/page.tsx), экран — из ?view= в URL.
import { create } from 'zustand';

/** Экран панели (вкладка сайдбара). Порядок в VIEWS — порядок навигации.
 *  Примечание (Task 58): 'security', 'custom-fields' и 'links' — не вкладки
 *  сайдбара, а РАЗДЕЛЫ «Настроек» (поднавигация SettingsView); значения
 *  сохранены в объединении ради ссылок ?view=security и подсветки раздела.
 *  Примечание (Task 59): 'api-keys' и 'sms-providers' — тоже не вкладки
 *  сайдбара, а разделы «Интеграций» (поднавигация IntegrationsView:
 *  «Интеграция с системой данных» и «SMS-провайдеры»); 'api-keys' — легаси-
 *  значение, оставшееся от бывшего отдельного экрана ключей. */
export type View =
  | 'dashboard'
  | 'funnels'
  | 'templates'
  | 'clients'
  | 'segments'
  | 'broadcasts'
  | 'links'
  | 'events'
  | 'sms'
  | 'delivery'
  | 'unsubscribed'
  | 'users'
  | 'api-keys'
  | 'custom-fields'
  | 'integrations'
  | 'sms-providers'
  | 'security'
  | 'settings'
  | 'docs';

/** Роль пользователя (зеркало серверного Role из lib/api.ts — для типизации UI). */
export type Role = 'ADMIN' | 'MANAGER' | 'VIEWER';

/** Текущий пользователь сессии (форма ответа /api/v1/auth/me). */
export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  /** Принудительная смена при первом входе/после сброса пароля —
   * page.tsx вместо оболочки показывает ChangePasswordGate. */
  mustChangePassword: boolean;
}

/** Полный список экранов в порядке сайдбара. Также используется app/page.tsx
 * для валидации ?view= из URL (неизвестное значение игнорируется). */
export const VIEWS: View[] = [
  'dashboard',
  'funnels',
  'templates',
  'clients',
  'segments',
  'broadcasts',
  'links',
  'events',
  'sms',
  'delivery',
  'unsubscribed',
  'users',
  'api-keys',
  'custom-fields',
  'integrations',
  'sms-providers',
  'security',
  'settings',
  'docs',
];

/** Срезы состояния + действия-сеттеры (Zustand). */
interface AppState {
  user: CurrentUser | null;
  /** false — сессия ещё проверяется (показываем Splash, а не логин). */
  authChecked: boolean;
  view: View;
  setUser: (user: CurrentUser | null) => void;
  setAuthChecked: (checked: boolean) => void;
  setView: (view: View) => void;
}

/** Хранилище Zustand. Подписка селектором: useAppStore((s) => s.user);
 * вне React — useAppStore.getState()/setState() (так делает api-client при 401). */
export const useAppStore = create<AppState>((set) => ({
  user: null,
  authChecked: false,
  view: 'dashboard',
  setUser: (user) => set({ user }),
  setAuthChecked: (authChecked) => set({ authChecked }),
  setView: (view) => {
    set({ view });
    if (typeof window !== 'undefined') {
      try {
        // replaceState (не pushState): история браузера не обрастает каждым
        // переключением вкладки («назад» не листает экраны), а URL остаётся
        // восстанавливаемым/шаряемым — /?view=clients переживёт F5.
        window.history.replaceState(null, '', `/?view=${view}`);
      } catch {
        /* ignore history errors */
      }
      // каждый экран начинается сверху (мгновенно, без анимации скролла)
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    }
  },
}));
