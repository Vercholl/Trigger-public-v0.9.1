// Публичная отписка по HMAC-токену и операторское управление стоп-листом.
// Проверка токена, идемпотентная отписка, ручное внесение номера оператором.
// Активные экземпляры воронок НЕ отменяются: отписка блокирует только
// маркетинговые SMS — комплаенс отклонит их на каждом SMS-узле, а сервисные
// шаги (напоминания об оплате, статусы) продолжают выполняться.
// Вызывается из API-роутов: /api/v1/unsubscribe (GET-страница/POST-исполнение
// по длинной ссылке), /api/v1/u (GET/POST — короткая ссылка ?u=код),
// /api/v1/unsubscribed (GET-список/POST-ручное добавление),
// /unsubscribed/{id} (DELETE — исключение из стоп-листа).
// Таблицы Prisma: UnsubscribeList (стоп-лист), Client (unsubscribedAt),
// ShortLink (резолв коротких кодов), AuditLog (отписки логируются).
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { verifyUnsubscribeToken, maskPhone } from '@/lib/compliance/disclaimer';
import { resolveShortLink } from '@/lib/compliance/short-links';
import { isValidE164 } from '@/lib/compliance/pipeline';
import { getSettings } from '@/lib/services/settings';
import { logAudit, AuditAction, AuditEntity } from '@/lib/security/audit';

/** Результат проверки/исполнения: ok + HTTP-статус + JSON-ответ для роута
 *  (ошибки отдаём теми же {ok:false,title:…} — публичная страница). */
export interface UnsubscribeCheckResult {
  ok: boolean;
  response: Record<string, unknown>;
  status: number;
  clientId?: string;
}

/** Проверка токена для GET (показ маскированного номера и рекламодателя). */
export async function checkUnsubscribeToken(token: string): Promise<UnsubscribeCheckResult> {
  if (!token) {
    return { ok: false, status: 400, response: { ok: false, title: 'Ссылка недействительна или истекла' } };
  }
  const verified = verifyUnsubscribeToken(token);
  if (!verified.ok) {
    return { ok: false, status: 400, response: { ok: false, title: 'Ссылка недействительна или истекла' } };
  }
  const client = await db.client.findUnique({ where: { id: verified.clientId } });
  if (!client) {
    return { ok: false, status: 400, response: { ok: false, title: 'Ссылка недействительна или истекла' } };
  }
  const settings = await getSettings();
  return {
    ok: true,
    status: 200,
    clientId: client.id,
    response: { ok: true, phone: maskPhone(client.phone), advertiser: settings.advertiserName },
  };
}

/** Проверка КОРОТКОЙ ссылки (?u={код}) — резолв кода → токен → та же
 * страница отписки. Переход фиксируется в статистике (track=true). */
export async function checkUnsubscribeCode(code: string): Promise<UnsubscribeCheckResult> {
  if (!code) {
    return { ok: false, status: 400, response: { ok: false, title: 'Ссылка недействительна или истекла' } };
  }
  const resolved = await resolveShortLink(code, { track: true });
  if (!resolved) {
    return { ok: false, status: 400, response: { ok: false, title: 'Ссылка недействительна или истекла' } };
  }
  return checkUnsubscribeToken(resolved.token);
}

/** Исполнение отписки по КОРОТКОЙ ссылке (без повторного счёта перехода). */
export async function performUnsubscribeByCode(code: string, ip: string): Promise<UnsubscribeCheckResult> {
  if (!code) {
    return { ok: false, status: 400, response: { ok: false, title: 'Ссылка недействительна или истекла' } };
  }
  const resolved = await resolveShortLink(code);
  if (!resolved) {
    return { ok: false, status: 400, response: { ok: false, title: 'Ссылка недействительна или истекла' } };
  }
  return performUnsubscribe(resolved.token, ip);
}

/** Исполнение отписки (идемпотентно): список + client.unsubscribedAt.
 * Экземпляры воронок НЕ отменяются: рекламные SMS отклонит комплаенс,
 * сервисные продолжат уходить. */
export async function performUnsubscribe(token: string, ip: string): Promise<UnsubscribeCheckResult> {
  const check = await checkUnsubscribeToken(token);
  if (!check.ok || !check.clientId) return check;

  // Гонка с удалением клиента между проверкой токена и исполнением:
  // публичный роут не должен отдавать 500 — нейтральный «ссылка недействительна».
  const client = await db.client.findUnique({ where: { id: check.clientId } });
  if (!client) {
    return { ok: false, status: 400, response: { ok: false, title: 'Ссылка недействительна или истекла' } };
  }

  // Идемпотентно: upsert по телефону.
  await db.unsubscribeList.upsert({
    where: { phone: client.phone },
    create: { phone: client.phone, source: 'LINK', clientId: client.id },
    update: { clientId: client.id },
  });
  if (client.unsubscribedAt === null) {
    await db.client.update({ where: { id: client.id }, data: { unsubscribedAt: new Date() } });
  }

  await logAudit({
    user: null,
    action: AuditAction.UNSUBSCRIBE,
    entityType: AuditEntity.CLIENT,
    entityId: client.id,
    details: { phone: maskPhone(client.phone), source: 'LINK' },
    ip,
  });

  return { ok: true, status: 200, clientId: client.id, response: { ok: true, phone: maskPhone(client.phone) } };
}

/** Операторское внесение номера в отписку (MANAGER+, П3): запись source=MANUAL
 * + client.unsubscribedAt для найденного по телефону клиента. Идемпотентно. */
export async function addUnsubscribedManual(
  phone: string,
  user: { id: string; email: string },
  ip: string,
): Promise<{ item: UnsubscribedItem; created: boolean }> {
  const normalized = phone.trim();
  if (!isValidE164(normalized)) {
    throw new ApiError(422, 'Некорректный номер телефона', 'Ожидается формат E.164, например +79001234567');
  }

  const existing = await db.unsubscribeList.findUnique({ where: { phone: normalized } });
  const client = await db.client.findFirst({ where: { phone: normalized } });

  const row = existing
    ? await db.unsubscribeList.update({
        where: { phone: normalized },
        data: { clientId: client?.id ?? existing.clientId },
      })
    : await db.unsubscribeList.create({
        data: { phone: normalized, source: 'MANUAL', clientId: client?.id ?? null },
      });

  if (client && client.unsubscribedAt === null) {
    await db.client.update({ where: { id: client.id }, data: { unsubscribedAt: new Date() } });
  }

  await logAudit({
    user,
    action: AuditAction.UNSUBSCRIBE,
    entityType: AuditEntity.CLIENT,
    entityId: client?.id ?? row.id,
    details: { phone: maskPhone(normalized), source: 'MANUAL', created: existing === null },
    ip,
  });

  return {
    item: {
      id: row.id,
      phone: row.phone,
      source: row.source,
      clientId: row.clientId,
      createdAt: row.createdAt,
    },
    created: existing === null,
  };
}

/** Строка стоп-листа в JSON API (телефон открыто — операторская страница). */
export interface UnsubscribedItem {
  id: string;
  phone: string;
  source: string;
  clientId: string | null;
  createdAt: Date;
}

/** Список отписавшихся (сессия): поиск по телефону, пагинация.
 *  Чтение — без побочных эффектов. */
export async function listUnsubscribed(filters: {
  search?: string;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}): Promise<{ items: unknown[]; total: number }> {
  const rows = await db.unsubscribeList.findMany({
    where:
      filters.search && filters.search.trim() !== ''
        ? { phone: { contains: filters.search.trim() } }
        : undefined,
    orderBy: { createdAt: 'desc' },
    skip: filters.skip,
    take: filters.take,
  });
  const total = await db.unsubscribeList.count(
    filters.search && filters.search.trim() !== ''
      ? { where: { phone: { contains: filters.search.trim() } } }
      : undefined,
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      phone: row.phone,
      source: row.source,
      clientId: row.clientId,
      createdAt: row.createdAt,
    })),
    total,
  };
}

/** Удаление из списка (MANAGER+): физическое удаление строки + снятие
 *  client.unsubscribedAt при совпадении телефона (клиент снова получает SMS).
 *  Побочные эффекты: удаление UnsubscribeList, запись Client, audit-лог DELETE. */
export async function removeUnsubscribed(id: string, user: { id: string; email: string }, ip: string): Promise<void> {
  const row = await db.unsubscribeList.findUnique({ where: { id } });
  if (!row) throw new Error('NOT_FOUND');
  await db.unsubscribeList.delete({ where: { id } });
  const client = await db.client.findFirst({ where: { phone: row.phone } });
  if (client && client.unsubscribedAt !== null) {
    await db.client.update({ where: { id: client.id }, data: { unsubscribedAt: null } });
  }
  await logAudit({
    user,
    action: AuditAction.DELETE,
    entityType: AuditEntity.CLIENT,
    entityId: row.id,
    details: { removedFromUnsubscribeList: maskPhone(row.phone) },
    ip,
  });
}
