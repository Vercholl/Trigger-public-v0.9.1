// История изменений профиля (P5): диффы «было → стало», запись в журнал
// ProfileChangeLog и чтение для карточки клиента.
//
// Оператор видит в карточке клиента,
// КТО/КОГДА/ПОЧЕМУ изменил каждое поле — ручная правка панели (MANUAL), CSV-импорт
// (IMPORT), событие ядра из client_card (EVENT) или массовое обновление сегмента
// (MASS_UPDATE). Одна строка журнала = изменение ОДНОГО поля; факт создания
// профиля — спец-строка __created__.
//
// ПРИНЦИПЫ:
//   • только ДИФФЫ: значение не изменилось → строки нет (события ядра шлют всю
//     карточку целиком, а меняется 1–2 поля — журнал без диффов захламился бы
//     миллионами no-op-строк);
//   • fail-soft: запись истории НИКОГДА не валит бизнес-операцию (try/catch,
//     как у аудита) — история важна, но не критична для сценария;
//   • значения — строковые представления (даты ISO, булевы true/false, числа
//     строкой; NULL = «пусто»): журнал читается людьми, типы восстанавливать
//     не нужно — реальные значения живут в профиле.
//
// Вызывается из: services/clients (create/update/CSV-импорт), scheduler/worker
// (upsertClientFromCard — события ядра), services/custom-fields (ручные правки
// cf и приём из client_card), services/mass-update (массовые операции),
// API-роут /api/v1/clients/{id}/history (чтение).
import type { Client, ProfileChangeLog } from '@prisma/client';
import { db } from '@/lib/db';
import { CANONICAL_CARD_FIELDS, type CardFieldType } from '@/lib/registry/card-fields';
import { CF_KEY_PREFIX } from '@/lib/registry/cf-ns';

/** Спец-поле: профиль создан (одна строка на создание — контекст, а не дифф). */
export const PROFILE_FIELD_CREATED = '__created__';

/** Источники изменения профиля (столбец source). */
export type ProfileChangeSource = 'MANUAL' | 'IMPORT' | 'EVENT' | 'MASS_UPDATE';

/** Ретеншн истории профиля: записи старше N дней чистит воркер (cleanup). */
export const PROFILE_HISTORY_RETENTION_DAYS = 180;

/** Одно изменение: поле (имя карточки / cf_<key> / спец-ключ) + было/стало. */
export interface ProfileChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Значение → строковое представление для диффа и хранения. Даты — ISO
 * (existing Date и dto-Date сравниваются одинаково), булевы — true/false,
 * числа — строкой, null/undefined — null («пусто»). Неизвестный тип — String().
 */
export function profileValueToString(
  value: unknown,
  type?: CardFieldType,
): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    // Даты-строки (CSV-путь до zod-трансформации) нормализуем к Date для
    // честного сравнения с существующим значением-датой.
    if (type === 'date') {
      const t = Date.parse(value);
      return Number.isNaN(t) ? value : new Date(t).toISOString();
    }
    return value;
  }
  return String(value);
}

/** Нормализованные значения равны (дифф не нужен)? */
function sameValue(a: string | null, b: string | null): boolean {
  return a === b;
}

/**
 * Дифф карточных полей + контактов/согласия: existing (строка БД) против
 * dto обновления (ключи карточки; undefined = «не трогали» — пропускается).
 * Возвращает только РЕАЛЬНЫЕ изменения (для записи в журнал).
 * Карточка — по реестру CANONICAL_CARD_FIELDS; phone/timezone/sms_consent_status —
 * спец-ключи (их меняют и события, и панель, и импорт).
 */
export function diffProfileUpdates(
  existing: Client,
  dto: {
    // Карточные поля под именами карточки (CardFieldsDto)
    [fieldName: string]: unknown;
    phone?: string | null;
    timezone?: string | null;
    smsConsentStatus?: string | null;
  },
): ProfileChange[] {
  const changes: ProfileChange[] = [];
  const source = dto as Record<string, unknown>;

  // Карточные поля (канонические; алиасы пишутся в колонку канонического —
  // cardFieldsToDb уже слил их, здесь ключи канонических имён карточки)
  for (const def of CANONICAL_CARD_FIELDS) {
    const next = source[def.fieldName];
    if (next === undefined) continue; // поле не передано — не трогали
    const prevRaw = (existing as unknown as Record<string, unknown>)[def.prisma];
    const prev = profileValueToString(prevRaw, def.type);
    const nextStr = profileValueToString(next, def.type);
    if (!sameValue(prev, nextStr)) {
      changes.push({ field: def.fieldName, oldValue: prev, newValue: nextStr });
    }
  }

  // Спец-поля: контакты и согласие (переданы и отличаются)
  if (dto.phone !== undefined) {
    const prev = profileValueToString(existing.phone);
    const next = profileValueToString(dto.phone);
    if (!sameValue(prev, next)) changes.push({ field: 'phone', oldValue: prev, newValue: next });
  }
  if (dto.timezone !== undefined) {
    const prev = profileValueToString(existing.timezone);
    const next = profileValueToString(dto.timezone);
    if (!sameValue(prev, next)) changes.push({ field: 'timezone', oldValue: prev, newValue: next });
  }
  if (dto.smsConsentStatus !== undefined) {
    const prev = profileValueToString(existing.smsConsentStatus);
    const next = profileValueToString(dto.smsConsentStatus);
    if (!sameValue(prev, next)) {
      changes.push({ field: 'sms_consent_status', oldValue: prev, newValue: next });
    }
  }
  return changes;
}

/**
 * Запись диффов в журнал (createMany одним батчем). НИКОГДА не бросает —
 * сбой истории пишется в консоль (как у аудита), операция продолжается.
 * Пустой список изменений — no-op без единого запроса.
 * sourceDetails — контекст «почему»: {actorEmail} | {line} | {eventId, event} |
 * {jobId, jobName} — сериализуется в JSON-строку.
 */
export async function recordProfileChanges(
  clientId: string,
  changes: readonly ProfileChange[],
  source: ProfileChangeSource,
  sourceDetails?: Record<string, unknown> | null,
): Promise<void> {
  if (changes.length === 0) return;
  try {
    await db.profileChangeLog.createMany({
      data: changes.map((c) => ({
        clientId,
        field: c.field,
        oldValue: c.oldValue === null || c.oldValue === undefined ? null : String(c.oldValue),
        newValue: c.newValue === null || c.newValue === undefined ? null : String(c.newValue),
        source,
        sourceDetails: sourceDetails ? JSON.stringify(sourceDetails) : null,
      })),
    });
  } catch (e) {
    console.error(
      `[profile-history] запись изменений не удалась (clientId=${clientId}, ${changes.length} шт.):`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Факт создания профиля — одна спец-строка __created__ (пустое состояние
 *  истории в карточке закрывается контекстом «кто завёл»). */
export async function recordProfileCreated(
  clientId: string,
  source: ProfileChangeSource,
  sourceDetails?: Record<string, unknown> | null,
): Promise<void> {
  try {
    await db.profileChangeLog.create({
      data: {
        clientId,
        field: PROFILE_FIELD_CREATED,
        oldValue: null,
        newValue: null,
        source,
        sourceDetails: sourceDetails ? JSON.stringify(sourceDetails) : null,
      },
    });
  } catch (e) {
    console.error(
      `[profile-history] запись создания не удалась (clientId=${clientId}):`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Ретеншн: удаление записей старше N дней (вызывает воркер в cleanup).
 *  Возвращает число удалённых строк (для лога). */
export async function cleanupProfileHistory(
  days: number = PROFILE_HISTORY_RETENTION_DAYS,
): Promise<number> {
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const res = await db.profileChangeLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return res.count;
  } catch (e) {
    console.error(
      '[profile-history] чистка не удалась:',
      e instanceof Error ? e.message : String(e),
    );
    return 0;
  }
}

/** Строка журнала → JSON API: details распарсены, значения как есть (строки/null). */
export function serializeProfileChange(row: ProfileChangeLog): Record<string, unknown> {
  let details: unknown = null;
  if (row.sourceDetails) {
    try {
      details = JSON.parse(row.sourceDetails);
    } catch {
      details = null;
    }
  }
  return {
    id: row.id,
    clientId: row.clientId,
    field: row.field,
    oldValue: row.oldValue,
    newValue: row.newValue,
    source: row.source,
    details,
    createdAt: row.createdAt,
  };
}

/** История изменений профиля клиента: страница + total (новейшие первыми).
 *  Чтение по покрывающему индексу (clientId, createdAt). */
export async function getClientProfileHistory(
  clientId: string,
  page: { skip: number; take: number },
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const [rows, total] = await Promise.all([
    db.profileChangeLog.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      skip: page.skip,
      take: page.take,
    }),
    db.profileChangeLog.count({ where: { clientId } }),
  ]);
  return { items: rows.map(serializeProfileChange), total };
}

/**
 * Дифф значения КАСТОМНОГО поля (cf_<key>): existing-строка значения → строковое
 * представление против нового нормализованного значения. Дата — ISO (как у
 * карточных полей), bool — true/false, number — строкой, null/«нет строки» —
 * null («пусто»). Используется точками применения cf (custom-fields, mass-update)
 * для записи истории в едином формате с карточными полями.
 */
export function cfChange(
  key: string,
  oldValue: string | number | boolean | Date | null | undefined,
  newValue: string | number | boolean | Date | null,
): ProfileChange | null {
  const prev = profileValueToString(oldValue);
  const next = profileValueToString(newValue);
  if (sameValue(prev, next)) return null;
  return { field: CF_KEY_PREFIX + key, oldValue: prev, newValue: next };
}
