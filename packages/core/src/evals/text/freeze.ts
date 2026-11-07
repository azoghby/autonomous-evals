/**
 * Freezing: a suite is identified by the SHA-256 of its canonical JSON. Runs, reproductions,
 * reruns and monitoring all carry this digest; a mismatch means the suite was edited after freeze.
 * The digest equals monitoring's `frozenSuiteDigest(canonicalSuiteJson(body))`.
 */
import { containsSecret } from "../../agents/redact";
import { createHash } from "node:crypto";
import { type FrozenTextSuite, type FrozenTextSuiteBody, FrozenTextSuiteBodySchema, FrozenTextSuiteSchema, normalizeReferenceText } from "./schema";

/** Deterministic JSON: object keys sorted, no whitespace. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function canonicalSuiteJson(body: FrozenTextSuiteBody): string {
  return canonicalJson(FrozenTextSuiteBodySchema.parse(body));
}

export function suiteDigest(body: FrozenTextSuiteBody): string {
  return createHash("sha256").update(canonicalSuiteJson(body), "utf8").digest("hex");
}

export function freezeSuite(body: FrozenTextSuiteBody): FrozenTextSuite {
  const parsed = FrozenTextSuiteBodySchema.parse({ ...body, referenceText: normalizeReferenceText(body.referenceText) });
  if (containsSecret(JSON.stringify(parsed))) throw new FrozenSuiteIntegrityError("suite contains credential content");
  return FrozenTextSuiteSchema.parse({ ...parsed, digest: suiteDigest(parsed) });
}

export class FrozenSuiteIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrozenSuiteIntegrityError";
  }
}

/** Parse a stored suite and verify its digest. Throws FrozenSuiteIntegrityError on any mismatch. */
export function verifyFrozenSuite(stored: unknown): FrozenTextSuite {
  const parsed = FrozenTextSuiteSchema.safeParse(stored);
  if (!parsed.success) throw new FrozenSuiteIntegrityError("stored suite does not match text_suite.v1");
  if (containsSecret(JSON.stringify(parsed.data))) throw new FrozenSuiteIntegrityError("suite contains credential content");
  const { digest, ...body } = parsed.data;
  if (suiteDigest(body) !== digest) throw new FrozenSuiteIntegrityError("stored suite digest does not match its content");
  return parsed.data;
}
