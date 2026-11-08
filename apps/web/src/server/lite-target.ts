import "server-only";
import type { IntakeInput } from "@ae/core/contracts/index";
import type { LiteTarget } from "@ae/core/lite/index";
import { getJobWithDecryptedCredentials } from "./job-store";

/** Intake endpoint the lite engine investigates/re-runs against (candidate B for version comparisons). */
export function liteTargetFromIntake(intake: IntakeInput): LiteTarget | null {
  const ep = intake.package === "text_eval" || intake.package === "workflow_eval" ? intake.endpoint
    : intake.package === "version_comparison" ? intake.endpointB : undefined;
  if (!ep) return null;
  return { url: ep.url, model: ep.model, apiKey: ep.apiKey, systemPrompt: ep.systemPrompt ?? "" };
}

/**
 * Durable target lookup for the lite engine when its in-memory copy is gone (serverless step boundaries).
 * Reads the job's stored intake and decrypts credentials (AES-GCM) server-side; the key is only returned to the engine.
 */
export async function resolveJobTarget(jobId: string): Promise<LiteTarget | null> {
  const full = await getJobWithDecryptedCredentials(jobId);
  return full ? liteTargetFromIntake(full.intake) : null;
}
