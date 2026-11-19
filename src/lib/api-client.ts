'use client';

// Клиентский fetch-обёртка — единственная точка обращения фронтенда к API
// (api()/downloadCsv/authHeaders используют все *-view и app-shell).
//
// Сессия: основная — HttpOnly-cookie tg_sid (fetch credentials: same-origin,
// передаётся автоматически); аварийный Bearer-фолбэк в localStorage — только
// когда браузер блокирует cookie (кросс-сайт iframe предпросмотра платформы,
// см. establishSession).
//
// Ошибки: тело любой ошибки сервера приходит в RFC 7807 ProblemDetail —
// разбираем title/detail в клиентский ApiError; сетевой сбой fetch →
// ApiError(0, 'Сервер недоступен'); 401 (не login) — сбрасывает сессию в
// Zustand-сторе → панель показывает экран входа.
import { useAppStore, type CurrentUser } from './store';

/** Ключ localStorage для аварийного Bearer-фолбэка (см. establishSession).
 * Хранится ТОЛЬКО когда cookie не работают; в обычном режиме токен не
 * сохраняется вовсе (HttpOnly остаётся единственным носителем сессии). */
const BEARER_KEY = 'tg_bearer';

/** Ошибка API на основе RFC 7807 ProblemDetail. */
export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string | null;

  constructor(status: number, title: string, detail: string | null = null) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'ApiError';
    this.status = status;
    this.title = title;
    this.detail = detail;
  }
}

/** Параметры запроса: method (по умолчанию POST при наличии body, иначе GET)
 * и body — произвольное значение, сериализуется в JSON. */
interface ApiOptions {
  method?: string;
  body?: unknown;
}

/** Токен-фолбэк из localStorage (SSR/заблокированный storage → null). */
function storedBearer(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(BEARER_KEY);
  } catch {
    return null; // приватный режим / блокировка storage
  }
}

/** Запись/удаление токена-фолбэка (best-effort: приватный режим может
 * блокировать storage — ошибки молча проглатываем, cookie-режим не страдает). */
function setStoredBearer(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token === null) window.localStorage.removeItem(BEARER_KEY);
    else window.localStorage.setItem(BEARER_KEY, token);
  } catch {
    /* приватный режим / блокировка storage — фолбэк недоступен */
  }
}

/** Публичная очистка (выход, устаревшая сессия). */
export function clearStoredBearer(): void {
  setStoredBearer(null);
}

/** Заголовки авторизации для ПРЯМЫХ fetch (cookie + Bearer-фолбэк).
 * Нужно для blob-скачиваний вне api()-клиента (дистрибутив и т.п.): в iframe предпросмотра
 * браузер блокирует cookie — без этого заголовка сервер получит запрос без авторизации. */
export function authHeaders(): Record<string, string> | undefined {
  return buildHeaders(false);
}

/** Заголовки запроса: Content-Type для JSON-тела + Authorization, если
 * сохранён Bearer-фолбэк (нет того и другого → undefined, чтобы fetch
 * не ставил бесполезный пустой заголовок). */
function buildHeaders(hasBody: boolean): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (hasBody) headers['Content-Type'] = 'application/json';
  const token = storedBearer();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Базовый клиент API. Только относительные пути (`/api/v1/...`),
 * cookie-сессия передаётся автоматически (same-origin); если браузер блокирует
 * cookie (кросс-сайт iframe предпросмотра) — прикладывается Bearer-токен.
 * 401 (кроме login) сбрасывает пользователя в store — SPA показывает экран входа.
 *
 * Ошибки (побочные эффекты): не-2xx → ApiError с title/detail из ProblemDetail-тела
 * (не-JSON тело, например HTML-страница ошибки прокси, — остаётся `HTTP <статус>`);
 * сетевой отказ fetch — ApiError(0, 'Сервер недоступен'); 401 дополнительно чистит
 * Bearer-фолбэк и user в store. 204 → undefined; успех — разобранный JSON-ответ.
 * @param opts.method не задан → POST при наличии body, иначе GET
 */
export async function api<T>(path: string, opts?: ApiOptions): Promise<T> {
  const hasBody = opts?.body !== undefined;
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts?.method ?? (hasBody ? 'POST' : 'GET'),
      headers: buildHeaders(hasBody),
      credentials: 'same-origin',
      body: hasBody ? JSON.stringify(opts?.body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, 'Сервер недоступен', err instanceof Error ? err.message : null);
  }

  if (!res.ok) {
    // Истёкшая сессия: выходим сразу (токен-фолбэк — тоже) — без попытки
    // разобрать тело; экран входа покажет page.tsx по user=null в store.
    if (res.status === 401 && !path.includes('/auth/login')) {
      setStoredBearer(null);
      useAppStore.getState().setUser(null);
    }
    let title = `HTTP ${res.status}`;
    let detail: string | null = null;
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === 'object') {
        const pd = parsed as Record<string, unknown>;
        if (typeof pd.title === 'string' && pd.title.length > 0) title = pd.title;
        if (typeof pd.detail === 'string' && pd.detail.length > 0) detail = pd.detail;
      }
    } catch {
      /* тело не JSON (например, HTML-страница 404) — оставляем HTTP-статус */
    }
    throw new ApiError(res.status, title, detail);
  }

  if (res.status === 204) {
    // успешное удаление и т.п. — тела нет
    return undefined as T;
  }
  return (await res.json()) as T;
}

/**
 * Завершение входа: основная схема — HttpOnly-cookie (токен НЕ сохраняется).
 * Если браузер отбросил cookie (кросс-сайт iframe предпросмотра, Safari ITP,
 * блокировка сторонних cookie) — /auth/me вернёт 401, и тогда токен из ответа
 * логина сохраняется в localStorage как Bearer-фолбэк и проверяется повторно.
 * Возвращает true, если сессия подтверждена хотя бы одним способом.
 */
export async function establishSession(loginResponse: {
  user: CurrentUser;
  sessionToken?: string;
}): Promise<boolean> {
  // Чистим возможный устаревший токен — пробуем чистую cookie-сессию.
  setStoredBearer(null);
  try {
    await api('/api/v1/auth/me');
    return true; // cookie работает — токен не храним (HttpOnly остаётся единственным)
  } catch {
    /* cookie не работает — переходим к фолбэку */
  }
  const token = loginResponse.sessionToken;
  if (!token) return false;
  setStoredBearer(token);
  try {
    await api<{ user: CurrentUser }>('/api/v1/auth/me');
    return true; // Bearer подтверждён
  } catch {
    setStoredBearer(null);
    return false;
  }
}

/** Скачивание CSV-экспорта (blob → файл). Имя файла — из content-disposition
 * ответа (fallbackName при отсутствии); 401 сбрасывает сессию как api().
 * Побочный эффект: создаёт временный <a download> и кликает его (запуск
 * скачивания браузером), объект-URL освобождается через 5 с. */
export async function downloadCsv(path: string, fallbackName = 'export.csv'): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { headers: buildHeaders(false), credentials: 'same-origin' });
  } catch (err) {
    throw new ApiError(0, 'Сервер недоступен', err instanceof Error ? err.message : null);
  }
  if (!res.ok) {
    if (res.status === 401) {
      setStoredBearer(null);
      useAppStore.getState().setUser(null);
    }
    throw new ApiError(res.status, 'Ошибка экспорта', `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/i.exec(cd);
  const filename = match?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
