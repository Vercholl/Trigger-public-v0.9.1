// Движок воронок: создание экземпляра по событию и цикл исполнения узлов.
// Инварианты: currentNodeId сохраняется ДО исполнения узла; после каждого узла
// состояние экземпляра персистится; задержки существуют ТОЛЬКО как scheduled_jobs.
//
// Связи: вызывается только из воркера (scheduler/worker.ts) — startInstance при
// обработке новых событий events_inbox, continueInstance при пробуждении задач;
// исполнители узлов — executors.ts, структура узлов/контракты — types.ts.
// Модель статусов экземпляра: RUNNING (исполняется) → COMPLETED / FAILED (терминальные)
// либо WAITING (пауза; ВСЕГДА подкреплена PENDING-задачей в scheduled_jobs, которая
// вернёт экземпляр в RUNNING); CANCELLED ставит воркер (режим REPLACE) или отмена вручную.
import type { Client, EventsInbox, Funnel, WorkflowInstance } from '@prisma/client';
import { db } from '@/lib/db';
import { getExecutor } from '@/lib/engine/executors';
import { cardVarsFromClient } from '@/lib/services/client-card';
import { cfVarsForClient } from '@/lib/services/custom-fields';
import type {
  FunnelDefinition,
  InstanceContext,
  InstanceEventType,
  LogEventOptions,
} from '@/lib/engine/types';

/**
 * JSON-строка → объект-словарь. null/массив/битый JSON → {} — повреждённый
 * payload события или client.data не должен валить обработку воркером.
 */
function parseJsonSafe(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Запись в таймлайн экземпляра (STATUS_CHANGE / NODE_* / SMS_* / ERROR / INFO).
 * Никогда не бросает (fail-soft): сбой лога не должен рушить исполнение воронки.
 */
export async function logInstanceEvent(
  instanceId: string,
  type: InstanceEventType | string,
  opts?: LogEventOptions,
): Promise<void> {
  try {
    await db.instanceEvent.create({
      data: {
        instanceId,
        type,
        nodeId: opts?.nodeId ?? null,
        nodeType: opts?.nodeType ?? null,
        message: opts?.message ?? null,
        payload: opts?.payload ? JSON.stringify(opts.payload) : null,
      },
    });
  } catch (e) {
    console.error('[engine] logInstanceEvent failed:', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Смена статуса экземпляра + обязательная зеркальная запись STATUS_CHANGE
 * в таймлайн. Вызывается движком на каждом значимом переходе (RUNNING→WAITING,
 * →COMPLETED, →FAILED). error пишется в поле WorkflowInstance.error для UI.
 */
async function setInstanceStatus(
  instanceId: string,
  status: string,
  extra: { error?: string | null } = {},
): Promise<void> {
  await db.workflowInstance.update({
    where: { id: instanceId },
    data: { status, error: extra.error ?? null },
  });
  await logInstanceEvent(instanceId, 'STATUS_CHANGE', { message: status });
}

/**
 * Создание экземпляра воронки по событию из events_inbox и запуск исполнения.
 *
 * Протокол:
 * - принимает воронку, клиента и событие инбокса; строит снапшот-контекст
 *   InstanceContext (event/payload/client/vars); приоритет переменных vars:
 *   кастомные поля профиля (cf_*) > payload события > client.data >
 *   типизированная карточка (cardVars);
 * - создаёт WorkflowInstance со статусом RUNNING и idempotencyKey события —
 *   по этому ключу воркер распознаёт повторную обработку (защита от дублей);
 *   funnelVersion/funnelName фиксируются снапшотом на момент запуска;
 * - определение воронки парсится заново (живой JSON): при ошибке парсинга
 *   экземпляр сразу FAILED («Некорректное определение воронки»), ошибки наружу
 *   не бросаются — возвращается экземпляр с итоговым статусом;
 * - далее синхронно запускается continueInstance от start_node; исключения
 *   исполнения ловятся внутри него (статус FAILED + ERROR в таймлайн).
 */
export async function startInstance(
  funnel: Funnel,
  client: Client,
  inboxEvent: EventsInbox,
): Promise<WorkflowInstance> {
  const payload = parseJsonSafe(inboxEvent.payload);
  const clientData = parseJsonSafe(client.data);
  // Карточка клиента (типизированные поля карточки) участвует в переменных шаблонов
  // и в условии-выражениях; client.data и payload остаются приоритетнее (в этом порядке).
  // Кастомные поля (cf_*) — ПОСЛЕ payload: воркер уже применил их к профилю
  // до запуска воронки, профиль — источник истины (формат даты — дд.мм.гггг,
  // как у полей карточки; перекрывает ISO-сырьё из payload события).
  const cardVars = cardVarsFromClient(client);
  const cfVars = await cfVarsForClient(client.id);
  const context: InstanceContext = {
    event: inboxEvent.event,
    payload,
    client: {
      externalId: client.externalId,
      phone: client.phone,
      timezone: client.timezone,
      data: clientData,
      ...cardVars,
      ...cfVars,
    },
    vars: { ...cardVars, ...clientData, ...payload, ...cfVars },
    baseUrl: inboxEvent.baseUrl ?? undefined,
  };

  const instance = await db.workflowInstance.create({
    data: {
      funnelId: funnel.id,
      funnelVersion: funnel.version,
      funnelName: funnel.name, // снапшот на момент запуска
      clientId: client.id,
      status: 'RUNNING',
      currentNodeId: null,
      context: JSON.stringify(context),
      eventId: inboxEvent.id,
      idempotencyKey: inboxEvent.idempotencyKey,
    },
  });
  await logInstanceEvent(instance.id, 'STATUS_CHANGE', { message: 'RUNNING' });

  let definition: FunnelDefinition;
  try {
    definition = JSON.parse(funnel.definition) as FunnelDefinition;
  } catch {
    await setInstanceStatus(instance.id, 'FAILED', { error: 'Некорректное определение воронки' });
    await logInstanceEvent(instance.id, 'ERROR', { message: 'Некорректное определение воронки' });
    return instance;
  }

  await continueInstance(instance, definition.start_node);
  return instance;
}

/** Потолок мгновенных узлов одного вызова continueInstance. Легитимная
 * воронка — десятки узлов; 200 — с многократным запасом. Превышение = цикл
 * без ожидания (валидатор требует delay/waitEvent в циклах, но у delay есть
 * режимы until_date/until_birthday, которые МОГУТ исполниться мгновенно —
 * прошедшая дата/отсутствующий ДР — и «протухнуть» в бесконечный цикл уже
 * после сохранения воронки). Без потолка такой цикл исполнялся бы вечно
 * внутри одного тика: мьютекс воркера (state.ticking) никогда не снялся бы —
 * события, рассылки и снапшоты БД остановились бы целиком. */
const MAX_NODES_PER_RUN = 200;

/**
 * Основной цикл: исполняет узлы от fromNodeId до завершения/ожидания/ошибки.
 * Состояние (currentNodeId) сохраняется до и после каждого узла.
 *
 * Шаг цикла (повторяется, пока currentId ≠ null):
 *  1. currentNodeId персистится ДО исполнения узла — после краша видно, где
 *     остановились (и «пожиратель зомби» воркера отличит зависание от паузы);
 *  2. узел берётся из карты узлов по id; исполнитель — по типу узла (getExecutor);
 *     «узел не найден»/«неизвестный тип» → FAILED + ERROR в таймлайн;
 *  3. NODE_START/NODE_DONE пишутся в таймлайн вокруг каждого узла;
 *  4. NodeOutcome исполнителя:
 *     CONTINUE — nextNodeId=null означает конец пути → COMPLETED; иначе переход
 *     к следующему узлу (условия ветвятся через onTrue/onFalse — это делает их
 *     исполнитель, движок видит только итоговый nextNodeId);
 *     WAIT — создаётся PENDING-задача scheduled_jobs {resumeNodeId, reason,
 *     runAt, attempts} и экземпляр уходит в WAITING; цикл прерывается —
 *     продолжит воркер, когда задача станет due (см. processDueJobs воркера);
 *     FAIL — статус FAILED + error + ERROR в таймлайн (терминально).
 *
 * Неожиданное исключение (БД, битый контекст) ловится обёрткой try/catch:
 *     экземпляр переводится в FAILED — иначе он навсегда остался бы RUNNING
 *     без задач и блокировал бы повторный вход SKIP_ACTIVE.
 */
export async function continueInstance(
  instance: WorkflowInstance,
  fromNodeId: string,
  opts: { attempts?: number } = {},
): Promise<void> {
  const funnel = await db.funnel.findUnique({ where: { id: instance.funnelId } });
  if (!funnel) {
    await setInstanceStatus(instance.id, 'FAILED', { error: 'Воронка не найдена' });
    await logInstanceEvent(instance.id, 'ERROR', { message: 'Воронка не найдена' });
    return;
  }

  let definition: FunnelDefinition;
  try {
    definition = JSON.parse(funnel.definition) as FunnelDefinition;
  } catch {
    await setInstanceStatus(instance.id, 'FAILED', { error: 'Некорректное определение воронки' });
    await logInstanceEvent(instance.id, 'ERROR', { message: 'Некорректное определение воронки' });
    return;
  }

  let context: InstanceContext;
  try {
    context = JSON.parse(instance.context) as InstanceContext;
  } catch {
    await setInstanceStatus(instance.id, 'FAILED', { error: 'Некорректный контекст экземпляра' });
    await logInstanceEvent(instance.id, 'ERROR', { message: 'Некорректный контекст экземпляра' });
    return;
  }
  // Карта узлов по id — переходы без линейного поиска по определению.
  const nodeMap = new Map(definition.nodes.map((n) => [n.id, n]));
  let attempts = opts.attempts ?? 0;
  let currentId: string | null = fromNodeId;
  let executedNodes = 0;
  const logEvent = (type: InstanceEventType | string, eventOpts?: LogEventOptions) =>
    logInstanceEvent(instance.id, type, eventOpts);

  try {
    while (currentId !== null) {
      // Страховка от бесконечного цикла мгновенных узлов — см. MAX_NODES_PER_RUN.
      executedNodes += 1;
      if (executedNodes > MAX_NODES_PER_RUN) {
        await setInstanceStatus(instance.id, 'FAILED', {
          error: `Превышен лимит узлов (${MAX_NODES_PER_RUN}) за один прогон — подозрение на цикл без ожидания`,
        });
        await logInstanceEvent(instance.id, 'ERROR', {
          nodeId: currentId,
          message: `Превышен лимит узлов (${MAX_NODES_PER_RUN}) — цикл без ожидания (delay с прошедшей датой/без ДР?)`,
        });
        return;
      }

      // Гард «отмены между узлами»: HTTP-отмена (роут /instances/{id}/cancel) и
      // отмена режимом REPLACE работают ПАРАЛЛЕЛЬНО тику воркера — экземпляр может
      // стать CANCELLED, пока цепочка исполняется (между await-точками цикла).
      // Проверка на каждом шаге останавливает исполнение ДО следующего узла:
      // без неё отменённая воронка продолжала бы исполнять оставшиеся узлы
      // (включая отправку SMS) до ближайшей паузы; гард у исхода WAIT ниже
      // ловит только остановки «в створе» одного узла.
      const st = await db.workflowInstance
        .findUnique({ where: { id: instance.id }, select: { status: true } })
        .catch(() => null);
      if (st && st.status === 'CANCELLED') {
        await logInstanceEvent(instance.id, 'INFO', { message: 'Исполнение остановлено: экземпляр отменён' });
        return;
      }

      // Персистим currentNodeId ДО исполнения узла (устойчивость к рестарту).
      await db.workflowInstance.update({
        where: { id: instance.id },
        data: { currentNodeId: currentId },
      });

      const node = nodeMap.get(currentId);
      if (!node) {
        await setInstanceStatus(instance.id, 'FAILED', { error: `Узел не найден: ${currentId}` });
        await logInstanceEvent(instance.id, 'ERROR', {
          nodeId: currentId,
          message: `Узел не найден: ${currentId}`,
        });
        return;
      }

      await logEvent('NODE_START', { nodeId: node.id, nodeType: node.type, message: node.name ?? null });

      const executor = getExecutor(node);
      if (!executor) {
        await setInstanceStatus(instance.id, 'FAILED', { error: `Неизвестный тип узла: ${node.type}` });
        await logInstanceEvent(instance.id, 'ERROR', {
          nodeId: node.id,
          nodeType: node.type,
          message: `Неизвестный тип узла: ${node.type}`,
        });
        return;
      }

      const result = await executor.execute(node, {
        instanceId: instance.id,
        clientId: instance.clientId,
        context,
        attempts,
        logEvent,
      });

      await logEvent('NODE_DONE', {
        nodeId: node.id,
        nodeType: node.type,
        message: result.message ?? null,
      });

      if (result.outcome === 'CONTINUE') {
        if (result.nextNodeId === null) {
          await setInstanceStatus(instance.id, 'COMPLETED');
          return;
        }
        currentId = result.nextNodeId;
      } else if (result.outcome === 'WAIT') {
        // Гард «отмены в створе»: HTTP-отмена (роут /instances/{id}/cancel,
        // отписка клиента) работает ПАРАЛЛЕЛЬНО тику воркера и может перевести
        // экземпляр в CANCELLED, пока узел исполняется (send провайдера до 10 с).
        // Без проверки движок перезаписал бы CANCELLED → WAITING и создал задачу —
        // отменённая воронка «воскресла» бы и продолжила слать SMS.
        const currentStatus = await db.workflowInstance
          .findUnique({ where: { id: instance.id }, select: { status: true } })
          .catch(() => null);
        if (currentStatus && currentStatus.status === 'CANCELLED') return;
        // Единственный механизм задержек — scheduled_jobs (переживает рестарт).
        await db.scheduledJob.create({
          data: {
            instanceId: instance.id,
            nodeId: result.resumeNodeId,
            reason: result.reason,
            runAt: result.runAt,
            status: 'PENDING',
            attempts: result.attempts ?? 0,
          },
        });
        await setInstanceStatus(instance.id, 'WAITING');
        return;
      } else {
        await setInstanceStatus(instance.id, 'FAILED', { error: result.error });
        await logInstanceEvent(instance.id, 'ERROR', {
          nodeId: node.id,
          nodeType: node.type,
          message: result.error,
        });
        return;
      }
    }
  } catch (e) {
    // Любое неожиданное исключение (БД, битый контекст) — экземпляр не должен
    // навсегда оставаться RUNNING без задач (блокирует повторный вход SKIP_ACTIVE).
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[engine] instance ${instance.id} crashed: ${message}`);
    await setInstanceStatus(instance.id, 'FAILED', { error: `Необработанная ошибка: ${message}` }).catch(
      () => undefined,
    );
    await logInstanceEvent(instance.id, 'ERROR', {
      nodeId: currentId ?? undefined,
      message: `Необработанная ошибка: ${message}`,
    }).catch(() => undefined);
  }
}
