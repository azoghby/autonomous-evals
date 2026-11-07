import { z } from "zod";
import type { AcquisitionRequest, AcquisitionResult, DataBatch } from "../acquisition";
import type { DataTaskSpec } from "../types";
import { assessDataQuality, inspectDataSafety } from "../quality";
import { canonicalJson } from "../../text/freeze";

export interface VerifiedRegistryConfig {
  registryId: string;
  /** Authenticated deployment configuration, never request content or a model/search response. */
  entries: Array<{ task: DataTaskSpec; data: DataBatch }>;
  maxSources: number;
  maxCases: number;
  maxContentChars: number;
  knownSecrets?: readonly string[];
}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
const date = z.string().refine(value => Number.isFinite(Date.parse(value)));
const publicHttps = z.string().url().refine(value => {
  const u = new URL(value);
  return u.protocol === "https:" && !u.username && !u.password && !u.port
    && !/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(u.hostname)
    && !u.hostname.endsWith(".local");
});
const review = z.object({ status: z.literal("approved"), reviewerId: z.string().min(1), reviewedAt: date, notes: z.string() }).strict();
const source = z.object({ id, url: publicHttps, content: z.string().min(1), license: z.object({
  name: z.string().min(1), url: publicHttps, permission: z.literal("allowed"),
  allowedUses: z.array(z.enum(["evaluation", "generation", "redistribution"])).min(1),
}).strict(), provenance: z.object({ origin: z.literal("public"), producerId: z.string().min(1),
  retrievedAt: date, contentHash: z.string().regex(/^[a-f0-9]{64}$/), }).strict(), review }).strict();
const withoutReview = (value: DataBatch["sources"][number]) => { const { review: _review, ...rest } = value; return rest; };
const withoutVerification = (value: DataBatch["cases"][number]) => { const { verification: _verification, ...rest } = value; return rest; };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Offline, task-scoped verified public registry. No network or search capability is claimed. */
export function createVerifiedRegistryAdapter(config: VerifiedRegistryConfig): {
  discover(request: AcquisitionRequest): Promise<AcquisitionResult>;
  reviewCandidates(data: DataBatch, request: AcquisitionRequest): Promise<DataBatch>;
} {
  id.parse(config.registryId);
  for (const cap of [config.maxSources, config.maxCases, config.maxContentChars]) {
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("Invalid registry cap");
  }
  if (config.maxSources > 100 || config.maxCases > 100 || config.maxContentChars > 100_000 || config.entries.length > 100) throw new Error("Registry cap exceeds hard limit");
  // Clone once: later mutation of a caller's config must not change approved material.
  const entries = structuredClone(config.entries);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.task.taskId)) throw new Error("Duplicate registry task");
    seen.add(entry.task.taskId);
    if (!inspectDataSafety(entry, config.knownSecrets).safe || entry.data.sources.length > config.maxSources
      || entry.data.cases.length > config.maxCases || entry.data.sources.reduce((sum, item) => sum + item.content.length, 0) > config.maxContentChars) throw new Error("Unsafe or oversized registry entry");
    for (const item of entry.data.sources) source.parse(item);
    const assessment = assessDataQuality(entry.task, entry.data.cases, entry.data.sources, { knownSecrets: config.knownSecrets });
    if (assessment.issues.length || assessment.acceptedCaseIds.length !== entry.data.cases.length) throw new Error("Registry entry lacks independent review or valid provenance");
  }
  function entryFor(request: AcquisitionRequest) {
    const entry = entries.find(value => value.task.taskId === request.task.taskId);
    if (entry && !same(entry.task, request.task)) throw new Error("Registry task scope conflict");
    return entry;
  }
  return {
    async discover(request) {
      const entry = entryFor(request);
      if (!entry) return { status: "complete", data: { sources: [], cases: [] } };
      const data = structuredClone(entry.data);
      return { status: "complete", data: {
        sources: data.sources.map(value => ({ ...value, review: { status: "pending", reviewerId: "", reviewedAt: "", notes: "Registry candidate; independent configured review required." } })),
        cases: data.cases.map(withoutVerification),
      } };
    },
    async reviewCandidates(data, request) {
      const entry = entryFor(request);
      if (!entry) return { sources: [], cases: [] };
      // A ledger approval is valid only for the same referenced evidence payload as well as the case.
      const evidenceMatches = (approved: DataBatch["cases"][number]) =>
        [...approved.sourceIds, ...(approved.verification?.evidenceSourceIds ?? [])].every(sourceId => {
          const trusted = entry.data.sources.find(source => source.id === sourceId);
          return trusted && data.sources.some(candidate => candidate.id === sourceId && same(withoutReview(candidate), withoutReview(trusted)));
        });
      return structuredClone({
        sources: entry.data.sources.filter(approved => data.sources.some(candidate => candidate.id === approved.id && same(withoutReview(candidate), withoutReview(approved)))),
        cases: entry.data.cases.filter(approved => evidenceMatches(approved) && data.cases.some(candidate => candidate.id === approved.id && same(withoutVerification(candidate), withoutVerification(approved)))),
      });
    },
  };
}
