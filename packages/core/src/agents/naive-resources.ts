/** SDK 0.12.3 resource adapters. No updates, deletes, session runs, or secret logging. */
import { createHash } from "node:crypto";
import type { VettaClient, SkillContent, OutcomeCreate, VaultCreate, CredentialCreate } from "@usenaive-sdk/managed-agents";
import { NaiveProvisionError, type ProvisionOperation } from "./naive-provisioning";
export type ResourceClientFactory = (idempotencyKey?: string) => Pick<VettaClient, "skills" | "outcomes" | "vaults">;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  return JSON.stringify(v);
}
export const resourceFingerprint = (value: unknown): string => hash(canonical(value));
const requireMatch = (ok: boolean) => { if (!ok) throw new NaiveProvisionError("configuration_drift"); };
type Page<T> = { data: T[]; has_more: boolean; next_cursor: string | null };
/** Never mistake partial pagination or duplicate records for absence. */
export async function discoverResource<T extends { id: string }>(list: (query: { limit: number; after?: string }) => Promise<Page<T>>, matches: (row: T) => boolean): Promise<T | undefined> {
  const cursors = new Set<string>(), ids = new Set<string>();
  let after: string | undefined, found: T | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await list({ limit: 100, ...(after ? { after } : {}) });
    if (!response || !Array.isArray(response.data) || response.data.length > 100 || typeof response.has_more !== "boolean" ||
      (response.has_more ? typeof response.next_cursor !== "string" || !response.next_cursor : response.next_cursor !== null)) {
      throw new NaiveProvisionError("inspection_failed");
    }
    for (const row of response.data) {
      if (!row || typeof row.id !== "string" || !row.id) throw new NaiveProvisionError("inspection_failed");
      if (ids.has(row.id)) throw new NaiveProvisionError("inspection_failed");
      ids.add(row.id);
      if (matches(row)) { if (found) throw new NaiveProvisionError("inspection_failed"); found = row; }
    }
    if (!response.has_more) return found;
    if (!response.next_cursor || cursors.has(response.next_cursor)) throw new NaiveProvisionError("inspection_failed");
    after = response.next_cursor; cursors.add(after);
  }
  throw new NaiveProvisionError("inspection_failed");
}
export function buildSkillOperation(client: ResourceClientFactory, desired: SkillContent & { slug: string }): ProvisionOperation {
  const body = { slug: desired.slug, content: desired.content, description: desired.description ?? "", sha256: hash(desired.content) };
  if (desired.sha256 !== undefined) requireMatch(desired.sha256 === body.sha256);
  return {
    kind: "skill", name: body.slug, fingerprint: resourceFingerprint(body),
    discover: async () => { const row = await discoverResource(q => client().skills.list(q), r => r.name === body.slug); return row ? { id: row.id, version: row.latest_version } : undefined; },
    attest: async receipt => {
      const row = await client().skills.get(body.slug);
      requireMatch(row.id === receipt.id && row.name === body.slug && row.latest_version === receipt.version && (row.description ?? "") === body.description);
      const version = await client().skills.getVersion(body.slug, receipt.version!);
      // Require actual content; an opaque provider hash alone is insufficient evidence.
      requireMatch(version.content === body.content);
    },
    create: async key => { const row = await client(key).skills.push(body); requireMatch(row.slug === body.slug && row.sha256 === body.sha256); return { id: row.id, version: row.version }; },
  };
}
export function buildOutcomeOperation(client: ResourceClientFactory, desired: OutcomeCreate): ProvisionOperation {
  const body = { ...desired };
  requireMatch(Number.isSafeInteger(body.max_iterations) && body.max_iterations! > 0);
  return {
    kind: "outcome", name: body.name, fingerprint: resourceFingerprint(body),
    discover: async () => { const r = await discoverResource(q => client().outcomes.list(q), r => r.name === body.name); return r ? { id: r.id } : undefined; },
    attest: async receipt => { const r = await client().outcomes.get(receipt.id); requireMatch(r.id === receipt.id && r.name === body.name && r.description === body.description && r.rubric === (body.rubric ?? null) && r.rubric_file === (body.rubric_file ?? null) && r.max_iterations === body.max_iterations); },
    create: async key => ({ id: (await client(key).outcomes.create(body)).id }),
  };
}
export function buildVaultOperation(client: ResourceClientFactory, desired: VaultCreate): ProvisionOperation {
  const body = { ...desired };
  return {
    kind: "vault", name: body.display_name, fingerprint: resourceFingerprint(body),
    discover: async () => { const r = await discoverResource(q => client().vaults.list(q), r => r.display_name === body.display_name); return r ? { id: r.id } : undefined; },
    attest: async receipt => { const r = await client().vaults.get(receipt.id); requireMatch(r.id === receipt.id && r.display_name === body.display_name && r.identity_id === (body.identity_id ?? null)); },
    create: async key => ({ id: (await client(key).vaults.create(body)).id }),
  };
}
/** A trusted receipt is local evidence of the submitted value, never provider value attestation. */
export interface CredentialBinding { id: string; fingerprint: string }
export function buildCredentialOperation(client: ResourceClientFactory, vaultId: string, desired: CredentialCreate, trusted?: CredentialBinding): ProvisionOperation {
  const body = { ...desired };
  requireMatch(body.kind === "static_bearer" && !!body.value && /^agt_[A-Za-z0-9]+$/.test(body.agent_id ?? "") && body.host === undefined);
  const url = new URL(body.mcp_server_url ?? "");
  requireMatch(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash);
  const { value, ...metadata } = body;
  const fingerprint = resourceFingerprint({ vaultId, ...metadata, valueHash: hash(value) });
  const trustedBinding = trusted ? { ...trusted } : undefined;
  let createdId: string | undefined;
  return {
    kind: "credential", name: body.key, fingerprint,
    discover: async () => { const r = await discoverResource(q => client().vaults.credentials.list(vaultId, q), r => r.key === body.key); return r ? { id: r.id } : undefined; },
    attest: async receipt => {
      requireMatch(receipt.id === createdId || (trustedBinding?.id === receipt.id && trustedBinding.fingerprint === fingerprint));
      const r = await discoverResource(q => client().vaults.credentials.list(vaultId, q), r => r.key === body.key);
      requireMatch(!!r && r.id === receipt.id && r.vault_id === vaultId && r.kind === body.kind && r.agent_id === body.agent_id && r.mcp_server_url === body.mcp_server_url && r.host === null && r.expires_at === (body.expires_at ?? null));
    },
    create: async key => { const r = await client(key).vaults.credentials.create(vaultId, body); createdId = r.id; return { id: r.id }; },
  };
}
