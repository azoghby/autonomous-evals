/**
 * SQL safety for ingest. Tool-binding statements are tightly restricted (DML only, named params only);
 * env DDL/seed is allowed to create tables/functions but not touch roles, extensions, files or the server.
 */

interface MaskOptions {
  /** Treat $tag$...$tag$ as an opaque literal (default true). DDL scanning keeps function bodies visible. */
  dollar?: boolean;
  /** Keep the content of "quoted identifiers" (default true). */
  keepIdents?: boolean;
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

/**
 * Returns a same-length copy of `sql` where comments and string-literal contents are blanked to spaces.
 * Block comments nest (as in Postgres). Throws on unterminated strings/comments so nothing can hide.
 */
export function maskSql(sql: string, opts: MaskOptions = {}): string {
  const dollar = opts.dollar ?? true;
  const keepIdents = opts.keepIdents ?? true;
  const out = sql.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const n = sql[i + 1];
    if (c === "-" && n === "-") {
      let e = sql.indexOf("\n", i);
      if (e === -1) e = sql.length;
      blank(i, e);
      i = e;
    } else if (c === "/" && n === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; }
        else if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; }
        else j++;
      }
      if (depth > 0) throw new Error("Unterminated /* comment");
      blank(i, j);
      i = j;
    } else if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? "") && !isWordChar(sql[i - 2]);
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) throw new Error("Unterminated string literal");
      blank(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) throw new Error("Unterminated quoted identifier");
      if (!keepIdents) blank(i + 1, j);
      i = j + 1;
    } else if (c === "$" && dollar && !isWordChar(sql[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (!m) { i++; continue; }
      const tag = m[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) throw new Error("Unterminated dollar-quoted string");
      blank(i + tag.length, end);
      i = end + tag.length;
    } else {
      i++;
    }
  }
  return out.join("");
}

const NAMED_PARAM = /(?<![:\w$]):([A-Za-z_]\w*)/g;

/** Distinct :name params in order of first appearance (ignores ::casts, literals, comments). */
export function namedParams(sql: string): string[] {
  const masked = maskSql(sql, { keepIdents: false });
  const seen: string[] = [];
  for (const m of masked.matchAll(NAMED_PARAM)) {
    const name = m[1]!;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** Replaces :name with $1.. (same name reuses its index). Missing args bind null. */
export function compileNamed(sql: string, args: Record<string, unknown>): { text: string; values: unknown[] } {
  const masked = maskSql(sql, { keepIdents: false });
  const names: string[] = [];
  const values: unknown[] = [];
  let text = "";
  let last = 0;
  for (const m of masked.matchAll(NAMED_PARAM)) {
    const name = m[1]!;
    let idx = names.indexOf(name);
    if (idx === -1) {
      names.push(name);
      const v = Object.prototype.hasOwnProperty.call(args, name) ? args[name] : null;
      values.push(v === undefined ? null : v);
      idx = names.length - 1;
    }
    text += sql.slice(last, m.index) + `$${idx + 1}`;
    last = (m.index ?? 0) + m[0].length;
  }
  return { text: text + sql.slice(last), values };
}

const FORBIDDEN_TOOL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(DROP|ALTER|CREATE|GRANT|REVOKE|COPY|TRUNCATE|VACUUM|CALL|EXECUTE|LISTEN|NOTIFY)\b/i, "forbidden keyword"],
  [/\bDO\s*(\$|LANGUAGE\b|')/i, "forbidden DO block"],
  [/\bSET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\b(?!\s*=)/i, "forbidden SET ROLE"],
  [/\bSET\s+SESSION\s+AUTHORIZATION\b/i, "forbidden SET SESSION AUTHORIZATION"],
  [/\bpg_\w*/i, "forbidden pg_ identifier"],
  [/\bset_config\b/i, "forbidden set_config"],
  [/\blo_\w+/i, "forbidden large-object function"],
  [/\bdblink\w*/i, "forbidden dblink"],
];

/** Throws if `stmt` is not a safe single DML statement using only named :params. */
export function assertSafeSql(stmt: string): void {
  if (/\$\{|\{\{/.test(stmt)) throw new Error("Unsafe SQL: interpolation marker (${ or {{) is not allowed; use :named params");
  let masked: string;
  try {
    masked = maskSql(stmt);
  } catch (e) {
    throw new Error(`Unsafe SQL: ${(e as Error).message}`);
  }
  let body = masked.trim();
  if (body.endsWith(";")) body = body.slice(0, -1).trimEnd();
  if (!body) throw new Error("Unsafe SQL: empty statement");
  if (body.includes(";")) throw new Error("Unsafe SQL: multiple statements (';' chaining) are not allowed");
  if (!/^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(body)) {
    throw new Error("Unsafe SQL: statement must start with SELECT, INSERT, UPDATE, DELETE or WITH");
  }
  for (const [re, label] of FORBIDDEN_TOOL_PATTERNS) {
    const m = re.exec(body);
    if (m) throw new Error(`Unsafe SQL: ${label} "${m[0].trim()}"`);
  }
  if (/\$\d/.test(body)) throw new Error("Unsafe SQL: positional params ($1) are not allowed; use :named params");
  if (!/\bINSERT\b/i.test(body) && /\bINTO\b/i.test(body)) throw new Error("Unsafe SQL: SELECT ... INTO is not allowed");
  const writes = /\bDELETE\s+FROM\b/i.test(body) || /\bUPDATE\s+[\w."]+(?:\s+(?:AS\s+)?\w+)?\s+SET\b/i.test(body);
  if (writes && !/\bWHERE\b/i.test(body)) throw new Error("Unsafe SQL: DELETE/UPDATE without WHERE is not allowed");
}

const FORBIDDEN_DDL_PATTERNS: Array<[RegExp, string]> = [
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?EXTENSION\b/i, "CREATE EXTENSION"],
  [/\bCOPY\b/i, "COPY"],
  [/\b(GRANT|REVOKE)\b/i, "GRANT/REVOKE"],
  [/\bCREATE\s+(ROLE|USER|GROUP)\b/i, "CREATE ROLE/USER"],
  [/\bALTER\s+(ROLE|USER|GROUP)\b/i, "ALTER ROLE/USER"],
  [/\bDROP\s+(DATABASE|SCHEMA)\b/i, "DROP DATABASE/SCHEMA"],
  [/\bDO\s*(\$|LANGUAGE\b|')/i, "DO block"],
  [/\bSET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\b(?!\s*=)/i, "SET ROLE"],
  [/\bSET\s+SESSION\s+AUTHORIZATION\b/i, "SET SESSION AUTHORIZATION"],
  [/\bpg_\w+\s*\(/i, "pg_ function call"],
  [/\b(?:lo_\w+|dblink\w*|set_config)\s*\(/i, "server-level function call"],
];

/** Throws if env DDL/seed SQL does anything beyond defining/populating the sandbox world. */
export function assertSafeDdl(sql: string): void {
  let masked: string;
  try {
    masked = maskSql(sql, { dollar: false });
  } catch (e) {
    throw new Error(`Unsafe DDL: ${(e as Error).message}`);
  }
  for (const [re, label] of FORBIDDEN_DDL_PATTERNS) {
    if (re.test(masked)) throw new Error(`Unsafe DDL: ${label} is not allowed`);
  }
}
