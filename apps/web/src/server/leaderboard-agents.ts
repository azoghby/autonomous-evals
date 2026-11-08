/**
 * Public-agent registry rules. We only test agents we are allowed to test: a termsUrl AND an authorizedNote are mandatory.
 */
import { z } from "zod";
import { SLUG_RE } from "./leaderboard";

export const AGENT_KINDS = ["reference", "third_party", "local_reference"] as const;
/** Kinds that run on the operator's machine (loopback shim). Never run by the web/cron path; CLI only, behind --allow-local. */
export const LOCAL_KINDS: readonly string[] = ["local_reference"];
export const isLocalKind = (kind: string | null | undefined): boolean => !!kind && LOCAL_KINDS.includes(kind);
/** The only non-HTTPS endpoint shape accepted: http://127.0.0.1:<port>/v1/chat/completions (exactly). */
export const LOCAL_ENDPOINT_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}\/v1\/chat\/completions$/;

export const PublicAgentInput = z.object({
  slug: z.string().regex(SLUG_RE, "slug: lowercase letters, digits, dashes"),
  name: z.string().min(1).max(120),
  vendor: z.string().min(1).max(120),
  kind: z.enum(AGENT_KINDS),
  /** Full OpenAI-compatible chat completions URL. HTTPS only, except local_reference (loopback shim, see LOCAL_ENDPOINT_RE). */
  endpointUrl: z.url(),
  model: z.string().min(1).max(200),
  /** NAME of the env var that holds the key. Never the key itself. */
  authEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "authEnvVar must be an ENV_VAR_NAME, not a key").nullish(),
  systemPrompt: z.string().max(20_000).nullish(),
  homepage: z.url().nullish(),
  termsUrl: z.url().nullish(),
  authorizedNote: z.string().max(1_000).nullish(),
  active: z.boolean().default(true),
}).superRefine((a, ctx) => {
  const local = isLocalKind(a.kind);
  if (local && !LOCAL_ENDPOINT_RE.test(a.endpointUrl)) ctx.addIssue({ code: "custom", path: ["endpointUrl"], message: "local_reference endpointUrl must be http://127.0.0.1:<port>/v1/chat/completions" });
  if (!local && !a.endpointUrl.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["endpointUrl"], message: "endpointUrl must use HTTPS" });
  if (local && a.authEnvVar) ctx.addIssue({ code: "custom", path: ["authEnvVar"], message: "local_reference agents take no API key" });
});
export type PublicAgentInput = z.infer<typeof PublicAgentInput>;

export class UnauthorizedAgentError extends Error {
  constructor(slug: string, reason: string) {
    super(`Refusing to test "${slug}": ${reason}`);
    this.name = "UnauthorizedAgentError";
  }
}

const SECRET_LIKE = /^(sk-|vck_|gw_|Bearer\s|[A-Za-z0-9_-]{32,}$)/;
const PLACEHOLDER = /^\s*(todo|tbd|n\/a|none|-)?\s*$/i;

/** Throws UnauthorizedAgentError unless the agent is active and has a real termsUrl + authorizedNote. */
export function assertAuthorizedToTest(agent: { slug: string; active?: boolean; termsUrl?: string | null; authorizedNote?: string | null; authEnvVar?: string | null }): void {
  if (agent.active === false) throw new UnauthorizedAgentError(agent.slug, "agent is inactive (opted out or paused)");
  if (!agent.termsUrl || PLACEHOLDER.test(agent.termsUrl) || !/^https:\/\//.test(agent.termsUrl)) throw new UnauthorizedAgentError(agent.slug, "termsUrl is missing (https URL of the terms that permit testing)");
  if (!agent.authorizedNote || PLACEHOLDER.test(agent.authorizedNote)) throw new UnauthorizedAgentError(agent.slug, "authorizedNote is missing (who authorized testing, and how)");
  if (agent.authEnvVar && SECRET_LIKE.test(agent.authEnvVar)) throw new UnauthorizedAgentError(agent.slug, "authEnvVar looks like a secret; store only the env var NAME");
}
