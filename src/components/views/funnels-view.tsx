'use client';

// Экран «Воронки» (триггерные цепочки): список воронок + конструктор шагов
// (SMS / пауза / ждать событие / условие с ветвлением). Определение хранится как граф
// FunnelDefinition (start_node + nodes со ссылками next/onTrue/onFalse/onEvent/onTimeout),
// редактор же работает с плоским списком шагов (DraftStep) и goto-номерами.
// Домен: триггерный маркетинг — событие от системы данных запускает активную воронку
// (исполнение: src/lib/engine + воркер src/lib/worker; валидация графа — services/funnels).
// API: GET/POST /api/v1/funnels, PUT/DELETE /api/v1/funnels/{id},
// POST /api/v1/funnels/{id}/activate | /deactivate; шаблоны для SMS-шагов — GET /api/v1/templates.
// Экран открывают все роли; мутации обёрнуты в ViewerGuard (VIEWER — только просмотр).

import * as React from 'react';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  GitFork,
  Hourglass,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api-client';
import { humanDuration } from '@/lib/sms-utils';
import {
  invalidatePanel,
  EmptyState,
  ENTRY_MODE_META,
  ErrorState,
  EventBadge,
  EVENT_META,
  fmtDT,
  useRole,
  ViewerGuard,
  type EntryMode,
  type EventType,
  type FunnelDefinition,
  type FunnelItem,
  type Paged,
  type TemplateItem,
} from '@/components/views/shared';

/** Типы узлов для UI: подпись + иконка (шапка карточки шага и превью в списке). */
const STEP_TYPE_META: Record<string, { label: string; icon: typeof MessageSquare }> = {
  sms: { label: 'SMS', icon: MessageSquare },
  delay: { label: 'Пауза', icon: Clock },
  condition: { label: 'Условие', icon: GitFork },
  waitEvent: { label: 'Ждать событие', icon: Hourglass },
};

/** Режимы паузы delay-узла: относительная (N часов) или абсолютные (до времени/даты/дня рождения). */
const DELAY_MODE_META: Array<{ value: 'relative' | 'until_time' | 'until_date' | 'until_birthday'; label: string }> = [
  { value: 'relative', label: 'Через N часов' },
  { value: 'until_time', label: 'До времени суток' },
  { value: 'until_date', label: 'До даты' },
  { value: 'until_birthday', label: 'До дня рождения' },
];

/** Полный список узлов воронки (для компактного предпросмотра шагов).
 *  Показываем ВСЕ узлы — без усечения и приписки «+N»: бейджи переносятся
 *  на следующую строку, если не влезают (требование владельца). */
function allNodes(def: FunnelDefinition | null | undefined): FunnelDefinition['nodes'] {
  if (!def || !Array.isArray(def.nodes)) return [];
  return def.nodes;
}

/** Компактное превью воронки в таблице: иконка на каждый узел (title = тип шага). */
function StepsPreview({ def }: { def: FunnelDefinition }) {
  const nodes = allNodes(def);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {nodes.map((n, i) => {
        const meta = STEP_TYPE_META[n.type];
        if (!meta) return null;
        const Icon = meta.icon;
        return (
          <span key={`${n.id}-${i}`} title={meta.label} className="inline-flex items-center">
            <Badge
              variant="outline"
              className="gap-1 border-border bg-muted px-1.5 text-zinc-600 dark:text-zinc-400"
            >
              <Icon className="size-3" aria-hidden />
            </Badge>
          </span>
        );
      })}
      {nodes.length === 0 ? <span className="text-xs text-zinc-400">—</span> : null}
    </div>
  );
}

/* ============================ Конструктор ============================ */

type StepType = 'sms' | 'delay' | 'condition' | 'waitEvent';
type DelayModeDraft = 'relative' | 'until_time' | 'until_date' | 'until_birthday';

/** Черновик шага редактора: все значения — строки/примитивы (простые инпуты).
 *  В узел FunnelDefinition превращает buildDefinition() — по позиции в списке. */
interface DraftStep {
  key: string;
  type: StepType;
  templateId: string;
  senderName: string;
  hours: string;
  minutes: string;
  expression: string;
  falseAction: 'end' | 'goto';
  falseGoto: string;
  // Следующий шаг для sms/delay/waitEvent (condition управляет ветками сам)
  nextAction: 'next' | 'end';
  // Абсолютные паузы
  delayMode: DelayModeDraft;
  atHour: string;
  atMinute: string;
  atDate: string;
  // waitEvent-узел
  waitEventName: string;
  timeoutHours: string;
  timeoutMinutes: string;
  timeoutAction: 'end' | 'goto';
  timeoutGoto: string;
}

let draftSeq = 0;
/** Уникальный key черновика для React-списков: время в base36 + счётчик. */
function nextDraftKey(): string {
  draftSeq += 1;
  return `s${Date.now().toString(36)}-${draftSeq}`;
}

/** Заготовка нового шага с дефолтами: пауза 24ч, ожидание APPLICATION_APPROVED, таймаут 72ч. */
function emptyStep(type: StepType): DraftStep {
  return {
    key: nextDraftKey(),
    type,
    templateId: '',
    senderName: '',
    hours: type === 'delay' ? '24' : '0',
    minutes: '0',
    expression: '',
    falseAction: 'end',
    falseGoto: '',
    nextAction: 'next',
    delayMode: 'relative',
    atHour: '9',
    atMinute: '0',
    atDate: '',
    waitEventName: 'APPLICATION_APPROVED',
    timeoutHours: '72',
    timeoutMinutes: '0',
    timeoutAction: 'end',
    timeoutGoto: '',
  };
}

/** FunnelDefinition → плоский список черновиков для редактора.
 *  Основная цепочка проходится от start_node (condition — по onTrue, waitEvent — по onEvent),
 *  узлы вне цепочки дописываются в конец — иначе редактор потерял бы goto-цели. */
function stepsFromDefinition(def: FunnelDefinition | null | undefined): DraftStep[] {
  if (!def || !Array.isArray(def.nodes) || def.nodes.length === 0) return [];
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  // Основная цепочка: start → … (condition по onTrue, waitEvent по onEvent)
  const chain: FunnelDefinition['nodes'] = [];
  const visited = new Set<string>();
  let cur: string | null | undefined = def.start_node;
  while (cur) {
    const node = byId.get(cur);
    if (!node || visited.has(node.id)) break;
    visited.add(node.id);
    chain.push(node);
    cur = node.type === 'condition' ? node.onTrue : node.type === 'waitEvent' ? node.onEvent : node.next;
  }
  // Узлы вне основной цепочки (достижимые только через ветки) — добавляем в конце,
  // иначе редактор их потерял бы (goto-ссылки строятся по номерам шагов).
  for (const node of def.nodes) {
    if (!visited.has(node.id)) {
      visited.add(node.id);
      chain.push(node);
    }
  }
  const idToIndex = new Map<string, number>();
  chain.forEach((n, i) => idToIndex.set(n.id, i + 1));

  return chain.map((node) => {
    const step = emptyStep(node.type);
    step.key = `${node.id}-${nextDraftKey()}`;
    step.templateId = node.templateId ?? '';
    step.hours = String(node.hours ?? 0);
    step.minutes = String(node.minutes ?? 0);
    step.expression = node.expression ?? '';
    step.delayMode = node.mode ?? 'relative';
    step.atHour = String(node.atHour ?? 9);
    step.atMinute = String(node.atMinute ?? 0);
    step.atDate = node.atDate ?? '';
    step.waitEventName = node.event ?? 'APPLICATION_APPROVED';
    step.timeoutHours = String(node.timeoutHours ?? 72);
    step.timeoutMinutes = String(node.timeoutMinutes ?? 0);
    if (node.type !== 'condition' && node.type !== 'waitEvent') {
      step.nextAction = node.next === null ? 'end' : 'next';
    }
    if (node.type === 'condition' && node.onFalse) {
      const idx = idToIndex.get(node.onFalse);
      if (idx !== undefined) {
        step.falseAction = 'goto';
        step.falseGoto = String(idx);
      }
    }
    if (node.type === 'waitEvent') {
      step.nextAction = node.onEvent === null ? 'end' : 'next';
      if (node.onTimeout) {
        const idx = idToIndex.get(node.onTimeout);
        if (idx !== undefined) {
          step.timeoutAction = 'goto';
          step.timeoutGoto = String(idx);
        }
      }
    }
    return step;
  });
}

/** Строка → целое в диапазоне [min, max]; NaN/мусор → min. */
function clampInt(v: string, min: number, max: number): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Черновики → граф FunnelDefinition: узлы n1..nN; «следующий» = сосед по списку
 *  (null = конец), а ветвления (onFalse/onTimeout) — только через goto на номер шага. */
function buildDefinition(steps: DraftStep[]): FunnelDefinition {
  const nodes: FunnelDefinition['nodes'] = steps.map((s, i) => {
    const id = `n${i + 1}`;
    const chainNext = i < steps.length - 1 ? `n${i + 2}` : null;
    const next = s.nextAction === 'end' ? null : chainNext;
    if (s.type === 'sms') {
      return {
        id,
        type: 'sms' as const,
        name: `SMS ${i + 1}`,
        templateId: s.templateId || null,
        senderName: s.senderName.trim() || null,
        next,
      };
    }
    if (s.type === 'delay') {
      return {
        id,
        type: 'delay' as const,
        name: `Пауза ${i + 1}`,
        hours: clampInt(s.hours, 0, 720),
        minutes: clampInt(s.minutes, 0, 59),
        ...(s.delayMode !== 'relative'
          ? {
              mode: s.delayMode,
              atHour: clampInt(s.atHour, 0, 23),
              atMinute: clampInt(s.atMinute, 0, 59),
              ...(s.delayMode === 'until_date' && s.atDate !== '' ? { atDate: s.atDate } : {}),
            }
          : {}),
        next,
      };
    }
    if (s.type === 'waitEvent') {
      const timeoutIdx =
        s.timeoutAction === 'goto' ? Number.parseInt(s.timeoutGoto, 10) : Number.NaN;
      const onTimeout =
        Number.isFinite(timeoutIdx) && timeoutIdx >= 1 && timeoutIdx <= steps.length
          ? `n${timeoutIdx}`
          : null;
      return {
        id,
        type: 'waitEvent' as const,
        name: `Ждать событие ${i + 1}`,
        event: s.waitEventName,
        timeoutHours: clampInt(s.timeoutHours, 0, 720),
        timeoutMinutes: clampInt(s.timeoutMinutes, 0, 59),
        onEvent: next,
        onTimeout,
      };
    }
    const falseIdx = s.falseAction === 'goto' ? Number.parseInt(s.falseGoto, 10) : Number.NaN;
    const onFalse =
      Number.isFinite(falseIdx) && falseIdx >= 1 && falseIdx <= steps.length
        ? `n${falseIdx}`
        : null;
    return {
      id,
      type: 'condition' as const,
      name: `Условие ${i + 1}`,
      expression: s.expression,
      onTrue: chainNext,
      onFalse,
    };
  });
  return { start_node: nodes.length > 0 ? nodes[0].id : '', nodes };
}

/** Клиентская валидация перед сохранением (сервер проверяет граф повторно):
 *  название, непустые шаги, шаблон у SMS, положительные задержка/таймаут, корректные goto-цели. */
function validateDraft(
  name: string,
  steps: DraftStep[],
): string[] {
  const problems: string[] = [];
  if (!name.trim()) problems.push('Укажите название воронки');
  if (steps.length === 0) problems.push('Добавьте хотя бы один шаг');
  steps.forEach((s, i) => {
    const n = i + 1;
    if (s.type === 'sms' && !s.templateId) problems.push(`Шаг ${n}: выберите шаблон`);
    if (s.type === 'delay') {
      if (s.delayMode === 'relative') {
        if (clampInt(s.hours, 0, 720) * 60 + clampInt(s.minutes, 0, 59) <= 0) {
          problems.push(`Шаг ${n}: задержка должна быть > 0`);
        }
      } else if (s.delayMode === 'until_date' && s.atDate === '') {
        problems.push(`Шаг ${n}: укажите дату паузы`);
      }
    }
    if (s.type === 'condition') {
      if (!s.expression.trim()) problems.push(`Шаг ${n}: пустое выражение условия`);
      if (s.falseAction === 'goto') {
        const idx = Number.parseInt(s.falseGoto, 10);
        if (!Number.isFinite(idx) || idx < 1 || idx > steps.length) {
          problems.push(`Шаг ${n}: выберите корректный шаг перехода «если false»`);
        }
      }
    }
    if (s.type === 'waitEvent') {
      if (clampInt(s.timeoutHours, 0, 720) * 60 + clampInt(s.timeoutMinutes, 0, 59) <= 0) {
        problems.push(`Шаг ${n}: таймаут ожидания должен быть > 0`);
      }
      if (s.timeoutAction === 'goto') {
        const idx = Number.parseInt(s.timeoutGoto, 10);
        if (!Number.isFinite(idx) || idx < 1 || idx > steps.length) {
          problems.push(`Шаг ${n}: выберите корректный шаг перехода «если таймаут»`);
        }
      }
    }
  });
  return problems;
}

/** Карточка шага в конструкторе: номер с вертикальной связкой слева, форма по типу узла,
 *  кнопки вверх/вниз/удалить. goto-цели — любые шаги, кроме самого себя. */
function StepCard({
  index,
  step,
  total,
  templates,
  onChange,
  onMove,
  onDelete,
}: {
  index: number;
  step: DraftStep;
  total: number;
  templates: TemplateItem[];
  onChange: (patch: Partial<DraftStep>) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const meta = STEP_TYPE_META[step.type];
  const Icon = meta.icon;
  // Цели goto-переходов: любой шаг, кроме самого себя
  const gotoOptions = Array.from({ length: total }, (_, i) => i + 1).filter((n) => n !== index + 1);

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white">
          {index + 1}
        </div>
        {index < total - 1 ? <div className="mt-1 w-px flex-1 bg-zinc-200 dark:bg-zinc-700" aria-hidden /> : null}
      </div>
      <div className="min-w-0 flex-1 rounded-lg border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <Badge variant="outline" className="gap-1.5 border-border bg-muted text-zinc-700 dark:text-zinc-300">
            <Icon className="size-3.5" aria-hidden />
            {meta.label}
          </Badge>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onMove(-1)}
              disabled={index === 0}
              aria-label="Переместить шаг выше"
            >
              <ChevronUp className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onMove(1)}
              disabled={index === total - 1}
              aria-label="Переместить шаг ниже"
            >
              <ChevronDown className="size-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-red-500 dark:text-red-400 hover:text-red-600 dark:text-red-400"
              onClick={onDelete}
              aria-label="Удалить шаг"
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        </div>

        <div className="space-y-3 p-3">
          {/* --- Шаг SMS: выбор активного шаблона --- */}
          {step.type === 'sms' ? (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Шаблон</Label>
                <Select
                  value={step.templateId}
                  onValueChange={(v) => onChange({ templateId: v })}
                >
                  <SelectTrigger className="w-full" aria-label="Шаблон SMS">
                    <SelectValue placeholder="Выберите шаблон" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                        Нет активных шаблонов — создайте их в разделе «Шаблоны»
                      </div>
                    ) : (
                      templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          <span className="flex items-center gap-2">
                            {t.name}
                            {t.isMarketing ? (
                              <span className="text-xs text-amber-600 dark:text-amber-400">(реклама)</span>
                            ) : null}
                          </span>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {/* Имя отправителя не задаётся на уровне шага — отправка всегда
                    от имени компании (Настройки). */}
              </div>
            </>
          ) : null}

          {/* --- Шаг «Пауза»: режим (relative / абсолютные) + поля --- */}
          {step.type === 'delay' ? (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Тип паузы</Label>
                <Select
                  value={step.delayMode}
                  onValueChange={(v) => onChange({ delayMode: v as DraftStep['delayMode'] })}
                >
                  <SelectTrigger className="w-full" aria-label="Тип паузы">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DELAY_MODE_META.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {step.delayMode === 'relative' ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs" htmlFor={`hours-${step.key}`}>
                        Часы (0–720)
                      </Label>
                      <Input
                        id={`hours-${step.key}`}
                        type="number"
                        min={0}
                        max={720}
                        value={step.hours}
                        onChange={(e) => onChange({ hours: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs" htmlFor={`minutes-${step.key}`}>
                        Минуты (0–59)
                      </Label>
                      <Input
                        id={`minutes-${step.key}`}
                        type="number"
                        min={0}
                        max={59}
                        value={step.minutes}
                        onChange={(e) => onChange({ minutes: e.target.value })}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Итого: {humanDuration(clampInt(step.hours, 0, 720), clampInt(step.minutes, 0, 59))}
                  </p>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    {step.delayMode === 'until_date' ? (
                      <div className="space-y-1.5">
                        <Label className="text-xs" htmlFor={`atdate-${step.key}`}>
                          Дата
                        </Label>
                        <Input
                          id={`atdate-${step.key}`}
                          type="date"
                          value={step.atDate}
                          onChange={(e) => onChange({ atDate: e.target.value })}
                        />
                      </div>
                    ) : null}
                    <div className="space-y-1.5">
                      <Label className="text-xs" htmlFor={`athour-${step.key}`}>
                        Час (0–23)
                      </Label>
                      <Input
                        id={`athour-${step.key}`}
                        type="number"
                        min={0}
                        max={23}
                        value={step.atHour}
                        onChange={(e) => onChange({ atHour: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs" htmlFor={`atminute-${step.key}`}>
                        Минуты (0–59)
                      </Label>
                      <Input
                        id={`atminute-${step.key}`}
                        type="number"
                        min={0}
                        max={59}
                        value={step.atMinute}
                        onChange={(e) => onChange({ atMinute: e.target.value })}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {step.delayMode === 'until_time'
                      ? 'До следующего наступления этого времени — по местному времени клиента'
                      : step.delayMode === 'until_date'
                        ? 'До даты (по местному времени клиента); прошедшая дата — шаг пропускается'
                        : 'До ближайшего дня рождения клиента (месяц/день без года); нет ДР — шаг пропускается'}
                  </p>
                </>
              )}
            </>
          ) : null}

          {/* --- Шаг «Ждать событие»: событие, таймаут, ветка таймаута --- */}
          {step.type === 'waitEvent' ? (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Ждать событие</Label>
                <Select
                  value={step.waitEventName}
                  onValueChange={(v) => onChange({ waitEventName: v })}
                >
                  <SelectTrigger className="w-full" aria-label="Ожидаемое событие">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(EVENT_META) as EventType[]).map((ev) => (
                      <SelectItem key={ev} value={ev}>
                        {EVENT_META[ev].label} ({ev})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Пришло событие → следующий шаг; тишина дольше таймаута → ветка «таймаут»
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor={`tohours-${step.key}`}>
                    Таймаут: часы
                  </Label>
                  <Input
                    id={`tohours-${step.key}`}
                    type="number"
                    min={0}
                    max={720}
                    value={step.timeoutHours}
                    onChange={(e) => onChange({ timeoutHours: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor={`tominutes-${step.key}`}>
                    Таймаут: минуты
                  </Label>
                  <Input
                    id={`tominutes-${step.key}`}
                    type="number"
                    min={0}
                    max={59}
                    value={step.timeoutMinutes}
                    onChange={(e) => onChange({ timeoutMinutes: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Если таймаут:</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Select
                    value={step.timeoutAction}
                    onValueChange={(v) => onChange({ timeoutAction: v as DraftStep['timeoutAction'] })}
                  >
                    <SelectTrigger className="w-full" aria-label="Действие при таймауте">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="end">Завершить воронку</SelectItem>
                      <SelectItem value="goto">Перейти к шагу №</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={step.timeoutGoto}
                    onValueChange={(v) => onChange({ timeoutGoto: v })}
                    disabled={step.timeoutAction !== 'goto'}
                  >
                    <SelectTrigger className="w-full" aria-label="Номер шага перехода при таймауте">
                      <SelectValue placeholder="Шаг №" />
                    </SelectTrigger>
                    <SelectContent>
                      {gotoOptions.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                          Другие шаги отсутствуют
                        </div>
                      ) : (
                        gotoOptions.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            Шаг №{n}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          ) : null}

          {/* --- Шаг «Условие»: выражение + ветка «если false» --- */}
          {step.type === 'condition' ? (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor={`expr-${step.key}`}>
                  Выражение
                </Label>
                <Textarea
                  id={`expr-${step.key}`}
                  className="font-mono text-sm"
                  rows={2}
                  value={step.expression}
                  onChange={(e) => onChange({ expression: e.target.value })}
                  placeholder="payload.overdue_days >= 5"
                />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Переменные: client.*, payload.*, event и имена переменных карточки/шаблонов
                  (agreement_actual_status, person_offer_available, overdue_days…; кастомные
                  поля — cf_*, например client.cf_is_credit_line). Операторы: ==
                  != &gt; &gt;= &lt; &lt;= &amp;&amp; || !
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Если false:</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Select
                    value={step.falseAction}
                    onValueChange={(v) => onChange({ falseAction: v as DraftStep['falseAction'] })}
                  >
                    <SelectTrigger className="w-full" aria-label="Действие при false">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="end">Завершить воронку</SelectItem>
                      <SelectItem value="goto">Перейти к шагу №</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={step.falseGoto}
                    onValueChange={(v) => onChange({ falseGoto: v })}
                    disabled={step.falseAction !== 'goto'}
                  >
                    <SelectTrigger className="w-full" aria-label="Номер шага перехода">
                      <SelectValue placeholder="Шаг №" />
                    </SelectTrigger>
                    <SelectContent>
                      {gotoOptions.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                          Другие шаги отсутствуют
                        </div>
                      ) : (
                        gotoOptions.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            Шаг №{n}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          ) : null}

          {/* --- «После шага» (для sms/delay/waitEvent; condition ветвится сам) --- */}
          {step.type !== 'condition' ? (
            <div className="space-y-1.5 border-t border-border pt-3">
              <Label className="text-xs">После шага</Label>
              <Select
                value={step.nextAction}
                onValueChange={(v) => onChange({ nextAction: v as DraftStep['nextAction'] })}
              >
                <SelectTrigger className="w-full" aria-label="Действие после шага">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="next">Следующий шаг</SelectItem>
                  <SelectItem value="end">Завершить воронку</SelectItem>
                </SelectContent>
              </Select>
              {step.type === 'waitEvent' ? (
                <p className="text-xs text-zinc-400">«Следующий шаг» = ветка «событие пришло»</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Конструктор воронки (создание/правка): название, триггерное событие, entryMode,
 *  описание и список шагов. funnel = null → создание; шаги восстанавливаются
 *  из definition через stepsFromDefinition и сохраняются через buildDefinition. */
function FunnelBuilderDialog({
  open,
  onOpenChange,
  funnel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  funnel: FunnelItem | null;
}) {
  const queryClient = useQueryClient();
  // Активные шаблоны для SMS-шагов; грузятся только при открытом диалоге.
  const templatesQuery = useQuery({
    queryKey: ['templates', 'all'],
    queryFn: () => api<Paged<TemplateItem>>('/api/v1/templates?pageSize=100'),
    enabled: open,
  });
  // Для SMS-шагов предлагаются только активные шаблоны
  const templates = (templatesQuery.data?.items ?? []).filter((t) => t.isActive);

  const [name, setName] = React.useState('');
  const [triggerEvent, setTriggerEvent] = React.useState<EventType>('LOAN_OVERDUE');
  const [entryMode, setEntryMode] = React.useState<EntryMode>('SKIP_ACTIVE');
  const [description, setDescription] = React.useState('');
  const [steps, setSteps] = React.useState<DraftStep[]>([]);
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Заполнение формы при открытии: из funnel (правка) или дефолты
  // (триггер LOAN_OVERDUE, entryMode SKIP_ACTIVE, без шагов).
  React.useEffect(() => {
    if (!open) return;
    setServerError(null);
    if (funnel) {
      setName(funnel.name);
      setTriggerEvent(funnel.triggerEvent);
      setEntryMode(funnel.entryMode);
      setDescription(funnel.description ?? '');
      setSteps(stepsFromDefinition(funnel.definition));
    } else {
      setName('');
      setTriggerEvent('LOAN_OVERDUE');
      setEntryMode('SKIP_ACTIVE');
      setDescription('');
      setSteps([]);
    }
  }, [open, funnel]);

  // Живая валидация формы: список проблем показывается в диалоге и блокирует «Сохранить».
  const problems = React.useMemo(() => validateDraft(name, steps), [name, steps]);

  // POST /funnels (создание) / PUT /funnels/{id} (правка): definition = buildDefinition(steps).
  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        triggerEvent,
        definition: buildDefinition(steps),
        entryMode,
        description: description.trim() || null,
      };
      if (funnel) {
        return api<FunnelItem>(`/api/v1/funnels/${funnel.id}`, { method: 'PUT', body });
      }
      return api<FunnelItem>('/api/v1/funnels', { method: 'POST', body });
    },
    onSuccess: () => {
      toast.success('Воронка сохранена');
      invalidatePanel(queryClient);
      onOpenChange(false);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось сохранить воронку';
      setServerError(detail);
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Точечная правка шага по key (key живёт в DraftStep, не в id узла).
  function updateStep(key: string, patch: Partial<DraftStep>) {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  // Перестановка шагов местами; goto-цели — номера, пересчитаются в buildDefinition.
  function moveStep(index: number, dir: -1 | 1) {
    setSteps((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  // Удаление шага: номера последующих сдвигаются — валидация перепроверит goto-цели.
  function deleteStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }

  // Добавить шаг с дефолтами в конец списка.
  function addStep(type: DraftStep['type']) {
    setSteps((prev) => [...prev, emptyStep(type)]);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{funnel ? `Редактирование «${funnel.name}»` : 'Новая воронка'}</DialogTitle>
          <DialogDescription>
            Последовательность шагов: SMS, задержки и условия ветвления
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* --- Секция: название + триггерное событие --- */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="funnel-name">Название</Label>
              <Input
                id="funnel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Просрочка → напоминания"
                maxLength={100}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Триггерное событие</Label>
              <Select value={triggerEvent} onValueChange={(v) => setTriggerEvent(v as EventType)}>
                <SelectTrigger className="w-full" aria-label="Триггерное событие">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(EVENT_META) as EventType[]).map((ev) => (
                    <SelectItem key={ev} value={ev}>
                      {EVENT_META[ev].label} ({ev})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* --- Режим повторного запуска (entryMode): что делать с уже идущей воронкой --- */}
          <div className="space-y-1.5 rounded-md border border-border p-3">
            <Label>Повторный запуск при новом событии</Label>
            <Select value={entryMode} onValueChange={(v) => setEntryMode(v as EntryMode)}>
              <SelectTrigger className="w-full" aria-label="Режим повторного запуска">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ENTRY_MODE_META) as EntryMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {ENTRY_MODE_META[m].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{ENTRY_MODE_META[entryMode].hint}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="funnel-desc">Описание</Label>
            <Textarea
              id="funnel-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Для чего нужна воронка (необязательно)"
            />
          </div>

          {/* --- Секция: шаги воронки (список + кнопки добавления) --- */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-foreground">Шаги воронки</h3>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{steps.length} шаг(ов)</span>
            </div>

            {steps.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                Шагов пока нет — добавьте первый ниже
              </div>
            ) : (
              <ol className="space-y-4">
                {steps.map((step, i) => (
                  <li key={step.key}>
                    <StepCard
                      index={i}
                      step={step}
                      total={steps.length}
                      templates={templates}
                      onChange={(patch) => updateStep(step.key, patch)}
                      onMove={(dir) => moveStep(i, dir)}
                      onDelete={() => deleteStep(i)}
                    />
                  </li>
                ))}
              </ol>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => addStep('sms')}>
                <MessageSquare className="size-4" aria-hidden />
                SMS
              </Button>
              <Button variant="outline" size="sm" onClick={() => addStep('delay')}>
                <Clock className="size-4" aria-hidden />
                Пауза
              </Button>
              <Button variant="outline" size="sm" onClick={() => addStep('waitEvent')}>
                <Hourglass className="size-4" aria-hidden />
                Ждать событие
              </Button>
              <Button variant="outline" size="sm" onClick={() => addStep('condition')}>
                <GitFork className="size-4" aria-hidden />
                Условие
              </Button>
            </div>
          </div>

          {/* --- Проблемы валидации / отказ сервера --- */}
          {problems.length > 0 ? (
            <Alert className="border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/60 text-amber-800">
              <AlertTitle>Исправьте перед сохранением</AlertTitle>
              <AlertDescription>
                <ul className="list-inside list-disc space-y-0.5">
                  {problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}

          {serverError ? (
            <Alert variant="destructive">
              <AlertTitle>Сервер отклонил воронку</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saveMutation.isPending}>
            Отмена
          </Button>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={problems.length > 0 || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ============================ Список ============================ */

/** Корневой экран «Воронки»: таблица воронок (триггер, превью шагов, активность) +
 *  конструктор и подтверждения активации/удаления. Активная воронка в реальном времени
 *  запускается событиями от системы данных. */
export function FunnelsView() {
  const queryClient = useQueryClient();
  const { canWrite } = useRole();

  // Все воронки одним запросом (pageSize=100, пагинация не нужна).
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['funnels'],
    queryFn: () => api<Paged<FunnelItem>>('/api/v1/funnels?pageSize=100'),
  });

  const [builderOpen, setBuilderOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<FunnelItem | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<FunnelItem | null>(null);
  const [activateTarget, setActivateTarget] = React.useState<FunnelItem | null>(null);

  // Клонирование — копия определения под новым именем; НОВАЯ воронка
  // создаётся НЕАКТИВНОЙ (безопасно: события не потребляет до проверки)
  const cloneMutation = useMutation({
    mutationFn: async (f: FunnelItem) =>
      api<FunnelItem>('/api/v1/funnels', {
        method: 'POST',
        body: {
          name: `${f.name} (копия)`.slice(0, 200),
          triggerEvent: f.triggerEvent,
          definition: f.definition,
          entryMode: f.entryMode,
          description: f.description ?? undefined,
        },
      }),
    onSuccess: () => {
      toast.success('Копия воронки создана (выключена) — проверьте и активируйте');
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось скопировать';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // POST /funnels/{id}/activate | /deactivate — включение/выключение потребления событий.
  const toggleMutation = useMutation({
    mutationFn: async (f: { id: string; activate: boolean }) =>
      api<FunnelItem>(`/api/v1/funnels/${f.id}/${f.activate ? 'activate' : 'deactivate'}`, {
        method: 'POST',
      }),
    onSuccess: (_data, vars) => {
      toast.success(vars.activate ? 'Воронка активирована' : 'Воронка деактивирована');
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось изменить статус';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // DELETE /funnels/{id} — безвозвратно; сервер отклонит удаление при живых экземплярах.
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api<void>(`/api/v1/funnels/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Воронка удалена');
      setDeleteTarget(null);
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось удалить воронку';
      toast.error(`Ошибка: ${detail}`);
      setDeleteTarget(null);
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      {/* --- Заголовок: пояснение + «Создать воронку» (VIEWER — только просмотр) --- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Воронки запускаются автоматически при поступлении события от системы данных
        </p>
        <ViewerGuard>
          <Button
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            onClick={() => {
              setEditTarget(null);
              setBuilderOpen(true);
            }}
          >
            <Plus className="size-4" aria-hidden />
            Создать воронку
          </Button>
        </ViewerGuard>
      </div>

      {/* --- Таблица воронок: загрузка / ошибка / пусто / строки --- */}
      <Card className="shadow-sm">
        <CardContent className="p-0">
          {isPending ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : error ? (
            <div className="p-4">
              <ErrorState error={error} onRetry={() => void refetch()} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={GitFork}
              title="Воронок пока нет — создайте первую"
              action={
                canWrite ? (
                  <Button
                    className="bg-emerald-600 text-white hover:bg-emerald-700"
                    onClick={() => {
                      setEditTarget(null);
                      setBuilderOpen(true);
                    }}
                  >
                    <Plus className="size-4" aria-hidden />
                    Создать воронку
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>Название</TableHead>
                    <TableHead>Триггер</TableHead>
                    <TableHead>Шаги</TableHead>
                    <TableHead>Активна</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((f) => (
                    <TableRow key={f.id} className="hover:bg-muted">
                      <TableCell className="py-3">
                        <p className="font-medium text-foreground">{f.name}</p>
                        {f.description ? (
                          <p className="max-w-xs truncate text-xs text-zinc-500 dark:text-zinc-400">{f.description}</p>
                        ) : null}
                        <p className="text-[11px] text-zinc-400">Обновлена {fmtDT(f.updatedAt)}</p>
                      </TableCell>
                      <TableCell className="py-3">
                        <EventBadge event={f.triggerEvent} />
                      </TableCell>
                      <TableCell className="py-3">
                        <StepsPreview def={f.definition} />
                      </TableCell>
                      <TableCell className="py-3">
                        {canWrite ? (
                          <Switch
                            checked={f.isActive}
                            disabled={toggleMutation.isPending}
                            onCheckedChange={(checked) => {
                              // Включение — через подтверждение (события начнут запускаться сразу);
                              // выключение выполняется немедленно.
                              if (checked) {
                                setActivateTarget(f);
                              } else {
                                toggleMutation.mutate({ id: f.id, activate: false });
                              }
                            }}
                            aria-label={`Активность воронки ${f.name}`}
                          />
                        ) : (
                          <Badge
                            variant="outline"
                            className={
                              f.isActive
                                ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400'
                                : 'border-border bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'
                            }
                          >
                            {f.isActive ? 'Активна' : 'Выключена'}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex items-center justify-end gap-1">
                          <ViewerGuard>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => cloneMutation.mutate(f)}
                              disabled={cloneMutation.isPending}
                              aria-label={`Клонировать воронку ${f.name}`}
                              title="Создать выключенную копию с теми же узлами"
                            >
                              <Copy className="size-4" aria-hidden />
                            </Button>
                          </ViewerGuard>
                          <ViewerGuard>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setEditTarget(f);
                                setBuilderOpen(true);
                              }}
                              aria-label={`Редактировать воронку ${f.name}`}
                            >
                              <Pencil className="size-4" aria-hidden />
                            </Button>
                          </ViewerGuard>
                          <ViewerGuard>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-red-500 dark:text-red-400 hover:text-red-600 dark:text-red-400"
                              onClick={() => setDeleteTarget(f)}
                              aria-label={`Удалить воронку ${f.name}`}
                            >
                              <Trash2 className="size-4" aria-hidden />
                            </Button>
                          </ViewerGuard>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* --- Диалоги: конструктор / удаление / подтверждение активации --- */}
      <FunnelBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        funnel={editTarget}
      />

      {/* --- Подтверждение удаления воронки --- */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить воронку «{deleteTarget?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Воронка будет удалена безвозвратно. Действие не отменить — у воронки не должно быть
              запущенных экземпляров.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              // анти-двойной клик: блокируем кнопку, пока идёт запрос
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* --- Подтверждение активации (переключатель в таблице) --- */}
      <AlertDialog
        open={activateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setActivateTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Активировать воронку «{activateTarget?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              События начнут запускать её немедленно.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              // анти-двойной клик: блокируем кнопку, пока идёт запрос
              disabled={toggleMutation.isPending}
              onClick={() => {
                if (activateTarget) {
                  toggleMutation.mutate({ id: activateTarget.id, activate: true });
                }
                setActivateTarget(null);
              }}
            >
              Активировать
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
