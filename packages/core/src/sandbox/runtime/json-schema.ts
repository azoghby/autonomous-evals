/**
 * Minimal, safe JSON Schema (draft-07 / 2020-12 subset) validator used for
 * tool arguments and simulated tool outputs. Never throws on bad schemas.
 */

export type JsonSchemaResult = { ok: true } | { ok: false; errors: string[] };

const MAX_ERRORS = 20;
const MAX_REF_DEPTH = 32;
const MAX_PATTERN_LENGTH = 500;

type Schema = Record<string, unknown>;

interface Ctx {
  root: Schema;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const escapeSegment = (s: string): string => s.replace(/~/g, "~0").replace(/\//g, "~1");

const childPath = (path: string, seg: string | number): string =>
  `${path === "/" ? "" : path}/${escapeSegment(String(seg))}`;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => has(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function matchesType(type: string, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "array":
      return Array.isArray(v);
    case "object":
      return isPlainObject(v);
    default:
      return false;
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function checkFormat(format: string, s: string): boolean {
  switch (format) {
    case "date":
      return isValidDate(s);
    case "date-time":
      return DATE_TIME_RE.test(s) && isValidDate(s.slice(0, 10)) && !Number.isNaN(Date.parse(s));
    case "email":
      return EMAIL_RE.test(s);
    case "uuid":
      return UUID_RE.test(s);
    default:
      return true;
  }
}

function resolveRef(ref: string, root: Schema): unknown {
  if (ref === "#") return root;
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) return undefined;
  const defs = root[m[1]];
  const name = m[2].replace(/~1/g, "/").replace(/~0/g, "~");
  if (!isPlainObject(defs) || !has(defs, name)) return undefined;
  return defs[name];
}

function validateString(schema: Schema, v: string, path: string, errs: string[]): void {
  if (typeof schema.minLength === "number" || typeof schema.maxLength === "number") {
    const len = Array.from(v).length;
    if (typeof schema.minLength === "number" && len < schema.minLength)
      errs.push(`${path}: must have at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && len > schema.maxLength)
      errs.push(`${path}: must have at most ${schema.maxLength} characters`);
  }
  if (typeof schema.pattern === "string") {
    let re: RegExp | null = null;
    if (schema.pattern.length <= MAX_PATTERN_LENGTH) {
      try {
        re = new RegExp(schema.pattern, "u");
      } catch {
        re = null;
      }
    }
    if (!re) errs.push(`${path}: invalid pattern`);
    else if (!re.test(v)) errs.push(`${path}: must match pattern ${schema.pattern}`);
  }
  if (typeof schema.format === "string" && !checkFormat(schema.format, v))
    errs.push(`${path}: must match format ${schema.format}`);
}

function validateNumber(schema: Schema, v: number, path: string, errs: string[]): void {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema;
  if (typeof minimum === "number" && v < minimum) errs.push(`${path}: must be >= ${minimum}`);
  if (typeof maximum === "number" && v > maximum) errs.push(`${path}: must be <= ${maximum}`);
  if (typeof exclusiveMinimum === "number" && v <= exclusiveMinimum)
    errs.push(`${path}: must be > ${exclusiveMinimum}`);
  if (typeof exclusiveMaximum === "number" && v >= exclusiveMaximum)
    errs.push(`${path}: must be < ${exclusiveMaximum}`);
  if (typeof multipleOf === "number" && multipleOf > 0) {
    const q = v / multipleOf;
    if (!Number.isFinite(q) || Math.abs(q - Math.round(q)) > 1e-9)
      errs.push(`${path}: must be a multiple of ${multipleOf}`);
  }
}

function validateArray(
  schema: Schema,
  v: unknown[],
  path: string,
  errs: string[],
  ctx: Ctx,
  depth: number,
): void {
  if (typeof schema.minItems === "number" && v.length < schema.minItems)
    errs.push(`${path}: must have at least ${schema.minItems} items`);
  if (typeof schema.maxItems === "number" && v.length > schema.maxItems)
    errs.push(`${path}: must have at most ${schema.maxItems} items`);
  if (schema.uniqueItems === true) {
    outer: for (let i = 0; i < v.length; i++)
      for (let j = 0; j < i; j++)
        if (deepEqual(v[i], v[j])) {
          errs.push(`${path}: items must be unique`);
          break outer;
        }
  }
  const items = schema.items;
  if (typeof items === "boolean" || isPlainObject(items)) {
    for (let i = 0; i < v.length && errs.length < MAX_ERRORS; i++)
      check(items, v[i], childPath(path, i), errs, ctx, depth);
  }
}

function validateObject(
  schema: Schema,
  v: Record<string, unknown>,
  path: string,
  errs: string[],
  ctx: Ctx,
  depth: number,
): void {
  if (Array.isArray(schema.required)) {
    for (const k of schema.required)
      if (typeof k === "string" && !has(v, k))
        errs.push(`${childPath(path, k)}: is required`);
  }
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [k, sub] of Object.entries(props)) {
    if (errs.length >= MAX_ERRORS) return;
    if (has(v, k)) check(sub, v[k], childPath(path, k), errs, ctx, depth);
  }
  const ap = schema.additionalProperties;
  if (ap === undefined || ap === true) return;
  for (const k of Object.keys(v)) {
    if (has(props, k)) continue;
    if (errs.length >= MAX_ERRORS) return;
    if (ap === false) errs.push(`${childPath(path, k)}: additional property not allowed`);
    else if (isPlainObject(ap)) check(ap, v[k], childPath(path, k), errs, ctx, depth);
  }
}

function subErrors(schema: unknown, v: unknown, path: string, ctx: Ctx, depth: number): string[] {
  const out: string[] = [];
  check(schema, v, path, out, ctx, depth);
  return out;
}

function validateCombinators(
  schema: Schema,
  v: unknown,
  path: string,
  errs: string[],
  ctx: Ctx,
  depth: number,
): void {
  if (Array.isArray(schema.allOf)) {
    for (const s of schema.allOf) check(s, v, path, errs, ctx, depth);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    if (!schema.anyOf.some((s) => subErrors(s, v, path, ctx, depth).length === 0))
      errs.push(`${path}: must match at least one schema in anyOf`);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const n = schema.oneOf.filter((s) => subErrors(s, v, path, ctx, depth).length === 0).length;
    if (n !== 1) errs.push(`${path}: must match exactly one schema in oneOf (matched ${n})`);
  }
  if (schema.not !== undefined && subErrors(schema.not, v, path, ctx, depth).length === 0)
    errs.push(`${path}: must not match schema in not`);
}

function check(
  schema: unknown,
  v: unknown,
  path: string,
  errs: string[],
  ctx: Ctx,
  depth: number,
): void {
  if (errs.length >= MAX_ERRORS) return;
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errs.push(`${path}: not allowed`);
    return;
  }
  if (!isPlainObject(schema)) return;

  if (typeof schema.$ref === "string") {
    if (depth >= MAX_REF_DEPTH) {
      errs.push(`${path}: $ref recursion depth exceeded`);
      return;
    }
    const target = resolveRef(schema.$ref, ctx.root);
    if (target === undefined) errs.push(`${path}: unresolved $ref ${schema.$ref}`);
    else check(target, v, path, errs, ctx, depth + 1);
  }

  if (v === null && schema.nullable === true) return;

  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(
      (t): t is string => typeof t === "string",
    );
    if (types.length > 0 && !types.some((t) => matchesType(t, v))) {
      errs.push(`${path}: must be ${types.join(" or ")}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, v)))
    errs.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  if (has(schema, "const") && !deepEqual(schema.const, v))
    errs.push(`${path}: must equal ${JSON.stringify(schema.const)}`);

  if (typeof v === "string") validateString(schema, v, path, errs);
  else if (typeof v === "number" && Number.isFinite(v)) validateNumber(schema, v, path, errs);
  else if (Array.isArray(v)) validateArray(schema, v, path, errs, ctx, depth);
  else if (isPlainObject(v)) validateObject(schema, v, path, errs, ctx, depth);

  validateCombinators(schema, v, path, errs, ctx, depth);
}

export function validateJsonSchema(schema: Record<string, unknown>, value: unknown): JsonSchemaResult {
  const errs: string[] = [];
  try {
    check(schema, value, "/", errs, { root: schema }, 0);
  } catch (e) {
    errs.push(`/: schema evaluation failed (${e instanceof Error ? e.message : "unknown"})`);
  }
  return errs.length === 0 ? { ok: true } : { ok: false, errors: errs.slice(0, MAX_ERRORS) };
}

/** Returns a plain object, parsing a JSON-stringified object if needed; else null. */
export function coerceObjectArgs(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
