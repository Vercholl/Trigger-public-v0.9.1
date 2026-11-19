// Типы движка воронок: узлы, определение, контекст экземпляра, результаты исполнителей.
// Узел waitEvent («ждать событие» с таймаутом и двумя ветками),
// абсолютные паузы delay-узла (до времени суток / до даты / до дня рождения),
// контекст экземпляра получает маркер waitEvent для пробуждения из events_inbox.

// Триггерные события. Единый источник (переиспользуется funnels/events/validate).
/**
 * 18 типов триггерных событий (единый источник — переиспользуется движком,
 * валидацией и UI редактора воронок/событий).
 * 5 базовых событий: LOAN_OVERDUE (просрочка), PAYMENT_DUE_SOON (платёж
 * близко), PAYMENT_RECEIVED (платёж получен), LOAN_CLOSED (займ закрыт),
 * BIRTHDAY (день рождения).
 * Контракт системы данных (+ статусы реальных сценариев):
 * APPLICATION_APPROVED (заявка одобрена, ст. 7), APPLICATION_REJECTED
 * (отказ по заявке, ст. 9), APPLICATION_CREATED (создана, ст. 5),
 * APPLICATION_IN_REVIEW (на рассмотрении, ст. 6), APPLICATION_ON_REVISION
 * (на доработке у клиента, ст. 9309), APPLICATION_CLIENT_DECLINED (клиент
 * отказался, ст. 10), APPLICATION_DECLINED_AFTER_APPROVAL (отказ после
 * одобрения, ст. 21), APPLICATION_PROCESSING_EXPIRED (истёк срок оформления,
 * ст. 710), APPROVAL_EXPIRED (истёк срок одобрения, ст. 711), LOAN_ISSUED
 * (выдача, договор ст. 13), LOAN_PROLONGED (пролонгация, ст. 17),
 * EARLY_PAYMENT_MADE (ЧДП — частичное досрочное погашение),
 * PREAPPROVE_ISSUED (выдан преапрув).
 * Маппинг status_id → событие: этот же файл (TRIGGER_EVENTS + комментарии
 * статусов выше); отдельный реестр registry-файл удалён (v0.8.8)
 * как дубликат.
 */
export const TRIGGER_EVENTS = [
  'LOAN_OVERDUE',
  'PAYMENT_DUE_SOON',
  'PAYMENT_RECEIVED',
  'LOAN_CLOSED',
  'BIRTHDAY',
  'APPLICATION_APPROVED',
  'APPROVAL_EXPIRED',
  'APPLICATION_REJECTED',
  'PREAPPROVE_ISSUED',
  'APPLICATION_CREATED',
  'APPLICATION_IN_REVIEW',
  'APPLICATION_ON_REVISION',
  'APPLICATION_CLIENT_DECLINED',
  'APPLICATION_DECLINED_AFTER_APPROVAL',
  'APPLICATION_PROCESSING_EXPIRED',
  'LOAN_ISSUED',
  'LOAN_PROLONGED',
  'EARLY_PAYMENT_MADE',
] as const;

export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

/**
 * Типы узлов воронки. Отдельных узлов «start»/«end» НЕТ: старт задаётся
 * FunnelDefinition.start_node, конец — ссылка next/onTrue/onFalse = null.
 */
export type NodeType = 'sms' | 'delay' | 'condition' | 'waitEvent';

/**
 * SMS-узел: рендер шаблона и отправка (предметная логика — smsExecutor в
 * executors.ts). next=null → конец воронки после отправки.
 */
export interface SmsNode {
  id: string;
  type: 'sms';
  /** Человекочитаемое имя узла в редакторе (в таймлайн как message). */
  name?: string;
  /** Id шаблона SmsTemplate; деактивация шаблона на бою → узел пропускается. */
  templateId: string;
  /** Имя отправителя этого узла (переопределяет шаблон/настройку). */
  senderName?: string | null;
  /** Следующий узел; null = завершить воронку. */
  next: string | null;
}

/** Режим паузы delay-узла (П5): относительная или абсолютная (в TZ клиента). */
export type DelayMode = 'relative' | 'until_time' | 'until_date' | 'until_birthday';

/**
 * Delay-узел — пауза (исполняется движком как WAIT + задача scheduled_jobs).
 * Всегда возобновляет СЛЕДУЮЩИЙ узел (next); сам узел повторно не исполняется.
 */
export interface DelayNode {
  id: string;
  type: 'delay';
  name?: string;
  /** Относительная пауза (по умолчанию — часы/минуты от текущего момента). */
  hours: number;
  minutes: number;
  /** Абсолютные паузы (П5): до следующего ЧЧ:ММ / до даты / до дня рождения — в TZ клиента. */
  mode?: DelayMode;
  /** until_time / until_birthday / until_date: час и минута целевого момента. */
  atHour?: number;
  atMinute?: number;
  /** until_date: «ГГГГ-ММ-ДД» (в TZ клиента; прошедшая дата — шаг пропускается). */
  atDate?: string;
  /** Следующий узел (возобновление после паузы); null → завершить воронку. */
  next: string | null;
}

/**
 * Condition-узел — ветвление: expression → boolean, переход по onTrue/onFalse.
 * Синтаксис выражения — см. шапку engine/expression.ts (безопасный парсер,
 * без eval); валидируется при сохранении воронки (validate.ts).
 */
export interface ConditionNode {
  id: string;
  type: 'condition';
  /** Человекочитаемое имя узла в редакторе. */
  name?: string;
  /** Выражение-условие; голые имена читаются из vars (как в шаблонах SMS). */
  expression: string;
  /** Ветка «истина»; null = завершить воронку. */
  onTrue: string | null;
  /** Ветка «ложь»; null = завершить воронку. */
  onFalse: string | null;
}

/** Узел «ждать событие» (П5): ожидание события клиента с таймаутом и двумя ветками. */
export interface WaitEventNode {
  id: string;
  type: 'waitEvent';
  name?: string;
  /** Тип ожидаемого события (одно из TRIGGER_EVENTS). */
  event: string;
  timeoutHours: number;
  timeoutMinutes?: number;
  /** Ветка «событие пришло» (null = завершить воронку). */
  onEvent: string | null;
  /** Ветка «таймаут» (null = завершить воронку). */
  onTimeout: string | null;
}

export type FunnelNode = SmsNode | DelayNode | ConditionNode | WaitEventNode;

/**
 * Определение воронки — JSON в FunnelDefinition (колонка Funnel.definition).
 * Граф — произвольный (циклы разрешены при наличии delay/waitEvent внутри).
 */
export interface FunnelDefinition {
  /** Id узла, с которого начинается исполнение каждого экземпляра. */
  start_node: string;
  /** Все узлы воронки (id уникальны — проверяет validateFunnelGraph). */
  nodes: FunnelNode[];
}

/**
 * Снапшот-контекст экземпляра (сохраняется в WorkflowInstance.context).
 * waitEvent — маркер активного ожидания: выставляет waitEvent-исполнитель,
 * воркер снимает его при пробуждении/таймауте.
 */
export interface InstanceContext {
  event: string;
  payload: Record<string, unknown>;
  client: {
    externalId: string;
    phone: string;
    timezone: string;
    data: Record<string, unknown>;
    /** Типизированные поля карточки (client_first_name, agreement_actual_status, ...). */
    [key: string]: unknown;
  };
  /**
   * Плоское слияние переменных шаблонов/условий: {...карточка, ...client.data,
   * ...payload события, ...cf-поля профиля} — каждый следующий слой приоритетнее
   * предыдущего (cf_* — сильнейший: воркер применяет их к профилю ДО запуска
   * воронки, профиль — источник истины). Сборка — engine.startInstance и
   * worker.wakeWaitingInstances (порядок слоёв идентичен в обеих точках).
   */
  vars: Record<string, unknown>;
  /** Origin запроса события — для ссылки отписки. */
  baseUrl?: string;
  /** Активное ожидание события {event, nodeId} либо null. */
  waitEvent?: { event: string; nodeId: string } | null;
  /** Id события, которым экземпляр будили в последний раз (идемпотентность
   *  wake: ретрай события не должен будить повторно — дубль ветки onEvent). */
  lastWakeEventId?: string;
}

/**
 * Статусы экземпляра воронки (WorkflowInstance.status).
 * Переходы: RUNNING → WAITING (пауза, есть PENDING-задача) → RUNNING…;
 * терминальные: COMPLETED (дошли до конца), FAILED (ошибка узла/движка),
 * CANCELLED (режим REPLACE или ручная отмена). WAITING без задач/«зомби»
 * RUNNING вычищает воркер (см. cleanup).
 */
export type InstanceStatus = 'RUNNING' | 'WAITING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** Типы записей таймлайна экземпляра. */
export type InstanceEventType =
  | 'STATUS_CHANGE'
  | 'NODE_START'
  | 'NODE_DONE'
  | 'SMS_SENT'
  | 'SMS_REJECTED'
  | 'SMS_FAILED'
  | 'ERROR'
  | 'INFO'
  | 'WAIT_EVENT_RECEIVED'
  | 'WAIT_EVENT_TIMEOUT';

/** Параметры записи в таймлайн: узел, тип, сообщение и произвольный payload. */
export interface LogEventOptions {
  nodeId?: string | null;
  nodeType?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
}

export type LogInstanceEvent = (
  type: InstanceEventType,
  opts?: LogEventOptions,
) => Promise<void>;

/** Результат исполнения узла. */
export type NodeOutcome =
  | { outcome: 'CONTINUE'; nextNodeId: string | null; message: string }
  | {
      outcome: 'WAIT';
      reason: 'NODE_DELAY' | 'QUIET_HOURS' | 'RETRY' | 'WAIT_EVENT';
      runAt: Date;
      /**
       * Узел, с которого продолжить при срабатывании задачи. Для WAIT_EVENT —
       * id самого waitEvent-узла: воркер берёт его ветку onTimeout (null → завершение).
       */
      resumeNodeId: string;
      attempts?: number;
      message: string;
    }
  | { outcome: 'FAIL'; error: string; message: string };

/**
 * Вход исполнителя узла: контекст экземпляра + число попыток ретрая (из
 * scheduled_jobs.attempts — сохраняется между пробуждениями WAIT reason=RETRY)
 * и функция записи в таймлайн.
 */
export interface ExecutorInput {
  instanceId: string;
  clientId: string;
  context: InstanceContext;
  /** Текущее число попыток ретрая провайдера (из задачи; 0 при свежем запуске). */
  attempts: number;
  logEvent: LogInstanceEvent;
}

/**
 * Контракт исполнителя узла: чистая функция «узел + вход → NodeOutcome».
 * Исполнитель не меняет статус экземпляра и не создаёт задачи сам — только
 * описывает желаемый исход, движок (engine.ts) применяет его к БД.
 */
export interface NodeExecutor<TNode extends FunnelNode = FunnelNode> {
  execute(node: TNode, input: ExecutorInput): Promise<NodeOutcome>;
}
