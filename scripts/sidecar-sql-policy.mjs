import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class PolicyError extends Error {}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESTRUCTIVE = /\b(DROP\s+(TABLE|SCHEMA|COLUMN|INDEX|FUNCTION|CONSTRAINT)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+\S+\s+DROP)\b/i;
// Reviewed against schema-plan.json and the actual replacement CHECKs. This is
// deliberately code-owned: a caller-supplied manifest cannot expand authority.
const REVIEWED = Object.freeze({
  "docs/naive-design-recovery-integration/sql/001-design-stage-recovery.sql": "c274a1dc4fa38e923d3f83f9a747cc1413055de11adba13f8760344693d32c59",
  "docs/naive-run-recovery-integration/sql/001-run-recovery.sql": "6949c814a4b52e8e0b15d3afdd517c088a32a4e528bd4d71b8c768cad11c57f8",
});

export function validateEndpointLabel(expected) {
  if (typeof expected !== "string" || !/^ep-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(expected) || expected.endsWith("-pooler") || expected.length > 63) {
    throw new PolicyError("refusing: invalid direct endpoint label");
  }
  return expected;
}

export function parseArguments(argv) {
  const options = { reviewedConstraints: false, dryRun: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === "--reviewed-constraints" && !options.reviewedConstraints) options.reviewedConstraints = true;
    else if (arg === "--dry-run" && !options.dryRun) options.dryRun = true;
    else if (arg.startsWith("--")) throw new PolicyError("refusing: unknown or duplicate option");
    else positional.push(arg);
  }
  const [envFile, expected, ...files] = positional;
  if (!envFile || !expected || !files.length || files.some((f) => !f)) {
    throw new PolicyError("usage: node scripts/apply-sidecar-sql.mjs [--dry-run] [--reviewed-constraints] <env-file> <expected-endpoint-id> <file.sql>...");
  }
  validateEndpointLabel(expected);
  return { ...options, envFile, expected, files };
}

export function validateSqlSource({ file, sql, realPath }, { reviewedConstraints = false, root = REPO_ROOT } = {}) {
  if (typeof sql !== "string" || !sql.trim()) throw new PolicyError("refusing: empty or invalid SQL file");
  const sha = createHash("sha256").update(sql).digest("hex");
  if (DESTRUCTIVE.test(sql)) {
    const canonical = Object.keys(REVIEWED).find((p) => resolve(root, p) === resolve(file));
    if (!reviewedConstraints || !canonical || realPath !== resolve(root, canonical) || sha !== REVIEWED[canonical]) {
      throw new PolicyError("refusing: destructive statement or unreviewed constraint replacement");
    }
  }
  return { f: file, sql, sha };
}

export function validateDatabaseUrl(url, expected) {
  validateEndpointLabel(expected);
  try {
    const parsed = new URL(url);
    // pg copies query options over URL authority. Permit only non-routing TLS
    // options used by direct Neon URLs; never allow host/port/socket overrides.
    const allowedQuery = new Set(['sslmode', 'channel_binding']);
    if ([...parsed.searchParams.keys()].some(key => !allowedQuery.has(key))) throw new PolicyError();
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname.startsWith(`${expected}.`) || parsed.port && parsed.port !== "5432") throw new PolicyError();
  } catch {
    throw new PolicyError("refusing: DATABASE_URL_UNPOOLED is missing or is not the expected direct endpoint");
  }
  return url;
}
