// Валидация графа воронки при сохранении (422 со списком всех ошибок).
// Узел waitEvent (обязательные ветки onEvent/onTimeout, валидный тип события,
// таймаут > 0) и абсолютные паузы delay-узла (until_time/until_date/until_birthday).
import type { FunnelDefinition, FunnelNode } from '@/lib/engine/types';
import { TRIGGER_EVENTS } from '@/lib/engine/types';
import { validateExpression } from '@/lib/engine/expression';

/** Потолок относительной задержки ОДНОГО delay-узла — 30 суток. */
export const MAX_DELAY_TOTAL_SEC = 30 * 24 * 60 * 60; // максимум суммарной задержки

/**
 * Все исходящие ссылки узла (next / onTrue / onFalse / onEvent / onTimeout,
 * без null-значений) — используется обходом достижимости и обеими проверками
 * циклов. null-ссылка — легальный конец пути, не ошибка структуры.
 */
export function successorsOf(node: FunnelNode): string[] {
  switch (node.type) {
    case 'sms':
      return node.next ? [node.next] : [];
    case 'delay':
      return node.next ? [node.next] : [];
    case 'condition':
      return [node.onTrue, node.onFalse].filter((v): v is string => v !== null);
    case 'waitEvent':
      return [node.onEvent, node.onTimeout].filter((v): v is string => v !== null);
  }
}

/**
 * Гарантирует ли delay-узел реальную паузу в рантайме:
 *  - relative — да (задержка > 0, проверяется правилами ниже);
 *  - until_time — да (nextWallClockOccurrence всегда в будущем);
 *  - until_date — НЕТ: прошедшая дата — мгновенный пропуск (CONTINUE) —
 *    корректная при сохранении дата «протухает», пока воронка активна;
 *  - until_birthday — НЕТ: у клиента без ДР пауза пропускается мгновенно.
 * Цикл, «защищённый» только такими delay, в рантайме превращается в
 * бесконечный цикл мгновенных узлов — валидатор обязан его отклонять.
 */
function delayGuaranteesWait(node: FunnelNode): boolean {
  if (node.type !== 'delay') return false;
  return node.mode === undefined || node.mode === 'relative' || node.mode === 'until_time';
}

/**
 * Структурная валидация определения (синхронная, без БД).
 * Возвращает список ошибок (пустой = валидно).
 * Полный перечень проверок (все ошибки собираются разом, не «первая»):
 * - непустой список узлов и уникальность id;
 * - start_node существует; все ссылки ведут на существующие узлы либо null;
 * - правила по типам: sms.templateId непуст; delay — диапазоны часов/дат/
 *   положительность и потолок 30 суток (relative); condition — выражение
 *   проходит validateExpression; waitEvent — валидный тип события,
 *   таймаут > 0 и хотя бы одна ветка;
 * - достижимость каждого узла от start_node (BFS);
 * - каждый цикл обязан проходить через delay/waitEvent (иначе бесконечный
 *   цикл мгновенных узлов заморозит воркер);
 * - запрет циклов ТОЛЬКО из delay/waitEvent-узлов (вечная воронка).
 * Вызывается сервисом воронок при сохранении/активации — ошибки → 422.
 */
export function validateFunnelGraph(def: FunnelDefinition): string[] {
  const errors: string[] = [];
  const nodes = def.nodes ?? [];
  if (nodes.length === 0) {
    return ['Воронка должна содержать хотя бы один узел'];
  }

  // Уникальные id узлов
  const byId = new Map<string, FunnelNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      errors.push(`Дублирующийся id узла: ${node.id}`);
    } else {
      byId.set(node.id, node);
    }
  }

  // start_node существует
  if (!def.start_node || !byId.has(def.start_node)) {
    errors.push(`Стартовый узел не найден: ${def.start_node}`);
  }

  // Ссылки next/onTrue/onFalse/onEvent/onTimeout — null или существующий id
  for (const node of nodes) {
    const refs: Array<[string, string | null]> =
      node.type === 'condition'
        ? [
            ['onTrue', node.onTrue],
            ['onFalse', node.onFalse],
          ]
        : node.type === 'waitEvent'
          ? [
              ['onEvent', node.onEvent],
              ['onTimeout', node.onTimeout],
            ]
          : [['next', node.next]];
    for (const [field, ref] of refs) {
      if (ref !== null && !byId.has(ref)) {
        errors.push(`Узел ${node.id}: поле ${field} ссылается на несуществующий узел ${ref}`);
      }
    }
  }

  // Правила по типам узлов
  for (const node of nodes) {
    if (node.type === 'sms') {
      if (!node.templateId || node.templateId.trim() === '') {
        errors.push(`Узел ${node.id} (sms): не указан templateId`);
      }
    } else if (node.type === 'delay') {
      if (node.mode === 'until_time') {
        if ((node.atHour ?? 0) < 0 || (node.atHour ?? 0) > 23) {
          errors.push(`Узел ${node.id} (delay): час должен быть 0–23`);
        }
      } else if (node.mode === 'until_date') {
        if (!node.atDate || !/^\d{4}-\d{2}-\d{2}$/.test(node.atDate) || Number.isNaN(Date.parse(node.atDate))) {
          errors.push(`Узел ${node.id} (delay): дата должна быть в формате ГГГГ-ММ-ДД`);
        }
      } else if (node.mode === 'until_birthday') {
        // время не обязательно (по умолчанию 9:00); ничего не проверяем
      } else {
        const totalSec = (node.hours || 0) * 3600 + (node.minutes || 0) * 60;
        if (totalSec <= 0) {
          errors.push(`Узел ${node.id} (delay): задержка должна быть больше нуля`);
        } else if (totalSec > MAX_DELAY_TOTAL_SEC) {
          errors.push(`Узел ${node.id} (delay): задержка превышает 30 суток`);
        }
      }
    } else if (node.type === 'condition') {
      if (!node.expression || node.expression.trim() === '') {
        errors.push(`Узел ${node.id} (condition): пустое выражение`);
      } else {
        try {
          validateExpression(node.expression);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          errors.push(`Узел ${node.id} (condition): ${message}`);
        }
      }
    } else if (node.type === 'waitEvent') {
      if (!node.event || !(TRIGGER_EVENTS as readonly string[]).includes(node.event)) {
        errors.push(`Узел ${node.id} (waitEvent): неизвестный тип события «${node.event ?? ''}»`);
      }
      const totalMin = (node.timeoutHours || 0) * 60 + (node.timeoutMinutes || 0);
      if (totalMin <= 0) {
        errors.push(`Узел ${node.id} (waitEvent): таймаут должен быть больше нуля`);
      }
      if (node.onEvent === null && node.onTimeout === null) {
        errors.push(`Узел ${node.id} (waitEvent): обе ветки не заданы — узел бессмыслен`);
      }
    }
  }

  // Достижимость от start_node (BFS по successorsOf) — иначе мёртвые узлы
  // молча копятся в определении и путают редактор.
  if (def.start_node && byId.has(def.start_node)) {
    const reachable = new Set<string>();
    const queue = [def.start_node];
    while (queue.length > 0) {
      const id = queue.pop() as string;
      if (reachable.has(id)) continue;
      reachable.add(id);
      const node = byId.get(id);
      if (node) {
        for (const succ of successorsOf(node)) {
          if (!reachable.has(succ)) queue.push(succ);
        }
      }
    }
    for (const node of nodes) {
      if (!reachable.has(node.id)) {
        errors.push(`Узел ${node.id} недостижим от стартового узла`);
      }
    }
  }

  // Циклы обязаны содержать узел ГАРАТИРОВАННОГО ожидания: для каждого
  // «мгновенного» узла ищем путь обратно к нему через только мгновенные узлы.
  // waitEvent ждёт всегда (таймаут > 0 по правилам); delay — только в режимах
  // relative/until_time (см. delayGuaranteesWait): until_date/until_birthday
  // могут исполниться мгновенно — путь через них НЕ считается паузой.
  for (const node of nodes) {
    if (node.type === 'delay' || node.type === 'waitEvent') continue;
    const visited = new Set<string>([node.id]);
    const queue = [...successorsOf(node)];
    let cyclicWithoutWait = false;
    while (queue.length > 0) {
      const id = queue.pop() as string;
      if (id === node.id) {
        cyclicWithoutWait = true;
        break;
      }
      if (visited.has(id)) continue;
      visited.add(id);
      const succ = byId.get(id);
      if (!succ) continue;
      if (succ.type === 'waitEvent') continue; // ожидание гарантировано
      if (succ.type === 'delay' && delayGuaranteesWait(succ)) continue; // пауза гарантирована
      queue.push(...successorsOf(succ)); // мгновенный/«протухающий» узел — идём дальше
    }
    if (cyclicWithoutWait) {
      errors.push(
        `Цикл через узел ${node.id} не содержит гарантированного ожидания (delay до даты/ДР может быть пропущен мгновенно — используйте относительную задержку или «до времени»)`,
      );
    }
  }

  // Цикл ТОЛЬКО из узлов ожидания (delay→сам-себя, кольцо waitEvent↔delay) —
  // вечная воронка: между узлами нет мгновенного шага, тик-движок никогда не
  // завершит экземпляр. Ищем цикл в подграфе wait-узлов (DFS с серыми вершинами).
  const WAIT_COLORS = new Map<string, 1 | 2>(); // 1 = в стеке (серая), 2 = закрыта (чёрная)
  const visitWait = (id: string): boolean => {
    const color = WAIT_COLORS.get(id);
    if (color === 1) return true; // back-edge — цикл из wait-узлов
    if (color === 2) return false;
    const node = byId.get(id);
    if (!node || (node.type !== 'delay' && node.type !== 'waitEvent')) return false;
    WAIT_COLORS.set(id, 1);
    for (const succ of successorsOf(node)) {
      if (visitWait(succ)) return true;
    }
    WAIT_COLORS.set(id, 2);
    return false;
  };
  for (const node of nodes) {
    if (node.type !== 'delay' && node.type !== 'waitEvent') continue;
    if (visitWait(node.id)) {
      errors.push(`Цикл только из delay/waitEvent-узлов (через ${node.id}) — воронка никогда не завершится`);
      break;
    }
  }

  return errors;
}

/** Нормализация hours/minutes delay-узла (undefined → 0). */
export function normalizeDelayNode(node: { hours?: number; minutes?: number }): { hours: number; minutes: number } {
  return { hours: node.hours ?? 0, minutes: node.minutes ?? 0 };
}
