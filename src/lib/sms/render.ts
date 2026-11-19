// Движок рендера SMS-шаблонов. Изоморфный модуль — используется и на
// сервере (воркер, рассылки, предпросмотр), и на клиенте (live-предпросмотр).
//
// Синтаксис (адаптирован под наши {{}}):
//   {{var}}                          — подстановка; отсутствие → RenderError
//   {{var|default:Клиент}}           — значение по умолчанию (или default:"текст")
//   {{var|money}}                    — «15 000 ₽» (разряды + валюта)
//   {{var|number}}                   — «15 000» (разряды)
//   {{var|date}}                     — ISO-дата → «25.12.2025» (dd.mm.yyyy проходит как есть)
//   {{var|upper}} / {{var|lower}} / {{var|ucfirst}}
//   {{var|urlencode}}                — кодирование для URL
//   фильтры цепочкой: {{loan_amount|default:0|money}}
//   {{#if expr}}…{{#else}}…{{#end}} — условие; expr: «var», «var==5», «var>=3»,
//                                     «var~=подстрока»; отсутствующая в условии
//                                     переменная = ложь для ЛЮБОГО оператора (не ошибка)
//   {{#variant}}…{{#or}}…{{#end}}   — случайный вариант («крутилка» для маркетинга)
//   {{#cancel}}                      — тихая отмена отправки (не ошибка)
//
// Операторы условий: == != > >= < <= ~= (содержит) !~ (не содержит).
// Отмена отправки — result.cancelled=true; текст при этом пустой.
/**
 * Ошибка рендера: синтаксическая ошибка шаблона или отсутствие переменной
 * без дефолта. Дорожка влияния: executors.ts переводит SMS-узел в FAIL
 * (экземпляр воронки останавливается); рассылки — в ошибку отправки.
 */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

/** Итог рендера: текст либо признак тихой отмены отправки (не ошибка). */
export interface RenderResult {
  text: string;
  /** true — шаблон отменил отправку ({{#cancel}} или пустой результат). */
  cancelled: boolean;
  /** Почему отменено: директива {{#cancel}} или пустой результат рендера. */
  cancelReason?: 'template' | 'empty';
}

// ---------- AST ----------

type Filter =
  | { kind: 'default'; value: string }
  | { kind: 'money' }
  | { kind: 'number' }
  | { kind: 'date' }
  | { kind: 'upper' }
  | { kind: 'lower' }
  | { kind: 'ucfirst' }
  | { kind: 'urlencode' };

type CmpOp = '==' | '!=' | '>' | '>=' | '<' | '<=' | '~=' | '!~';

interface Expr {
  name: string;
  op?: CmpOp;
  value?: string;
}

type Node =
  | { type: 'text'; text: string }
  | { type: 'var'; name: string; filters: Filter[] }
  | { type: 'if'; expr: Expr; then: Node[]; otherwise: Node[] | null }
  | { type: 'variant'; choices: Node[][] }
  | { type: 'cancel' };

// ---------- Токенизация ----------

// Директива — содержимое {{...}} без вложенных фигурных скобок; всё между
// директивами — литеральный текст.
const DIRECTIVE_RE = /\{\{([^{}]*)\}\}/;

/** Разбор тела шаблона на чередование текста и директив {{...}} (сырой разбор без интерпретации). */
function tokenize(body: string): Array<{ kind: 'text'; text: string } | { kind: 'directive'; raw: string }> {
  const tokens: Array<{ kind: 'text'; text: string } | { kind: 'directive'; raw: string }> = [];
  let rest = body;
  for (;;) {
    const m = DIRECTIVE_RE.exec(rest);
    if (!m || m.index === undefined) {
      if (rest.length > 0) tokens.push({ kind: 'text', text: rest });
      return tokens;
    }
    if (m.index > 0) tokens.push({ kind: 'text', text: rest.slice(0, m.index) });
    tokens.push({ kind: 'directive', raw: m[1].trim() });
    rest = rest.slice(m.index + m[0].length);
  }
}

// ---------- Разбор директив ----------

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const OPS: CmpOp[] = ['==', '!=', '>=', '<=', '>', '<', '~=', '!~'];

/** Разбор директивы-переменной: имя + цепочка фильтров через «|» (значения —
 * до следующего «|» или в двойных кавычках для значений с «|»/пробелами).
 * Примеры: {{name | default:"Клиент" | upper}}, {{sum | money}}. */
function parseVarDirective(raw: string, ctx: string): Node {
  // «|» до всего остального отделяет имя переменной от цепочки фильтров:
  // {{name|default:Клиент}} → name="name", rest="default:Клиент".
  const pipe = raw.indexOf('|');
  const name = (pipe === -1 ? raw : raw.slice(0, pipe)).trim();
  if (!NAME_RE.test(name)) {
    throw new RenderError(`${ctx}: некорректное имя переменной «${name}»`);
  }
  const filters: Filter[] = [];
  if (pipe !== -1) {
    // Цикл по фильтрам: каждый — «kind» или «kind:value»; value в кавычках
    // может содержать «|» и пробелы (default:"нет данных"), без кавычек —
    // до следующего «|» с обрезкой пробелов. Ошибки именуются с ctx (позиция
    // в шаблоне), чтобы автор понял, КАКАЯ директива сломана.
    let rest = raw.slice(pipe + 1);
    while (rest.length > 0) {
      const colon = rest.indexOf(':');
      const kind = (colon === -1 ? rest : rest.slice(0, colon)).trim();
      let value = '';
      if (colon !== -1) {
        rest = rest.slice(colon + 1);
        if (rest.startsWith('"')) {
          // Кавычечное значение: до закрывающей кавычки, дальше только «|» или конец.
          const end = rest.indexOf('"', 1);
          if (end === -1) throw new RenderError(`${ctx}: незакрытая кавычка в фильтре «${kind}»`);
          value = rest.slice(1, end);
          rest = rest.slice(end + 1);
          if (rest.startsWith('|')) rest = rest.slice(1);
          else if (rest.trim().length > 0) throw new RenderError(`${ctx}: лишние символы после фильтра «${kind}»`);
          else rest = '';
        } else {
          // Голое значение: до следующего «|» (default:Клиент|upper).
          const nextPipe = rest.indexOf('|');
          value = (nextPipe === -1 ? rest : rest.slice(0, nextPipe)).trim();
          rest = nextPipe === -1 ? '' : rest.slice(nextPipe + 1);
        }
      } else {
        rest = '';
      }
      switch (kind) {
        case 'default':
          filters.push({ kind: 'default', value });
          break;
        case 'money':
        case 'number':
        case 'date':
        case 'upper':
        case 'lower':
        case 'ucfirst':
        case 'urlencode':
          if (value !== '') throw new RenderError(`${ctx}: фильтр «${kind}» не принимает значение`);
          filters.push({ kind });
          break;
        default:
          throw new RenderError(`${ctx}: неизвестный фильтр «${kind}»`);
      }
    }
  }
  return { type: 'var', name, filters };
}

/** Разбор условия {{#if ...}}: «имя», «имя оператор значение» (значение — голое
 * или в кавычках; операторы — OPS). Ошибка — RenderError с контекстом. */
function parseExpr(raw: string, ctx: string): Expr {
  const trimmed = raw.trim();
  const found = findOperatorOutsideQuotes(trimmed);
  if (found !== null) {
    const name = trimmed.slice(0, found.index).trim();
    const value = trimmed.slice(found.index + found.op.length).trim();
    if (!NAME_RE.test(name)) {
      throw new RenderError(`${ctx}: некорректное имя переменной в условии «${name}»`);
    }
    if (value.length === 0) {
      throw new RenderError(`${ctx}: не указано значение для сравнения «${found.op}»`);
    }
    return { name, op: found.op, value: unquote(value) };
  }
  if (!NAME_RE.test(trimmed)) {
    throw new RenderError(`${ctx}: некорректное условие «${trimmed}»`);
  }
  return { name: trimmed };
}

/** Поиск оператора сравнения ВНЕ кавычек (значение вида "A!=" не должно ломать разбор).
 * Двухсимвольные операторы проверяются раньше односимвольных. */
function findOperatorOutsideQuotes(s: string): { op: CmpOp; index: number } | null {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // строковый литерал ДО оператора: слева от оператора может быть только имя переменной
      return null;
    }
    for (const op of OPS) {
      if (s.startsWith(op, i)) return { op, index: i };
    }
  }
  return null;
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

// ---------- Парсер ----------

interface ParseState {
  tokens: ReturnType<typeof tokenize>;
  pos: number;
}

function peek(t: ParseState): { kind: 'text'; text: string } | { kind: 'directive'; raw: string } | null {
  return t.tokens[t.pos] ?? null;
}

function next(t: ParseState): { kind: 'text'; text: string } | { kind: 'directive'; raw: string } | null {
  return t.tokens[t.pos++] ?? null;
}

/** Разбор последовательности узлов до закрывающей директивы (#end/#else/#or).
 *  Рекурсивный спуск: каждый #if/#variant ВЫЗЫВАЕТ parseNodes для своего тела,
 *  передавая список допустимых стоп-слов; встретив стоп-слово, возвращаем его
 *  вызывающему — он решает, продолжать (следующая ветка #or) или закрыть блок. */
function parseNodes(t: ParseState, stops: string[], ctx: string): { nodes: Node[]; stop: string | null } {
  const nodes: Node[] = [];
  for (;;) {
    const tok = next(t);
    if (tok === null) {
      // Конец токенов: на верхнем уровне (stops пуст) — норма; внутри блока —
      // незакрытый {{#if}}/{{#variant}}, ошибка с ожидаемой директивой.
      if (stops.length > 0) throw new RenderError(`${ctx}: не закрыт блок (ожидается {{${stops[0]}}})`);
      return { nodes, stop: null };
    }
    if (tok.kind === 'text') {
      nodes.push({ type: 'text', text: tok.text });
      continue;
    }
    const raw = tok.raw;
    if (raw === '#cancel') {
      nodes.push({ type: 'cancel' });
      continue;
    }
    if (raw.startsWith('#if')) {
      // {{#if}}: тело до #else/#end; после #else — вторая ветка до #end.
      const exprSrc = raw.slice(3);
      if (exprSrc.trim().length === 0) throw new RenderError(`${ctx}: пустое условие в {{#if}}`);
      const expr = parseExpr(exprSrc, ctx);
      const thenPart = parseNodes(t, ['#else', '#end'], ctx);
      if (thenPart.stop === null) throw new RenderError(`${ctx}: {{#if}} без {{#end}}`);
      let otherwise: Node[] | null = null;
      if (thenPart.stop === '#else') {
        const elsePart = parseNodes(t, ['#end'], ctx);
        if (elsePart.stop === null) throw new RenderError(`${ctx}: {{#else}} без {{#end}}`);
        otherwise = elsePart.nodes;
      }
      nodes.push({ type: 'if', expr, then: thenPart.nodes, otherwise });
      continue;
    }
    if (raw === '#variant') {
      // {{#variant}}: ветки собираем циклом, пока parseNodes возвращает #or
      // (следующая альтернатива); #end замыкает список choices.
      const choices: Node[][] = [];
      for (;;) {
        const part = parseNodes(t, ['#or', '#end'], ctx);
        if (part.stop === null) throw new RenderError(`${ctx}: {{#variant}} без {{#end}}`);
        choices.push(part.nodes);
        if (part.stop === '#end') break;
      }
      nodes.push({ type: 'variant', choices });
      continue;
    }
    if (raw.startsWith('#')) {
      // Прочее «#»-слово: либо наш стоп (возвращаем вызывающему блоку),
      // либо мусорная директива — ошибкой, чтобы не вывести её как текст.
      const word = raw.split(/\s+/)[0];
      if (stops.includes(word)) {
        return { nodes, stop: word };
      }
      throw new RenderError(`${ctx}: неожиданная директива {{${raw}}} (ожидается {{#end}})`);
    }
    nodes.push(parseVarDirective(raw, ctx));
  }
}

const astCache = new Map<string, Node[]>();

/**
 * Разбор шаблона в AST с кэшем: одно тело рендерится тысячи раз (рассылки по
 * сегменту), парсить каждый раз дорого. Кэш сбрасывается целиком после 500
 * тел (защита от раздувания памяти у динамически порождаемых шаблонов).
 */
function parseTemplate(body: string): Node[] {
  const cached = astCache.get(body);
  if (cached) return cached;
  const t: ParseState = { tokens: tokenize(body), pos: 0 };
  const { nodes } = parseNodes(t, [], 'шаблон');
  if (astCache.size > 500) astCache.clear();
  astCache.set(body, nodes);
  return nodes;
}

// ---------- Вычисление ----------

/** Значение переменной (только собственные ключи — без прототипа) либо undefined. */
function lookupVar(vars: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
  return undefined;
}

/** Приведение к «истине» для {{#if}}: пустая строка/0/null/undefined — ложь. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  return true;
}

/** Применение фильтра к строке (money/number терпимы к пробелам и запятой;
 * date ISO → dd.mm.yyyy, dd.mm.yyyy проходит как есть). */
function applyFilter(value: string, filter: Filter, name: string): string {
  switch (filter.kind) {
    case 'default':
      return value === '' ? filter.value : value;
    case 'money':
    case 'number': {
      const num = Number(value.replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(num)) return value;
      const grouped = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(num);
      // NBSP (U+00A0) — разделитель разрядов ru-RU — НЕ входит в GSM-7: латинский
      // шаблон с {{x|number}} молча переводился в UCS-2 (160→70 символов на часть,
      // ×2 тариф). Заменяем на обычный пробел — визуально неотличимо в SMS.
      // «₽» в money всё равно переводит сообщение в UCS-2 — это осознанно.
      const sms = grouped.replace(/[\u00a0\u202f]/g, ' ');
      return filter.kind === 'money' ? `${sms} ₽` : sms;
    }
    case 'date': {
      const v = value.trim();
      if (/^\d{2}\.\d{2}\.\d{4}$/.test(v)) return v; // уже dd.mm.yyyy
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
      if (m) return `${m[3]}.${m[2]}.${m[1]}`;
      return v;
    }
    case 'upper':
      return value.toUpperCase();
    case 'lower':
      return value.toLowerCase();
    case 'ucfirst':
      return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
    case 'urlencode':
      return encodeURIComponent(value);
  }
}

/** Нормализация числа для ЧИСЛОВОГО сравнения — 1:1 с фильтром money/number
 *  (иначе фильтр и {{#if}} расходились бы на одних и тех же данных):
 *  пробелы-разделители разрядов срезаются, запятая — десятичный разделитель.
 *  "3 500"→3500, "3,5"→3.5; "1,000,000" — не число (NaN), как и в фильтре. */
function parseCompareNumber(raw: string): number {
  return Number(raw.replace(/\s/g, '').replace(',', '.'));
}

/** Дата дд.мм.гггг в сортируемый ключ ГГГГММДД (строка — лексикографический
 *  порядок совпадает с хронологическим). Карточные даты приходят именно в
 *  этом формате — лексикографическое сравнение «25.12.2025» > «01.01.2026»
 *  давало бы тихо неверную ветку воронки. */
function dateKeyRu(s: string): string | null {
  return /^(\d{2})\.(\d{2})\.(\d{4})$/.test(s.trim())
    ? `${s.trim().slice(6)}${s.trim().slice(3, 5)}${s.trim().slice(0, 2)}`
    : null;
}

/** Вычисление условия {{#if}} (семантика операторов — в шапке файла и
 * комментариях ниже по коду). */
function evalExpr(expr: Expr, vars: Record<string, unknown>): boolean {
  const value = lookupVar(vars, expr.name);
  if (expr.op === undefined) return truthy(value);
  // Отсутствующая переменная (именно undefined, не пустая строка) = ложь для любого
  // оператора — заявленная семантика условий; иначе «нет значения» вело бы себя как
  // «значение ≠ X» и заводило воронки/рассылки в then-ветку с ошибкой рендера.
  if (value === undefined) return false;
  const left = value === null ? '' : String(value);
  const right = expr.value ?? '';
  // Обе стороны — даты дд.мм.гггг: сравниваем хронологически (через ключ
  // ГГГГММДД), а не лексикографически по исходной строке.
  const leftDate = dateKeyRu(left);
  const rightDate = dateKeyRu(right);
  if (leftDate !== null && rightDate !== null) {
    switch (expr.op) {
      case '==':
        return leftDate === rightDate;
      case '!=':
        return leftDate !== rightDate;
      case '>':
        return leftDate > rightDate;
      case '>=':
        return leftDate >= rightDate;
      case '<':
        return leftDate < rightDate;
      case '<=':
        return leftDate <= rightDate;
      // ~= / !~ для дат — строковая семантика ниже (по исходному написанию)
    }
  }
  // Числовое сравнение — только когда обе стороны выглядят числами;
  // нормализация 1:1 с фильтром money (пробелы-разряды, запятая-десятичная)
  const leftNum = parseCompareNumber(left);
  const rightNum = parseCompareNumber(right);
  const bothNum =
    left.trim() !== '' &&
    right.trim() !== '' &&
    Number.isFinite(leftNum) &&
    Number.isFinite(rightNum);
  switch (expr.op) {
    case '==':
      return bothNum ? leftNum === rightNum : left.trim() === right;
    case '!=':
      return bothNum ? leftNum !== rightNum : left.trim() !== right;
    case '>':
      return bothNum ? leftNum > rightNum : left > right;
    case '>=':
      return bothNum ? leftNum >= rightNum : left >= right;
    case '<':
      return bothNum ? leftNum < rightNum : left < right;
    case '<=':
      return bothNum ? leftNum <= rightNum : left <= right;
    case '~=':
      return left.toLowerCase().includes(right.toLowerCase());
    case '!~':
      return !left.toLowerCase().includes(right.toLowerCase());
  }
}

/**
 * Обход AST с накоплением текста в out.parts. {{#cancel}} останавливает обход
 * ЦЕЛИКОМ (весь результат отменяется, а не только хвост). rng — выбор веток
 * {{#variant}}: детерминированный ГПСЧ по сиду (см. RenderOptions) либо Math.random.
 */
function evalNodes(
  nodes: Node[],
  vars: Record<string, unknown>,
  out: { parts: string[]; cancelled: boolean },
  rng: () => number,
): void {
  for (const node of nodes) {
    if (out.cancelled) return;
    switch (node.type) {
      case 'text':
        out.parts.push(node.text);
        break;
      case 'cancel':
        out.cancelled = true;
        return;
      case 'if':
        if (evalExpr(node.expr, vars)) {
          evalNodes(node.then, vars, out, rng);
        } else if (node.otherwise !== null) {
          evalNodes(node.otherwise, vars, out, rng);
        }
        break;
      case 'variant': {
        const idx = Math.floor(rng() * node.choices.length);
        evalNodes(node.choices[idx], vars, out, rng);
        break;
      }
      case 'var': {
        const raw = lookupVar(vars, node.name);
        let value: string;
        if (raw === null || raw === undefined) {
          const hasDefault = node.filters.some((f) => f.kind === 'default');
          if (!hasDefault) {
            throw new RenderError(`Не заполнена переменная: {{${node.name}}}`);
          }
          value = '';
        } else {
          value = String(raw);
        }
        let filtered = value;
        for (const f of node.filters) {
          filtered = applyFilter(filtered, f, node.name);
        }
        out.parts.push(filtered);
        break;
      }
    }
  }
}

// ---------- Публичный API ----------

export interface RenderOptions {
  /** СИД выбора вариантов {{#variant}} — детерминированный «крутилки»:
   * один и тот же сид → один и тот же вариант (живой предпросмотр не мерцает;
   * отправки сеются идентификатором клиента — у каждого клиента свой стабильный
   * вариант, распределение по базе сохраняется). Без сида — случайный выбор
   * на каждый вызов (легаси-поведение). */
  variantSeed?: string;
}

/** FNV-1a хэш строки → 32-бит (детерминированный сид ГПСЧ). */
function fnv1a(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — маленький детерминированный ГПСЧ (последовательность по сиду). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Полный рендер. Ошибки синтаксиса и отсутствие переменной без дефолта → RenderError.
 * Пустой/пустой-по-пробелам результат = тихая отмена (провайдер пустое SMS не примет). */
export function renderTemplate(
  body: string,
  vars: Record<string, unknown>,
  options?: RenderOptions,
): RenderResult {
  const nodes = parseTemplate(body);
  const out = { parts: [] as string[], cancelled: false, cancelReason: undefined as 'template' | 'empty' | undefined };
  const rng = options?.variantSeed !== undefined ? mulberry32(fnv1a(options.variantSeed)) : Math.random;
  evalNodes(nodes, vars, out, rng);
  if (out.cancelled) return { text: '', cancelled: true, cancelReason: 'template' };
  const text = out.parts.join('');
  if (text.trim() === '') {
    // все условия ложны и текста вне блоков нет — отправлять нечего
    return { text: '', cancelled: true, cancelReason: 'empty' };
  }
  return { text, cancelled: false };
}

function collectVars(nodes: Node[], acc: Map<string, boolean>): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'var': {
        const hasDefault = node.filters.some((f) => f.kind === 'default');
        acc.set(node.name, (acc.get(node.name) ?? true) && hasDefault);
        break;
      }
      case 'if':
        acc.set(node.expr.name, acc.get(node.expr.name) ?? true); // в условии — не обязательна
        collectVars(node.then, acc);
        if (node.otherwise) collectVars(node.otherwise, acc);
        break;
      case 'variant':
        for (const c of node.choices) collectVars(c, acc);
        break;
      default:
        break;
    }
  }
}

/**
 * Все переменные шаблона (включая использованные в условиях), в порядке появления.
 */
export function extractVariables(body: string): string[] {
  try {
    const acc = new Map<string, boolean>();
    collectVars(parseTemplate(body), acc);
    return Array.from(acc.keys());
  } catch {
    // синтаксически битый шаблон — старый регэксп, чтобы UI показывал хоть что-то
    const seen = new Set<string>();
    const result: string[] = [];
    for (const m of body.matchAll(/\{\{\s*([A-Za-z0-9_.]+)[|}\s]/g)) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        result.push(m[1]);
      }
    }
    return result;
  }
}

/**
 * Переменные БЕЗ дефолта хотя бы в одном использовании — обязательные для рендера
 * (для валидации рассылок: карточка клиента должна их содержать).
 */
export function requiredVariables(body: string): string[] {
  try {
    const acc = new Map<string, boolean>();
    collectVars(parseTemplate(body), acc);
    return Array.from(acc.entries())
      .filter(([, hasDefault]) => !hasDefault)
      .map(([name]) => name);
  } catch {
    return extractVariables(body);
  }
}

/** Проверка синтаксиса без рендера: возвращает список ошибок (пустой = ок). */
export function validateTemplateSyntax(body: string): string[] {
  try {
    parseTemplate(body);
    return [];
  } catch (e) {
    return [e instanceof RenderError ? e.message : String(e)];
  }
}

/** Максимальная длина строкового значения переменной в снимке (остальное — «…»). */
const SNAPSHOT_VALUE_MAX = 200;

/**
 * Снимок переменных сообщения (P6): {имя: значение|null} — только переменные,
 * реально использованные шаблоном ({{var}}, условия, варианты), со значениями
 * на момент рендера. Переменная без значения → null: по снимку видно и «что
 * подставилось», и «чего не было» (рендер взял дефолт или оставил плейсхолдер).
 *
 * Значения: Date → ISO (снапшот — для разбора полётов, не для людей), булевы и
 * числа — как есть, строки длиннее SNAPSHOT_VALUE_MAX усекаются (мегабайтные
 * payload-переменные не раздувают SMS-лог). Никогда не бросает — снимок не
 * должен ломать создание сообщения.
 * Возвращает JSON-строку для колонки SmsMessage.varsSnapshot либо null
 * (шаблон без переменных — снимок не нужен).
 */
export function snapshotVars(
  body: string,
  vars: Record<string, unknown>,
): string | null {
  try {
    const names = extractVariables(body);
    if (names.length === 0) return null;
    const snap: Record<string, unknown> = {};
    for (const name of names) {
      const value = vars[name];
      if (value === undefined || value === null) {
        snap[name] = null;
      } else if (value instanceof Date) {
        snap[name] = Number.isNaN(value.getTime()) ? null : value.toISOString();
      } else if (typeof value === 'string') {
        snap[name] =
          value.length > SNAPSHOT_VALUE_MAX ? `${value.slice(0, SNAPSHOT_VALUE_MAX)}…` : value;
      } else {
        const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
        snap[name] =
          str.length > SNAPSHOT_VALUE_MAX ? `${str.slice(0, SNAPSHOT_VALUE_MAX)}…` : str;
      }
    }
    return JSON.stringify(snap);
  } catch {
    return null; // битый шаблон/несериализуемое значение — снимок просто отсутствует
  }
}
