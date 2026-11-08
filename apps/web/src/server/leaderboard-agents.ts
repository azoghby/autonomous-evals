/**
 * Public-agent registry rules. We only test agents we are allowed to test: a termsUrl AND an authorizedNote are mandatory.
 */
import { z } from "zod";
import { SLUG_RE } from "./leaderboard";

export const AGENT_KINDS = ["reference", "third_party"] as const;

export const PublicAgentInput = z.object({
  slug: z.string().regex(SLUG_RE, "slug: lowercase letters, digits, dashes"),
  name: z.string().min(1).max(120),
  vendor: z.string().min(1).max(120),
  kind: z.enum(AGENT_KINDS),
  /** Full OpenAI-compatible chat completions URL. HTTPS only. */
  endpointUrl: z.url().refine((u) => u.startsWith("https://"), "endpointUrl must use HTTPS"),
  model: z.string().min(1).max(200),
  /** NAME of the env var that holds the key. Never the key itself. */
  authEnvVar: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "authEnvVar must be an ENV_VAR_NAME, not a key").nullish(),
  systemPrompt: z.string().max(20_000).nullish(),
  homepage: z.url().nullish(),
  termsUrl: z.url().nullish(),
  authorizedNote: z.string().max(1_000).nullish(),
  active: z.boolean().default(true),
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
