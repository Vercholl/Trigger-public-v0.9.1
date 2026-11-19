// ИМЕННЫЕ короткие ссылки для маркетинга.
// Маркетолог создаёт ссылку: название + целевой URL + UTM-метки → короткий
// код. В SMS попадает {base}/r?c={code} (~20-30 символов вместо длинного URL
// с UTM-хвостом). Каждый клик — редирект-лог (ShortLinkVisit): видно, какая
// акция работает (сокращатель + UTM + лог кликов).
//
// Жизненный цикл: создание/правка/удаление — панель «Маркетинговые ссылки»
// (API /api/v1/links, пишет аудит CREATE/UPDATE/DELETE по SHORT_LINK);
// вставка в SMS — плейсхолдер {link} маркетингового шаблона (short-links.ts);
// клик клиента — публичный роут /app/r/route.ts → resolveNamedLink(track=true).
// kind='LINK' отличает именные ссылки от служебных ссылок отписки в той же таблице
// ShortLink — CRUD-методы ниже работают ТОЛЬКО с kind='LINK' (404 на остальных).
import type { ShortLink } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { randomShortCode, trackShortLinkVisit } from './short-links';
import { logAudit, AuditAction, AuditEntity } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';
import { buildTargetUrl as buildTargetUrlPure, type UtmParams } from './link-url';

export { UTM_KEYS, buildTargetUrl, splitTargetUrl, countUtmParams } from './link-url';
export type { UtmKey, UtmParams } from './link-url';

const CREATE_ATTEMPTS = 5;

const MAX_NAME = 80;
const MAX_URL = 500;
const MAX_UTM_VALUE = 100;

// ---------- Схема валидации (API) ----------

/** Zod-схема тела POST/PUT /api/v1/links: имя, целевой URL, UTM-метки (до 100
 * симв. каждая), срок действия «ГГГГ-ММ-ДД» (необязателен). */
export const namedLinkSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME),
  targetUrl: z.string().trim().min(1).max(MAX_URL),
  utm: z.object({
      utm_source: z.string().trim().max(MAX_UTM_VALUE).optional().default(''),
      utm_medium: z.string().trim().max(MAX_UTM_VALUE).optional().default(''),
      utm_campaign: z.string().trim().max(MAX_UTM_VALUE).optional().default(''),
      utm_content: z.string().trim().max(MAX_UTM_VALUE).optional().default(''),
      utm_term: z.string().trim().max(MAX_UTM_VALUE).optional().default(''),
    })
    .optional(),
  expiresAt: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Формат даты: ГГГГ-ММ-ДД')
    .nullish(),
});

export type NamedLinkInput = z.infer<typeof namedLinkSchema>;

// ---------- URL-механика (изоморфная — см. link-url.ts) ----------

/** Серверная сборка итогового URL с понятной ошибкой 422. */
function buildTargetUrlOrThrow(targetUrl: string, utm: UtmParams): string {
  const built = buildTargetUrlPure(targetUrl, utm);
  if (built === null) {
    throw new ApiError(
      422,
      'Некорректный целевой URL',
      'Адрес должен начинаться с http:// или https:// и быть корректным URL',
    );
  }
  return built;
}

// ---------- Сериализация ----------

/** DTO именной ссылки для UI: счётчики визитов и числа SMS с этим кодом. */
export interface NamedLinkDto {
  id: string;
  code: string;
  name: string;
  targetUrl: string; // итоговый URL (с UTM)
  expiresAt: string | null;
  visits: number;
  lastVisitAt: string | null;
  smsCount: number; // в скольких отправленных SMS встречается код
  createdAt: string;
  updatedAt: string;
}

/** Ряд ShortLink → DTO (даты в ISO; smsCount считается отдельно, см. countSmsWithCode). */
export function serializeNamedLink(row: ShortLink, smsCount: number): NamedLinkDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name ?? '',
    targetUrl: row.targetUrl ?? '',
    expiresAt: row.expiresAt?.toISOString() ?? null,
    visits: row.visits,
    lastVisitAt: row.lastVisitAt?.toISOString() ?? null,
    smsCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------- CRUD ----------

/**
 * Создание с ретраем: короткий код случаен, на 5 попыток выпадет свободный
 * (P2002/гонка — просто новый код); дольше — редкая 500-ка.
 */
async function createWithRetry(data: { name: string; targetUrl: string; expiresAt: Date | null }): Promise<ShortLink> {
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    const code = randomShortCode();
    try {
      return await db.shortLink.create({
        data: { code, kind: 'LINK', token: null, ...data },
      });
    } catch {
      // коллизия кода (P2002) или гонка — пробуем новый код
    }
  }
  throw new ApiError(500, 'Не удалось сгенерировать уникальный код ссылки');
}

/** Дата окончания из «ГГГГ-ММ-ДД» → конец суток UTC (включительно). */
function parseExpiry(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T23:59:59.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError(422, 'Некорректная дата действия ссылки');
  }
  if (d.getTime() <= Date.now()) {
    throw new ApiError(422, 'Дата действия уже прошла');
  }
  return d;
}

/**
 * Создание именной ссылки: сборка URL с UTM → проверка срока → запись с
 * уникальным кодом → аудит CREATE/SHORT_LINK (кто: user из сессии; ip из
 * запроса; когда: сразу после записи). Возвращает DTO (0 SMS — новая).
 */
export async function createNamedLink(
  input: NamedLinkInput,
  user: SessionUser,
  ip: string | null,
): Promise<NamedLinkDto> {
  const targetUrl = buildTargetUrlOrThrow(input.targetUrl, input.utm ?? {});
  const expiresAt = parseExpiry(input.expiresAt ?? null);
  const row = await createWithRetry({ name: input.name, targetUrl, expiresAt });
  await logAudit({
    user,
    action: AuditAction.CREATE,
    entityType: AuditEntity.SHORT_LINK,
    entityId: row.id,
    details: { name: row.name, code: row.code, targetUrl },
    ip,
  });
  return serializeNamedLink(row, 0);
}

/**
 * Правка ссылки (имя/URL/UTM/срок): только kind='LINK' (404 иначе — служебные
 * ссылки не трогаем), аудит UPDATE/SHORT_LINK. Код НЕ меняется: SMS со старым
 * кодом продолжат вести на обновлённый целевой URL.
 */
export async function updateNamedLink(
  id: string,
  input: NamedLinkInput,
  user: SessionUser,
  ip: string | null,
): Promise<NamedLinkDto> {
  const existing = await db.shortLink.findUnique({ where: { id } });
  if (!existing || existing.kind !== 'LINK') {
    throw new ApiError(404, 'Ссылка не найдена');
  }
  const targetUrl = buildTargetUrlOrThrow(input.targetUrl, input.utm ?? {});
  const expiresAt = parseExpiry(input.expiresAt ?? null);
  const row = await db.shortLink.update({
    where: { id },
    data: { name: input.name, targetUrl, expiresAt },
  });
  await logAudit({
    user,
    action: AuditAction.UPDATE,
    entityType: AuditEntity.SHORT_LINK,
    entityId: id,
    details: { name: row.name, targetUrl },
    ip,
  });
  return serializeNamedLink(row, await countSmsWithCode(row.code));
}

/**
 * Удаление ссылки (только kind='LINK', иначе 404) + аудит DELETE/SHORT_LINK.
 * Уже разосланные SMS останутся с мёртвым кодом — /r ответит 404; статистика
 * визитов удаляется вместе со строкой.
 */
export async function deleteNamedLink(id: string, user: SessionUser, ip: string | null): Promise<void> {
  const existing = await db.shortLink.findUnique({ where: { id } });
  if (!existing || existing.kind !== 'LINK') {
    throw new ApiError(404, 'Ссылка не найдена');
  }
  await db.shortLink.delete({ where: { id } });
  await logAudit({
    user,
    action: AuditAction.DELETE,
    entityType: AuditEntity.SHORT_LINK,
    entityId: id,
    details: { name: existing.name, code: existing.code },
    ip,
  });
}

/** Сколько отправленных SMS содержат код ссылки (LIKE по телу).
 * Демо-масштаб: полный скан; на бою — счётчик на ссылке/связь с шаблоном. */
async function countSmsWithCode(code: string): Promise<number> {
  return db.smsMessage.count({ where: { body: { contains: `/r?c=${code}` } } });
}

/**
 * Список ссылок (новые сверху) со счётчиком «в скольких SMS встречается код»
 * и последним визитом. Счётчики — N+1 LIKE-запросов по телу SMS: демо-масштаб
 * (см. countSmsWithCode).
 */
export async function listNamedLinks(): Promise<NamedLinkDto[]> {
  const rows = await db.shortLink.findMany({
    where: { kind: 'LINK' },
    orderBy: { createdAt: 'desc' },
  });
  const counts = await Promise.all(rows.map((r) => countSmsWithCode(r.code)));
  return rows.map((r, i) => serializeNamedLink(r, counts[i] ?? 0));
}

// ---------- Резолв (публичный редирект) ----------

export interface NamedLinkResolution {
  targetUrl: string;
}

/**
 * Резолв кода именной ссылки для редиректа /r?c={code}: нормализация кода,
 * гард длины ≤16, проверка срока действия; track=true (переход из SMS) —
 * запись клика в лог визитов. null — код не найден/истёк (роут отдаст 404).
 */
export async function resolveNamedLink(
  code: string,
  options: { track?: boolean } = {},
): Promise<NamedLinkResolution | null> {
  const normalized = code.trim();
  if (normalized === '' || normalized.length > 16) return null;
  const row = await db.shortLink.findUnique({ where: { code: normalized } });
  if (!row || row.kind !== 'LINK' || !row.targetUrl) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  if (options.track) {
    await trackShortLinkVisit(row);
  }
  return { targetUrl: row.targetUrl };
}
