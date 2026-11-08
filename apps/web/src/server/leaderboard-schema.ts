/** Leaderboard tables now live in @ae/core schema; re-exported here for existing imports. */
import { schema } from "@ae/core/db/client";
export const { publicAgents, publicAgentRuns } = schema;

export const ENSURE_TABLES_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS public_agents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL, name text NOT NULL, vendor text NOT NULL, kind text NOT NULL DEFAULT 'third_party',
    endpoint_url text NOT NULL, model text NOT NULL, auth_env_var text, system_prompt text, homepage text,
    terms_url text, authorized_note text, active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS public_agents_slug_uq ON public_agents (slug)`,
  `CREATE TABLE IF NOT EXISTS public_agent_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id uuid NOT NULL REFERENCES public_agents(id) ON DELETE CASCADE,
    suite_version text NOT NULL, ran_at timestamptz NOT NULL DEFAULT now(),
    passed integer NOT NULL, total integer NOT NULL, by_category jsonb NOT NULL,
    findings jsonb NOT NULL DEFAULT '[]'::jsonb, cost_micro_usd bigint NOT NULL DEFAULT 0, job_id uuid)`,
  `CREATE INDEX IF NOT EXISTS public_agent_runs_agent_ran_idx ON public_agent_runs (agent_id, ran_at)`,
];
