// Исполнители узлов воронки. Реестр: sms / delay / condition.
// Движок отвечает за цикл, статусы экземпляра и таймлайн; исполнители — за
// предметную логику узла (compliance, отправка, ретраи, вычисление условия).
// Полный реестр типов: sms / delay / condition / waitEvent (nodeExecutors ниже).
// Контракт: исполнитель НИКОГДА не меняет статус экземпляра сам — только возвращает
// NodeOutcome (types.ts), решение о статусе/задачах принимает движок (engine.ts).
// Все значимые происшествия узла пишутся в таймлайн через input.logEvent.
import { db } from '@/lib/db';
import { getSettings } from '@/lib/services/settings';
import { renderTemplate, RenderError, snapshotVars } from '@/lib/sms/render';
import { countSegments } from '@/lib/sms/segments';
import { runCompliancePipeline, REJECT_REASON_TEXT, type RejectReason } from '@/lib/compliance/pipeline';
import {
  resolveUnsubscribeBaseUrl,
} from '@/lib/compliance/disclaimer';
import { buildMarketingSmsBody } from '@/lib/compliance/short-links';
import { formatInTimezone } from '@/lib/compliance/quiet-hours';
import { getProvider, TemporaryProviderError } from '@/lib/provider/types';
import { journalSendOutcome } from '@/lib/services/message-events';
import { evaluateExpression, buildEvalContext } from '@/lib/engine/expression';
import { nextWallClockOccurrence, nextBirthdayWall, zonedTimeToUtc } from '@/lib/time';
import type {
  ConditionNode,
  DelayNode,
  ExecutorInput,
  FunnelNode,
  NodeExecutor,
  NodeOutcome,
  SmsNode,
  WaitEventNode,
} from '@/lib/engine/types';

/** Максимум попыток отправки при временных ошибках провайдера. */
export const MAX_SEND_ATTEMPTS = 5;

/**
 * Создание строки SmsMessage — единая точка журналирования всех исходов узла SMS
 * (отправлено/отклонено/отменено/ошибка) с дефолтами null; возвращает id записи.
 * Вызывается на КАЖДОМ терминальном исходе SMS-узла — в журнале видны и отклоны.
 * varsSnapshot (P6) — снимок переменных шаблона на момент рендера (контекст
 * воронки: карточка + cf + payload события); пишется во ВСЕ исходы — и в отказных
 * сообщениях видно, что подставилось / чего не хватало.
 */
async function createSmsMessage(data: {
  instanceId: string;
  clientId: string;
  phone: string;
  body: string;
  segments: number;
  provider: string;
  templateId: string;
  templateName: string;
  status: string;
  rejectReason?: RejectReason | null;
  error?: string | null;
  providerMessageId?: string | null;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  varsSnapshot?: string | null;
}): Promise<string> {
  const row = await db.smsMessage.create({
    data: {
      instanceId: data.instanceId,
      clientId: data.clientId,
      phone: data.phone,
      body: data.body,
      segments: data.segments,
      provider: data.provider,
      providerMessageId: data.providerMessageId ?? null,
      templateId: data.templateId,
      templateName: data.templateName,
      status: data.status,
      rejectReason: data.rejectReason ?? null,
      error: data.error ?? null,
      varsSnapshot: data.varsSnapshot ?? null,
      sentAt: data.sentAt ?? null,
      deliveredAt: data.deliveredAt ?? null,
    },
  });
  return row.id;
}

// ---------- SMS-узел ----------

/**
 * SMS-узел: комплаенс → рендер → маркетинговая приписка → лимит частей → отправка.
 *
 * Политика исходов (воронка по возможности НЕ валится):
 * - REJECT комплаенса (кроме тихих часов) → CONTINUE, сообщение в журнале со
 *   статусом REJECTED_BY_COMPLIANCE + SMS_REJECTED в таймлайн (SMS не отправляем,
 *   но сценарий идёт дальше — так задумано);
 * - RESCHEDULE (тихие часы) → WAIT reason=QUIET_HOURS, resumeNodeId=этот же узел:
 *   при пробуждении узел исполняется целиком заново, все проверки идемпотентны;
 * - {{#cancel}} / пустой результат рендера → CONTINUE, запись CANCELLED
 *   (rejectReason=TEMPLATE_CANCEL) — тихая отмена, не ошибка;
 * - превышение maxSegments → CONTINUE, REJECTED_BY_COMPLIANCE (SMS_TOO_LONG);
 * - ошибка рендера (RenderError) → FAIL узла — экземпляр останавливается;
 * - TemporaryProviderError провайдера → WAIT reason=RETRY с экспоненциальным
 *   backoff; после MAX_SEND_ATTEMPTS попыток — FAIL;
 * - постоянная ошибка провайдера (ok=false) → FAIL.
 */
const smsExecutor: NodeExecutor<SmsNode> = {
  async execute(node: SmsNode, input: ExecutorInput): Promise<NodeOutcome> {
    const client = await db.client.findUnique({ where: { id: input.clientId } });
    if (!client) {
      return { outcome: 'FAIL', error: 'Клиент не найден', message: 'Клиент не найден' };
    }
    const settings = await getSettings();
    const template = await db.smsTemplate.findFirst({ where: { id: node.templateId } });
    if (!template) {
      return { outcome: 'FAIL', error: 'Шаблон не найден', message: 'Шаблон не найден' };
    }
    if (!template.isActive) {
      // Шаблон деактивировали после старта воронки: узел пропускается (воронка живёт),
      // в лог — честная запись; иначе деактивация шаблона валила бы все живые воронки.
      await createSmsMessage({
        instanceId: input.instanceId,
        clientId: client.id,
        phone: client.phone,
        body: '',
        segments: 0,
        provider: settings.provider,
        templateId: template.id,
        templateName: template.name,
        status: 'CANCELLED',
        error: 'Шаблон деактивирован — отправка пропущена',
        varsSnapshot: snapshotVars(template.body, input.context.vars),
      });
      await input.logEvent('SMS_REJECTED', {
        nodeId: node.id,
        nodeType: node.type,
        message: 'Шаблон деактивирован — узел пропущен',
      });
      return {
        outcome: 'CONTINUE',
        nextNodeId: node.next,
        message: 'SMS пропущено: шаблон деактивирован',
      };
    }

    const pipeline = await runCompliancePipeline({ client, template, settings });

    // Снимок переменных сообщения (P6): контекст воронки (карточка + cf + payload)
    // на момент узла — один расчёт на все исходы ниже (комплаенс/рендер/отправка).
    const varsSnapshot = snapshotVars(template.body, input.context.vars);

    if (pipeline.decision === 'REJECT') {
      // Для записи в лог пытаемся отрендерить; при ошибке рендера пишем исходный текст шаблона.
      let bodyForLog = template.body;
      try {
        bodyForLog = renderTemplate(template.body, input.context.vars, { variantSeed: client.id }).text;
      } catch {
        bodyForLog = template.body;
      }
      const seg = countSegments(bodyForLog);
      await createSmsMessage({
        instanceId: input.instanceId,
        clientId: client.id,
        phone: client.phone,
        body: bodyForLog,
        segments: seg.segments,
        provider: settings.provider,
        templateId: template.id,
        templateName: template.name,
        status: 'REJECTED_BY_COMPLIANCE',
        rejectReason: pipeline.reason,
        varsSnapshot,
      });
      const human = REJECT_REASON_TEXT[pipeline.reason];
      await input.logEvent('SMS_REJECTED', {
        nodeId: node.id,
        nodeType: node.type,
        message: `Причина: ${human}`,
        payload: { reason: pipeline.reason },
      });
      // Отказ комплаенсом не останавливает воронку (кроме тихих часов — там перенос).
      return {
        outcome: 'CONTINUE',
        nextNodeId: node.next,
        message: `SMS отклонено комплаенсом: ${human}`,
      };
    }

    if (pipeline.decision === 'RESCHEDULE') {
      const localTime = formatInTimezone(pipeline.nextAllowedAt, client.timezone);
      return {
        outcome: 'WAIT',
        reason: 'QUIET_HOURS',
        runAt: pipeline.nextAllowedAt,
        resumeNodeId: node.id, // повторное выполнение узла: проверки идемпотентны
        message: `Перенос на ${localTime} (тихие часы)`,
      };
    }

    // ALLOW → рендер (движок с условиями/дефолтами/вариантами)
    let rendered: string;
    try {
      const renderResult = renderTemplate(template.body, input.context.vars, { variantSeed: client.id });
      if (renderResult.cancelled) {
        // {{#cancel}} или пустой результат — тихая отмена отправки (не ошибка, воронка продолжается)
        const why = renderResult.cancelReason === 'empty' ? 'пустой результат рендера' : '{{#cancel}}';
        await createSmsMessage({
          instanceId: input.instanceId,
          clientId: client.id,
          phone: client.phone,
          body: '',
          segments: 0,
          provider: settings.provider,
          templateId: template.id,
          templateName: template.name,
          status: 'CANCELLED',
          rejectReason: 'TEMPLATE_CANCEL',
          error: why === '{{#cancel}}' ? null : 'Пустой результат рендера',
          varsSnapshot,
        });
        await input.logEvent('SMS_REJECTED', {
          nodeId: node.id,
          nodeType: node.type,
          message: `Отправка отменена шаблоном (${why})`,
          payload: { reason: 'TEMPLATE_CANCEL' },
        });
        return {
          outcome: 'CONTINUE',
          nextNodeId: node.next,
          message: `SMS отменено шаблоном (${why})`,
        };
      }
      rendered = renderResult.text;
    } catch (e) {
      const message = e instanceof RenderError ? e.message : 'Неизвестная ошибка рендера';
      const seg = countSegments(template.body);
      await createSmsMessage({
        instanceId: input.instanceId,
        clientId: client.id,
        phone: client.phone,
        body: template.body,
        segments: seg.segments,
        provider: settings.provider,
        templateId: template.id,
        templateName: template.name,
        status: 'FAILED',
        rejectReason: 'RENDER_ERROR',
        error: message,
        varsSnapshot,
      });
      await input.logEvent('SMS_FAILED', {
        nodeId: node.id,
        nodeType: node.type,
        message: `Ошибка рендера шаблона: ${message}`,
      });
      return {
        outcome: 'FAIL',
        error: `Ошибка рендера шаблона: ${message}`,
        message: `Ошибка рендера шаблона: ${message}`,
      };
    }

    // Финальный текст: маркетинговым добавляем приписку (редактируемый текст
    // с {link}/{advertiser}) со ссылкой отписки — короткой или полной.
    const baseUrl = resolveUnsubscribeBaseUrl(input.context.baseUrl, settings);
    let finalBody = rendered;
    if (template.isMarketing) {
      finalBody = await buildMarketingSmsBody(rendered, settings, baseUrl, client.id);
    }
    const seg = countSegments(finalBody);

    // Лимит частей SMS (maxSegments шаблона; 0 = без лимита).
    // Превышение → сообщение не отправляется вообще,
    // но воронка продолжается (аналог отказа комплаенсом).
    if (template.maxSegments > 0 && seg.segments > template.maxSegments) {
      await createSmsMessage({
        instanceId: input.instanceId,
        clientId: client.id,
        phone: client.phone,
        body: finalBody,
        segments: seg.segments,
        provider: settings.provider,
        templateId: template.id,
        templateName: template.name,
        status: 'REJECTED_BY_COMPLIANCE',
        rejectReason: 'SMS_TOO_LONG',
        error: `Частей ${seg.segments} > лимита ${template.maxSegments}`,
        varsSnapshot,
      });
      await input.logEvent('SMS_REJECTED', {
        nodeId: node.id,
        nodeType: node.type,
        message: `Превышен лимит частей SMS: ${seg.segments} > ${template.maxSegments}`,
        payload: { reason: 'SMS_TOO_LONG', segments: seg.segments, maxSegments: template.maxSegments },
      });
      return {
        outcome: 'CONTINUE',
        nextNodeId: node.next,
        message: `SMS отклонено: превышен лимит частей (${seg.segments} > ${template.maxSegments})`,
      };
    }

    // Имя отправителя: узел воронки > шаблон > настройка по умолчанию.
    const senderName =
      node.senderName?.trim() || template.senderName?.trim() || settings.defaultSenderName?.trim() || null;
    const provider = getProvider(settings.provider);

    let result;
    try {
      result = await provider.send({
        phone: client.phone,
        body: finalBody,
        clientId: client.id,
        instanceId: input.instanceId,
        sender: senderName,
        // Стабильный контекст ретраев узла — идемпотентность SMS.Tech без дублей
        idempotencyScope: `funnel:${input.instanceId}:${node.id}`,
        tags: ['trigger', template.name].filter((t) => t && t.length > 0),
      });
    } catch (e) {
      if (e instanceof TemporaryProviderError) {
        if (input.attempts >= MAX_SEND_ATTEMPTS) {
          await createSmsMessage({
            instanceId: input.instanceId,
            clientId: client.id,
            phone: client.phone,
            body: finalBody,
            segments: seg.segments,
            provider: provider.name,
            templateId: template.id,
            templateName: template.name,
            status: 'FAILED',
            error: e.message,
            varsSnapshot,
          });
          await input.logEvent('SMS_FAILED', {
            nodeId: node.id,
            nodeType: node.type,
            message: `Превышено число попыток отправки: ${e.message}`,
          });
          return {
            outcome: 'FAIL',
            error: `Превышено число попыток отправки: ${e.message}`,
            message: `Превышено число попыток отправки: ${e.message}`,
          };
        }
        // Экспоненциальный backoff ретраев: 2^attempts минут (2, 4, 8, 16, 32), потолок 60.
        const delayMin = Math.min(2 ** input.attempts, 60);
        const runAt = new Date(Date.now() + delayMin * 60 * 1000);
        return {
          outcome: 'WAIT',
          reason: 'RETRY',
          runAt,
          resumeNodeId: node.id,
          attempts: input.attempts + 1,
          message: `Временная ошибка провайдера, повтор через ${delayMin} мин: ${e.message}`,
        };
      }
      throw e;
    }

    if (result.ok) {
      const now = new Date();
      const smsId = await createSmsMessage({
        instanceId: input.instanceId,
        clientId: client.id,
        phone: client.phone,
        body: finalBody,
        // Число сегментов по данным шлюза точнее локального расчёта (SMS.Tech)
        segments: result.segmentsCount ?? seg.segments,
        provider: provider.name,
        providerMessageId: result.providerMessageId ?? null,
        templateId: template.id,
        templateName: template.name,
        status: result.immediateDelivery ? 'DELIVERED' : 'SENT',
        sentAt: now,
        deliveredAt: result.immediateDelivery ? now : null,
        varsSnapshot,
      });
      // «Захват событий»: отправка (и мгновенная доставка песочницы) — в журнал
      await journalSendOutcome({
        smsId,
        clientId: client.id,
        phone: client.phone,
        provider: provider.name,
        providerMessageId: result.providerMessageId ?? null,
        immediateDelivery: result.immediateDelivery === true,
        templateName: template.name,
      });
      await input.logEvent('SMS_SENT', {
        nodeId: node.id,
        nodeType: node.type,
        message: 'SMS отправлено',
        payload: { providerMessageId: result.providerMessageId ?? null },
      });
      return { outcome: 'CONTINUE', nextNodeId: node.next, message: 'SMS отправлено' };
    }

    // Постоянная ошибка провайдера (4xx): ретрая нет — фиксируем провал.
    const errorText = result.error ?? 'Неизвестная ошибка провайдера';
    await createSmsMessage({
      instanceId: input.instanceId,
      clientId: client.id,
      phone: client.phone,
      body: finalBody,
      segments: seg.segments,
      provider: provider.name,
      templateId: template.id,
      templateName: template.name,
      status: 'FAILED',
      error: errorText,
      varsSnapshot,
    });
    await input.logEvent('SMS_FAILED', {
      nodeId: node.id,
      nodeType: node.type,
      message: `Ошибка провайдера: ${errorText}`,
    });
    return {
      outcome: 'FAIL',
      error: `Ошибка провайдера: ${errorText}`,
      message: `Ошибка провайдера: ${errorText}`,
    };
  },
};

// ---------- Delay-узел ----------

/**
 * Delay-узел: переводит воронку в WAITING через scheduled_jobs.
 * Ключевой нюанс: resumeNodeId = node.next — задача возобновляет СЛЕДУЮЩИЙ узел,
 * сама пауза при срабатывании уже «прожита» (узел delay повторно не исполняется).
 * Задержка без продолжения (next=null) мгновенно завершает воронку.
 * Режимы (DelayMode): relative — часы+минуты от текущего момента;
 * until_time / until_date / until_birthday — абсолютное стеновое время в TZ
 * клиента (TZ читается свежей из БД, не из снапшота контекста); прошедшая дата
 * или отсутствующий/некорректный ДР — пауза пропускается (CONTINUE).
 */
const delayExecutor: NodeExecutor<DelayNode> = {
  async execute(node: DelayNode, input: ExecutorInput): Promise<NodeOutcome> {
    if (node.next === null) {
      // задержка перед завершением бессмысленна — завершаем сразу
      return { outcome: 'CONTINUE', nextNodeId: null, message: 'Задержка без продолжения — завершение' };
    }
    const now = new Date();
    // Часовой пояс — всегда свежий из БД (карточка могла обновиться за время ожидания;
    // смешение снапшота/БД между режимами давало бы разные пояса в одной воронке).
    const clientRow = await db.client.findUnique({
      where: { id: input.clientId },
      select: { timezone: true },
    });
    const tz = clientRow?.timezone ?? input.context.client.timezone;

    // Абсолютные паузы — в местном стеночном времени КЛИЕНТА.
    if (node.mode === 'until_time') {
      const runAt = nextWallClockOccurrence(now, tz, node.atHour ?? 9, node.atMinute ?? 0, null);
      return {
        outcome: 'WAIT',
        reason: 'NODE_DELAY',
        runAt,
        resumeNodeId: node.next,
        message: `Пауза до ${formatInTimezone(runAt, tz)} (местное время клиента)`,
      };
    }
    if (node.mode === 'until_date') {
      const m = /^\d{4}-\d{2}-\d{2}$/.exec(node.atDate ?? '');
      if (!m) {
        return {
          outcome: 'FAIL',
          error: `Узел ${node.id}: некорректная дата паузы «${node.atDate ?? ''}» (ожидается ГГГГ-ММ-ДД)`,
          message: 'Некорректная дата паузы',
        };
      }
      const runAt = zonedTimeToUtc(
        Number.parseInt(m[1], 10),
        Number.parseInt(m[2], 10),
        Number.parseInt(m[3], 10),
        node.atHour ?? 9,
        node.atMinute ?? 0,
        tz,
      );
      if (runAt.getTime() <= now.getTime()) {
        return {
          outcome: 'CONTINUE',
          nextNodeId: node.next,
          message: 'Дата паузы уже прошла — продолжение сразу',
        };
      }
      return {
        outcome: 'WAIT',
        reason: 'NODE_DELAY',
        runAt,
        resumeNodeId: node.next,
        message: `Пауза до ${formatInTimezone(runAt, tz)} (местное время клиента)`,
      };
    }
    if (node.mode === 'until_birthday') {
      // День рождения — из строки БД (не из контекста: там отформатированная строка).
      const client = await db.client.findUnique({ where: { id: input.clientId }, select: { birthday: true, timezone: true } });
      if (!client || client.birthday === null) {
        return {
          outcome: 'CONTINUE',
          nextNodeId: node.next,
          message: 'У клиента нет даты рождения — пауза до ДР пропущена',
        };
      }
      const runAt = nextBirthdayWall(
        now,
        { month: client.birthday.getUTCMonth() + 1, day: client.birthday.getUTCDate() },
        client.timezone,
        node.atHour ?? 9,
        node.atMinute ?? 0,
      );
      if (runAt === null) {
        return {
          outcome: 'CONTINUE',
          nextNodeId: node.next,
          message: 'Некорректная дата рождения — пауза до ДР пропущена',
        };
      }
      return {
        outcome: 'WAIT',
        reason: 'NODE_DELAY',
        runAt,
        resumeNodeId: node.next,
        message: `Пауза до дня рождения — ${formatInTimezone(runAt, client.timezone)} (местное время клиента)`,
      };
    }

    // Обычная относительная пауза. Локальное время в подписи — по СВЕЖЕЙ зоне
    // клиента из БД (tz выше): прочие режимы delay уже так делают; снапшот
    // контекста мог устареть (карточка обновлена за время жизни воронки).
    const runAt = new Date(Date.now() + node.hours * 3600_000 + node.minutes * 60_000);
    const localTime = formatInTimezone(runAt, tz);
    return {
      outcome: 'WAIT',
      reason: 'NODE_DELAY',
      runAt,
      resumeNodeId: node.next, // задача возобновляет воронку со СЛЕДУЮЩЕГО узла
      message: `Задержка до ${localTime}`,
    };
  },
};

// ---------- WaitEvent-узел (П5) ----------

/**
 * waitEvent-узел: вписывает в контекст экземпляра маркер ожидания
 * {event, nodeId} и возвращает WAIT reason=WAIT_EVENT с таймаут-задачей.
 * Дальше решает воркер: событие пришло — wakeWaitingInstances (ветка onEvent,
 * таймаут-задача отменяется); таймаут истёк — processDueJobs (ветка onTimeout).
 */
const waitEventExecutor: NodeExecutor<WaitEventNode> = {
  async execute(node: WaitEventNode, input: ExecutorInput): Promise<NodeOutcome> {
    const timeoutMs = node.timeoutHours * 3600_000 + (node.timeoutMinutes ?? 0) * 60_000;
    const runAt = new Date(Date.now() + timeoutMs);
    // Маркер ожидания — в контекст экземпляра: воркер ищет его при обработке событий.
    const ctx = { ...input.context, waitEvent: { event: node.event, nodeId: node.id } };
    await db.workflowInstance.update({
      where: { id: input.instanceId },
      data: { context: JSON.stringify(ctx) },
    });
    const localTime = formatInTimezone(runAt, input.context.client.timezone);
    return {
      outcome: 'WAIT',
      reason: 'WAIT_EVENT',
      runAt,
      // nodeId задачи = id waitEvent-узла: при таймауте воркер возьмёт ветку onTimeout
      resumeNodeId: node.id,
      message: `Ожидание события ${node.event} до ${localTime} (таймаут)`,
    };
  },
};

// ---------- Condition-узел ----------

/**
 * Condition-узел: выражение → boolean (безопасный парсер expression.ts),
 * ветка onTrue/onFalse; null в ветке = завершение воронки.
 * Синтаксическая ошибка выражения невозможна на сохранённой через API воронке
 * (validate.ts проверяет при сохранении); битое определение, правленное мимо
 * API, бросит ExpressionError → движок пометит экземпляр FAILED.
 */
const conditionExecutor: NodeExecutor<ConditionNode> = {
  async execute(node: ConditionNode, input: ExecutorInput): Promise<NodeOutcome> {
    const value = evaluateExpression(
      node.expression,
      buildEvalContext({
        client: input.context.client as unknown as Record<string, unknown>,
        payload: input.context.payload,
        event: input.context.event,
        vars: input.context.vars,
      }),
    );
    const target = value ? node.onTrue : node.onFalse;
    return {
      outcome: 'CONTINUE',
      nextNodeId: target,
      message: `Условие: ${value ? 'true' : 'false'} → ${target ?? 'завершение'}`,
    };
  },
};

/** Реестр исполнителей по типу узла. */
export const nodeExecutors: {
  sms: NodeExecutor<SmsNode>;
  delay: NodeExecutor<DelayNode>;
  condition: NodeExecutor<ConditionNode>;
  waitEvent: NodeExecutor<WaitEventNode>;
} = {
  sms: smsExecutor,
  delay: delayExecutor,
  condition: conditionExecutor,
  waitEvent: waitEventExecutor,
};

/**
 * Исполнитель по типу узла; null для неизвестного типа (движок пометит
 * экземпляр FAILED «Неизвестный тип узла»). Полный switch без default —
 * компилятор проверяет исчерпание NodeType.
 */
export function getExecutor(node: FunnelNode): NodeExecutor | null {
  switch (node.type) {
    case 'sms':
      return nodeExecutors.sms;
    case 'delay':
      return nodeExecutors.delay;
    case 'condition':
      return nodeExecutors.condition;
    case 'waitEvent':
      return nodeExecutors.waitEvent;
  }
}
