/**
 * Prebuilt sandbox environments, bundled as strings (prebuilt-files.generated.ts) so they build inside serverless
 * functions. Regenerate with `npx tsx scripts/gen-sandbox-prebuilt.ts` after editing data/envs/<id>/*.
 */
import type { IntegrationMode } from "../spec";
import { buildEnvironmentSpec, type BuildReport } from "./build";
import { PREBUILT_ENV_FILES } from "./prebuilt-files.generated";
import type { EnvironmentSpec } from "../spec";

export interface PrebuiltEnvInfo { id: string; specId: string; name: string; domain: string; frozenNow: string }

const META: Record<string, Omit<PrebuiltEnvInfo, "id">> = {
  "acme-support": { specId: "acme_support", name: "Acme Support", domain: "customer support: orders, refunds, tickets", frozenNow: "2026-06-01T15:00:00Z" },
  "tau2-retail": { specId: "tau2_retail", name: "tau2 Retail", domain: "retail customer service: orders, returns, exchanges", frozenNow: "2026-06-01T15:00:00Z" },
};

/** Prebuilt environments available in this build (only those whose files exist under data/envs). */
export function listPrebuiltEnvs(): PrebuiltEnvInfo[] {
  return Object.keys(PREBUILT_ENV_FILES).filter((id) => META[id]).map((id) => ({ id, ...META[id]! }));
}

export function isPrebuiltEnvId(id: string): boolean {
  return listPrebuiltEnvs().some((e) => e.id === id);
}

export async function buildPrebuiltEnv(id: string, integration?: IntegrationMode): Promise<{ spec: EnvironmentSpec; report: BuildReport }> {
  const files = PREBUILT_ENV_FILES[id];
  const meta = META[id];
  if (!files || !meta) throw new Error(`Unknown prebuilt environment: ${id}`);
  return buildEnvironmentSpec({
    id: meta.specId,
    name: meta.name,
    domain: meta.domain,
    openapi: files["openapi.yaml"],
    ddl: files["schema.sql"],
    seedSql: files["seed.sql"],
    frozenNow: meta.frozenNow,
    policiesMarkdown: files["policies.md"],
    workflows: JSON.parse(files["workflows.json"]) as unknown[],
    ...(integration ? { integration } : {}),
  });
}
