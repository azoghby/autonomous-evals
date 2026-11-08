/**
 * Postgres SQL text utilities: a small lexer plus helpers built on it.
 * Pure functions, no DB access. Values are never interpolated into SQL text.
 */

export class SqlTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlTextError';
  }
}

type SegmentType = 'code' | 'string' | 'ident' | 'dollar' | 'comment';

interface Segment {
  type: SegmentType;
  /** Raw source text of the segment. */
  text: string;
  /** Dollar-quoted segments only: the text between the tag delimiters. */
  body?: string;
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

function endOfLineComment(sql: string, i: number): number {
  const nl = sql.indexOf('\n', i);
  return nl === -1 ? sql.length : nl;
}

function endOfBlockComment(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql.startsWith('/*', i)) {
      depth++;
      i += 2;
    } else if (sql.startsWith('*/', i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return sql.length;
}

/** Returns the index just past the closing quote (or end of input). */
function endOfQuoted(sql: string, start: number, quote: string, backslash: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (backslash && c === '\\') {
      i += 2;
    } else if (c === quote) {
      if (sql[i + 1] === quote) i += 2;
      else return i + 1;
    } else {
      i++;
    }
  }
  return sql.length;
}

function tokenize(sql: string): Segment[] {
  const segments: Segment[] = [];
  let codeStart = 0;
  let i = 0;

  const flushCode = (end: number): void => {
    if (end > codeStart) segments.push({ type: 'code', text: sql.slice(codeStart, end) });
  };
  const push = (segment: Segment, end: number): void => {
    flushCode(i);
    segments.push(segment);
    i = end;
    codeStart = end;
  };

  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const end = endOfLineComment(sql, i);
      push({ type: 'comment', text: sql.slice(i, end) }, end);
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = endOfBlockComment(sql, i);
      push({ type: 'comment', text: sql.slice(i, end) }, end);
    } else if (c === "'") {
      const prev = sql[i - 1];
      const isEscape = (prev === 'e' || prev === 'E') && !(i >= 2 && IDENT_CHAR.test(sql[i - 2]));
      const end = endOfQuoted(sql, i, "'", isEscape);
      if (isEscape) {
        // Keep the E prefix as part of the string segment.
        flushCode(i - 1);
        segments.push({ type: 'string', text: sql.slice(i - 1, end) });
        i = end;
        codeStart = end;
      } else {
        push({ type: 'string', text: sql.slice(i, end) }, end);
      }
    } else if (c === '"') {
      const end = endOfQuoted(sql, i, '"', false);
      push({ type: 'ident', text: sql.slice(i, end) }, end);
    } else if (c === '$' && (i === 0 || !IDENT_CHAR.test(sql[i - 1]))) {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(sql);
      if (m) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        const close = sql.indexOf(tag, bodyStart);
        const bodyEnd = close === -1 ? sql.length : close;
        const end = close === -1 ? sql.length : close + tag.length;
        push({ type: 'dollar', text: sql.slice(i, end), body: sql.slice(bodyStart, bodyEnd) }, end);
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  flushCode(sql.length);
  return segments;
}

/** Replace every non-newline character with a space (preserves line structure). */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Replaces string/identifier/dollar-quoted contents and comments with spaces.
 * Strings become `'   '`, quoted identifiers become `"x"`. Newlines are kept.
 */
export function stripCommentsAndStrings(sql: string): string {
  return tokenize(sql)
    .map((s) => {
      switch (s.type) {
        case 'code':
          return s.text;
        case 'comment':
        case 'dollar':
          return blank(s.text);
        case 'ident':
          return '"x"' + blank(s.text.slice(3));
        case 'string': {
          const hasE = s.text[0] === 'e' || s.text[0] === 'E';
          const open = hasE ? 2 : 1;
          return s.text.slice(0, open) + blank(s.text.slice(open, -1)) + (s.text.length > open ? "'" : '');
        }
      }
    })
    .join('');
}

/**
 * Like stripCommentsAndStrings but keeps the *contents* of strings and dollar
 * quotes as scannable text (quotes become spaces). Comments are still removed.
 */
function revealStrings(sql: string): string {
  return tokenize(sql)
    .map((s) => {
      switch (s.type) {
        case 'code':
          return s.text;
        case 'comment':
          return blank(s.text);
        case 'ident':
          return '"x"' + blank(s.text.slice(3));
        case 'string': {
          const inner = s.text.replace(/^[eE]?'/, ' ').replace(/'$/, ' ');
          return inner.replace(/''/g, ' ').replace(/\\(.)/g, ' $1');
        }
        case 'dollar':
          return ` ${revealStrings(s.body ?? '')} `;
      }
    })
    .join('');
}

/** Contents of every dollar-quoted block (recursively), with inner strings revealed. */
function dollarBodies(sql: string): string[] {
  const out: string[] = [];
  for (const s of tokenize(sql)) {
    if (s.type === 'dollar') out.push(revealStrings(s.body ?? ''));
  }
  return out;
}

export function splitTopLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let hasContent = false;
  const finish = (): void => {
    const trimmed = current.trim();
    if (trimmed && hasContent) statements.push(trimmed);
    current = '';
    hasContent = false;
  };
  for (const seg of tokenize(sql)) {
    if (seg.type !== 'code') {
      current += seg.text;
      if (seg.type !== 'comment') hasContent = true;
      continue;
    }
    const parts = seg.text.split(';');
    parts.forEach((part, idx) => {
      if (idx > 0) finish();
      current += part;
      if (part.trim()) hasContent = true;
    });
  }
  finish();
  return statements;
}

export function convertParamValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object': {
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) throw new SqlTextError('Invalid Date parameter');
        return value.toISOString();
      }
      return JSON.stringify(value);
    }
    default:
      throw new SqlTextError(`Unsupported parameter type: ${typeof value}`);
  }
}

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;

export function compileNamedParams(
  sql: string,
  args: Record<string, unknown>,
): { text: string; values: unknown[]; names: string[] } {
  const names: string[] = [];
  const values: unknown[] = [];
  const indexOf = new Map<string, number>();

  const place = (name: string): number => {
    const existing = indexOf.get(name);
    if (existing !== undefined) return existing;
    names.push(name);
    values.push(Object.prototype.hasOwnProperty.call(args, name) ? convertParamValue(args[name]) : null);
    indexOf.set(name, names.length);
    return names.length;
  };

  const text = tokenize(sql)
    .map((seg) => {
      if (seg.type !== 'code') return seg.text;
      const code = seg.text;
      let out = '';
      let i = 0;
      while (i < code.length) {
        const c = code[i];
        if (c === ':') {
          if (code[i + 1] === ':') {
            out += '::';
            i += 2;
          } else if (i + 1 < code.length && NAME_START.test(code[i + 1])) {
            let j = i + 2;
            while (j < code.length && NAME_CHAR.test(code[j])) j++;
            out += `$${place(code.slice(i + 1, j))}`;
            i = j;
          } else {
            out += c;
            i++;
          }
        } else if (c === '$' && /[0-9]/.test(code[i + 1] ?? '') && !(i > 0 && IDENT_CHAR.test(code[i - 1]))) {
          throw new SqlTextError('SQL must use :name parameters, not positional $n parameters');
        } else {
          out += c;
          i++;
        }
      }
      return out;
    })
    .join('');

  return { text, values, names };
}

const READ_ONLY_FIRST = new Set(['SELECT', 'WITH']);

const READ_ONLY_FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'GRANT', 'REVOKE',
  'COPY', 'CALL', 'DO', 'VACUUM', 'LOCK', 'SET', 'RESET', 'LISTEN', 'NOTIFY', 'PREPARE', 'EXECUTE',
  'COMMIT', 'ROLLBACK', 'BEGIN',
];

const READ_ONLY_FORBIDDEN_FUNCTIONS = [
  'pg_sleep', 'pg_sleep_for', 'pg_sleep_until', 'pg_terminate_backend', 'pg_cancel_backend',
  'set_config', 'dblink', 'lo_import', 'lo_export', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir',
];

const wordRegex = (words: string[]): RegExp => new RegExp(`\\b(${words.join('|')})\\b`, 'i');

const READ_ONLY_KEYWORD_RE = wordRegex(READ_ONLY_FORBIDDEN_KEYWORDS);
const READ_ONLY_FUNCTION_RE = wordRegex(READ_ONLY_FORBIDDEN_FUNCTIONS);

/** Returns the single read-only statement (without trailing `;`), or throws. */
export function assertReadOnlySql(sql: string): string {
  const statements = splitTopLevelStatements(sql);
  if (statements.length !== 1) {
    throw new SqlTextError(`Expected exactly one SQL statement, got ${statements.length}`);
  }
  const statement = statements[0];
  const stripped = stripCommentsAndStrings(statement);
  const first = /^\s*([A-Za-z_]+)/.exec(stripped)?.[1]?.toUpperCase();
  if (!first || !READ_ONLY_FIRST.has(first)) {
    throw new SqlTextError('Only SELECT or WITH statements are allowed');
  }
  const keyword = READ_ONLY_KEYWORD_RE.exec(stripped);
  if (keyword) throw new SqlTextError(`Keyword not allowed in read-only SQL: ${keyword[1].toUpperCase()}`);
  const fn = READ_ONLY_FUNCTION_RE.exec(stripped);
  if (fn) throw new SqlTextError(`Function not allowed in read-only SQL: ${fn[1].toLowerCase()}`);
  return statement;
}

const SAFE_SCRIPT_RULES: ReadonlyArray<{ re: RegExp; what: string }> = [
  {
    re: /\b(?:CREATE|DROP|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:IF\s+EXISTS\s+)?(?:DATABASE|ROLE|USER|EXTENSION|TABLESPACE|SUBSCRIPTION|PUBLICATION|SERVER)\b/i,
    what: 'CREATE/DROP/ALTER of DATABASE, ROLE, USER, EXTENSION, TABLESPACE, SUBSCRIPTION, PUBLICATION or SERVER',
  },
  { re: /\bCOPY\b/i, what: 'COPY' },
  { re: /\bALTER\s+SYSTEM\b/i, what: 'ALTER SYSTEM' },
  { re: /\b(?:GRANT|REVOKE)\b/i, what: 'GRANT/REVOKE' },
  {
    re: /\b(pg_terminate_backend|pg_cancel_backend|dblink\w*|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_reload_conf)\b/i,
    what: 'a forbidden function',
  },
  { re: /\b(pg_sleep(?:_for|_until)?)\b/i, what: 'pg_sleep' },
  // Scripts run under a statement_timeout; they may not lift it.
  { re: /\b(statement_timeout|set_config)\b/i, what: 'statement_timeout / set_config' },
  { re: /^[ \t]*\\/m, what: 'a psql meta-command' },
];

const LOAD_RE = /^\s*LOAD\b/i;
// Statement-position only, so `UPDATE t SET role = ...` (a column) is allowed.
const SET_ROLE_RE =
  /^\s*(?:(?:BEGIN|EXECUTE|THEN|ELSE|LOOP)\s+)*SET\s+(?:(?:SESSION|LOCAL)\s+)?(?:ROLE|SESSION\s+AUTHORIZATION)\b/i;
const DO_STRING_BODY_RE = /\bDO\s+(?:LANGUAGE\s+\w+\s+)?[eE]?'/i;

/**
 * Guards customer DDL/seed/fixture/tool scripts. Dollar-quoted bodies (e.g.
 * plpgsql function bodies and DO blocks) are scanned too, with their inner
 * string literals revealed, because dynamic EXECUTE could hide forbidden
 * statements. Ordinary string literals outside dollar quotes are not scanned,
 * except for `DO '...'` string bodies.
 */
export function assertSafeScript(sql: string, context: string): void {
  const stripped = stripCommentsAndStrings(sql);
  const texts = [stripped, ...dollarBodies(sql)];
  if (DO_STRING_BODY_RE.test(stripped)) texts.push(revealStrings(sql));

  for (const text of texts) {
    for (const rule of SAFE_SCRIPT_RULES) {
      const m = rule.re.exec(text);
      if (m) {
        throw new SqlTextError(`${context}: script not allowed, contains ${rule.what} (${m[0].trim()})`);
      }
    }
    for (const piece of text.split(';')) {
      if (LOAD_RE.test(piece)) throw new SqlTextError(`${context}: script not allowed, contains LOAD`);
      if (SET_ROLE_RE.test(piece)) {
        throw new SqlTextError(`${context}: script not allowed, contains SET ROLE / SET SESSION AUTHORIZATION`);
      }
    }
  }
}
