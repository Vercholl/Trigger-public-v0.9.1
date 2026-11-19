// Сервис SMS-лога: список с фильтрами и CSV-экспорт (BOM, «;»).
// Домен: журнал всех исходящих SMS (рассылки + воронки) со статусами доставки.
// Вызывается из API-роутов: /api/v1/sms (GET-список), /sms/export (GET-CSV),
// /clients/{id}/messages (getClientSmsHistory — карточка клиента).
// Таблицы Prisma: SmsMessage (основная; строки пишут движок/воркер, статус
// обновляют webhook-и), Client (include externalId), AuditLog (экспорт).
import type { Prisma, SmsMessage } from '@prisma/client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { AuditAction, AuditEntity, logAudit } from '@/lib/security/audit';
import type { SessionUser } from '@/lib/security/session';

/** Статусы SMS: QUEUED→SENDING→SENT→DELIVERED/FAILED (жизненный цикл),
 *  REJECTED_BY_COMPLIANCE — отклонено до отправки, CANCELLED — отменено
 *  (пауза/отмена рассылки, отписка клиента). */
export const SMS_STATUSES = [
  'QUEUED',
  'SENDING',
  'SENT',
  'DELIVERED',
  'FAILED',
  'REJECTED_BY_COMPLIANCE',
  'CANCELLED',
] as const;

/** Фильтры журнала: статус (из SMS_STATUSES), поиск по телефону/тексту,
 *  диапазон дат from/to (ISO или YYYY-MM-DD — см. parseDateRange). */
export interface SmsFilters {
  status?: string;
  search?: string;
  from?: string;
  to?: string;
}

/** Разбор ISO-даты/дат: date-only «YYYY-MM-DD» → границы суток. */
export function parseDateRange(from?: string, to?: string): { gte?: Date; lte?: Date } {
  const result: { gte?: Date; lte?: Date } = {};
  if (from) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      result.gte = new Date(`${from}T00:00:00.000Z`);
    } else {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) result.gte = d;
    }
  }
  if (to) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      result.lte = new Date(`${to}T23:59:59.999Z`);
    } else {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) result.lte = d;
    }
  }
  return result;
}

/** Построение Prisma-where из фильтров; неизвестный статус — 422
 *  (молчаливый игнор скрывал бы ошибку фильтра). */
function buildSmsWhere(filters: SmsFilters): Prisma.SmsMessageWhereInput {
  const where: Prisma.SmsMessageWhereInput = {};
  if (filters.status !== undefined && filters.status !== '') {
    // Неизвестный статус — честная 422 (раньше фильтр молча игнорировался и показывались ВСЕ сообщения)
    if (!(SMS_STATUSES as readonly string[]).includes(filters.status)) {
      throw new ApiError(422, 'Ошибка валидации', `Неизвестный статус: ${filters.status}`);
    }
    where.status = filters.status;
  }
  if (filters.search && filters.search.trim() !== '') {
    const s = filters.search.trim();
    where.OR = [{ phone: { contains: s } }, { body: { contains: s } }];
  }
  const range = parseDateRange(filters.from, filters.to);
  if (range.gte || range.lte) {
    where.createdAt = {};
    if (range.gte) where.createdAt.gte = range.gte;
    if (range.lte) where.createdAt.lte = range.lte;
  }
  return where;
}

/** Строка SmsMessage (+клиент) → JSON API (с тарификацией из уведомлений
 *  шлюза). Чистая функция. varsSnapshot — распарсенный снимок переменных
 *  сообщения (P6): {имя: значение|null}; битный JSON → null (молчать, как
 *  у data клиента). */
export function serializeSms(
  row: SmsMessage & { client?: { externalId: string } | null },
): Record<string, unknown> {
  let varsSnapshot: Record<string, unknown> | null = null;
  if (row.varsSnapshot) {
    try {
      const parsed = JSON.parse(row.varsSnapshot) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        varsSnapshot = parsed as Record<string, unknown>;
      }
    } catch {
      varsSnapshot = null;
    }
  }
  return {
    id: row.id,
    phone: row.phone,
    body: row.body,
    segments: row.segments,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    // Тарификация и оператор из уведомлений шлюза (SMS.Tech)
    priceKopecks: row.priceKopecks,
    operatorCode: row.operatorCode,
    templateName: row.templateName,
    status: row.status,
    rejectReason: row.rejectReason,
    error: row.error,
    varsSnapshot,
    broadcastName: row.broadcastName ?? null,
    sentAt: row.sentAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    clientExternalId: row.client?.externalId ?? null,
  };
}

/** Список SMS с фильтрами и пагинацией (+ externalId клиента через include).
 *  Чтение — без побочных эффектов. */
export async function listSms(
  filters: SmsFilters,
  page: { skip: number; take: number },
): Promise<{ items: unknown[]; total: number }> {
  const where = buildSmsWhere(filters);
  const [rows, total] = await Promise.all([
    db.smsMessage.findMany({
      where,
      include: { client: { select: { externalId: true } } },
      orderBy: { createdAt: 'desc' },
      skip: page.skip,
      take: page.take,
    }),
    db.smsMessage.count({ where }),
  ]);
  return { items: rows.map(serializeSms), total };
}

/* ---------- История SMS в карточке клиента («Клиенты») ---------- */

export interface ClientSmsStats {
  total: number;
  delivered: number;
  sent: number;
  failed: number;
  rejected: number;
  queued: number;
  /** Дата последнего сообщения (или null, если истории нет). */
  lastAt: string | null;
}

/** История отправок конкретного клиента: пагинация + агрегаты по статусам. */
export async function getClientSmsHistory(
  clientId: string,
  page: { skip: number; take: number },
): Promise<{ items: unknown[]; total: number; stats: ClientSmsStats }> {
  const where: Prisma.SmsMessageWhereInput = { clientId };
  const [rows, total, grouped, lastRow] = await Promise.all([
    db.smsMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: page.skip,
      take: page.take,
    }),
    db.smsMessage.count({ where }),
    db.smsMessage.groupBy({ by: ['status'], where, _count: { _all: true } }),
    db.smsMessage.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);
  const byStatus: Record<string, number> = {};
  for (const g of grouped) byStatus[g.status] = g._count._all;
  return {
    items: rows.map((row) => serializeSms(row)),
    total,
    stats: {
      total,
      delivered: byStatus['DELIVERED'] ?? 0,
      sent: byStatus['SENT'] ?? 0,
      failed: byStatus['FAILED'] ?? 0,
      rejected: byStatus['REJECTED_BY_COMPLIANCE'] ?? 0,
      // «В очереди» = ещё не отправленные (QUEUED/SENDING); CANCELLED —
      // терминальный статус («Отменено»), в очереди не состоит.
      queued: (byStatus['QUEUED'] ?? 0) + (byStatus['SENDING'] ?? 0),
      lastAt: lastRow ? lastRow.createdAt.toISOString() : null,
    },
  };
}

const CSV_HEADER = 'Время;Телефон;Текст;Сегменты;Провайдер;Шаблон;Статус;Причина отказа;Отправлено;Доставлено';

/** CSV-экранирование: кавычки/разделители/переводы строк → «...» с удвоением
 *  внутренних кавычек (RFC 4180, разделитель «;»).
 *  Плюс нейтрализация formula injection (CSV injection): тело SMS и данные
 *  клиента приходят извне (ядро компании) и могут начинаться с =, +, -, @,
 *  Tab или CR — Excel/LibreOffice исполнят такую ячейку как формулу
 *  (HYPERLINK/DDE). Защита — нейтральный апостроф перед опасным префиксом. */
function csvEscape(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[;"\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function isoOrNull(d: Date | null): string {
  return d ? d.toISOString() : '';
}

/** CSV-экспорт: BOM + «;», те же фильтры, без пагинации (кап 10000 строк).
 *  Побочные эффекты: audit-лог EXPORT (счётчик + фильтры). */
export async function exportSmsCsv(filters: SmsFilters, user: SessionUser, ip: string): Promise<{ csv: string; filename: string; count: number }> {
  const where = buildSmsWhere(filters);
  const rows = await db.smsMessage.findMany({
    where,
    include: { client: { select: { externalId: true } } },
    orderBy: { createdAt: 'desc' },
    take: 10000,
  });

  const lines: string[] = [CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        csvEscape(isoOrNull(row.createdAt)),
        csvEscape(row.phone),
        csvEscape(row.body),
        String(row.segments),
        csvEscape(row.provider),
        csvEscape(row.templateName ?? ''),
        csvEscape(row.status),
        csvEscape(row.rejectReason ?? ''),
        csvEscape(isoOrNull(row.sentAt)),
        csvEscape(isoOrNull(row.deliveredAt)),
      ].join(';'),
    );
  }

  const now = new Date();
  const datePart = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('');

  await logAudit({
    user,
    action: AuditAction.EXPORT,
    entityType: AuditEntity.SMS,
    details: { count: rows.length, filters: { status: filters.status ?? null, search: filters.search ?? null } },
    ip,
  });

  return {
    csv: `\uFEFF${lines.join('\r\n')}`,
    filename: `sms_log_${datePart}.csv`,
    count: rows.length,
  };
}
