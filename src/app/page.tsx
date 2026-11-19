'use client';

// ВХОДНАЯ ТОЧКА приложения — единственная страница «/» (SPA без React Router).
// Здесь решается, ЧТО показать, в два этапа:
//   1) URL-режим: ?u={код} / ?unsub={токен} — публичная страница отписки из
//      SMS (без авторизации); ?view={экран} — восстановление активной вкладки
//      (Zustand-стор, см. lib/store);
//   2) Сессия: откуда берётся — запрос GET /api/v1/auth/me (HttpOnly-cookie
//      tg_sid, при блокировке cookie — Bearer-фолбэк, см. lib/api-client).
//      Нет сессии → LoginView; есть, но mustChangePassword → ChangePasswordGate
//      (принудительная смена после выдачи/сброса пароля); иначе → AppShell —
//      рабочая оболочка, экраны внутри переключаются через store.setView.
// Пока URL/сессия не выяснены — Splash-заглушка (мигание логина исключено
// трёхзначным стейтом: undefined «ещё не читали» ≠ null «параметра нет»).
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageSquareText } from 'lucide-react';

import { api } from '@/lib/api-client';
import { useAppStore, VIEWS, type CurrentUser, type View } from '@/lib/store';
import { AppShell } from '@/components/app-shell';
import { LoginView } from '@/components/views/login-view';
import { ChangePasswordGate } from '@/components/views/change-password';
import { UnsubscribePublicView } from '@/components/views/unsubscribe-public-view';

/** Заглушка на время проверки URL/сессии: пульсирующая эмблема «загрузка…». */
function Splash() {
  return (
    <main className="grid min-h-screen place-items-center bg-zinc-50">
      <div className="flex flex-col items-center gap-4">
        <div className="flex size-14 animate-pulse items-center justify-center rounded-xl bg-emerald-600 text-white">
          <MessageSquareText className="size-7" aria-hidden />
        </div>
        <p className="text-sm text-zinc-500">Trigger · загрузка…</p>
      </div>
    </main>
  );
}

/** Корневой компонент «/»: бутстрап React Query + выбор корневого
 * представления (отписка / логин / смена пароля / оболочка). */
export default function Home() {
  // Один QueryClient на всё приложение (ленивая инициализация в useState —
  // не пересоздаётся при ререндерах): все запросы *-view идут через react-query
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // staleTime 0: при каждом открытии вкладки данные перезапрашиваются —
          // правки и фоновые изменения (воркер, вебхуки) видны мгновенно.
          queries: { retry: 1, staleTime: 0, refetchOnWindowFocus: false },
        },
      }),
  );

  // undefined = параметры URL ещё не прочитаны; ?u={код} — короткая ссылка,
  // ?unsub={токен} — полная (легаси-ссылки из ранее отправленных SMS)
  const [unsubToken, setUnsubToken] = React.useState<string | null | undefined>(undefined);
  const [shortCode, setShortCode] = React.useState<string | null | undefined>(undefined);
  const user = useAppStore((s) => s.user);
  const authChecked = useAppStore((s) => s.authChecked);

  React.useEffect(() => {
    // Один раз на монтировании: разбор ?u/?unsub/?view и первичная проверка
    // сессии (window недоступен при SSR — поэтому в эффекте, а не в теле рендера)
    const params = new URLSearchParams(window.location.search);
    const token = params.get('unsub');
    const code = params.get('u');
    setUnsubToken(token);
    setShortCode(code);
    if (!token && !code) {
      // Это не ссылка отписки: восстановить вкладку из ?view= и проверить
      // сессию. Ошибка запроса — тоже результат: user=null → LoginView.
      const v = params.get('view');
      if (v && (VIEWS as string[]).includes(v)) {
        useAppStore.setState({ view: v as View });
      }
      api<{ user: CurrentUser }>('/api/v1/auth/me')
        .then((res) => useAppStore.getState().setUser(res.user))
        .catch(() => useAppStore.getState().setUser(null))
        .finally(() => useAppStore.getState().setAuthChecked(true));
    }
  }, []);

  // Каскад решений (порядок важен): splash до чтения URL → публичная отписка
  // (короткая ссылка приоритетнее полного токена) → splash до проверки сессии
  // → логин → принудительная смена пароля → рабочая оболочка панели.
  let content: React.ReactNode;
  if (unsubToken === undefined || shortCode === undefined) {
    content = <Splash />;
  } else if (shortCode !== null) {
    content = <UnsubscribePublicView shortCode={shortCode} />;
  } else if (unsubToken !== null) {
    content = <UnsubscribePublicView token={unsubToken} />;
  } else if (!authChecked) {
    content = <Splash />;
  } else if (!user) {
    content = <LoginView />;
  } else if (user.mustChangePassword) {
    content = <ChangePasswordGate />;
  } else {
    content = <AppShell />;
  }

  // Все представления — под одним провайдером: кэш/инвалидации общие
  // (мутация в одном виде перечитывает данные в другом)
  return <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>;
}
