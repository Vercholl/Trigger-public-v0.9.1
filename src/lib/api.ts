// Помощники API-слоя: RFC 7807 ProblemDetail, пагинация, обёртки авторизации,
// разбор IP клиента и преобразование ошибок (zod/ApiError/неизвестных) в ProblemDetail.
//
// Слой: серверные утилиты route-handler'ов — используются всеми роутами
// src/app/api/**. withAuth — авторизуемые эндпоинты панели (/api/v1/**),
// publicRoute — публичные приёмники (webhook-и провайдеров, отписка, короткие
// ссылки r/u). Приёмники событий берут отсюда же getClientIp (аудит/лимиты)
// и deriveBaseUrl (ссылки отписки в тексте SMS).
import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getSessionUser, type SessionUser } from '@/lib/security/session';
import { isHttpsRequest } from '@/lib/security/https';

/** Роль пользователя панели. Иерархия прав: VIEWER < MANAGER < ADMIN. */
export type Role = 'ADMIN' | 'MANAGER' | 'VIEWER';

/** Числовые ранги ролей для сравнения «не ниже требуемой» (RBAC-модель withAuth). */
const ROLE_RANK: Record<string, number> = { VIEWER: 1, MANAGER: 2, ADMIN: 3 };

/** Ранг роли по имени. Неизвестная роль → 0 — не проходит ни одну проверку прав. */
export function roleRank(role: string): number {
  return ROLE_RANK[role] ?? 0;
}

/** RFC 7807 ProblemDetail-ответ: JSON { type, title, status, detail? }.
 * Единый формат ВСЕХ ошибок API — клиент разбирает его в ApiError (lib/api-client.ts). */
export function problem(status: number, title: string, detail?: string): NextResponse {
  const body: Record<string, unknown> = { type: 'about:blank', title, status };
  if (detail !== undefined && detail !== null) body.detail = detail;
  return NextResponse.json(body, { status });
}

/** Доменная ошибка: сервис бросает, обёртка превращает в ProblemDetail.
 * Носит HTTP-статус и короткий title — «легальный» способ для слоя услуг
 * сообщить роуту об отказе (4xx); ошибки валидации отдаются zod → 422. */
export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail?: string;

  constructor(status: number, title: string, detail?: string) {
    super(detail ?? title);
    this.name = 'ApiError';
    this.status = status;
    this.title = title;
    this.detail = detail;
  }
}

/** Разбор JSON-тела запроса с понятной 400-ошибкой при мусоре. */
export async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, 'Некорректное тело запроса', 'Ожидается корректный JSON');
  }
}

/** Пагинация списка: страница 1-based + предвычисленные skip/take для Prisma-запросов. */
export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

/** Query-параметр → положительное целое; пусто/мусор/≤0 → fallback. */
function toPositiveInt(value: string | null, fallback: number): number {
  if (value === null || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Пагинация из query: page (1-based), pageSize 1..100 (по умолчанию 20;
 * сверху обрезается — защита от «выкачать всю таблицу» одним запросом). */
export function parsePagination(searchParams: URLSearchParams): Pagination {
  const page = toPositiveInt(searchParams.get('page'), 1);
  let pageSize = toPositiveInt(searchParams.get('pageSize'), 20);
  if (pageSize > 100) pageSize = 100;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** IP клиента. За шлюзом Caddy ставит x-real-ip и ПЕРЕЗАПИСЫВАЕТ x-forwarded-for
 * фактическим адресом; при прямой цепочке прокси, ДОПИСЫВАЮЩИХ XFF, подделанный
 * злоумышленником адрес стоит в начале списка — поэтому берём ПОСЛЕДНИЙ элемент.
 * Фолбэк 'direct' (а не 'unknown', v0.8.8): маркер «подключение без прокси,
 * адрес определить нельзя» — честная причина в audit-журнале. Rate-лимиты при
 * этом делят ОДИН бакет на всех direct-клиентов, поэтому боевой деплой обязан
 * ходить через reverse-proxy, ставящий x-real-ip (см. docs/security.md). */
export function getClientIp(req: NextRequest): string {
  const realIp = req.headers.get('x-real-ip');
  if (realIp && realIp.trim() !== '') return realIp.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter((p) => p !== '');
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return 'direct';
}

/** Origin запроса (для ссылок отписки): общий HTTPS-детектор + заголовки хоста. */
export function deriveBaseUrl(req: NextRequest): string {
  // Мульти-сигнальный детект (шлюз затирает x-forwarded-proto — см. security/https.ts);
  // отдельный сегмент x-forwarded-proto не https → http.
  const proto = isHttpsRequest(req) ? 'https' : 'http';
  const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host');
  if (host) return `${proto}://${host}`;
  return `http://${process.env.SERVER_PUBLIC_HOST || 'localhost'}:3000`;
}

function zodDetail(e: ZodError): string {
  return e.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'тело'}: ${issue.message}`)
    .join('; ');
}

/** Любое исключение → ProblemDetail. Никаких стеков наружу.
 * Маппинг: ApiError → его статус; ZodError → 422 (перечень полей в detail);
 * прочее → 500 с логом в консоль сервера (наружу — только общий текст). */
export function toProblemResponse(e: unknown): NextResponse {
  if (e instanceof ApiError) return problem(e.status, e.title, e.detail);
  if (e instanceof ZodError) return problem(422, 'Ошибка валидации', zodDetail(e));
  console.error('[api] unexpected error:', e instanceof Error ? e.message : String(e));
  return problem(500, 'Внутренняя ошибка');
}

/** Политика доступа оборачиваемого роута. RBAC-модель — ранговая: роль
 * пользователя сравнивается с минимально требуемой (roleRank). Запись
 * (не-GET) требует options.write (по умолчанию MANAGER); чтение — только
 * если задан options.read (по умолчанию проходит любая аутентифицированная
 * роль). Дефолт-матрица: VIEWER — чтение без записи, MANAGER — чтение+
 * запись, ADMIN — всё; write:'ADMIN' резервирует роуты уровня «управление
 * пользователями/api-ключами/настройками». */
export interface AuthOptions {
  /** Минимальная роль для чтения (GET). По умолчанию — любая аутентифицированная. */
  read?: 'ADMIN' | 'MANAGER';
  /** Минимальная роль для записи (не-GET). По умолчанию MANAGER (VIEWER → 403);
   *  'VIEWER' — исключение для САМООБСЛУЖИВАНИЯ над СВОИМИ данными (отзыв своих
   *  сессий): мутирующий запрос разрешён любой аутентифицированной роли, объект
   *  операции жёстко ограничен владельцем внутри сервиса (userId из сессии). */
  write?: 'MANAGER' | 'ADMIN' | 'VIEWER';
}

/** Контекст route-handler'а Next.js 16: динамические сегменты приходят Promise'ом. */
type RouteCtx<P> = { params?: Promise<P> };

/** Имя хоста без порта (учёт IPv6 `[::1]:3000`), в нижнем регистре. */
function hostnameOf(hostWithPort: string): string {
  const h = hostWithPort.trim().toLowerCase();
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    return close === -1 ? h : h.slice(1, close);
  }
  const colon = h.lastIndexOf(':');
  // единственное ':' — это порт; несколько ':' без скобок — не-Host-подобная строка
  if (colon > 0 && h.indexOf(':') === colon) return h.slice(0, colon);
  return h;
}

/** Защита от кросс-сайтовых мутаций без тела (activate/run/pause/…).
 *
 * Двухуровневая схема:
 * 1. Современные браузеры присылают `Sec-Fetch-Site` — его ставит браузер, JS
 *    подделать не может, и прокси-цепочка песочницы его не затирает (проверено
 *    на живом трафике). `same-origin`/`none` — запрос со страницы приложения
 *    или прямой ввод адреса → пропускаем; `cross-site` — чужая страница → блок.
 *    Это работает даже когда внешний шлюз ПЕРЕЗАПИСЫВАЕТ Host на внутреннее
 *    имя (внешний origin ≠ Host) — сверка Origin↔Host в такой цепочке ложно
 *    отклоняла все cookie-POST-ы панели («Кросс-сайтовый запрос отклонён»).
 * 2. Легаси-фолбэк (нет Sec-Fetch-Site: старый браузер, curl, сервер-к-серверу):
 *    сверка Origin с Host / X-Forwarded-Host по ИМЕНИ хоста — порты игнорируем,
 *    т.к. шлюзы могут срезать или дописывать порт; уникальный признак «сайта» —
 *    имя хоста. Отсутствие Origin не блокируем (не-браузерные клиенты).
 * `same-site` (соседний поддомен/порт) намеренно НЕ пропускается автоматически:
 *    уходит в легаси-сверку по имени хоста.
 *
 * Экспортируется: тот же гейт применяют и auth-роуты (login/logout/change-password/
 * change-password/skip), которые идут без withAuth — условия идентичны, чтобы
 * поведение iframe-предпросмотра (Sec-Fetch-Site: same-origin / совпадение имени
 * хоста Origin↔Host) не зависело от типа роута. */
export function checkSameOrigin(req: NextRequest): NextResponse | null {
  if (req.headers.get('authorization')) return null;
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  const secFetchSite = req.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite === 'same-origin' || secFetchSite === 'none') return null;
  if (secFetchSite === 'cross-site') {
    return problem(403, 'Запрещено', 'Кросс-сайтовый запрос отклонён');
  }

  const origin = req.headers.get('origin');
  if (!origin) return null; // curl / сервер-к-серверу / Bearer — решает авторизация
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  if (originHost === null) return null; // некорректный Origin — пусть дальше решает авторизация
  const originName = hostnameOf(originHost);
  const candidates = [
    req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ?? '',
    req.headers.get('host') ?? '',
  ].filter((c) => c !== '');
  if (candidates.length === 0 || candidates.some((c) => hostnameOf(c) === originName)) {
    return null;
  }
  return problem(403, 'Запрещено', 'Кросс-сайтовый запрос отклонён');
}

/**
 * Обёртка route-handler'а: проверка сессии, RBAC и единая обработка ошибок.
 * Порядок проверок: CSRF-гейт checkSameOrigin → сессия (нет → 401) → права
 * по методу (не-GET: write-ранг, GET: read-ранг; ниже требуемого → 403) →
 * сам handler с распакованными user и params. Любое исключение внутри
 * handler'а превращается в ProblemDetail (toProblemResponse).
 * Next.js 16 передаёт контекст { params: Promise<...> } для динамических сегментов.
 */
export function withAuth<P extends Record<string, string> = Record<string, never>>(
  handler: (req: NextRequest, user: SessionUser, params: P) => Promise<Response>,
  options?: AuthOptions,
) {
  return async (req: NextRequest, ctx?: RouteCtx<P>): Promise<Response> => {
    try {
      const sameOrigin = checkSameOrigin(req);
      if (sameOrigin) return sameOrigin;
      const user = await getSessionUser(req);
      if (!user) return problem(401, 'Не авторизован');
      const rank = roleRank(user.role);
      const isWriteMethod = req.method !== 'GET';
      if (isWriteMethod) {
        // Любая запись требует минимум MANAGER (VIEWER получает 403 на всех не-GET).
        const required = roleRank(options?.write ?? 'MANAGER');
        if (rank < required) return problem(403, 'Недостаточно прав');
      } else if (options?.read) {
        if (rank < roleRank(options.read)) return problem(403, 'Недостаточно прав');
      }
      const params = (ctx?.params ? await ctx.params : {}) as P;
      return await handler(req, user, params);
    } catch (e) {
      return toProblemResponse(e);
    }
  };
}

/** Обёртка публичных route-handler'ов (без авторизации): только единая
 * обработка ошибок → ProblemDetail. Для приёмников вебхуков, отписки и
 * коротких ссылок — секрет/подпись каждый из них проверяет сам по своей схеме. */
export function publicRoute<P extends Record<string, string> = Record<string, never>>(
  handler: (req: NextRequest, params: P) => Promise<Response>,
) {
  return async (req: NextRequest, ctx?: RouteCtx<P>): Promise<Response> => {
    try {
      const params = (ctx?.params ? await ctx.params : {}) as P;
      return await handler(req, params);
    } catch (e) {
      return toProblemResponse(e);
    }
  };
}
