/**
 * A tiny, safe expression evaluator for workflow conditions.
 *
 * Deliberately not JavaScript: a workflow is authored by a business user in a
 * visual builder, and giving that surface `eval` would hand every builder
 * remote code execution inside the platform. This supports exactly what a
 * routing condition needs — variable lookup, comparison, membership and
 * boolean composition — and nothing else.
 *
 * Grammar:
 *   expr    := or
 *   or      := and ( "or" and )*
 *   and     := not ( "and" not )*
 *   not     := "not" not | comparison
 *   compare := primary ( op primary )?
 *   op      := == != > >= < <= contains startsWith endsWith in matches
 *   primary := "(" expr ")" | literal | path
 */

export type Scope = Record<string, unknown>;

export function evaluateExpression(expression: string, scope: Scope): unknown {
  if (!expression?.trim()) return true;
  const tokens = tokenize(expression);
  const parser = new Parser(tokens, scope);
  const value = parser.parseExpression();
  parser.expectEnd();
  return value;
}

export function evaluateCondition(expression: string, scope: Scope): boolean {
  return truthy(evaluateExpression(expression, scope));
}

/** Interpolate `{{ path.to.value }}` placeholders in a template string. */
export function interpolate(template: string, scope: Scope): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) => {
    const value = resolvePath(path.trim(), scope);
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

export function resolvePath(path: string, scope: Scope): unknown {
  let current: unknown = scope;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    const key = segment.replace(/\[(\d+)\]$/, '.$1');
    for (const part of key.split('.')) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

// ── Lexer ────────────────────────────────────────────────────────────────────

type Token =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'path'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'punct'; value: string };

const OPERATORS = ['==', '!=', '>=', '<=', '>', '<'];
const WORD_OPERATORS = ['contains', 'startswith', 'endswith', 'matches', 'in'];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '(' || char === ')' || char === ',' || char === '[' || char === ']') {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      let value = '';
      index += 1;
      while (index < input.length && input[index] !== char) {
        if (input[index] === '\\') index += 1;
        value += input[index];
        index += 1;
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }

    const twoChar = input.slice(index, index + 2);
    if (OPERATORS.includes(twoChar)) {
      tokens.push({ kind: 'op', value: twoChar });
      index += 2;
      continue;
    }
    if (OPERATORS.includes(char)) {
      tokens.push({ kind: 'op', value: char });
      index += 1;
      continue;
    }

    if (/[\d]/.test(char) || (char === '-' && /\d/.test(input[index + 1] ?? ''))) {
      let value = char;
      index += 1;
      while (index < input.length && /[\d.]/.test(input[index])) {
        value += input[index];
        index += 1;
      }
      tokens.push({ kind: 'number', value: Number(value) });
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      let word = '';
      while (index < input.length && /[\w.$[\]]/.test(input[index])) {
        word += input[index];
        index += 1;
      }
      const lower = word.toLowerCase();
      if (lower === 'true' || lower === 'false') tokens.push({ kind: 'boolean', value: lower === 'true' });
      else if (lower === 'null' || lower === 'nil') tokens.push({ kind: 'null' });
      else if (['and', 'or', 'not'].includes(lower) || WORD_OPERATORS.includes(lower)) tokens.push({ kind: 'op', value: lower });
      else tokens.push({ kind: 'path', value: word });
      continue;
    }

    throw new Error(`Unexpected character "${char}" in expression`);
  }

  return tokens;
}

// ── Parser ───────────────────────────────────────────────────────────────────

class Parser {
  private position = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly scope: Scope,
  ) {}

  parseExpression(): unknown {
    return this.parseOr();
  }

  expectEnd(): void {
    if (this.position < this.tokens.length) {
      throw new Error('Unexpected trailing tokens in expression');
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private consumeOperator(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'op' && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.consumeOperator('or')) {
      const right = this.parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseNot();
    while (this.consumeOperator('and')) {
      const right = this.parseNot();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private parseNot(): unknown {
    if (this.consumeOperator('not')) return !truthy(this.parseNot());
    return this.parseComparison();
  }

  private parseComparison(): unknown {
    const left = this.parsePrimary();
    const token = this.peek();
    if (token?.kind !== 'op' || ['and', 'or', 'not'].includes(token.value)) return left;

    this.position += 1;
    const right = this.parsePrimary();
    return compare(token.value, left, right);
  }

  private parsePrimary(): unknown {
    const token = this.peek();
    if (!token) throw new Error('Unexpected end of expression');

    if (token.kind === 'punct' && token.value === '(') {
      this.position += 1;
      const value = this.parseOr();
      const closing = this.peek();
      if (closing?.kind !== 'punct' || closing.value !== ')') throw new Error('Missing closing parenthesis');
      this.position += 1;
      return value;
    }

    if (token.kind === 'punct' && token.value === '[') {
      this.position += 1;
      const items: unknown[] = [];
      while (this.peek() && !(this.peek()!.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parsePrimary());
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ',') this.position += 1;
      }
      this.position += 1;
      return items;
    }

    this.position += 1;
    switch (token.kind) {
      case 'string':
      case 'number':
      case 'boolean':
        return token.value;
      case 'null':
        return null;
      case 'path':
        return resolvePath(token.value, this.scope);
      default:
        throw new Error(`Unexpected token in expression`);
    }
  }
}

function compare(operator: string, left: unknown, right: unknown): boolean {
  switch (operator) {
    case '==':
      return looseEquals(left, right);
    case '!=':
      return !looseEquals(left, right);
    case '>':
      return Number(left) > Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<':
      return Number(left) < Number(right);
    case '<=':
      return Number(left) <= Number(right);
    case 'contains':
      if (Array.isArray(left)) return left.some((item) => looseEquals(item, right));
      return String(left ?? '').toLowerCase().includes(String(right ?? '').toLowerCase());
    case 'startswith':
      return String(left ?? '').toLowerCase().startsWith(String(right ?? '').toLowerCase());
    case 'endswith':
      return String(left ?? '').toLowerCase().endsWith(String(right ?? '').toLowerCase());
    case 'in':
      if (Array.isArray(right)) return right.some((item) => looseEquals(item, left));
      return String(right ?? '').toLowerCase().includes(String(left ?? '').toLowerCase());
    case 'matches':
      try {
        // Anchored and length-capped so a workflow author cannot author a
        // catastrophic backtracking pattern.
        return new RegExp(String(right).slice(0, 200)).test(String(left ?? ''));
      } catch {
        return false;
      }
    default:
      throw new Error(`Unknown operator "${operator}"`);
  }
}

function looseEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right);
  return String(left).toLowerCase() === String(right).toLowerCase();
}
