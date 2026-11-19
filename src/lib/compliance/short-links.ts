// Короткие ссылки отписки. Код 7 символов (алфавит без похожих глифов)
// → полный HMAC-токен в таблице ShortLink. Ссылка в SMS: {base}/?u={code}
// вместо {base}/?unsub=<~86 симв. токена> — экономия ~80 символов на каждом
// маркетинговом SMS (~1 часть при 500 тыс. отправок/мес).
// Переходы считаются при резолве (GET /api/v1/u?c=) — «редирект-лог»
// (сокращатель + лог кликов).
import { randomInt } from 'crypto';
import type { AppSettings, ShortLink } from '@prisma/client';
import { db } from '@/lib/db';
import { generateUnsubscribeToken, verifyUnsubscribeToken } from './disclaimer';
import { renderDisclaimerText } from './disclaimer-text';

// Без 0/O/1/l/I — глифы легко перепутать при ручном наборе кода
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
// 7 символов из 54-символьного алфавита ≈ 1,3 трлн комбинаций — пространство кодов
// с запасом: коллизия статистически ничтожна, а код остаётся коротким для SMS
const CODE_LENGTH = 7;
// Бюджет ретраев при коллизии кода (unique P2002): каждая попытка — новый случайный код;
// исчерпание → исключение наверх (ссылка не создана тихо)
const CREATE_ATTEMPTS = 5;

/** Сгенерировать короткий код: 7 символов алфавита без похожих глифов (0/O/1/l/I —
 *  код читается и набирается вручную без ошибок). randomInt из crypto — равномерное
 *  распределение без modulo-bias (не `Math.random() % length`). */
export function randomShortCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export interface UnsubscribeShortLink {
  code: string;
  token: string;
  expiresAt: Date;
}

/** Создать персональную короткую ссылку отписки для клиента. */
export async function createUnsubscribeShortLink(clientId: string): Promise<UnsubscribeShortLink> {
  const token = generateUnsubscribeToken(clientId);
  const verified = verifyUnsubscribeToken(token);
  const expiresAt = new Date(verified.ok ? verified.expMs : Date.now() + 180 * 24 * 3600 * 1000);
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    const code = randomShortCode();
    try {
      const row = await db.shortLink.create({
        data: { code, kind: 'UNSUBSCRIBE', token, clientId, expiresAt },
      });
      return { code: row.code, token, expiresAt: row.expiresAt ?? expiresAt };
    } catch {
      // коллизия кода (P2002) или гонка — пробуем новый код
    }
  }
  throw new Error(`Не удалось сгенерировать уникальный код короткой ссылки (попыток: ${CREATE_ATTEMPTS})`);
}

export interface ShortLinkResolution {
  token: string;
  clientId: string | null;
}

/** Зафиксировать переход: счётчик + строка в редирект-логе.
 * Ошибки не роняют основной сценарий — статистика не критична. */
export async function trackShortLinkVisit(row: ShortLink): Promise<void> {
  try {
    await db.$transaction([
      db.shortLink.update({
        where: { id: row.id },
        data: { visits: { increment: 1 }, lastVisitAt: new Date() },
      }),
      db.shortLinkVisit.create({
        data: { linkId: row.id, kind: row.kind },
      }),
    ]);
  } catch {
    // статистика перехода не критична
  }
}

/** Резолв кода. track=true (проверка ссылки) — инкремент перехода. */
export async function resolveShortLink(
  code: string,
  options: { track?: boolean } = {},
): Promise<ShortLinkResolution | null> {
  const normalized = code.trim();
  if (normalized === '' || normalized.length > 16) return null;
  const row = await db.shortLink.findUnique({ where: { code: normalized } });
  if (!row || row.kind !== 'UNSUBSCRIBE' || !row.token) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  if (options.track) {
    await trackShortLinkVisit(row);
  }
  return { token: row.token, clientId: row.clientId };
}

export interface ShortLinkStats {
  total: number; // создано ссылок
  total30d: number; // создано за 30 дней
  visited: number; // ссылок с переходами
  visits: number; // всего переходов
  last30dVisits: number; // переходы по ссылкам, созданным за 30 дней
}

/** Статистика коротких ссылок отписки для карточки настроек (П7).
 * Именные ссылки (kind=LINK) считаются отдельно в разделе «Настройки» → «Ссылки». */
export async function getShortLinkStats(): Promise<ShortLinkStats> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const where = { kind: 'UNSUBSCRIBE' };
  const [total, total30d, visited, agg, agg30d] = await Promise.all([
    db.shortLink.count({ where }),
    db.shortLink.count({ where: { ...where, createdAt: { gte: since } } }),
    db.shortLink.count({ where: { ...where, visits: { gt: 0 } } }),
    db.shortLink.aggregate({ where, _sum: { visits: true } }),
    db.shortLink.aggregate({ where: { ...where, createdAt: { gte: since } }, _sum: { visits: true } }),
  ]);
  return {
    total,
    total30d,
    visited,
    visits: agg._sum.visits ?? 0,
    last30dVisits: agg30d._sum.visits ?? 0,
  };
}

/** Чистка протухших ссылок (воркер, раз в ~5 минут): удаляем через 30 дней
 * после истечения — статистика и аудит живут (ShortLinkVisit — каскад), мусор — нет. */
export async function cleanupExpiredShortLinks(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const res = await db.shortLink.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return res.count;
}

// ---------- Сборка итогового тела маркетингового SMS ----------

/** Демонстрационный код для превью (не создаёт запись в БД). */
export const SAMPLE_SHORT_CODE = 'Xk3fQ9a';

/** Минимальный остаток срока годности ссылки для переиспользования: не
 *  тянем в новое SMS ссылку, которая протухнет через несколько дней. */
const REUSE_MIN_LEFT_MS = 30 * 24 * 3600 * 1000;

/** Переиспользуемая активная ссылка отписки клиента: последняя UNSUBSCRIBE-
 *  ссылка с запасом годности. Повторные исполнения SMS-узла (перенос тихих
 *  часов, ретраи провайдера, requeue после краха) раньше создавали НОВУЮ
 *  строку ShortLink на каждый прогон — таблица росла линейно числу повторов
 *  (10% клиентов в тихих часах → +10% мусора за запуск рассылки-воронки). */
async function findReusableUnsubscribeLink(clientId: string): Promise<UnsubscribeShortLink | null> {
  try {
    const row = await db.shortLink.findFirst({
      where: {
        clientId,
        kind: 'UNSUBSCRIBE',
        token: { not: null },
        expiresAt: { gt: new Date(Date.now() + REUSE_MIN_LEFT_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || !row.token) return null;
    return { code: row.code, token: row.token, expiresAt: row.expiresAt ?? new Date() };
  } catch {
    return null; // сбой поиска — просто создадим новую ссылку
  }
}

/** Персональная ссылка отписки: короткая (П7) или полная с токеном. */
export async function buildUnsubscribeLink(
  settings: AppSettings,
  baseUrl: string,
  clientId: string,
): Promise<string> {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  if (settings.useShortLinks) {
    // Живая ссылка клиента переиспользуется (см. findReusableUnsubscribeLink):
    // все SMS одному клиенту получают один и тот же код — статистика честнее
    // (счётчик «SMS с кодом»), таблица не размножается повторами.
    const reusable = await findReusableUnsubscribeLink(clientId);
    if (reusable !== null) {
      return `${base}/?u=${reusable.code}`;
    }
    const link = await createUnsubscribeShortLink(clientId);
    return `${base}/?u=${link.code}`;
  }
  return `${base}/?unsub=${generateUnsubscribeToken(clientId)}`;
}

/** Превью ссылки (без записи в БД): короткая с примером кода или полный sample-токен. */
export function buildSampleUnsubscribeLink(settings: AppSettings, baseUrl: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  if (settings.useShortLinks) {
    return `${base}/?u=${SAMPLE_SHORT_CODE}`;
  }
  return `${base}/?unsub=${generateUnsubscribeToken('00000000-0000-4000-8000-000000000000')}`;
}

/** Итоговое тело маркетингового SMS: `${renderedBody} ${приписка}`.
 * Приписка — редактируемый шаблон из настроек ({link}/{advertiser}),
 * ссылка — короткая или полная. Вызывается из SMS-узла воронки и рассылок. */
export async function buildMarketingSmsBody(
  renderedBody: string,
  settings: AppSettings,
  baseUrl: string,
  clientId: string,
): Promise<string> {
  const link = await buildUnsubscribeLink(settings, baseUrl, clientId);
  const disclaimer = renderDisclaimerText(
    settings.marketingDisclaimer,
    settings.advertiserName,
    link,
  );
  return `${renderedBody} ${disclaimer}`;
}

/** Превью итогового тела (шаблоны): без записи в БД. */
export function buildSampleMarketingSmsBody(
  renderedBody: string,
  settings: AppSettings,
  baseUrl: string,
): string {
  const link = buildSampleUnsubscribeLink(settings, baseUrl);
  const disclaimer = renderDisclaimerText(
    settings.marketingDisclaimer,
    settings.advertiserName,
    link,
  );
  return `${renderedBody} ${disclaimer}`;
}
