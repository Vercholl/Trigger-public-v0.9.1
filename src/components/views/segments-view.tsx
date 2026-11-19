'use client';

// Вкладка «Сегменты» (П3): список + конструктор условий по полям карточки клиента,
// предпросмотр (сколько клиентов подходит) и список клиентов сегмента.
// Домен: сегментация клиентской базы — мишени массовых рассылок (broadcast targeting).
// API: GET/POST/PUT/DELETE /api/v1/segments, POST /api/v1/segments/preview,
// GET /api/v1/segments/{id}/count, GET /{id}/clients, POST /{id}/freeze, POST /{id}/unfreeze.
// Экран открывают все роли (ADMIN/MANAGER/VIEWER); мутации обёрнуты в ViewerGuard —
// VIEWER видит список/клиентов/счётчики, но кнопки заблокированы (RBAC повторяется на сервере).

import * as React from 'react';
import { Copy, Filter, Loader2, Pencil, Pin, PinOff, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, ApiError } from '@/lib/api-client';
import {
  invalidatePanel,
  AgreementStatusBadge,
  ConsentBadge,
  EmptyState,
  ErrorState,
  ProductBadge,
  TablePagination,
  ViewerGuard,
  fmtDate,
  fmtDT,
  relTime,
  type Paged,
} from '@/components/views/shared';
import {
  CF_CATEGORY,
  cfToSegmentField,
  SEGMENT_CATEGORIES,
  SEGMENT_FIELDS,
  operatorsForType,
  ruleToText,
  type SegmentFieldDef,
  type SegmentValue,
} from '@/lib/segments/fields';
import { useCustomFields } from '@/components/views/shared';

// ---------- Типы ----------

/** Одно условие сегмента: поле карточки (SEGMENT_FIELDS) + оператор + значение. */
interface SegmentRule {
  field: string;
  op: string;
  value: SegmentValue;
}

/** Условия сегмента: список правил + режим склейки (all = И, any = ИЛИ). */
interface SegmentConditions {
  match: 'all' | 'any';
  rules: SegmentRule[];
}

/** Сегмент из GET /api/v1/segments: условия, режим (dynamic/static) и данные фиксации. */
interface SegmentItem {
  id: string;
  name: string;
  description: string | null;
  conditions: SegmentConditions;
  mode: 'dynamic' | 'static';
  frozenCount: number | null;
  frozenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Ответ GET /segments/{id}/count: число + режим + момент расчёта/фиксации. */
interface SegmentCountResponse {
  total: number;
  mode: 'dynamic' | 'static';
  computedAt: string;
  frozenAt: string | null;
}

/** Строка превью из POST /segments/preview — компактный срез карточки клиента. */
interface PreviewSampleItem {
  id: string;
  externalId: string;
  fullName: string;
  phone: string;
  agreementStatus: number | null;
  lastProductType: 'PDL' | 'IL' | null;
  smsConsentStatus: 'NONE' | 'PENDING' | 'GRANTED' | 'REVOKED';
  notificationActive: boolean;
  birthday: string | null;
  offerApproveMoney: number | null;
  offerDateExpired: string | null;
}

/** Ответ POST /segments/preview: точное total + выборка клиентов (до sampleSize). */
interface PreviewResponse {
  total: number;
  sample: PreviewSampleItem[];
}

// ---------- Черновик правила (value хранится строкой до сохранения) ----------

interface RuleDraft {
  uid: string;
  field: string;
  op: string;
  /** string | string[] | boolean — сериализация в SegmentValue при сохранении */
  raw: string;
  list: string[];
  bool: boolean;
}

// Счётчик uid черновиков (ключи React-списков). Аудит 29-d: crypto.randomUUID
// доступен только в secure context (https/localhost) — на внутреннем http-контуре
// он undefined и рендер «Сегментов» падал TypeError'ом без error boundary;
// случайность для uid не нужна, поэтому счётчик + время (как nextDraftKey в funnels).
let draftUidSeq = 0;
function nextDraftUid(): string {
  draftUidSeq += 1;
  return `r${Date.now().toString(36)}-${draftUidSeq}`;
}

/** Сохранённое правило → черновик для редактора (массивы в list, скаляры в raw). */
function draftFromRule(rule: SegmentRule): RuleDraft {
  return {
    uid: nextDraftUid(),
    field: rule.field,
    op: rule.op,
    raw: Array.isArray(rule.value) ? '' : String(rule.value),
    list: Array.isArray(rule.value) ? (rule.value as string[]) : [],
    bool: rule.value === true,
  };
}

/** Новый критерий по умолчанию: статус договора, оператор eq. */
function defaultDraft(): RuleDraft {
  return { uid: nextDraftUid(), field: 'agreement_actual_status', op: 'eq', raw: '', list: [], bool: true };
}

/** Черновик → значение для API (по kind оператора). null = значение ещё не готово.
 *  fields — полный список полей (статические + CF) для резолва типа. */
function draftValue(draft: RuleDraft, fields: readonly SegmentFieldDef[]): SegmentValue | null {
  const field = fields.find((f) => f.key === draft.field);
  const opDef = operatorsForType(field?.type ?? 'number').find((o) => o.op === draft.op);
  if (!field || !opDef) return null;
  switch (opDef.valueKind) {
    case 'number':
    case 'days':
    case 'years': {
      const n = Number(draft.raw);
      return draft.raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
    }
    case 'string':
      return draft.raw.trim() !== '' ? draft.raw.trim() : null;
    case 'enum':
      return draft.raw !== '' ? draft.raw : null;
    case 'enumMulti':
      return draft.list.length > 0 ? draft.list : null;
    case 'boolean':
      return draft.bool;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(draft.raw) ? draft.raw : null;
    default:
      return null;
  }
}

function ruleToTextDraft(draft: RuleDraft, fields: readonly SegmentFieldDef[]): string | null {
  const value = draftValue(draft, fields);
  if (value === null) return null;
  return ruleToText({ field: draft.field, op: draft.op, value }, fields);
}

// ---------- Элемент ввода значения ----------

/** Инпут значения критерия — вид ввода выбирается по valueKind оператора
 *  (число/дни/годы/текст/дата/enum/enumMulti/булево). null — пара поле+оператор невалидна.
 *  fields — полный список полей (статические + CF) для резолва типа. */
function ValueInput({ draft, fields, onChange }: { draft: RuleDraft; fields: readonly SegmentFieldDef[]; onChange: (patch: Partial<RuleDraft>) => void }) {
  const field = fields.find((f) => f.key === draft.field);
  const opDef = operatorsForType(field?.type ?? 'number').find((o) => o.op === draft.op);

  if (!field || !opDef) return null;

  switch (opDef.valueKind) {
    case 'number':
      return (
        <Input
          type="number"
          min={0}
          inputMode="numeric"
          value={draft.raw}
          onChange={(e) => onChange({ raw: e.target.value })}
          placeholder="0"
          aria-label="Значение"
        />
      );
    case 'days':
      return (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={36500}
            value={draft.raw}
            onChange={(e) => onChange({ raw: e.target.value })}
            placeholder="7"
            aria-label="Количество дней"
          />
          <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">дней</span>
        </div>
      );
    case 'years':
      return (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            max={120}
            value={draft.raw}
            onChange={(e) => onChange({ raw: e.target.value })}
            placeholder="25"
            aria-label="Количество лет"
          />
          <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">лет</span>
        </div>
      );
    case 'string':
      return (
        <Input
          value={draft.raw}
          onChange={(e) => onChange({ raw: e.target.value })}
          placeholder="Текст…"
          aria-label="Текстовое значение"
        />
      );
    case 'date':
      return (
        <Input
          type="date"
          value={draft.raw}
          onChange={(e) => onChange({ raw: e.target.value })}
          aria-label="Дата"
        />
      );
    case 'enum':
      return (
        <Select value={draft.raw} onValueChange={(v) => onChange({ raw: v })}>
          <SelectTrigger aria-label="Значение">
            <SelectValue placeholder="Выберите…" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o} value={o}>
                {field.key === 'sms_consent_status'
                  ? { NONE: 'нет', PENDING: 'ожидает', GRANTED: 'дано', REVOKED: 'отозвано' }[o] ?? o
                  : o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'enumMulti':
      return (
        <div className="flex flex-wrap gap-1.5">
          {(field.options ?? []).map((o) => {
            const active = draft.list.includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  onChange({
                    list: active ? draft.list.filter((x) => x !== o) : [...draft.list, o],
                  })
                }
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 font-medium text-emerald-700 dark:text-emerald-400'
                    : 'border-border bg-card text-zinc-600 dark:text-zinc-400 hover:bg-muted'
                }`}
              >
                {o}
              </button>
            );
          })}
        </div>
      );
    case 'boolean':
      return (
        <Select value={draft.bool ? 'true' : 'false'} onValueChange={(v) => onChange({ bool: v === 'true' })}>
          <SelectTrigger aria-label="Значение">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">да</SelectItem>
            <SelectItem value="false">нет</SelectItem>
          </SelectContent>
        </Select>
      );
    default:
      return null;
  }
}

// ---------- Конструктор сегмента ----------

/** Диалог создания/редактирования сегмента: конструктор критериев + «Проверить» (preview).
 *  initial = null → создание; mode=static (зафиксирован) — критерии заблокированы. */
function SegmentDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: SegmentItem | null; // null → создание
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [match, setMatch] = React.useState<'all' | 'any'>('all');
  const [drafts, setDrafts] = React.useState<RuleDraft[]>([defaultDraft()]);
  const [preview, setPreview] = React.useState<PreviewResponse | null>(null);

  // Кастомные поля (динамический реестр) — категория «Кастомные» конструктора;
  // CF-правила валидирует и вычисляет сервер по тому же реестру (кэш 30с).
  const cfQuery = useCustomFields();
  const allFields = React.useMemo<readonly SegmentFieldDef[]>(
    () => [...SEGMENT_FIELDS, ...(cfQuery.data?.items ?? []).map(cfToSegmentField)],
    [cfQuery.data],
  );

  // Фиксированный срез: критерии заблокированы (иначе срез и условия разъехались бы) —
  // правится только название/описание; сохранение шлёт их без условий.
  const locked = initial?.mode === 'static';

  // Заполнение формы при каждом открытии: из initial (правка) или дефолты (создание); превью сбрасывается.
  React.useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setDescription(initial.description ?? '');
      setMatch(initial.conditions.match ?? 'all');
      setDrafts(
        (initial.conditions.rules ?? []).map((r) => draftFromRule(r)),
      );
    } else {
      setName('');
      setDescription('');
      setMatch('all');
      setDrafts([defaultDraft()]);
    }
    setPreview(null);
  }, [open, initial]);

  // Точечная правка черновика; любое изменение обнуляет устаревший предпросмотр.
  const patchDraft = (uid: string, patch: Partial<RuleDraft>) => {
    setDrafts((prev) => prev.map((d) => (d.uid === uid ? { ...d, ...patch } : d)));
    setPreview(null);
  };

  // Смена поля: оператор сбрасывается на первый доступный для типа поля, значение очищается.
  const changeField = (uid: string, field: string) => {
    const f = allFields.find((x) => x.key === field);
    const firstOp = operatorsForType(f?.type ?? 'number')[0]?.op ?? 'eq';
    setDrafts((prev) =>
      prev.map((d) =>
        d.uid === uid ? { ...d, field, op: firstOp, raw: '', list: [], bool: true } : d,
      ),
    );
    setPreview(null);
  };

  // Черновики → conditions для API. null = хотя бы одно значение не заполнено
  // (проверить/сохранить нельзя). Пересчитывается на каждый ввод.
  const conditions = React.useMemo<SegmentConditions | null>(() => {
    const rules: SegmentRule[] = [];
    for (const d of drafts) {
      const value = draftValue(d, allFields);
      if (value === null) return null;
      rules.push({ field: d.field, op: d.op, value });
    }
    if (rules.length === 0) return null;
    return { match, rules };
  }, [drafts, match, allFields]);

  // «Проверить»: POST /api/v1/segments/preview — сколько клиентов подходит + выборка из 20.
  const checkMutation = useMutation({
    mutationFn: async () => {
      if (!conditions) throw new Error('BAD_RULES');
      return api<PreviewResponse>('/api/v1/segments/preview', {
        method: 'POST',
        body: { conditions, sampleSize: 20 },
      });
    },
    onSuccess: (res) => setPreview(res),
    onError: (err) => {
      if (err instanceof Error && err.message === 'BAD_RULES') {
        toast.error('Заполните значения всех критериев');
        return;
      }
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось проверить сегмент';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Сохранение: POST /segments (создание) или PUT /segments/{id} (правка).
  // Для фиксированного (locked) условия не отправляются — правится только название/описание.
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!conditions) throw new Error('BAD_RULES');
      const body = locked
        ? { name: name.trim(), description: description.trim() || null }
        : { name: name.trim(), description: description.trim() || null, conditions };
      return initial
        ? api<SegmentItem>(`/api/v1/segments/${initial.id}`, { method: 'PUT', body })
        : api<SegmentItem>('/api/v1/segments', { method: 'POST', body });
    },
    onSuccess: () => {
      toast.success(initial ? 'Сегмент обновлён' : 'Сегмент создан');
      onOpenChange(false);
      invalidatePanel(queryClient);
      onSaved();
    },
    onError: (err) => {
      if (err instanceof Error && err.message === 'BAD_RULES') {
        toast.error('Заполните название и значения всех критериев');
        return;
      }
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось сохранить сегмент';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Доступно сохранение: имя непустое и (фиксированный сегмент ИЛИ все критерии заполнены).
  const canSave = name.trim() !== '' && (locked || conditions !== null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{initial ? 'Редактировать сегмент' : 'Новый сегмент'}</DialogTitle>
          <DialogDescription>
            {locked
              ? 'Сегмент зафиксирован: критерии заморожены вместе с составом.'
              : 'Критерии по полям карточки клиента. Динамический сегмент пересчитывается при каждом использовании.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* --- Секция: название и описание --- */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="seg-name">Название</Label>
              <Input
                id="seg-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Например: Преапрув истекает"
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seg-desc">Описание (необязательно)</Label>
              <Input
                id="seg-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Для чего этот сегмент"
                maxLength={500}
              />
            </div>
          </div>

          {/* --- Фиксированный срез: критерии недоступны для правки --- */}
          {locked ? (
            <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
              <Pin className="size-4" aria-hidden />
              <AlertTitle>Состав зафиксирован{initial?.frozenAt ? ` — срез от ${fmtDT(initial.frozenAt)}` : ''}</AlertTitle>
              <AlertDescription className="text-amber-800 dark:text-amber-400">
                Критерии недоступны для правки: срез и условия не должны расходиться. Снимите
                фиксацию на карточке, измените критерии и зафиксируйте заново.
              </AlertDescription>
            </Alert>
          ) : null}

          {/* --- Конструктор условий (для fixed блокируется через pointer-events) --- */}
          <div className={locked ? 'pointer-events-none select-none space-y-4 opacity-60' : 'space-y-4'} aria-disabled={locked}>
          <div className="space-y-2">
            <Label>Логика условий</Label>
            <Tabs value={match} onValueChange={(v) => { setMatch(v as 'all' | 'any'); setPreview(null); }}>
              <TabsList className="h-9">
                <TabsTrigger value="all" className="px-3 py-1 text-xs">Все условия (И)</TabsTrigger>
                <TabsTrigger value="any" className="px-3 py-1 text-xs">Любое условие (ИЛИ)</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {/* --- Секция: список критериев (поле / оператор / значение) --- */}
          <div className="space-y-3">
            {drafts.map((d, idx) => {
              const field = allFields.find((f) => f.key === d.field);
              return (
                <div
                  key={d.uid}
                  className="rounded-lg border border-border bg-muted/60 p-3"
                >
                  <div className="flex items-center justify-between gap-2 pb-2">
                    <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Критерий {idx + 1}</span>
                    {drafts.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-red-600 dark:text-red-400 hover:text-red-700 dark:text-red-400"
                        onClick={() => {
                          setDrafts((prev) => prev.filter((x) => x.uid !== d.uid));
                          setPreview(null);
                        }}
                        aria-label={`Удалить критерий ${idx + 1}`}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                        Убрать
                      </Button>
                    ) : null}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1.1fr)]">
                    <Select value={d.field} onValueChange={(v) => changeField(d.uid, v)}>
                      <SelectTrigger aria-label="Поле">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[...SEGMENT_CATEGORIES, CF_CATEGORY].map((cat) => (
                          <React.Fragment key={cat}>
                            <div className="px-2 py-1.5 text-xs font-semibold text-zinc-400">{cat}</div>
                            {allFields.filter((f) => f.category === cat).map((f) => (
                              <SelectItem key={f.key} value={f.key}>
                                {f.label}
                                {f.cf ? <span className="ml-1 font-mono text-[11px] text-zinc-400">{f.key}</span> : null}
                              </SelectItem>
                            ))}
                          </React.Fragment>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={d.op}
                      onValueChange={(v) => {
                        // Значение сохраняем, если у старого и нового оператора один тип ввода
                        const ops = operatorsForType(field?.type ?? 'number');
                        const oldKind = ops.find((o) => o.op === d.op)?.valueKind;
                        const newKind = ops.find((o) => o.op === v)?.valueKind;
                        const sameKind = oldKind !== undefined && oldKind === newKind;
                        patchDraft(d.uid, sameKind ? { op: v } : { op: v, raw: '', list: [], bool: true });
                      }}
                    >
                      <SelectTrigger aria-label="Оператор">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {operatorsForType(field?.type ?? 'number').map((o) => (
                          <SelectItem key={o.op} value={o.op}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <ValueInput draft={d} fields={allFields} onChange={(patch) => patchDraft(d.uid, patch)} />
                  </div>
                  {field?.hint ? (
                    <p className="pt-1.5 text-xs text-zinc-400">{field.hint}</p>
                  ) : null}
                  {opHint(d.op) ? (
                    <p className="pt-1 text-xs text-zinc-400">{opHint(d.op)}</p>
                  ) : null}
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() => {
                setDrafts((prev) => [...prev, defaultDraft()]);
                setPreview(null);
              }}
            >
              <Plus className="size-4" aria-hidden />
              Добавить критерий
            </Button>
          </div>
          </div>

          {/* --- Секция: предпросмотр — сколько подходит + выборка клиентов --- */}
          {preview ? (
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/60 p-3">
              <p className="text-sm font-medium text-emerald-800 dark:text-emerald-300">
                Подходит клиентов: {preview.total.toLocaleString('ru-RU')}
              </p>
              {preview.sample.length > 0 ? (
                <div className="mt-2 max-h-56 overflow-y-auto overflow-x-auto rounded-md border border-emerald-100 bg-card">
                  <Table>
                    <TableHeader className="sticky top-0 bg-emerald-50 dark:bg-emerald-950/80">
                      <TableRow>
                        <TableHead className="text-xs">Клиент</TableHead>
                        <TableHead className="text-xs">Телефон</TableHead>
                        <TableHead className="text-xs">Договор</TableHead>
                        <TableHead className="text-xs">Продукт</TableHead>
                        <TableHead className="text-xs">Согласие</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.sample.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell className="py-2 text-xs">
                            <span className="font-medium text-zinc-800 dark:text-zinc-200">{c.fullName}</span>
                            <span className="ml-1 font-mono text-zinc-400">{c.externalId}</span>
                          </TableCell>
                          <TableCell className="py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">{c.phone}</TableCell>
                          <TableCell className="py-2">
                            <AgreementStatusBadge status={c.agreementStatus} />
                          </TableCell>
                          <TableCell className="py-2">
                            <ProductBadge product={c.lastProductType} />
                          </TableCell>
                          <TableCell className="py-2">
                            <ConsentBadge status={c.smsConsentStatus} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {/* Проверка недоступна для фиксированного сегмента и незаполненных критериев */}
          <Button
            type="button"
            variant="outline"
            disabled={!conditions || checkMutation.isPending || locked}
            onClick={() => checkMutation.mutate()}
          >
            {checkMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Проверить
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button
              type="button"
              disabled={!canSave || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {initial ? 'Сохранить' : 'Создать'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Подсказка оператора (для дат) — null, если подходит подсказка поля. */
function opHint(op: string): string | null {
  switch (op) {
    case 'birthday_within_next_days':
      return 'Сравнивается месяц и день — без года';
    default:
      return null;
  }
}

// ---------- Список клиентов сегмента ----------

/** Число подходящих клиентов в правильном падеже: 1 клиент / 2 клиента / 5 клиентов. */
function pluralClients(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'клиент';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'клиента';
  return 'клиентов';
}

// ---------- Карточка сегмента: счёт + режим + фиксация состава ----------

/** Карточка сегмента: число подходящих клиентов с режимной подписью
 * (динамический — «живой пересчёт · N мин назад», фиксированный — «срез от …»)
 * и действия фиксации состава. */
function SegmentCard({
  segment,
  onEdit,
  onClone,
  clonePending,
  onDelete,
  onClients,
  onChanged,
}: {
  segment: SegmentItem;
  onEdit: (s: SegmentItem) => void;
  onClone: (s: SegmentItem) => void;
  /** Клонирование в полёте — кнопка заблокирована (анти-дабл-клик). */
  clonePending: boolean;
  onDelete: (s: SegmentItem) => void;
  onClients: (s: SegmentItem) => void;
  onChanged: () => void;
}) {
  // Человекочитаемые правила с метками CF-полей (динамический реестр — общий хук)
  const cfQuery = useCustomFields();
  const allFields = React.useMemo<readonly SegmentFieldDef[]>(
    () => [...SEGMENT_FIELDS, ...(cfQuery.data?.items ?? []).map(cfToSegmentField)],
    [cfQuery.data],
  );
  // GET /segments/{id}/count: «живой» пересчёт для dynamic, замороженное число для static;
  // кэш 5 минут (число не критично), один ретрай.
  const countQuery = useQuery({
    queryKey: ['segment-count', segment.id],
    queryFn: () => api<SegmentCountResponse>(`/api/v1/segments/${segment.id}/count`),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const [confirm, setConfirm] = React.useState<'freeze' | 'refreeze' | 'unfreeze' | null>(null);

  // POST /{id}/freeze — зафиксировать текущий состав в срез (mode → static).
  // Используется и для «Обновить срез» (refreeze): пересоздаёт замороженный список.
  const freezeMutation = useMutation({
    mutationFn: () => api<SegmentItem>(`/api/v1/segments/${segment.id}/freeze`, { method: 'POST' }),
    onSuccess: (updated) => {
      setConfirm(null);
      const n = updated.frozenCount ?? 0;
      toast.success(
        `Состав зафиксирован: ${n.toLocaleString('ru-RU')} ${pluralClients(n)} — число замерло до обновления среза`,
      );
      onChanged();
    },
    onError: (err) => {
      setConfirm(null);
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось зафиксировать';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // POST /{id}/unfreeze — снять фиксацию (mode → dynamic), замороженный список удаляется.
  const unfreezeMutation = useMutation({
    mutationFn: () => api<SegmentItem>(`/api/v1/segments/${segment.id}/unfreeze`, { method: 'POST' }),
    onSuccess: () => {
      setConfirm(null);
      toast.success('Фиксация снята — сегмент снова пересчитывается по условиям');
      onChanged();
    },
    onError: (err) => {
      setConfirm(null);
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось снять фиксацию';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  const isStatic = segment.mode === 'static';
  const rulesText = (segment.conditions.rules ?? []).map((r) => ruleToText(r, allFields));
  const liveTotal = countQuery.data?.total;
  const busy = freezeMutation.isPending || unfreezeMutation.isPending;
  const nowCount =
    liveTotal !== undefined ? `${liveTotal.toLocaleString('ru-RU')} ${pluralClients(liveTotal)}` : null;

  // Тексты и действие для AlertDialog — по типу подтверждения (freeze/refreeze/unfreeze).
  const confirmMeta =
    confirm === 'freeze'
      ? {
          title: `Зафиксировать состав «${segment.name}»?`,
          body: `В срез войдут клиенты, подходящие под условия прямо сейчас${nowCount ? ` — ${nowCount}` : ''}. Число и рассылки по сегменту «замирают» ровно на этом списке — пока вы не обновите срез или не снимете фиксацию.`,
          action: 'Зафиксировать',
          run: () => freezeMutation.mutate(),
        }
      : confirm === 'refreeze'
        ? {
            title: `Обновить срез «${segment.name}»?`,
            body: `Текущий срез${segment.frozenCount !== null ? ` (${segment.frozenCount.toLocaleString('ru-RU')} ${pluralClients(segment.frozenCount)})` : ''} будет заменён на состав, подходящий под условия сейчас${nowCount ? `: ${nowCount}` : ''}.`,
            action: 'Обновить срез',
            run: () => freezeMutation.mutate(),
          }
        : confirm === 'unfreeze'
          ? {
              title: `Снять фиксацию с «${segment.name}»?`,
              body: 'Зафиксированный список будет удалён, сегмент вернётся к живому пересчёту по условиям. Отправленные рассылки и их история не затрагиваются.',
              action: 'Снять фиксацию',
              run: () => unfreezeMutation.mutate(),
            }
          : null;

  return (
    <Card className="flex min-w-0 flex-col shadow-sm">
      <CardContent className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        {/* --- Заголовок: название, описание, бейджи И/ИЛИ и режима --- */}
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 break-words font-semibold text-foreground" title={segment.name}>
              {segment.name}
            </p>
            {segment.description ? (
              <p
                className="mt-0.5 line-clamp-2 break-words text-xs text-zinc-500 dark:text-zinc-400"
                title={segment.description}
              >
                {segment.description}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge
              variant="outline"
              className="border-border bg-muted text-zinc-500 dark:text-zinc-400"
            >
              {segment.conditions.match === 'any' ? 'ИЛИ' : 'И'}
            </Badge>
            <Badge
              variant="outline"
              className={
                isStatic
                  ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400'
                  : 'border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/60 text-zinc-500 dark:text-zinc-400'
              }
            >
              {isStatic ? 'Фиксированный' : 'Динамический'}
            </Badge>
          </div>
        </div>
        {/* --- Условия человекочитаемо (ruleToText) --- */}
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {rulesText.map((t, i) => (
            <Badge
              key={i}
              variant="outline"
              className="max-w-full min-w-0 truncate border-border bg-card font-normal text-zinc-600 dark:text-zinc-400"
              title={t}
            >
              {t}
            </Badge>
          ))}
        </div>
        {/* --- Низ карточки: счётчик + действия (фиксация/клон/правка/удаление) --- */}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onClients(segment)}>
              <Users className="size-4" aria-hidden />
              Клиенты
            </Button>
            {countQuery.isPending ? (
              <span className="text-xs text-zinc-400 dark:text-zinc-500">подсчёт…</span>
            ) : countQuery.data ? (
              <span className="min-w-0">
                <span className="block whitespace-nowrap text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  {countQuery.data.total.toLocaleString('ru-RU')}{' '}
                  {pluralClients(countQuery.data.total)}
                </span>
                <span className="block whitespace-nowrap text-[11px] text-zinc-400 dark:text-zinc-500">
                  {countQuery.data.mode === 'static'
                    ? `срез от ${fmtDT(countQuery.data.frozenAt)}`
                    : `живой пересчёт · ${relTime(countQuery.data.computedAt)}`}
                </span>
              </span>
            ) : null}
          </div>
          <ViewerGuard>
            <div className="flex flex-wrap justify-end gap-1">
              {isStatic ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1.5 px-2 text-xs"
                    title="Заменить срез на состав, подходящий под условия сейчас"
                    disabled={busy}
                    onClick={() => setConfirm('refreeze')}
                  >
                    <RefreshCw className="size-3.5" aria-hidden />
                    Обновить срез
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Снять фиксацию ${segment.name}`}
                    title="Снять фиксацию — вернуть живой пересчёт по условиям"
                    disabled={busy}
                    onClick={() => setConfirm('unfreeze')}
                  >
                    <PinOff className="size-4" aria-hidden />
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2 text-xs"
                  title="Запомнить текущий состав — число перестанет меняться"
                  disabled={busy}
                  onClick={() => setConfirm('freeze')}
                >
                  <Pin className="size-3.5" aria-hidden />
                  Зафиксировать
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Клонировать ${segment.name}`}
                title="Создать копию с теми же условиями (динамическую)"
                // Анти-дабл-клик: иконка без отклика провоцирует повторный клик —
                // два POST = две одинаковые копии (имена не уникальны на сервере)
                disabled={clonePending}
                onClick={() => onClone(segment)}
              >
                <Copy className="size-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Редактировать ${segment.name}`}
                onClick={() => onEdit(segment)}
              >
                <Pencil className="size-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-red-600 dark:text-red-400 hover:text-red-700 dark:text-red-400"
                aria-label={`Удалить ${segment.name}`}
                onClick={() => onDelete(segment)}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          </ViewerGuard>
        </div>
      </CardContent>

      {/* --- Подтверждение фиксации / обновления среза / снятия фиксации --- */}
      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmMeta?.title ?? ''}</AlertDialogTitle>
            <AlertDialogDescription>{confirmMeta?.body ?? ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                // Не закрывать диалог автоматически — закроет onSuccess/onError
                e.preventDefault();
                confirmMeta?.run();
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {confirmMeta?.action ?? ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** Диалог «Клиенты сегмента»: постраничный список GET /segments/{id}/clients.
 *  Для static показывается замороженный срез, для dynamic — клиенты, подходящие сейчас. */
function SegmentClientsDialog({
  segment,
  onOpenChange,
}: {
  segment: SegmentItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [page, setPage] = React.useState(1);
  const pageSize = 20;

  // Человекочитаемые правила с метками CF-полей (динамический реестр — общий хук)
  const cfQuery = useCustomFields();
  const allFields = React.useMemo<readonly SegmentFieldDef[]>(
    () => [...SEGMENT_FIELDS, ...(cfQuery.data?.items ?? []).map(cfToSegmentField)],
    [cfQuery.data],
  );

  // Смена сегмента — возврат на 1-ю страницу списка.
  React.useEffect(() => {
    setPage(1);
  }, [segment?.id]);

  // Постраничный список клиентов сегмента (20 на страницу); пустой segment — диалог закрыт.
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['segment-clients', segment?.id, page],
    enabled: segment !== null,
    queryFn: () =>
      api<Paged<SegmentClientItem>>(
        `/api/v1/segments/${segment?.id}/clients?page=${page}&pageSize=${pageSize}`,
      ),
  });

  const rulesText = React.useMemo(
    () =>
      segment
        ? (segment.conditions.rules ?? []).map((r) => ruleToText(r, allFields))
        : [],
    [segment, allFields],
  );

  return (
    <Dialog open={segment !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{segment?.name ?? ''}</DialogTitle>
          <DialogDescription>
            {segment?.description ||
              (segment?.mode === 'static'
                ? 'Фиксированный срез — состав на момент фиксации, не пересчитывается'
                : 'Клиенты, подходящие под условия сегмента (вычислено сейчас)')}
          </DialogDescription>
        </DialogHeader>
        {/* --- Сводка: сколько клиентов в срезе / подходит --- */}
        {data ? (
          <div className="rounded-md border border-border bg-muted px-3 py-2">
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              {segment?.mode === 'static' ? 'В срезе:' : 'Подходит клиентов:'}{' '}
              <span className="font-semibold text-foreground">
                {data.total.toLocaleString('ru-RU')}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {segment?.mode === 'static'
                ? `Срез зафиксирован ${fmtDT(segment?.frozenAt)} — состав не пересчитывается${
                    segment?.frozenCount != null && segment.frozenCount !== data.total
                      ? `; с момента фиксации удалено клиентов: ${(segment.frozenCount - data.total).toLocaleString('ru-RU')}`
                      : ''
                  }`
                : 'Список ниже — постраничное превью; счёт точный на момент вычисления'}
            </p>
          </div>
        ) : null}
        {/* --- Условия сегмента (бейджи) --- */}
        {rulesText.length > 0 ? (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            <Badge
              variant="outline"
              className="shrink-0 border-zinc-300 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
            >
              {segment?.conditions.match === 'any' ? 'Любое условие' : 'Все условия'}
            </Badge>
            {rulesText.map((t, i) => (
              <Badge
                key={i}
                variant="outline"
                className="max-w-full min-w-0 truncate border-border bg-card font-normal text-zinc-600 dark:text-zinc-400"
                title={t}
              >
                {t}
              </Badge>
            ))}
          </div>
        ) : null}

        {/* --- Таблица клиентов: загрузка / ошибка / пусто / данные + пагинация --- */}
        {isPending ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : (data?.items ?? []).length === 0 ? (
          <EmptyState icon={Users} title="Под условия не подходит ни один клиент" />
        ) : (
          <>
            <div className="max-h-[55vh] overflow-y-auto overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted">
                  <TableRow>
                    <TableHead>Клиент</TableHead>
                    <TableHead>Телефон</TableHead>
                    <TableHead>Договор</TableHead>
                    <TableHead>Продукт</TableHead>
                    <TableHead>Согласие</TableHead>
                    <TableHead>ДР</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.items ?? []).map((c) => (
                    <TableRow key={c.id} className="hover:bg-muted">
                      <TableCell className="py-2.5">
                        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                          {fullNameOf(c)}
                        </span>
                        <span className="ml-1 font-mono text-xs text-zinc-400">{c.client_id}</span>
                      </TableCell>
                      <TableCell className="py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">{c.phone}</TableCell>
                      <TableCell className="py-2.5">
                        <AgreementStatusBadge status={c.agreement_actual_status} />
                      </TableCell>
                      <TableCell className="py-2.5">
                        <ProductBadge product={c.last_product_type} />
                      </TableCell>
                      <TableCell className="py-2.5">
                        <ConsentBadge status={c.smsConsentStatus} />
                      </TableCell>
                      <TableCell className="py-2.5 text-xs text-zinc-500 dark:text-zinc-400">
                        {c.person_birthday ? fmtDate(c.person_birthday) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {data ? (
              <TablePagination page={page} pageSize={pageSize} total={data.total} onPage={setPage} />
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Строка GET /segments/{id}/clients: поля карточки клиента (snake_case) + идентификаторы. */
interface SegmentClientItem {
  id: string;
  client_id: string;
  phone: string;
  client_last_name: string | null;
  client_first_name: string | null;
  client_middle_name: string | null;
  agreement_actual_status: number | null;
  last_product_type: 'PDL' | 'IL' | null;
  smsConsentStatus: 'NONE' | 'PENDING' | 'GRANTED' | 'REVOKED';
  person_birthday: string | null;
}

/** ФИО из трёх полей карточки; если все пусты — fallback на client_id. */
function fullNameOf(c: SegmentClientItem): string {
  const parts = [c.client_last_name, c.client_first_name, c.client_middle_name].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : c.client_id;
}

// ---------- Основной экран ----------

/** Корневой экран «Сегменты»: сетка карточек SegmentCard + диалоги
 *  (конструктор, клиенты сегмента, подтверждение удаления). */
export function SegmentsView() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState<SegmentItem | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [detail, setDetail] = React.useState<SegmentItem | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<SegmentItem | null>(null);

  // Клонирование — новый сегмент с теми же условиями (имя + «копия»)
  const cloneMutation = useMutation({
    mutationFn: async (s: SegmentItem) =>
      api<SegmentItem>('/api/v1/segments', {
        method: 'POST',
        body: {
          name: `${s.name} (копия)`.slice(0, 120),
          description: s.description ?? undefined,
          conditions: s.conditions,
        },
      }),
    onSuccess: () => {
      toast.success('Копия сегмента создана — переименуйте и правьте условия');
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось скопировать';
      toast.error(`Ошибка: ${detail}`);
    },
  });

  // Все сегменты одним запросом (pageSize=100 — пагинация не нужна, сегментов немного).
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['segments'],
    queryFn: () => api<Paged<SegmentItem>>('/api/v1/segments?pageSize=100'),
  });

  // DELETE /segments/{id} — удаляются только условия; клиенты и история рассылок не затрагиваются.
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api<void>(`/api/v1/segments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Сегмент удалён');
      setDeleteTarget(null);
      invalidatePanel(queryClient);
    },
    onError: (err) => {
      const detail = err instanceof ApiError ? (err.detail ?? err.title) : 'Не удалось удалить сегмент';
      toast.error(`Ошибка: ${detail}`);
      setDeleteTarget(null);
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      {/* --- Заголовок: пояснение + «Создать сегмент» (VIEWER — только просмотр) --- */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
          Сегменты собирают клиентов по полям карточки: статусы договоров,
          преапрувы, даты, счётчики. Динамический сегмент пересчитывается при каждом
          использовании — число живёт вместе с базой; «Зафиксировать» замораживает текущий
          состав в срез для повторяемых рассылок. Основа рассылок по сегментам.
        </p>
        <ViewerGuard>
          <Button
            className="shrink-0"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-4" aria-hidden />
            Создать сегмент
          </Button>
        </ViewerGuard>
      </div>

      {/* --- Сетка карточек: загрузка / ошибка / пусто / список --- */}
      {isPending ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="Сегментов пока нет"
          action={
            <ViewerGuard>
              <Button variant="outline" size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }}>
                <Plus className="size-4" aria-hidden />
                Создать первый сегмент
              </Button>
            </ViewerGuard>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {items.map((s) => (
            <SegmentCard
              key={s.id}
              segment={s}
              onEdit={(seg) => {
                setEditing(seg);
                setDialogOpen(true);
              }}
              onClone={(seg) => cloneMutation.mutate(seg)}
              clonePending={cloneMutation.isPending}
              onDelete={setDeleteTarget}
              onClients={setDetail}
              onChanged={() => {
                invalidatePanel(queryClient);
                void refetch();
              }}
            />
          ))}
        </div>
      )}

      {/* --- Диалоги: конструктор / клиенты сегмента / подтверждение удаления --- */}
      <SegmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
        onSaved={() => void refetch()}
      />

      <SegmentClientsDialog segment={detail} onOpenChange={(open) => !open && setDetail(null)} />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить сегмент «{deleteTarget?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Условия будут удалены. Клиенты и настройки не изменяются; рассылки, использовавшие
              сегмент, не затрагиваются.
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
    </div>
  );
}
