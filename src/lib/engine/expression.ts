// Безопасный вычислитель выражений условий воронок (без eval, без Function,
// без доступа к методам — только обход «плоских» свойств замороженного контекста).
//
// Грамматика (рекурсивный спуск):
//   expr   := or
//   or     := and ('||' and)*
//   and    := not ('&&' not)*
//   not    := '!' not | cmp
//   cmp    := primary (('=='|'!='|'>='|'<='|'>'|'<') primary)?
//   primary:= '(' expr ')' | literal | path
//   literal:= number | 'string' | "string" | true | false | null
//   path   := ident ('.' ident)* — корень строго из {client, payload, event, vars};
//             ГОЛОЕ имя (не корень) — неявный путь в vars: условия видят те же
//             переменные, что и шаблоны SMS ({{agreement_actual_status}})
//
// Семантика: числа сравниваются численно, строки — лексикографически; несоответствие
// типов → false для упорядочивания и для ==; null == null → true; отсутствие пути → null.

/**
 * Допустимые корни путей в выражении: client / payload / event / vars.
 * Голое имя (не из списка) трактуется как путь в vars — единое пространство
 * имён с переменными шаблонов SMS (см. parsePath).
 */
export const ROOT_IDENTIFIERS = ['client', 'payload', 'event', 'vars'] as const;
const ROOT_SET = new Set<string>(ROOT_IDENTIFIERS);

/** Ошибка валидации/синтаксиса выражения — поймается при сохранении воронки (422). */
export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/** Контекст вычисления: те же данные, что уходят в рендер шаблона. */
export interface EvalContext {
  client: Record<string, unknown>;
  payload: Record<string, unknown>;
  event: string;
  vars: Record<string, unknown>;
}

// ---------- Токены ----------

// Лексер: строка → поток токенов (операторы/скобки/числа/строки/идентификаторы).
// Двухсимвольные операторы (==, !=, >=, <=, &&, ||) разбираются раньше
// односимвольных (> < !). Бросает ExpressionError на недопустимом символе
// и незакрытой строке/эскейпе.

type Token =
  | { t: 'op'; v: '==' | '!=' | '>=' | '<=' | '>' | '<' | '&&' | '||' | '!' }
  | { t: 'punct'; v: '(' | ')' | '.' }
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; v: string };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '>=' || two === '<=' || two === '&&' || two === '||') {
      tokens.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (ch === '>' || ch === '<' || ch === '!') {
      tokens.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '.') {
      tokens.push({ t: 'punct', v: ch });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let s = '';
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
          const esc = src[i + 1];
          if (esc === undefined) throw new ExpressionError('Незакрытая экранирующая последовательность в строке');
          if (esc === 'n') s += '\n';
          else if (esc === 't') s += '\t';
          else s += esc;
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        s += c;
        i++;
      }
      if (!closed) throw new ExpressionError('Незакрытая строковый литерал');
      tokens.push({ t: 'str', v: s });
      continue;
    }
    if (DIGIT.test(ch)) {
      let num = '';
      while (i < src.length && DIGIT.test(src[i])) {
        num += src[i];
        i++;
      }
      // дробная часть: '.' считается частью числа, только если за ним цифра
      if (src[i] === '.' && src[i + 1] !== undefined && DIGIT.test(src[i + 1])) {
        num += '.';
        i++;
        while (i < src.length && DIGIT.test(src[i])) {
          num += src[i];
          i++;
        }
      }
      const value = Number(num);
      if (!Number.isFinite(value)) throw new ExpressionError(`Некорректное число: ${num}`);
      tokens.push({ t: 'num', v: value });
      continue;
    }
    if (IDENT_START.test(ch)) {
      let ident = '';
      while (i < src.length && IDENT_PART.test(src[i])) {
        ident += src[i];
        i++;
      }
      tokens.push({ t: 'ident', v: ident });
      continue;
    }
    throw new ExpressionError(`Недопустимый символ: «${ch}»`);
  }
  return tokens;
}

// ---------- AST ----------

// Узлы дерева разбора; логические связки левоассоциативны.

type AstNode =
  | { kind: 'or'; left: AstNode; right: AstNode }
  | { kind: 'and'; left: AstNode; right: AstNode }
  | { kind: 'not'; operand: AstNode }
  | { kind: 'cmp'; op: '==' | '!=' | '>' | '>=' | '<' | '<='; left: AstNode; right: AstNode }
  | { kind: 'lit'; value: string | number | boolean | null }
  | { kind: 'path'; segments: string[] };

/**
 * Рекурсивный спуск по грамматике из шапки файла. Методы перечислены по
 * убыванию приоритета: or → and → not → cmp → primary (скобки меняют порядок).
 * parse() следит, что за выражением не осталось «лишних» токенов.
 */
class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private expectPunct(v: '(' | ')'): void {
    const tok = this.next();
    if (!tok || tok.t !== 'punct' || tok.v !== v) {
      throw new ExpressionError(`Ожидался символ «${v}»`);
    }
  }

  parse(): AstNode {
    if (this.tokens.length === 0) {
      throw new ExpressionError('Пустое выражение');
    }
    const node = this.parseOr();
    const trailing = this.peek();
    if (trailing) {
      throw new ExpressionError(`Лишние символы после конца выражения (позиция ${this.pos})`);
    }
    return node;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (true) {
      const tok = this.peek();
      if (tok && tok.t === 'op' && tok.v === '||') {
        this.next();
        const right = this.parseAnd();
        left = { kind: 'or', left, right };
      } else {
        return left;
      }
    }
  }

  private parseAnd(): AstNode {
    let left = this.parseNot();
    while (true) {
      const tok = this.peek();
      if (tok && tok.t === 'op' && tok.v === '&&') {
        this.next();
        const right = this.parseNot();
        left = { kind: 'and', left, right };
      } else {
        return left;
      }
    }
  }

  private parseNot(): AstNode {
    const tok = this.peek();
    if (tok && tok.t === 'op' && tok.v === '!') {
      this.next();
      return { kind: 'not', operand: this.parseNot() };
    }
    return this.parseCmp();
  }

  private parseCmp(): AstNode {
    const left = this.parsePrimary();
    const tok = this.peek();
    if (tok && tok.t === 'op' && ['==', '!=', '>', '>=', '<', '<='].includes(tok.v)) {
      this.next();
      const right = this.parsePrimary();
      return { kind: 'cmp', op: tok.v as '==' | '!=' | '>' | '>=' | '<' | '<=', left, right };
    }
    return left;
  }

  private parsePrimary(): AstNode {
    const tok = this.next();
    if (!tok) throw new ExpressionError('Неожиданный конец выражения');
    if (tok.t === 'punct' && tok.v === '(') {
      const inner = this.parseOr();
      this.expectPunct(')');
      return inner;
    }
    if (tok.t === 'num') return { kind: 'lit', value: tok.v };
    if (tok.t === 'str') return { kind: 'lit', value: tok.v };
    if (tok.t === 'ident') {
      if (tok.v === 'true') return { kind: 'lit', value: true };
      if (tok.v === 'false') return { kind: 'lit', value: false };
      if (tok.v === 'null') return { kind: 'lit', value: null };
      return this.parsePath(tok.v);
    }
    throw new ExpressionError(`Неожиданный токен: «${String(tok.v)}»`);
  }

  private parsePath(first: string): AstNode {
    const implicitVars = !ROOT_SET.has(first);
    // Голое имя (не client/payload/event/vars) — неявный путь в vars:
    // условие видит переменные шаблона (agreement_actual_status, overdue_days, ...).
    const segments = [implicitVars ? 'vars' : first];
    if (implicitVars) segments.push(first);
    while (true) {
      const dot = this.peek();
      if (dot && dot.t === 'punct' && dot.v === '.') {
        this.next();
        const ident = this.next();
        if (!ident || ident.t !== 'ident') {
          throw new ExpressionError(`После «.» ожидается имя свойства в пути ${segments.join('.')}`);
        }
        segments.push(ident.v);
      } else {
        return { kind: 'path', segments };
      }
    }
  }
}

// ---------- Вычисление ----------

/** Приведение значения к boolean — JS-семантика (число 0, пустая строка, null → false). */
function truthy(value: unknown): boolean {
  return Boolean(value);
}

/**
 * Обход цепочки вложенных свойств от корня контекста. Возвращает null при
 * обрыве пути — ЭТО ЗАЩИТА: не выходим за «плоские» данные, не читаем
 * прототип (hasOwnProperty), не вызываем методы (typeof !== 'object' → null).
 */
function resolvePath(segments: string[], ctx: EvalContext): unknown {
  let current: unknown = ctx;
  for (const seg of segments) {
    if (current === null || current === undefined) return null;
    if (typeof current !== 'object' || Array.isArray(current)) return null;
    if (!Object.prototype.hasOwnProperty.call(current, seg)) return null;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function compareValues(left: unknown, op: '==' | '!=' | '>' | '>=' | '<' | '<=', right: unknown): boolean {
  // Числовая коэрция числоподобных строк с ОБЕИХ сторон — семантика единая с
  // {{#if}} в шаблонах (render.ts): payload "15000" (строкой) == 15000 (числом).
  // null == null → true; упорядочивание: числа — численно, строки — лексикографически.
  const asNumber = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v)
      ? v
      : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(',', '.')))
        ? Number(v.replace(',', '.'))
        : null;
  const ln = asNumber(left);
  const rn = asNumber(right);
  if (ln !== null && rn !== null) {
    switch (op) {
      case '==':
        return ln === rn;
      case '!=':
        return ln !== rn;
      case '>':
        return ln > rn;
      case '>=':
        return ln >= rn;
      case '<':
        return ln < rn;
      case '<=':
        return ln <= rn;
    }
  }
  if (op === '==') return left === right; // строгое равенство (null == null → true)
  if (op === '!=') return left !== right;
  // упорядочивание: строки — лексикографически, иначе false
  if (typeof left === 'string' && typeof right === 'string') {
    switch (op) {
      case '>':
        return left > right;
      case '>=':
        return left >= right;
      case '<':
        return left < right;
      case '<=':
        return left <= right;
    }
  }
  return false;
}

/** Обход AST. Логические операторы вычисляются по truthy; or/and — со стандартным
 * коротким замыканием. Результат не обязательно boolean (приводит evaluateExpression). */
function evalAst(node: AstNode, ctx: EvalContext): unknown {
  switch (node.kind) {
    case 'or':
      return truthy(evalAst(node.left, ctx)) || truthy(evalAst(node.right, ctx));
    case 'and':
      return truthy(evalAst(node.left, ctx)) && truthy(evalAst(node.right, ctx));
    case 'not':
      return !truthy(evalAst(node.operand, ctx));
    case 'cmp':
      return compareValues(evalAst(node.left, ctx), node.op, evalAst(node.right, ctx));
    case 'lit':
      return node.value;
    case 'path':
      return resolvePath(node.segments, ctx);
  }
}

/**
 * Валидация выражения: бросает ExpressionError с понятным текстом.
 * Вызывается валидацией воронки при сохранении (engine/validate.ts) — ошибка
 * доходит до UI как 422, а не падает экземпляры на бою.
 */
export function validateExpression(expr: string): void {
  if (expr.trim() === '') {
    throw new ExpressionError('Пустое выражение условия');
  }
  new Parser(tokenize(expr)).parse();
}

/**
 * Безопасное вычисление выражения; результат приводится к boolean.
 * Протокол: принимает строку условия и EvalContext; бросает ExpressionError
 * при синтаксической ошибке (на валидированных данных не случается);
 * отсутствие пути в данных → null (ложь) — не ошибка.
 */
export function evaluateExpression(expr: string, ctx: EvalContext): boolean {
  const ast = new Parser(tokenize(expr)).parse();
  return truthy(evalAst(ast, ctx));
}

/** Контекст вычисления из контекста экземпляра (замораживаем корни). */
export function buildEvalContext(ctx: {
  client: Record<string, unknown>;
  payload: Record<string, unknown>;
  event: string;
  vars: Record<string, unknown>;
}): EvalContext {
  return {
    client: Object.freeze({ ...ctx.client }),
    payload: Object.freeze({ ...ctx.payload }),
    event: ctx.event,
    vars: Object.freeze({ ...ctx.vars }),
  };
}
