import "server-only";
/** Turns collected onboarding requirements into a SandboxIntakeInput (and fetches OpenAPI specs from public URLs). */
import type { OnboardingRequirements } from "@ae/core/company/onboarding";
import { GATEWAY_TARGET_MODELS, GATEWAY_TARGET_URL, SandboxIntakeInput } from "@/components/sandbox/contract";
import { assertPublicTarget } from "../target-url";

export const HOSTED_MODELS: readonly string[] = GATEWAY_TARGET_MODELS;
export const MAX_SPEC_BYTES = 500_000;
const FETCH_TIMEOUT_MS = 10_000;

/** A problem with what the customer gave us, phrased for the customer. */
export class IntakeError extends Error {
  constructor(message: string, readonly field: "openapiUrl" | "other" = "other") { super(message); this.name = "IntakeError"; }
}

export type FetchSpec = (url: string) => Promise<string>;

/** SSRF-checked, size- and time-bounded fetch of a public OpenAPI document. No redirects, no credentials. */
export const defaultFetchSpec: FetchSpec = async (url) => {
  const reason = await assertPublicTarget(url);
  if (reason) throw new IntakeError(`I can't fetch that URL (${reason}).`, "openapiUrl");
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json, application/yaml, text/yaml, */*" } });
  if (!res.ok) throw new IntakeError(`That URL returned HTTP ${res.status}.`, "openapiUrl");
  const text = await res.text();
  if (text.length > MAX_SPEC_BYTES) throw new IntakeError("That spec is larger than 500 KB; please paste the relevant part.", "openapiUrl");
  return text;
};

export async function buildIntake(req: OnboardingRequirements, fetchSpec: FetchSpec): Promise<SandboxIntakeInput> {
  const { agent, tools } = req;
  const integration = agent.endpointUrl
    ? { mode: "tool_loop" as const, endpointUrl: agent.endpointUrl, model: agent.model ?? "default", ...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}) }
    : { mode: "tool_loop" as const, endpointUrl: GATEWAY_TARGET_URL, model: agent.model ?? "", ...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}) };
  const name = req.name?.trim() || "Onboarding agent";
  if (tools.prebuiltWorld) {
    return SandboxIntakeInput.parse({ name, domain: "customer support: orders, refunds, tickets", integration, prebuilt: tools.prebuiltWorld });
  }
  let toolsPart: { format: "openapi" | "mcp_tools"; content: string };
  if (tools.openapiText) toolsPart = { format: "openapi", content: tools.openapiText };
  else if (tools.mcpToolsJson) toolsPart = { format: "mcp_tools", content: tools.mcpToolsJson };
  else if (tools.openapiUrl) toolsPart = { format: "openapi", content: await fetchSpec(tools.openapiUrl) };
  else throw new IntakeError("I still need the agent's tools.");
  const hasDdl = !!req.dataSample && /\bcreate\s+table\b/i.test(req.dataSample);
  return SandboxIntakeInput.parse({
    name, domain: "", integration,
    world: {
      tools: toolsPart,
      data: hasDdl ? { format: "ddl", content: req.dataSample } : { format: "infer", content: "" },
      policies: req.policies ? [{ title: "Customer policies", text: req.policies }] : [],
      workflowNotes: "",
    },
  });
}
