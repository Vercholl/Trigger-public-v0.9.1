'use client';

// ОБЩИЕ строительные блоки всех вью панели (src/components/views/*): контракты
// API (по docs/api-contract.md), форматтеры дат, копирование в буфер (copyText
// с http-фолбэком), метаданные справочников и бейджи статусов, RBAC-хелперы
// (useRole/ViewerGuard), универсальные состояния
// (Empty/Error/Skeleton), TablePagination и общие хуки (useSettings/invalidatePanel).
// Файл переиспользуют все представления — держать без доменной логики.
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertCircle } from 'lucide-react';
import { format, formatDistanceToNow, parseISO } from 'date-fns';
import { ru } from 'date-fns/locale';
import { useQuery, type QueryClient } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@/components/ui/table';
import { api, ApiError } from '@/lib/api-client';
import { useAppStore, type Role } from '@/lib/store';
import { tzOffsetLabel } from '@/lib/time';
import { CANONICAL_CARD_FIELDS } from '@/lib/registry/card-fields';

/* ================= ТИПЫ (по docs/api-contract.md) ================= */
/* Контракты ответов /api/v1 — единственный источник правды для всех вью. */

/** Типы триггерных событий: 5 сервисных событий компании (просрочка/платёжи/закрытие/ДР)
 *  + 13 событий интеграции с внешней системой (карточка/заявка/договор — полный реестр
 *  статусов карточки; канонический список — engine/types.ts TRIGGER_EVENTS). */
export type EventType =
  | 'LOAN_OVERDUE'
  | 'PAYMENT_DUE_SOON'
  | 'PAYMENT_RECEIVED'
  | 'LOAN_CLOSED'
  | 'BIRTHDAY'
  | 'APPLICATION_APPROVED'
  | 'APPROVAL_EXPIRED'
  | 'APPLICATION_REJECTED'
  | 'PREAPPROVE_ISSUED'
  | 'APPLICATION_CREATED'
  | 'APPLICATION_IN_REVIEW'
  | 'APPLICATION_ON_REVISION'
  | 'APPLICATION_CLIENT_DECLINED'
  | 'APPLICATION_DECLINED_AFTER_APPROVAL'
  | 'APPLICATION_PROCESSING_EXPIRED'
  | 'LOAN_ISSUED'
  | 'LOAN_PROLONGED'
  | 'EARLY_PAYMENT_MADE';

/** Статус рекламного согласия клиента — влияет на комплаенс при отправке. */
export type ConsentStatus = 'NONE' | 'PENDING' | 'GRANTED' | 'REVOKED';

/** Статус экземпляра воронки: RUNNING/WAITING — активные, остальные — терминальные. */
export type InstanceStatus = 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** Жизненный цикл SMS: от очереди до доставки/отказа/отмены. */
export type SmsStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'REJECTED_BY_COMPLIANCE' | 'CANCELLED';

/** Причины отказа (комплаенс/шлюз): REJECTED_BY_COMPLIANCE и отказы при создании. */
export type RejectReason =
  | 'QUIET_HOURS'
  | 'UNSUBSCRIBED'
  | 'ADVERT_OFF'
  | 'NO_CONSENT'
  | 'LIMIT_CLIENT'
  | 'LIMIT_SYSTEM'
  | 'INVALID_PHONE'
  | 'RENDER_ERROR'
  | 'SMS_TOO_LONG'
  | 'TEMPLATE_CANCEL';
/** Статус обработки входящего события воркером. DUPLICATE не включён:
 *  дубликаты при приёме НЕ вставляются в БД (дедуп — пропуск), статус никому
 *  не присваивается (v0.8.8 убрал из фильтра-пустышку). */
export type EventStatus = 'NEW' | 'PROCESSING' | 'PROCESSED' | 'FAILED';

/** Универсальная обёртка пагинированных списков API. */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Карточка клиента (П1) — поля отдаются API плоско под snake_case-именами. */
export interface ClientCardFields {
  client_first_name: string | null;
  client_last_name: string | null;
  client_middle_name: string | null;
  email: string | null;
  application_id: number | null;
  application_actual_status: number | null;
  application_previous_status: number | null;
  agreement_id: number | null;
  agreement_actual_status: number | null;
  agreement_previous_status: number | null;
  loan_amount: number | null;
  loan_period: number | null;
  loan_closed_date: string | null;
  notification_active: boolean;
  person_offer_date_start: string | null;
  person_offer_date_expired: string | null;
  person_offer_approve_money: number | null;
  person_offer_approve_days: number | null;
  person_offer_available: boolean | null;
  person_birthday: string | null;
  last_product_type: 'PDL' | 'IL' | null;
  agreements_for_lastyear: number | null;
  agreements_for_lifetime: number | null;
  ban_days: number | null;
  date_update: string | null;
}

/** Клиент (GET /api/v1/clients): карточка клиента + данные панели (согласие/отписка).
 *  customFields — значения кастомных полей профиля под ключами БЕЗ префикса
 *  (GET /clients/{id} и PUT; даты — «дд.мм.гггг»). */
export interface ClientItem extends ClientCardFields {
  id: string;
  externalId: string;
  client_id?: string; // алиас externalId под внешнюю систему
  phone: string;
  timezone: string;
  data: Record<string, unknown>;
  customFields?: Record<string, string | number | boolean>;
  smsConsentStatus: ConsentStatus;
  smsConsentSource: string | null;
  smsConsentAt: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
}

/** ФИО из карточки (Фамилия Имя Отчество), фолбэк — externalId. */
export function clientFullName(c: Pick<ClientItem, 'client_last_name' | 'client_first_name' | 'client_middle_name' | 'externalId'>): string {
  const parts = [c.client_last_name, c.client_first_name, c.client_middle_name].filter(
    (p): p is string => typeof p === 'string' && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(' ') : c.externalId;
}

/** Статус договора: 16 — действующий, 17 — пролонгирован, 19 — закрыт. */
export const AGREEMENT_STATUS_META: Record<number, { label: string; badge: string }> = {
  16: { label: 'Действующий', badge: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400' },
  17: { label: 'Пролонгирован', badge: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400' },
  19: { label: 'Закрыт', badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400' },
};

/** Бейдж статуса договора из карточки (16/17/19; прочие — «№N»). */
export function AgreementStatusBadge({ status }: { status: number | null }) {
  if (status === null) return <span className="text-sm text-zinc-400">—</span>;
  const meta = AGREEMENT_STATUS_META[status];
  return (
    <Badge
      variant="outline"
      className={meta?.badge ?? 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'}
      title={meta ? undefined : `Статус договора №${status}`}
    >
      {meta ? meta.label : `№${status}`}
    </Badge>
  );
}

/** Бейдж продукта клиента: PDL (до зарплаты) / IL (рассрочка). */
export function ProductBadge({ product }: { product: 'PDL' | 'IL' | null }) {
  if (product === null) return <span className="text-sm text-zinc-400">—</span>;
  return (
    <Badge
      variant="outline"
      className={
        product === 'PDL'
          ? 'border-teal-200 bg-teal-50 text-teal-700'
          : 'border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/60 text-orange-700 dark:text-orange-400'
      }
      title={product === 'PDL' ? 'До зарплаты (PDL)' : 'Рассрочка (IL)'}
    >
      {product}
    </Badge>
  );
}

/** Шаблон SMS (GET /api/v1/templates). */
export interface TemplateItem {
  id: string;
  name: string;
  body: string;
  isMarketing: boolean;
  /** Настройки шаблона */
  description: string | null;
  senderName: string | null;
  maxSegments: number;
  version: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Узел графа воронки (sms/delay/condition/waitEvent) — как хранится в definition. */
export interface FunnelNode {
  id: string;
  type: 'sms' | 'delay' | 'condition' | 'waitEvent';
  name?: string | null;
  templateId?: string | null;
  senderName?: string | null;
  hours?: number;
  minutes?: number;
  /** Режим паузы delay-узла. */
  mode?: 'relative' | 'until_time' | 'until_date' | 'until_birthday';
  atHour?: number;
  atMinute?: number;
  atDate?: string;
  expression?: string | null;
  next?: string | null;
  onTrue?: string | null;
  onFalse?: string | null;
  /** waitEvent-узел. */
  event?: string | null;
  timeoutHours?: number;
  timeoutMinutes?: number;
  onEvent?: string | null;
  onTimeout?: string | null;
}

/** Граф воронки: стартовый узел + список узлов. */
export interface FunnelDefinition {
  start_node: string;
  nodes: FunnelNode[];
}

/** Режим повторного входа клиента в воронку (политика воркера при новом событии). */
export type EntryMode = 'SKIP' | 'SKIP_ACTIVE' | 'REPLACE' | 'PARALLEL';

/** Метки/подсказки/цвета режимов входа (селектор в редакторе воронок). */
export const ENTRY_MODE_META: Record<
  EntryMode,
  { label: string; hint: string; badge: string }
> = {
  SKIP: {
    label: 'Один раз навсегда',
    hint: 'Клиент уже проходил воронку (в любом статусе) — новые события её не запускают',
    badge: 'border-border bg-muted text-zinc-600 dark:text-zinc-400',
  },
  SKIP_ACTIVE: {
    label: 'Пропускать пока активна',
    hint: 'Событие не запускает новую цепочку, пока экземпляр выполняется или ждёт',
    badge: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400',
  },
  REPLACE: {
    label: 'Перезапускать',
    hint: 'Активный экземпляр отменяется, события запускают цепочку заново',
    badge: 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400',
  },
  PARALLEL: {
    label: 'Параллельно',
    hint: 'Каждое событие запускает отдельный экземпляр — цепочки идут одновременно',
    badge: 'border-violet-200 bg-violet-50 text-violet-700',
  },
};

/** Воронка (GET /api/v1/funnels) с вычисленным nodeCount. */
export interface FunnelItem {
  id: string;
  name: string;
  triggerEvent: EventType;
  isActive: boolean;
  version: number;
  definition: FunnelDefinition;
  entryMode: EntryMode;
  description: string | null;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Запись журнала событий (GET /api/v1/events). */
export interface EventItem {
  id: string;
  event: EventType;
  externalId: string;
  status: EventStatus;
  /** Итог обработки воркером (JSON-объект: флаги карточки, экземпляры воронок). */
  result?: Record<string, unknown> | null;
  /** Поля client_card вне схемы карточки — «радар» доработок ядра
   *  (null/пусто — все ключи известны). */
  unknownFields?: string[] | null;
  /** Текст ошибки для FAILED-событий (для кнопки «Повторить»). */
  error?: string | null;
  source: 'API' | 'PANEL';
  createdAt: string;
}

/** Наблюдение радара (GET /api/v1/events/unknown-fields): поле ядра вне схемы. */
export interface UnknownFieldItem {
  fieldName: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastEventId: string | null;
  lastEventName: string | null;
}

/** Клиент в списке экземпляров (компактная проекция). */
export interface InstanceClient {
  id: string;
  externalId: string;
  phone: string;
}

/** Экземпляр воронки в списке (GET /api/v1/instances). */
export interface InstanceItem {
  id: string;
  funnelName: string;
  funnelVersion: number;
  client: InstanceClient;
  status: InstanceStatus;
  currentNodeId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Запись таймлайна экземпляра — лог движка (NODE_*, SMS_*, WAIT_* и т.д.). */
export interface InstanceEventItem {
  id: string;
  type: string;
  nodeId: string | null;
  nodeType: string | null;
  message: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

/** SMS-сообщение из журнала (GET /api/v1/sms…). */
export interface SmsMessage {
  id: string;
  phone: string;
  body: string;
  segments: number;
  provider: string;
  providerMessageId: string | null;
  /** Тарификация шлюза SMS.Tech — копейки за сообщение. */
  priceKopecks?: number | null;
  /** Оператор получателя по данным шлюза (MTS/BEELINE/…). */
  operatorCode?: string | null;
  templateName: string | null;
  /** Имя рассылки на момент создания (для истории после удаления рассылки). */
  broadcastName?: string | null;
  status: SmsStatus;
  rejectReason: RejectReason | null;
  error: string | null;
  /** Снимок переменных сообщения (P6): {имя: значение|null} — что подставилось
   *  в момент рендера (только использованные шаблоном переменные). */
  varsSnapshot?: Record<string, unknown> | null;
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  clientExternalId?: string | null;
}

/** Блок «Переменные сообщения» (P6): снимок {имя: значение} из карточки SMS —
 *  что именно подставилось при рендере (null — переменной не было, рендер взял
 *  дефолт/плейсхолдер). Используется в журнале SMS и карточке клиента. */
export function SmsVarsSnapshot({ vars }: { vars: Record<string, unknown> | null | undefined }) {
  if (!vars || Object.keys(vars).length === 0) return null;
  const entries = Object.entries(vars);
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Переменные сообщения</p>
      <div className="max-h-44 overflow-y-auto rounded-md border border-border">
        <Table>
          <TableBody>
            {entries.map(([name, value]) => (
              <TableRow key={name}>
                <TableCell className="w-[40%] py-1.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                  {'{{'}
                  {name}
                  {'}}'}
                </TableCell>
                <TableCell className="whitespace-normal break-all py-1.5 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                  {value === null || value === undefined ? (
                    <span className="text-orange-600 dark:text-orange-400" title="Переменной не было — сработал дефолт или плейсхолдер">
                      нет значения
                    </span>
                  ) : (
                    String(value)
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Запись стоп-листа отписок (GET /api/v1/unsubscribed). */
export interface UnsubscribedItem {
  id: string;
  phone: string;
  /** Источник записи: LINK/MANUAL/IMPORT — панель; HOOK — отписка из события
   *  внешнего захвата доставки (unsub_sms). */
  source: 'LINK' | 'MANUAL' | 'IMPORT' | 'HOOK';
  clientId: string | null;
  createdAt: string;
}

/* ================= Рассылки по сегментам (П4) ================= */

/** Тип рассылки: разовая или регулярная по расписанию. */
export type BroadcastKind = 'ONCE' | 'RECURRING';

/** Жизненный статус рассылки: ACTIVE/PAUSED — управляемые, DONE/CANCELLED — терминальные. */
export type BroadcastStatus = 'ACTIVE' | 'PAUSED' | 'DONE' | 'CANCELLED';

/** Статус одного запуска рассылки. */
export type BroadcastRunStatus = 'RUNNING' | 'DONE' | 'FAILED';

/** Метки и цвета статусов рассылки (бейджи карточек). */
export const BROADCAST_STATUS_META: Record<BroadcastStatus, { label: string; badge: string }> = {
  ACTIVE: { label: 'Активна', badge: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400' },
  PAUSED: { label: 'На паузе', badge: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400' },
  DONE: { label: 'Завершена', badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400' },
  CANCELLED: { label: 'Отменена', badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-400' },
};

/** Метки и цвета типов рассылок. */
export const BROADCAST_KIND_META: Record<BroadcastKind, { label: string; badge: string }> = {
  ONCE: { label: 'Разовая', badge: 'border-teal-200 bg-teal-50 text-teal-700' },
  RECURRING: { label: 'Регулярная', badge: 'border-violet-200 bg-violet-50 text-violet-700' },
};

/** Дни недели для расписаний рассылок; weekday в API: 1=Пн … 7=Вс. */
export const WEEKDAYS_FULL = [
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье',
] as const;

/** Короткие обозначения дней недели (селекторы). */
export const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;

/** Итоги доставки одного запуска — счётчики по статусам сообщений. */
export interface BroadcastRunStats {
  queued: number;
  sent: number;
  delivered: number;
  rejected: number;
  failed: number;
  cancelled: number;
}

export interface BroadcastRejectReason {
  reason: string;
  count: number;
}

/** Один запуск рассылки (история в RunsDialog; последний — lastRun в списке). */
export interface BroadcastRunItem {
  id: string;
  broadcastId: string;
  status: BroadcastRunStatus;
  planned: number;
  recipients: number;
  skippedGuard: number;
  cappedBy: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  stats: BroadcastRunStats;
  /** Разбивка отказов по причинам (пустая, если отказов не было). */
  rejectReasons?: BroadcastRejectReason[];
}

/** Карточка рассылки в списке (GET /api/v1/broadcasts). */
export interface BroadcastItem {
  id: string;
  name: string;
  description: string | null;
  kind: BroadcastKind;
  segmentId: string;
  segmentName: string | null;
  templateId: string;
  templateName: string | null;
  runAt: string | null;
  weekday: number | null;
  hour: number | null;
  minute: number;
  minDaysBetween: number;
  maxRecipients: number;
  status: BroadcastStatus;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun: BroadcastRunItem | null;
}

/** Рассылка с историей запусков (GET /api/v1/broadcasts/{id}). */
export interface BroadcastDetail extends BroadcastItem {
  runs: BroadcastRunItem[];
}

/** Пользователь панели (GET /api/v1/users). */
export interface UserItem {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  createdAt: string;
}

/** API-ключ приёмника событий (GET /api/v1/api-keys; сам секрет не отдаётся). */
export interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  ipAllowlist: string | null;
  /** Пер-ключевой лимит запросов/мин (null — общий дефолт приёма событий). */
  rateLimitPerMin: number | null;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** Настройки панели (GET/PUT /api/v1/settings): комплаенс, провайдер, дисклеймер. */
export interface AppSettings {
  advertiserName: string;
  quietHoursStart: number;
  quietHoursEnd: number;
  dailyClientLimit: number;
  systemDailyLimit: number;
  provider: 'sandbox' | 'smstech' | 't2' | 'mts';
  unsubscribeBaseUrl: string | null;
  defaultTimezone: string;
  /** Имя отправителя по умолчанию. */
  defaultSenderName: string;
  /** Короткие ссылки отписки (/{base}/?u={код} вместо полного токена). */
  useShortLinks: boolean;
  /** Шаблон приписки ({link}/{advertiser}); пусто — стандартный текст. */
  marketingDisclaimer: string;
  /** Сколько дней хранить обработанные события и завершённые задачи (0 = не удалять). */
  inboxRetentionDays: number;
  /** Ретеншн журнала событий доставки MessageEvent: старше срока — выгрузка
   *  в gz-архив (db/message-events-archive) и удаление; 0 = не удалять.
   *  Очередь форвардера (недоставленные в приёмник) не удаляется. */
  messageEventRetentionDays: number;
}

/** Карточка подключения SMS-провайдера (GET /api/v1/integrations). */
export interface IntegrationCard {
  id: 'sandbox' | 'smstech' | 't2' | 'mts';
  displayName: string;
  kind: 'aggregator' | 'operator' | 'sandbox';
  title: string;
  description: string;
  active: boolean;
  configured: boolean;
  /** Как хранится секрет подключения: сохранён в панели / взят из env / отсутствует.
   *  Само значение в панель не отдаётся — только маска (последние символы). */
  secret?: {
    stored: 'panel' | 'env' | null;
    hint?: string | null;
    envName?: string;
  };
  /** Альфа-имя, уже зарегистрированное в аккаунте провайдера. */
  registeredSenderName?: string;
  defaultSenderName?: string;
  webhook?: {
    path: string;
    url: string;
    secretSet?: boolean;
    method?: string;
  };
  envKeys?: { webhookSecret?: string };
  cabinetUrl?: string;
  limits?: {
    perPhonePerHour?: number;
    recommendedRps?: number;
    statusWaitDays?: number;
    segmentGsm7?: string;
    segmentUcs2?: string;
  };
}

/** Ответ GET /api/v1/integrations: активный провайдер + карточки всех. */
export interface IntegrationsResponse {
  activeProvider: 'sandbox' | 'smstech' | 't2' | 'mts';
  providers: IntegrationCard[];
}

/** Проверка токена SMS.Tech (POST /api/v1/integrations/smstech/check). */
export interface SmstechCheckResponse {
  ok: boolean;
  detail: string;
  operator?: string;
  normalizedPhone?: string;
}

/** Сохранение токена SMS.Tech (POST /api/v1/integrations/smstech/token). */
export interface SaveSmstechTokenResponse {
  ok: boolean;
  tokenSet: boolean;
}

/** Сохранение логина/пароля Т2 (POST /api/v1/integrations/t2/credentials). */
export interface SaveT2CredentialsResponse {
  ok: boolean;
  credentialsSet: boolean;
}

/** Сохранение логина/пароля МТС (POST /api/v1/integrations/mts/credentials). */
export interface SaveMtsCredentialsResponse {
  ok: boolean;
  credentialsSet: boolean;
}

/** Проверка подключения Т2 (POST /api/v1/integrations/t2/check). */
export interface T2CheckResponse {
  ok: boolean;
  detail: string;
}

/** Проверка подключения МТС (POST /api/v1/integrations/mts/check). */
export interface MtsCheckResponse {
  ok: boolean;
  detail: string;
}

/** Тестовая отправка через Т2 (POST /api/v1/integrations/t2/test). */
export interface T2TestResponse {
  ok: boolean;
  code: string | null;
  segments: number;
  smsId: string;
  error: string | null;
}

/** Тестовая отправка через МТС (POST /api/v1/integrations/mts/test). */
export interface MtsTestResponse {
  ok: boolean;
  code: string | null;
  segments: number;
  smsId: string;
  error: string | null;
}

/** Тестовая отправка через SMS.Tech (POST /api/v1/integrations/smstech/test). */
export interface SmstechTestResponse {
  ok: boolean;
  code: string | null;
  segments: number;
  smsId: string;
  error: string | null;
}

/** Ответ активации провайдера (POST /api/v1/integrations/{id}/activate). */
export interface ActivateProviderResponse {
  provider: string;
  defaultSenderName: string;
}

/** Статистика коротких ссылок отписки (GET /api/v1/short-links/stats). */
export interface ShortLinkStatsResponse {
  total: number;
  total30d: number;
  visited: number;
  visits: number;
  last30dVisits: number;
  unsubscribed30d: number;
  unsubscribedTotal: number;
}

/** Именная короткая ссылка (kind=LINK) — GET/POST/PUT /api/v1/links. */
export interface NamedLinkItem {
  id: string;
  code: string;
  name: string;
  targetUrl: string;
  expiresAt: string | null;
  visits: number;
  lastVisitAt: string | null;
  smsCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Список именных ссылок (GET /api/v1/links) — без пагинации. */
export interface NamedLinksResponse {
  items: NamedLinkItem[];
}

/** Статистика дашборда (GET /api/v1/stats?days=…): итоги, по дням, топы. */
export interface StatsResponse {
  totals: {
    sent: number;
    delivered: number;
    failed: number;
    rejected: number;
    unsubscribed: number;
    activeInstances: number;
    waitingJobs: number;
    /** Переходы по именным коротким ссылкам за период. */
    linkClicks: number;
    /** Переходы по отписочным коротким ссылкам за период. */
    unsubLinkVisits: number;
    /** Новые отписки за период. */
    unsubscribedInPeriod: number;
  };
  byDay: Array<{
    date: string;
    sent: number;
    delivered: number;
    failed: number;
    rejected: number;
    /** Переходы по коротким ссылкам (именные + отписочные). */
    clicks: number;
  }>;
  recentEvents: EventItem[];
  topFunnels: Array<{ name: string; count: number }>;
  /** Топ шаблонов за период (отправки/доставки). */
  topTemplates: Array<{ name: string; sent: number; delivered: number; rejected: number }>;
}

/** Ответ серверного превью шаблона (POST /api/v1/templates/preview). */
export interface TemplatePreviewResponse {
  rendered: string;
  /** true — шаблон отменил отправку ({{#cancel}}). */
  cancelled: boolean;
  chars: number;
  segments: number;
  encoding: 'GSM-7' | 'UCS-2';
  variables: string[];
  /** Переменные без дефолта (обязательные). */
  requiredVariables: string[];
  renderedWithDisclaimer: string;
  segmentsWithDisclaimer: number;
  /** Лимит частей (0 = без лимита). */
  maxSegments: number;
  /** true — итог превышает лимит частей → отправка не произойдёт. */
  overLimit: boolean;
}

/** Итог CSV-импорта клиентов: создано/обновлено/ошибки по строкам. */
export interface ImportResult {
  created: number;
  updated: number;
  errors: Array<{ line: number; message: string }>;
}

/* ================= ФОРМАТИРОВАНИЕ ================= */

/** «31.12.2025, 10:00» из ISO-строки; '—' для null/битой даты. */
export function fmtDT(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** «31.12.2025» из ISO-строки; '—' для null/битой даты. */
export function fmtDate(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Относительное время («5 минут назад», date-fns ru); фолбэк — fmtDT. */
export function relTime(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return formatDistanceToNow(d, { addSuffix: true, locale: ru });
  } catch {
    return fmtDT(s);
  }
}

/** Короткая подпись дат оси графиков («5 мар»). */
export function fmtChartDate(iso: string): string {
  try {
    return format(parseISO(iso), 'd MMM', { locale: ru });
  } catch {
    return iso;
  }
}

/* ================= БУФЕР ОБМЕНА ================= */

/** Копирование текста в буфер: async Clipboard API, а на http-контуре
 *  (navigator.clipboard существует только в secure context) — фолбэк
 *  document.execCommand('copy') через временную textarea. true — скопировано;
 *  false — оба пути не сработали, вызывающий код показывает тост-подсказку. */
export async function copyText(value: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // отказ разрешения/потеря фокуса — ниже пробуем легаси-путь
    }
  }
  // http-домен: navigator.clipboard === undefined → execCommand (deprecated, но работает)
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ================= МЕТАДАННЫЕ СПРАВОЧНИКОВ ================= */

/** Справочник событий для UI: метка, цвет бейджа, подсказка по payload и
 *  примеры (payloadExample/cardExample) для вкладки ручной отправки. */
export const EVENT_META: Record<
  EventType,
  { label: string; badge: string; payloadHint: string; payloadExample: string; cardExample?: string }
> = {
  LOAN_OVERDUE: {
    label: 'Просрочка займа',
    badge: 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400',
    payloadHint: 'payload.overdue_days — дней просрочки',
    payloadExample: '{"overdue_days":3, "loan_number":"LN-0001"}',
  },
  PAYMENT_DUE_SOON: {
    label: 'Скоро платёж',
    badge: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400',
    payloadHint: 'payload.due_date — дата платежа',
    payloadExample: '{"due_date":"25.12.2025", "loan_number":"LN-0001"}',
  },
  PAYMENT_RECEIVED: {
    label: 'Платёж получен',
    badge: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400',
    payloadHint: 'payload.payment_amount — сумма платежа',
    payloadExample: '{"payment_amount":"5000", "loan_number":"LN-0001"}',
  },
  LOAN_CLOSED: {
    label: 'Займ закрыт',
    badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400',
    payloadHint: 'client_card: договор со статусом 19 (закрыт) + loan_closed_date',
    payloadExample:
      '{"client_card":{"client_first_name":"Мария","phone":"+79000000020","agreement_id":101002,"agreement_actual_status":19,"agreement_previous_status":16,"loan_amount":15000,"loan_period":14,"loan_closed_date":"2026-10-24T00:00:00Z","last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Мария", "phone": "+79000000020", "agreement_id": 101002, "agreement_actual_status": 19, "agreement_previous_status": 16, "loan_amount": 15000, "loan_period": 14, "loan_closed_date": "2026-10-24T00:00:00Z", "last_product_type": "PDL"}',
  },
  BIRTHDAY: {
    label: 'День рождения',
    badge: 'border-pink-200 bg-pink-50 text-pink-700',
    payloadHint: 'дополнительный payload не требуется',
    payloadExample: '{}',
  },
  APPLICATION_APPROVED: {
    label: 'Заявка одобрена',
    badge: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400',
    payloadHint: 'client_card: карточка с одобренной заявкой (обновит клиента и запустит воронки)',
    payloadExample:
      '{"client_card":{"client_first_name":"Сергей","client_last_name":"Макет","phone":"+79000000050","email":"sergey.maket@example.com","application_id":551005,"application_actual_status":4,"application_previous_status":2,"agreement_id":101005,"agreement_actual_status":16,"loan_amount":21000,"loan_period":21,"last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Сергей", "client_last_name": "Макет", "phone": "+79000000050", "email": "sergey.maket@example.com", "application_id": 551005, "application_actual_status": 4, "application_previous_status": 2, "agreement_id": 101005, "agreement_actual_status": 16, "loan_amount": 21000, "loan_period": 21, "last_product_type": "PDL"}',
  },
  APPROVAL_EXPIRED: {
    label: 'Срок одобрения истёк',
    badge: 'border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/60 text-orange-700 dark:text-orange-400',
    payloadHint: 'client_card: преапрув с прошедшей датой person_offer_date_expired',
    payloadExample:
      '{"client_card":{"client_first_name":"Наталья","phone":"+79000000100","person_offer_approve_money":12000,"person_offer_approve_days":10,"person_offer_date_expired":"2026-10-18T00:00:00Z","person_offer_available":false,"last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Наталья", "phone": "+79000000100", "person_offer_approve_money": 12000, "person_offer_approve_days": 10, "person_offer_date_expired": "2026-10-18T00:00:00Z", "person_offer_available": false, "last_product_type": "PDL"}',
  },
  APPLICATION_REJECTED: {
    label: 'Клиент отказался',
    badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400',
    payloadHint: 'client_card: заявка со статусом 9 (отказ) + ban_days',
    payloadExample:
      '{"client_card":{"client_first_name":"Александр","phone":"+79000000090","application_id":551009,"application_actual_status":9,"application_previous_status":4,"ban_days":90,"last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Александр", "phone": "+79000000090", "application_id": 551009, "application_actual_status": 9, "application_previous_status": 4, "ban_days": 90, "last_product_type": "PDL"}',
  },
  PREAPPROVE_ISSUED: {
    label: 'Выдан преапрув',
    badge: 'border-teal-200 bg-teal-50 text-teal-700',
    payloadHint: 'client_card: карточка с преапрувом (сумма/срок/даты, available=true)',
    payloadExample:
      '{"client_card":{"client_first_name":"Анна","client_last_name":"Синтетикова","phone":"+79000000040","timezone":"Asia/Novosibirsk","person_offer_approve_money":18000,"person_offer_approve_days":14,"person_offer_date_start":"2026-10-20T00:00:00Z","person_offer_date_expired":"2026-11-05T00:00:00Z","person_offer_available":true,"last_product_type":"PDL","date_update":"2026-10-20T08:00:00Z"}}',
    cardExample:
      '{"client_first_name": "Анна", "client_last_name": "Синтетикова", "phone": "+79000000040", "timezone": "Asia/Novosibirsk", "person_offer_approve_money": 18000, "person_offer_approve_days": 14, "person_offer_date_start": "2026-10-20T00:00:00Z", "person_offer_date_expired": "2026-11-05T00:00:00Z", "person_offer_available": true, "last_product_type": "PDL", "date_update": "2026-10-20T08:00:00Z"}',
  },
  APPLICATION_CREATED: {
    label: 'Заявка создана',
    badge: 'border-sky-200 bg-sky-50 text-sky-700',
    payloadHint: 'client_card: заявка со статусом 5 (в процессе оформления)',
    payloadExample:
      '{"client_card":{"client_first_name":"Ольга","phone":"+79000000120","application_id":551012,"application_actual_status":5,"application_previous_status":1,"last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Ольга", "phone": "+79000000120", "application_id": 551012, "application_actual_status": 5, "application_previous_status": 1, "last_product_type": "PDL"}',
  },
  APPLICATION_IN_REVIEW: {
    label: 'Заявка на рассмотрении',
    badge: 'border-sky-200 bg-sky-50 text-sky-700',
    payloadHint: 'client_card: заявка со статусом 6 (на рассмотрении)',
    payloadExample:
      '{"client_card":{"client_first_name":"Ольга","phone":"+79000000120","application_id":551012,"application_actual_status":6,"application_previous_status":5,"last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Ольга", "phone": "+79000000120", "application_id": 551012, "application_actual_status": 6, "application_previous_status": 5, "last_product_type": "PDL"}',
  },
  APPLICATION_ON_REVISION: {
    label: 'На доработке у клиента',
    badge: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400',
    payloadHint: 'client_card: заявка со статусом 9309 (на доработке у клиента)',
    payloadExample:
      '{"client_card":{"client_first_name":"Пётр","phone":"+79000000130","application_id":551013,"application_actual_status":9309,"application_previous_status":6,"last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Пётр", "phone": "+79000000130", "application_id": 551013, "application_actual_status": 9309, "application_previous_status": 6, "last_product_type": "PDL"}',
  },
  APPLICATION_CLIENT_DECLINED: {
    label: 'Клиент отказался',
    badge: 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:text-zinc-400',
    payloadHint: 'client_card: заявка со статусом 10 (клиент отозвал заявку)',
    payloadExample:
      '{"client_card":{"client_first_name":"Мария","phone":"+79000000140","application_id":551014,"application_actual_status":10,"application_previous_status":6,"last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Мария", "phone": "+79000000140", "application_id": 551014, "application_actual_status": 10, "application_previous_status": 6, "last_product_type": "PDL"}',
  },
  APPLICATION_DECLINED_AFTER_APPROVAL: {
    label: 'Отказ после одобрения',
    badge: 'border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/60 text-orange-700 dark:text-orange-400',
    payloadHint: 'client_card: заявка со статусом 21 (отказ клиента после одобрения)',
    payloadExample:
      '{"client_card":{"client_first_name":"Иван","phone":"+79000000150","application_id":551015,"application_actual_status":21,"application_previous_status":7,"last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Иван", "phone": "+79000000150", "application_id": 551015, "application_actual_status": 21, "application_previous_status": 7, "last_product_type": "PDL"}',
  },
  APPLICATION_PROCESSING_EXPIRED: {
    label: 'Истёк срок оформления',
    badge: 'border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/60 text-orange-700 dark:text-orange-400',
    payloadHint: 'client_card: заявка со статусом 710 (5 дней бездействия)',
    payloadExample:
      '{"client_card":{"client_first_name":"Дмитрий","phone":"+79000000160","application_id":551016,"application_actual_status":710,"application_previous_status":5,"last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Дмитрий", "phone": "+79000000160", "application_id": 551016, "application_actual_status": 710, "application_previous_status": 5, "last_product_type": "PDL"}',
  },
  LOAN_ISSUED: {
    label: 'Выдача займа',
    badge: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400',
    payloadHint: 'client_card: договор со статусом 13 (подписан, к выплате)',
    payloadExample:
      '{"client_card":{"client_first_name":"Елена","phone":"+79000000170","agreement_id":101017,"agreement_actual_status":13,"agreement_previous_status":16,"loan_amount":12000,"loan_period":14,"last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Елена", "phone": "+79000000170", "agreement_id": 101017, "agreement_actual_status": 13, "agreement_previous_status": 16, "loan_amount": 12000, "loan_period": 14, "last_product_type": "PDL"}',
  },
  LOAN_PROLONGED: {
    label: 'Пролонгация',
    badge: 'border-teal-200 bg-teal-50 text-teal-700',
    payloadHint: 'client_card: договор со статусом 17 (пролонгирован)',
    payloadExample:
      '{"client_card":{"client_first_name":"Сергей","phone":"+79000000180","agreement_id":101018,"agreement_actual_status":17,"agreement_previous_status":16,"loan_amount":9000,"loan_period":7,"last_product_type":"PDL"}}',
    cardExample:
      '{"client_first_name": "Сергей", "phone": "+79000000180", "agreement_id": 101018, "agreement_actual_status": 17, "agreement_previous_status": 16, "loan_amount": 9000, "loan_period": 7, "last_product_type": "PDL"}',
  },
  EARLY_PAYMENT_MADE: {
    label: 'Досрочное погашение (ЧДП)',
    badge: 'border-teal-200 bg-teal-50 text-teal-700',
    payloadHint: 'client_card: обновление плановой даты закрытия по ЧДП-джобу ядра',
    payloadExample:
      '{"client_card":{"client_first_name":"Анна","phone":"+79000000040","agreement_id":101004,"agreement_actual_status":16,"loan_amount":15000,"loan_period":21,"last_product_type":"IL","date_update":"2026-11-07T02:00:00Z"}}',
    cardExample:
      '{"client_first_name": "Анна", "phone": "+79000000040", "agreement_id": 101004, "agreement_actual_status": 16, "loan_amount": 15000, "loan_period": 21, "last_product_type": "IL", "date_update": "2026-11-07T02:00:00Z"}',
  },
};

/** Метки и цвета статусов экземпляра воронки. */
export const INSTANCE_STATUS_META: Record<InstanceStatus, { label: string; badge: string }> = {
  RUNNING: { label: 'Выполняется', badge: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400' },
  WAITING: { label: 'Ожидание', badge: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400' },
  COMPLETED: { label: 'Завершён', badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400' },
  FAILED: { label: 'Ошибка', badge: 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400' },
  CANCELLED: { label: 'Отменён', badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-400' },
};

/** Метки и цвета статусов SMS (журнал, таймлайны). */
export const SMS_STATUS_META: Record<SmsStatus, { label: string; badge: string }> = {
  QUEUED: { label: 'В очереди', badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400' },
  SENDING: { label: 'Отправляется', badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400' },
  SENT: { label: 'Отправлено', badge: 'border-teal-200 bg-teal-50 text-teal-700' },
  DELIVERED: { label: 'Доставлено', badge: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400' },
  FAILED: { label: 'Ошибка', badge: 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400' },
  REJECTED_BY_COMPLIANCE: {
    label: 'Отказ комплаенса',
    badge: 'border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/60 text-orange-700 dark:text-orange-400',
  },
  CANCELLED: { label: 'Отменено', badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-400' },
};

/** Человекочитаемые имена SMS-провайдеров (клиентский аналог серверного реестра). */
export const PROVIDER_LABELS: Record<string, string> = {
  sandbox: 'Песочница',
  smstech: 'SMS.Tech',
  t2: 'Т2 «Бизнес SMS»',
  mts: 'МТС OmniChannel',
};

/** Метки и цвета статусов согласия на рекламу. */
export const CONSENT_META: Record<ConsentStatus, { label: string; badge: string }> = {
  GRANTED: { label: 'Дано', badge: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400' },
  PENDING: { label: 'Ожидает', badge: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400' },
  NONE: { label: 'Нет', badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400' },
  REVOKED: { label: 'Отозвано', badge: 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400' },
};

/** Метки и цвета статусов событий журнала. */
export const EVENT_STATUS_META: Record<EventStatus, { label: string; badge: string }> = {
  NEW: { label: 'Новое', badge: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400' },
  PROCESSING: { label: 'Обрабатывается', badge: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400' },
  PROCESSED: { label: 'Обработано', badge: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400' },
  FAILED: { label: 'Ошибка', badge: 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400' },
};

/** Метки и цвета ролей пользователей (шапка, справочник пользователей). */
export const ROLE_META: Record<Role, { label: string; badge: string }> = {
  ADMIN: { label: 'Администратор', badge: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400' },
  MANAGER: { label: 'Менеджер', badge: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400' },
  VIEWER: { label: 'Наблюдатель', badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400' },
};

/** Человекочитаемые причины отказа (совпадают с серверным перечнем RejectReason). */
export const REJECT_REASON_TEXT: Record<RejectReason, string> = {
  QUIET_HOURS: 'Тихие часы',
  UNSUBSCRIBED: 'Отписан от рекламы',
  ADVERT_OFF: 'Реклама отключена',
  NO_CONSENT: 'Нет согласия',
  LIMIT_CLIENT: 'Лимит на клиента',
  LIMIT_SYSTEM: 'Лимит системы',
  INVALID_PHONE: 'Неверный номер',
  RENDER_ERROR: 'Ошибка рендера',
  SMS_TOO_LONG: 'Превышен лимит частей',
  TEMPLATE_CANCEL: 'Отменено шаблоном',
};

/** Зоны РФ (порядок по смещению, запад→восток) + UTC. */
export const TIMEZONES = [
  'Europe/Kaliningrad',
  'Europe/Moscow',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Novosibirsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Yakutsk',
  'Asia/Vladivostok',
  'Asia/Magadan',
  'Asia/Kamchatka',
  'UTC',
];

/** Подпись зоны с цифровым смещением UTC: «Asia/Yekaterinburg (UTC+5)». */
export function timezoneOptionLabel(tz: string): string {
  const offset = tzOffsetLabel(tz);
  return offset !== '' ? `${tz} (${offset})` : tz;
}

/* ================= БЕЙДЖИ ================= */

/** Бейдж типа события (метка+цвет из EVENT_META; фолбэк — сырой код). */
export function EventBadge({ event }: { event: EventType }) {
  const meta = EVENT_META[event];
  return (
    <Badge variant="outline" className={meta?.badge ?? 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'}>
      {meta?.label ?? event}
    </Badge>
  );
}

/** Бейдж статуса экземпляра воронки (INSTANCE_STATUS_META). */
export function InstanceBadge({ status }: { status: InstanceStatus }) {
  const meta = INSTANCE_STATUS_META[status];
  return (
    <Badge variant="outline" className={meta?.badge ?? ''}>
      {meta?.label ?? status}
    </Badge>
  );
}

/** Бейдж статуса SMS-сообщения (SMS_STATUS_META).
 *  className — точечная кастомизация: в узких ячейках таблиц передают
 *  «max-w-full whitespace-normal break-words», чтобы длинные метки
 *  («Отказ комплаенса») переносились вместо вылезания за колонку. */
export function SmsBadge({ status, className }: { status: SmsStatus; className?: string }) {
  const meta = SMS_STATUS_META[status];
  return (
    <Badge variant="outline" className={[meta?.badge ?? '', className].filter(Boolean).join(' ')}>
      {meta?.label ?? status}
    </Badge>
  );
}

/** Бейдж статуса согласия (CONSENT_META). */
export function ConsentBadge({ status }: { status: ConsentStatus }) {
  const meta = CONSENT_META[status];
  return (
    <Badge variant="outline" className={meta?.badge ?? ''}>
      {meta?.label ?? status}
    </Badge>
  );
}

/** Бейдж статуса события журнала (EVENT_STATUS_META). */
export function EventStatusBadge({ status }: { status: EventStatus }) {
  const meta = EVENT_STATUS_META[status];
  return (
    <Badge variant="outline" className={meta?.badge ?? ''}>
      {meta?.label ?? status}
    </Badge>
  );
}

/** Бейдж роли пользователя (ROLE_META). */
export function RoleBadge({ role }: { role: Role }) {
  const meta = ROLE_META[role];
  return (
    <Badge variant="outline" className={meta?.badge ?? ''}>
      {meta?.label ?? role}
    </Badge>
  );
}

/* ================= ХЕЛПЕРЫ РОЛЕЙ ================= */

/** Роль текущего пользователя из store + производные флаги:
 *  isAdmin (ADMIN) и canWrite (ADMIN/MANAGER) — основа RBAC в UI. */
export function useRole(): { role: Role | null; isAdmin: boolean; canWrite: boolean } {
  const role = useAppStore((s) => s.user?.role ?? null);
  return { role, isAdmin: role === 'ADMIN', canWrite: role === 'ADMIN' || role === 'MANAGER' };
}

/** Обёртка для мутационных кнопок: VIEWER — disabled + подсказка «Только просмотр».
 *  Аудит 29-d: inert на обёртке обязателен — disabled через cloneElement работает
 *  только на form-элементах; когда ребёнок — div с кнопками (блок действий
 *  карточки сегмента), без inert кнопки оставались кликабельными для VIEWER. */
export function ViewerGuard({ children }: { children: React.ReactElement }) {
  const { canWrite } = useRole();
  if (canWrite) return children;
  return (
    <span title="Только просмотр" className="inline-flex cursor-not-allowed items-center opacity-50" inert>
      {React.cloneElement(children, { disabled: true } as React.HTMLAttributes<HTMLElement>)}
    </span>
  );
}

/* ================= СОСТОЯНИЯ ================= */

/** Пустой список: иконка, текст и опциональное действие (кнопка создания). */
export function EmptyState({
  icon: Icon,
  title,
  action,
}: {
  icon: LucideIcon;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Icon className="mb-3 size-10 text-zinc-300 dark:text-zinc-600" aria-hidden />
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{title}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Ошибка загрузки: текст из ApiError/Error + кнопка «Повторить» (refetch). */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  let message = 'Не удалось загрузить данные';
  if (error instanceof ApiError) {
    message = error.detail ?? error.title;
  } else if (error instanceof Error) {
    message = error.message;
  }
  return (
    <Alert variant="destructive">
      <AlertCircle className="size-4" aria-hidden />
      <AlertTitle>Ошибка загрузки</AlertTitle>
      <AlertDescription>
        <span>{message}</span>
        {onRetry ? (
          <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
            Повторить
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** Заглушка таблицы на время загрузки — rows × cols серых полосок. */
export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-3 p-4">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={c === 0 ? 'h-5 flex-1' : 'h-5 w-20'} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ================= ПАГИНАЦИЯ ================= */

/** Номера страниц с ellipsis: «1 … p-1 p p+1 … N» (без «…» при ≤7 страниц). */
function pageList(page: number, pages: number): Array<number | 'ellipsis-l' | 'ellipsis-r'> {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out: Array<number | 'ellipsis-l' | 'ellipsis-r'> = [1];
  if (page > 3) out.push('ellipsis-l');
  for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) out.push(i);
  if (page < pages - 2) out.push('ellipsis-r');
  out.push(pages);
  return out;
}

/** Пагинация списков: «Показано X–Y из Z» + shadcn Pagination; клик → onPage(p).
 *  page > pages (после удаления последней строки последней страницы) —
 *  авто-возврат на последнюю существующую страницу. */
export function TablePagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  // Кламп страницы: без него после удаления последней строки последней
  // страницы остаётся «Нет записей» и ручной возврат «Назад»
  React.useEffect(() => {
    if (page > pages) onPage(pages);
  }, [page, pages, onPage]);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  if (total === 0) {
    return <p className="pt-3 text-xs text-zinc-500 dark:text-zinc-400">Нет записей</p>;
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-3">
      <p className="text-xs text-zinc-500 dark:text-zinc-400" aria-live="polite">
        Показано {from}–{to} из {total}
      </p>
      <Pagination className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              aria-disabled={page <= 1}
              className={page <= 1 ? 'pointer-events-none opacity-50' : ''}
              onClick={(e) => {
                e.preventDefault();
                if (page > 1) onPage(page - 1);
              }}
            />
          </PaginationItem>
          {pageList(page, pages).map((p, i) =>
            typeof p === 'number' ? (
              <PaginationItem key={p}>
                <PaginationLink
                  href="#"
                  isActive={p === page}
                  onClick={(e) => {
                    e.preventDefault();
                    onPage(p);
                  }}
                >
                  {p}
                </PaginationLink>
              </PaginationItem>
            ) : (
              <PaginationItem key={`${p}-${i}`}>
                <PaginationEllipsis />
              </PaginationItem>
            ),
          )}
          <PaginationItem>
            <PaginationNext
              href="#"
              aria-disabled={page >= pages}
              className={page >= pages ? 'pointer-events-none opacity-50' : ''}
              onClick={(e) => {
                e.preventDefault();
                if (page < pages) onPage(page + 1);
              }}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

/* ================= ОБЩИЕ ХУКИ ================= */

/** Мгновенное применение правок (требование владельца): после любого успешного
 *  сохранения/удаления/запуска сбрасываем ВЕСЬ кэш панели — активные запросы
 *  перезагружаются немедленно, остальные — при следующем открытии вкладки.
 *  Так правка шаблона сразу видна в воронках, запуск рассылки — в SMS-логе
 *  и на дашборде, смена настроек — во всех превью. */
export function invalidatePanel(queryClient: QueryClient): void {
  void queryClient.invalidateQueries();
}

/** Кастомное поле профиля (GET /api/v1/custom-fields): реестр ADMIN-раздела
 *  «Кастомные поля» + источник динамических полей конструктора сегментов и
 *  подсказок переменных шаблонов ({{cf_<key>}}). */
export interface CustomFieldItem {
  id: string;
  key: string; // без префикса (is_credit_line)
  varName: string; // готовое имя переменной (cf_is_credit_line) — для подсказок
  label: string;
  type: 'text' | 'number' | 'date' | 'bool';
  description: string | null;
  isActive: boolean;
  values: number; // заполненных значений (счётчик groupBy)
  createdAt: string;
  updatedAt: string;
}

/** Активные кастомные поля (кэш 60с): для конструктора сегментов, подсказок
 *  шаблонов и блока в карточке клиента. Пусто — полей нет, UI их не рисует. */
export function useCustomFields() {
  return useQuery({
    queryKey: ['custom-fields'],
    queryFn: () => api<{ items: CustomFieldItem[] }>('/api/v1/custom-fields'),
    staleTime: 60_000,
  });
}

/** Метки типов кастомных полей (реестр + подписи в UI). */
export const CF_TYPE_META: Record<CustomFieldItem['type'], { label: string; hint: string }> = {
  text: { label: 'Текст', hint: 'строка до 200 символов' },
  number: { label: 'Число', hint: 'целое или дробное' },
  date: { label: 'Дата', hint: 'дата без времени' },
  bool: { label: 'Да/Нет', hint: 'логическое значение' },
};

/** Настройки панели (кэш 60с): рекламодатель, дисклеймер, провайдер, тихие часы. */
export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api<AppSettings>('/api/v1/settings'),
    staleTime: 60_000,
  });
}

/* ================= Массовое обновление клиентов (P4) ================= */

/** Статус операции массового обновления. */
export type MassUpdateStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

/** Метки и цвета статусов операций (бейджи журнала). */
export const MASS_UPDATE_STATUS_META: Record<MassUpdateStatus, { label: string; badge: string }> = {
  PENDING: { label: 'В очереди', badge: 'border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-400' },
  RUNNING: { label: 'Выполняется', badge: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400' },
  DONE: { label: 'Завершена', badge: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400' },
  FAILED: { label: 'Ошибка', badge: 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-400' },
  CANCELLED: { label: 'Отменена', badge: 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400' },
};

/** Бейдж статуса операции массового обновления. */
export function MassUpdateStatusBadge({ status }: { status: MassUpdateStatus }) {
  const meta = MASS_UPDATE_STATUS_META[status];
  return (
    <Badge variant="outline" className={meta?.badge ?? ''}>
      {meta?.label ?? status}
    </Badge>
  );
}

/** Одно правило обновления операции: поле (cf_<key> | notification_active |
 *  sms_consent_status) и значение (null = «очистить»). */
export interface MassUpdateRule {
  field: string;
  value: string | number | boolean | null;
}

/** Операция массового обновления (GET/POST /api/v1/clients/mass-update). */
export interface MassUpdateJobItem {
  id: string;
  name: string;
  segmentId: string;
  segmentName: string;
  updates: MassUpdateRule[];
  maxAffected: number;
  status: MassUpdateStatus;
  planned: number;
  processed: number;
  affected: number;
  error: string | null;
  createdByEmail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ================= История изменений профиля (P5) ================= */

/** Запись истории профиля (GET /api/v1/clients/{id}/history): дифф одного поля. */
export interface ProfileChangeItem {
  id: string;
  clientId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  source: 'MANUAL' | 'IMPORT' | 'EVENT' | 'MASS_UPDATE';
  details: Record<string, unknown> | null;
  createdAt: string;
}

/** Метки источников изменений профиля. */
export const PROFILE_SOURCE_META: Record<ProfileChangeItem['source'], { label: string; badge: string }> = {
  MANUAL: { label: 'Вручную', badge: 'border-teal-200 bg-teal-50 text-teal-700' },
  IMPORT: { label: 'Импорт CSV', badge: 'border-violet-200 bg-violet-50 text-violet-700' },
  EVENT: { label: 'Событие ядра', badge: 'border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-400' },
  MASS_UPDATE: { label: 'Массовое обновление', badge: 'border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/60 text-orange-700 dark:text-orange-400' },
};

/** Спец-ключ факта создания профиля (одна строка вместо диффа). */
export const PROFILE_FIELD_CREATED = '__created__';

/** Человекочитаемые метки полей истории: карточные поля — из единого
 *  реестра registry/card-fields; cf-ключи резолвит вызывающий через cfLabels. */
const HISTORY_FIELD_LABELS: ReadonlyMap<string, string> = new Map([
  ...CANONICAL_CARD_FIELDS.map((f) => [f.fieldName, f.label] as const),
  ['phone', 'Телефон'],
  ['timezone', 'Часовой пояс'],
  ['sms_consent_status', 'Статус SMS-согласия'],
  ['notification_active', 'Реклама разрешена'],
]);

/** Метка поля истории: реестр карточки → спец-ключи → cf-метки → само имя. */
export function profileHistoryFieldLabel(
  field: string,
  cfLabels?: ReadonlyMap<string, string>,
): string {
  if (field === PROFILE_FIELD_CREATED) return 'Профиль создан';
  const known = HISTORY_FIELD_LABELS.get(field);
  if (known !== undefined) return known;
  if (field.startsWith('cf_')) {
    return cfLabels?.get(field.slice(3)) ?? field;
  }
  return field;
}

/** Значение истории → человекочитаемо: ISO-даты — «дд.мм.гггг», true/false —
 *  «да»/«нет», null — «пусто» (очистка/не заполнено). */
export function formatProfileHistoryValue(v: string | null): string {
  if (v === null) return 'пусто';
  if (v === 'true') return 'да';
  if (v === 'false') return 'нет';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
    try {
      return format(parseISO(v), 'dd.MM.yyyy');
    } catch {
      return v;
    }
  }
  return v;
}

/** Инициалы для аватара. */
export function initialsOf(name: string | null | undefined, email: string): string {
  if (name && name.trim().length > 0) {
    const parts = name.trim().split(/\s+/).slice(0, 2);
    return parts
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('');
  }
  return email.slice(0, 2).toUpperCase();
}
