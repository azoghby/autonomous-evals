import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, timestamp, integer, bigint, jsonb, boolean, uniqueIndex, index, pgEnum, doublePrecision, serial,
} from "drizzle-orm/pg-core";
import { JOB_STATES, PACKAGES } from "../contracts/index";

export const jobState = pgEnum("job_state", JOB_STATES);
export const packageEnum = pgEnum("package", PACKAGES);
export const envEnum = pgEnum("environment", ["live", "test"]);

const ts = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = ts("created_at").notNull().defaultNow();

export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  name: text("name"),
  team: text("team"),
  source: text("source").notNull().default("walk_up"), // walk_up | outreach | inbound
  isInternalFixture: boolean("is_internal_fixture").notNull().default(false),
  /** Billing plan (packages/core/src/pricing/plans.ts PlanId): developer | pro | scale | enterprise. */
  plan: text("plan").notNull().default("developer"),
  /** month | year for self-serve subscriptions; null on developer/enterprise. */
  planInterval: text("plan_interval"),
  /** Stripe subscription status mirror (active | trialing | past_due | canceled ...); null when never subscribed. */
  planStatus: text("plan_status"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  planCurrentPeriodEnd: ts("plan_current_period_end"),
  planUpdatedAt: ts("plan_updated_at"),
  createdAt,
}, (t) => [uniqueIndex("customers_email_uq").on(sql`lower(${t.email})`)]);

export const magicLinks = pgTable("magic_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt,
}, (t) => [uniqueIndex("magic_links_token_uq").on(t.tokenHash)]);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt,
}, (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash)]);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  package: packageEnum("package").notNull(),
  state: jobState("state").notNull().default("draft"),
  environment: envEnum("environment").notNull().default("test"),
  /** Intake without secrets (credentials live in job_credentials). */
  intake: jsonb("intake").notNull(),
  traceBlobPath: text("trace_blob_path"),
  workflowRunId: text("workflow_run_id"),
  retestOfJobId: uuid("retest_of_job_id"),
  isMock: boolean("is_mock").notNull().default(false),
  neonBranchId: text("neon_branch_id"),
  /** Neon snapshot of the job branch taken at delivery (reproducibility). */
  deliverySnapshotId: text("delivery_snapshot_id"),
  reportBlobPath: text("report_blob_path"),
  suiteBlobPath: text("suite_blob_path"),
  budgetReservedMicroUsd: bigint("budget_reserved_micro_usd", { mode: "number" }).notNull().default(0),
  error: text("error"),
  deliveredAt: ts("delivered_at"),
  credentialsDeleteAfter: ts("credentials_delete_after"),
  branchDeleteAfter: ts("branch_delete_after"),
  idempotencyKey: text("idempotency_key"),
  createdAt,
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("jobs_customer_idx").on(t.customerId),
  index("jobs_state_idx").on(t.state),
  uniqueIndex("jobs_idem_uq").on(t.customerId, t.idempotencyKey),
]);

export const jobCredentials = pgTable("job_credentials", {
  jobId: uuid("job_id").primaryKey().references(() => jobs.id),
  /** AES-256-GCM ciphertext of a JSON map of slot -> apiKey. */
  ciphertext: text("ciphertext").notNull(),
  createdAt,
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  role: text("role").notNull(), // customer | commercial | operator | system
  body: text("body").notNull(),
  createdAt,
}, (t) => [index("messages_job_idx").on(t.jobId)]);

export const quotes = pgTable("quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  version: integer("version").notNull(),
  package: packageEnum("package").notNull(),
  priceCents: integer("price_cents").notNull(),
  scopeSummary: text("scope_summary").notNull(),
  deliverables: jsonb("deliverables").notNull(),
  acceptedAt: ts("accepted_at"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  /** 'fixed' | 'per_finding'. Chosen by the customer at acceptance; priceCents stays the fixed price. */
  pricingMode: text("pricing_mode").notNull().default("fixed"),
  /** Authorization cap for per_finding quotes (null for fixed). */
  capCents: integer("cap_cents"),
  createdAt,
}, (t) => [uniqueIndex("quotes_job_version_uq").on(t.jobId, t.version)]);

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  quoteVersion: integer("quote_version").notNull(),
  stripeEventId: text("stripe_event_id"),
  stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("usd"),
  environment: envEnum("environment").notNull(),
  kind: text("kind").notNull().default("one_time"), // one_time | subscription
  /** Set once the workflow hook accepted payment_confirmed; null rows are retried by cron. */
  workflowResumedAt: ts("workflow_resumed_at"),
  /** paid (fixed) | authorized (per_finding hold) | captured | released | needs_refund (late/mismatched fixed payment; refund is manual). */
  status: text("status").notNull().default("paid"),
  capturedAmountCents: integer("captured_amount_cents"),
  createdAt,
}, (t) => [
  uniqueIndex("payments_session_uq").on(t.stripeCheckoutSessionId),
  uniqueIndex("payments_event_uq").on(t.stripeEventId),
]);

export const progressEvents = pgTable("progress_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  milestone: text("milestone").notNull(),
  message: text("message").notNull(),
  createdAt,
}, (t) => [index("progress_job_idx").on(t.jobId, t.createdAt)]);

export const findings = pgTable("findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  findingKey: text("finding_key").notNull(),
  data: jsonb("data").notNull(),
  rerunOfFindingId: uuid("rerun_of_finding_id"),
  createdAt,
}, (t) => [index("findings_job_idx").on(t.jobId)]);

/** Validated fixes ("fix, not just find"): one per confirmed finding. data = Remediation contract. */
export const remediations = pgTable("remediations", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  findingRowId: uuid("finding_row_id").notNull().references(() => findings.id),
  data: jsonb("data").notNull(),
  createdAt,
}, (t) => [index("remediations_job_idx").on(t.jobId), uniqueIndex("remediations_finding_uq").on(t.findingRowId)]);

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => jobs.id),
  agent: text("agent").notNull(),
  agentId: text("agent_id"),
  agentVersion: text("agent_version"),
  sessionId: text("session_id"),
  status: text("status").notNull().default("created"),
  decision: text("decision"),
  result: jsonb("result"),
  usageMicroUsd: bigint("usage_micro_usd", { mode: "number" }).notNull().default(0),
  createdAt,
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("agent_sessions_session_uq").on(t.sessionId)]);

export const costs = pgTable("costs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => jobs.id),
  source: text("source").notNull(), // naive | naive_proxy | ai_gateway
  agent: text("agent"),
  sessionId: text("session_id"),
  microUsd: bigint("micro_usd", { mode: "number" }).notNull(),
  meta: jsonb("meta").notNull().default({}),
  createdAt,
  receiptKey: text("receipt_key"),
  receiptIdentity: jsonb("receipt_identity"),
}, (t) => [index("costs_job_idx").on(t.jobId), uniqueIndex("costs_provider_receipt_uq").on(t.source, t.receiptKey).where(sql`${t.receiptKey} is not null`)]);

export const budgetReservations = pgTable("budget_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  agent: text("agent").notNull(),
  microUsd: bigint("micro_usd", { mode: "number" }).notNull(),
  releasedAt: ts("released_at"),
  createdAt,
});

export const interventions = pgTable("interventions", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => jobs.id),
  operatorEmail: text("operator_email").notNull(),
  kind: text("kind").notNull(), // refund | override | fix | approve_outreach | other
  note: text("note").notNull(),
  createdAt,
});

export const outreachDrafts = pgTable("outreach_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | sent
  /** expert_invite (default, legacy rows) | agent_invite (free-benchmark invitation to a third-party agent owner). */
  kind: text("kind").notNull().default("expert_invite"),
  approvedBy: text("approved_by"),
  sentAt: ts("sent_at"),
  createdAt,
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  scope: text("scope").notNull(),
  response: jsonb("response"),
  createdAt,
});

export const monitoringSubscriptions = pgTable("monitoring_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  stripeSubscriptionId: text("stripe_subscription_id"),
  status: text("status").notNull().default("pending"),
  environment: envEnum("environment").notNull(),
  lastRunAt: ts("last_run_at"),
  createdAt,
});

/** One nightly re-run of a frozen suite per subscription per UTC day. */
export const monitoringRuns = pgTable("monitoring_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: uuid("subscription_id").notNull().references(() => monitoringSubscriptions.id),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  /** UTC calendar day this run covers (YYYY-MM-DD); with subscription_id it makes the cron idempotent. */
  runDate: text("run_date").notNull(),
  ranAt: ts("ran_at").notNull().defaultNow(),
  /** [{ scenarioId, passed, detail }] */
  results: jsonb("results").notNull(),
  regressions: integer("regressions").notNull().default(0),
}, (t) => [
  uniqueIndex("monitoring_runs_sub_day_uq").on(t.subscriptionId, t.runDate),
  index("monitoring_runs_sub_idx").on(t.subscriptionId),
]);

/** At most one follow-up email per (subject, kind). subject_type: job | expert_engagement. */
export const followUps = pgTable("follow_ups", {
  id: uuid("id").primaryKey().defaultRandom(),
  subjectType: text("subject_type").notNull(),
  subjectId: uuid("subject_id").notNull(),
  kind: text("kind").notNull(),
  sentAt: ts("sent_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("follow_ups_subject_kind_uq").on(t.subjectType, t.subjectId, t.kind)]);

// ---- Expert Network (docs/EXPERT_NETWORK.md) ----

export const experts = pgTable("experts", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  organization: text("organization"),
  domains: text("domains").array().notNull().default(sql`'{}'::text[]`),
  profileUrl: text("profile_url"),
  source: text("source").notNull().default("opt_in"), // opt_in | customer_nominated | agent_researched
  rateCents: integer("rate_cents"),
  availability: text("availability"),
  consentFlags: jsonb("consent_flags").notNull().default({}),
  status: text("status").notNull().default("active"), // active | opted_out
  createdAt,
}, (t) => [uniqueIndex("experts_email_uq").on(sql`lower(${t.email})`)]);

export const expertRequests = pgTable("expert_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => jobs.id),
  domain: text("domain").notNull(),
  questions: jsonb("questions").notNull(),
  purpose: text("purpose").notNull(),
  maxBudgetCents: integer("max_budget_cents").notNull().default(0),
  status: text("status").notNull().default("open"), // open | answered | closed
  requestedByAgentSession: uuid("requested_by_agent_session").references(() => agentSessions.id),
  createdAt,
}, (t) => [index("expert_requests_status_idx").on(t.status)]);

export const expertEngagements = pgTable("expert_engagements", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id").notNull().references(() => expertRequests.id),
  expertId: uuid("expert_id").notNull().references(() => experts.id),
  mode: text("mode").notNull().default("async"), // async | call
  tokenHash: text("token_hash").notNull(),
  /** Hashes of rotated-out tokens. Only opt-out (CAN-SPAM) still honors these; everything else needs the current token. */
  previousTokenHashes: text("previous_token_hashes").array().notNull().default(sql`'{}'::text[]`),
  expiresAt: ts("expires_at").notNull(),
  scheduledAt: ts("scheduled_at"),
  calendarEventId: text("calendar_event_id"),
  recordingConsent: boolean("recording_consent").notNull().default(false),
  honorariumCents: integer("honorarium_cents").notNull().default(0),
  paidAt: ts("paid_at"),
  /** The outreach_drafts row that carries the invite; sending goes through the operator approve route only. */
  outreachDraftId: uuid("outreach_draft_id").references(() => outreachDrafts.id),
  status: text("status").notNull().default("invited"), // invited | answered | paid | cancelled
  answeredAt: ts("answered_at"),
  createdAt,
}, (t) => [
  uniqueIndex("expert_engagements_token_uq").on(t.tokenHash),
  uniqueIndex("expert_engagements_req_expert_uq").on(t.requestId, t.expertId),
  index("expert_engagements_expert_idx").on(t.expertId),
]);

export const expertResponses = pgTable("expert_responses", {
  id: uuid("id").primaryKey().defaultRandom(),
  engagementId: uuid("engagement_id").notNull().references(() => expertEngagements.id),
  answers: jsonb("answers").notNull(),
  transcriptBlobPath: text("transcript_blob_path"),
  insights: jsonb("insights"),
  provenance: text("provenance").notNull().default("expert_sourced"),
  createdAt,
}, (t) => [index("expert_responses_engagement_idx").on(t.engagementId)]);

/** Operator-published call availability. An expert claims one atomically via taken_by_engagement_id. */
export const callSlots = pgTable("call_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  startsAt: ts("starts_at").notNull(),
  durationMin: integer("duration_min").notNull().default(15),
  takenByEngagementId: uuid("taken_by_engagement_id").references(() => expertEngagements.id),
  createdAt,
}, (t) => [
  uniqueIndex("call_slots_starts_at_uq").on(t.startsAt),
  index("call_slots_engagement_idx").on(t.takenByEngagementId),
]);

/** Maps an AgentMail thread to the job / expert engagement it belongs to, so inbound replies can be routed. */
export const emailThreads = pgTable("email_threads", {
  threadId: text("thread_id").primaryKey(),
  jobId: uuid("job_id").references(() => jobs.id),
  expertEngagementId: uuid("expert_engagement_id").references(() => expertEngagements.id),
  /** Owner-submitted public agent this thread is about (owner replies are answered by the responder). */
  publicAgentId: uuid("public_agent_id").references(() => publicAgents.id, { onDelete: "set null" }),
  purpose: text("purpose").notNull(), // auth | commercial | job | expert_outreach | owner_agent
  createdAt,
}, (t) => [index("email_threads_job_idx").on(t.jobId), index("email_threads_engagement_idx").on(t.expertEngagementId)]);

export const contactSuppressions = pgTable("contact_suppressions", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stored lowercased. */
  email: text("email").notNull(),
  reason: text("reason").notNull().default("opt_out"),
  createdAt,
}, (t) => [uniqueIndex("contact_suppressions_email_uq").on(sql`lower(${t.email})`)]);

/** App-level fixed-window rate limiter (fallback behind Vercel Firewall rules). One row per key. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: ts("window_start").notNull().defaultNow(),
  count: integer("count").notNull().default(0),
});

/** API keys for agents (MCP). Only the sha256 hash is stored; the plaintext is shown once at creation. */
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  /** First 8 chars of the plaintext key, for display only. */
  prefix: text("prefix").notNull(),
  lastUsedAt: ts("last_used_at"),
  revokedAt: ts("revoked_at"),
  createdAt,
}, (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash), index("api_keys_customer_idx").on(t.customerId)]);

/** Opt-in public share link per job. Only the sha256 hash of the token is stored; plaintext is returned once. */
export const jobShares = pgTable("job_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  tokenHash: text("token_hash").notNull(),
  createdAt,
  revokedAt: ts("revoked_at"),
}, (t) => [
  uniqueIndex("job_shares_job_uq").on(t.jobId),
  uniqueIndex("job_shares_token_uq").on(t.tokenHash),
]);

/** Customer's GitHub repo target for shipping verified fixes as PRs. Token is AES-256-GCM encrypted; deleted at tokenExpiresAt. */
export const jobGithubTargets = pgTable("job_github_targets", {
  jobId: uuid("job_id").primaryKey().references(() => jobs.id),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  baseBranch: text("base_branch").notNull(),
  filePath: text("file_path").notNull(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenExpiresAt: ts("token_expires_at").notNull(),
  createdAt,
});

export const githubPrs = pgTable("github_prs", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  remediationId: uuid("remediation_id").notNull().references(() => remediations.id),
  branch: text("branch").notNull(),
  prNumber: integer("pr_number").notNull(),
  prUrl: text("pr_url").notNull(),
  createdAt,
}, (t) => [uniqueIndex("github_prs_remediation_uq").on(t.remediationId), index("github_prs_job_idx").on(t.jobId)]);

/** CI regression re-runs of a job's frozen suite (POST /api/v1/regression-runs). */
export const regressionRuns = pgTable("regression_runs", {
  id: uuid("id").primaryKey(),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  status: text("status").notNull(),
  result: jsonb("result"),
  error: text("error"),
  createdAt,
}, (t) => [index("regression_runs_customer_idx").on(t.customerId, t.createdAt)]);

// ---- Public agents leaderboard ----
export const publicAgents = pgTable("public_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  vendor: text("vendor").notNull(),
  kind: text("kind").notNull().default("third_party"), // reference | third_party
  endpointUrl: text("endpoint_url").notNull(),
  model: text("model").notNull(),
  authEnvVar: text("auth_env_var"), // NAME of the env var holding the key; never the key
  systemPrompt: text("system_prompt"),
  homepage: text("homepage"),
  termsUrl: text("terms_url"),
  authorizedNote: text("authorized_note"),
  active: boolean("active").notNull().default(true),
  // ---- owner-submitted agents (agent-owner autopilot). Null owner_email = operator-seeded reference/third-party row. ----
  /** Lowercased owner address; the only person our agents email about this agent. */
  ownerEmail: text("owner_email"),
  /** public (leaderboard) | private (results go to the owner only). */
  visibility: text("visibility").notNull().default("public"),
  /** pending_verification | active | paused | opted_out. `active` mirrors status === "active" (the runner gate). */
  status: text("status").notNull().default("active"),
  /** AES-256-GCM ciphertext (storage/crypto encrypt) of the owner's API key. Never returned or logged. */
  apiKeyCiphertext: text("api_key_ciphertext"),
  /** Consent record captured at submission: { version, authorizeText, emailsText, acceptedAt, ipHash }. */
  consent: jsonb("consent"),
  verifiedAt: ts("verified_at"),
  /** Set by the owner (reply responder) to ask for a re-run; cleared when the run starts. */
  rerunRequestedAt: ts("rerun_requested_at"),
  createdAt,
}, (t) => [uniqueIndex("public_agents_slug_uq").on(t.slug), index("public_agents_owner_idx").on(sql`lower(${t.ownerEmail})`)]);

export const publicAgentRuns = pgTable("public_agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => publicAgents.id, { onDelete: "cascade" }),
  suiteVersion: text("suite_version").notNull(),
  ranAt: ts("ran_at").notNull().defaultNow(),
  passed: integer("passed").notNull(),
  total: integer("total").notNull(),
  byCategory: jsonb("by_category").notNull().$type<Record<string, { passed: number; total: number }>>(),
  findings: jsonb("findings").notNull().$type<unknown[]>().default(sql`'[]'::jsonb`),
  costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
  jobId: uuid("job_id"),
}, (t) => [index("public_agent_runs_agent_ran_idx").on(t.agentId, t.ranAt)]);


/** Single-use hashed tokens for owner-submitted agents (purpose: verify). Only sha256(token) is stored. */
export const publicAgentTokens = pgTable("public_agent_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull().references(() => publicAgents.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull().default("verify"),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt,
}, (t) => [uniqueIndex("public_agent_tokens_hash_uq").on(t.tokenHash), index("public_agent_tokens_agent_idx").on(t.agentId)]);

/** Every email our agents send to an agent owner. Drives the non-transactional cadence cap (1 per owner per 3 days). */
export const ownerEmailLog = pgTable("owner_email_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Lowercased. */
  ownerEmail: text("owner_email").notNull(),
  agentId: uuid("agent_id").references(() => publicAgents.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  transactional: boolean("transactional").notNull(),
  messageId: text("message_id"),
  sentAt: ts("sent_at").notNull().defaultNow(),
}, (t) => [index("owner_email_log_owner_sent_idx").on(t.ownerEmail, t.sentAt)]);

/* ---------------- Sandbox Evals (engine-backed; packages/core/src/sandbox) ---------------- */

/** A customer's sandbox world: the built EnvironmentSpec (tools, DDL/seed, policies, workflows, integration). No secrets. */
export const sandboxEnvironments = pgTable("sandbox_environments", {
  /** env_<uuid> */
  id: text("id").primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => customers.id),
  /** Reserved for team/org ownership; null = personal. */
  orgId: text("org_id"),
  name: text("name").notNull(),
  domain: text("domain").notNull().default(""),
  /** prebuilt | custom */
  source: text("source").notNull(),
  prebuiltId: text("prebuilt_id"),
  spec: jsonb("spec").notNull().$type<unknown>(),
  warnings: jsonb("warnings").notNull().$type<string[]>().default(sql`'[]'::jsonb`),
  createdAt,
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("sandbox_environments_owner_idx").on(t.ownerId, t.createdAt)]);

/** A generated + gated scenario suite for an environment (the wizard's "draft"). id = drf_<uuid>. */
export const sandboxSuites = pgTable("sandbox_suites", {
  id: text("id").primaryKey(),
  environmentId: text("environment_id").notNull().references(() => sandboxEnvironments.id, { onDelete: "cascade" }),
  ownerId: uuid("owner_id").notNull().references(() => customers.id),
  orgId: text("org_id"),
  /** generating | gating | ready | failed */
  status: text("status").notNull().default("generating"),
  /** GeneratedScenario[] (scenario + grader mutations) before gating. */
  generated: jsonb("generated").notNull().$type<unknown[]>().default(sql`'[]'::jsonb`),
  /** Reviewable scenarios: {scenario, decision, edited, validated, gateReasons}[]. */
  scenarios: jsonb("scenarios").notNull().$type<unknown[]>().default(sql`'[]'::jsonb`),
  costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
  budgetMicroUsd: bigint("budget_micro_usd", { mode: "number" }).notNull(),
  error: text("error"),
  workflowRunId: text("workflow_run_id"),
  createdAt,
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("sandbox_suites_owner_idx").on(t.ownerId, t.createdAt), index("sandbox_suites_env_idx").on(t.environmentId)]);

/** One sandbox eval run: k trials per accepted scenario against the target, with pass^k + Wilson CI. id = run_<uuid>. */
export const sandboxRuns = pgTable("sandbox_runs", {
  id: text("id").primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => customers.id),
  orgId: text("org_id"),
  environmentId: text("environment_id").notNull().references(() => sandboxEnvironments.id, { onDelete: "cascade" }),
  suiteId: text("suite_id").references(() => sandboxSuites.id, { onDelete: "set null" }),
  /** queued | running | complete | failed */
  status: text("status").notNull().default("queued"),
  k: integer("k").notNull(),
  /** SandboxScenario[] frozen at start. */
  scenarios: jsonb("scenarios").notNull().$type<unknown[]>(),
  /** ScenarioResult[] (per-trial results inside), one entry per finished scenario. */
  results: jsonb("results").notNull().$type<unknown[]>().default(sql`'[]'::jsonb`),
  /** Gate report summaries of the scenarios in this run, copied from the suite. */
  gates: jsonb("gates").notNull().$type<unknown[]>().default(sql`'[]'::jsonb`),
  /** SuiteSummary (pass@1, pass^k, byCategory, security). */
  summary: jsonb("summary").$type<unknown>(),
  passAt1: doublePrecision("pass_at_1"),
  passHatK: doublePrecision("pass_hat_k"),
  ci95Low: doublePrecision("ci95_low"),
  ci95High: doublePrecision("ci95_high"),
  versions: jsonb("versions").$type<unknown>(),
  costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
  budgetMicroUsd: bigint("budget_micro_usd", { mode: "number" }).notNull(),
  trialsDone: integer("trials_done").notNull().default(0),
  trialsTotal: integer("trials_total").notNull().default(0),
  /** Neon world id (neon-world:<branchId>) while the run holds a job branch; cleared on teardown. */
  worldId: text("world_id"),
  workflowRunId: text("workflow_run_id"),
  error: text("error"),
  /** fatal | retryable | budget */
  errorKind: text("error_kind"),
  startedAt: ts("started_at"),
  completedAt: ts("completed_at"),
  createdAt,
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("sandbox_runs_owner_idx").on(t.ownerId, t.createdAt), index("sandbox_runs_status_idx").on(t.status)]);

/* ---------------- Plans & sales (packages/core/src/pricing/plans.ts) ---------------- */

/** Every completed plan/audit Checkout (subscription or one-off Agent Audit). Idempotent on the Checkout session id. */
export const planPurchases = pgTable("plan_purchases", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").references(() => customers.id),
  email: text("email").notNull(),
  /** subscription | audit */
  kind: text("kind").notNull(),
  /** pro | scale | agent_audit */
  product: text("product").notNull(),
  /** month | year (subscriptions only) */
  interval: text("interval"),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull().default("usd"),
  environment: envEnum("environment").notNull(),
  stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripeCustomerId: text("stripe_customer_id"),
  /** paid | active | canceled | delivered (audit) */
  status: text("status").notNull().default("paid"),
  createdAt,
}, (t) => [uniqueIndex("plan_purchases_session_uq").on(t.stripeCheckoutSessionId), index("plan_purchases_customer_idx").on(t.customerId)]);

/** Enterprise "Talk to us" requests from /contact-sales. Shown in the operator console; no automatic emails to the prospect. */
export const salesLeads = pgTable("sales_leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  workEmail: text("work_email").notNull(),
  company: text("company").notNull(),
  agentDescription: text("agent_description").notNull(),
  /** Free-text / bucketed expected volume (e.g. "10k-100k trials/mo"). */
  volume: text("volume").notNull(),
  /** new | contacted | qualified | closed */
  status: text("status").notNull().default("new"),
  source: text("source").notNull().default("contact_sales"),
  /** sha256(ip) for abuse triage; never the raw IP. */
  ipHash: text("ip_hash"),
  createdAt,
}, (t) => [index("sales_leads_created_idx").on(t.createdAt)]);

// ---- Founder approvals + phone notifications (docs/FOUNDER_APPROVALS.md) ----

/** One thing the founder must approve/reject (or an FYI) from their phone. Decisions are idempotent: only pending rows change. */
export const founderApprovals = pgTable("founder_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Short human id for "YES 12" replies. */
  seq: serial("seq").notNull(),
  /** Registered handler kind, e.g. outreach_draft | sales_lead | plan_purchase | job_intervention | company_* */
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  /** Redacted, phone-sized summary (no secrets, no prospect emails). */
  summary: text("summary").notNull(),
  /** Payload reference (e.g. outreach_drafts.id). Unique per kind so re-requests are no-ops. */
  ref: text("ref").notNull(),
  payload: jsonb("payload").notNull().default({}),
  /** pending | approved | rejected | expired | fyi */
  status: text("status").notNull().default("pending"),
  /** telegram | whatsapp | email | email_reply | console */
  decidedVia: text("decided_via"),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  /** Handler outcome note or error after a decision. */
  result: text("result"),
  expiresAt: ts("expires_at"),
  /** Channel message refs, e.g. { telegram: { chatId, messageId } } so buttons can be cleared after deciding. */
  channelRefs: jsonb("channel_refs").notNull().default({}),
  createdAt,
}, (t) => [
  uniqueIndex("founder_approvals_kind_ref_uq").on(t.kind, t.ref),
  uniqueIndex("founder_approvals_seq_uq").on(t.seq),
  index("founder_approvals_status_idx").on(t.status, t.createdAt),
]);

/** Single-row (id = "founder") channel bindings set from /operator, so chat ids need no env vars. */
export const founderNotifySettings = pgTable("founder_notify_settings", {
  id: text("id").primaryKey(),
  telegramChatId: text("telegram_chat_id"),
  /** sha256 of the one-time /start code; never the code itself. */
  telegramLinkCodeHash: text("telegram_link_code_hash"),
  telegramLinkCodeExpiresAt: ts("telegram_link_code_expires_at"),
  whatsappTo: text("whatsapp_to"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/**
 * Outbound founder emails we started (approval requests and daily reports), keyed by AgentMail thread id.
 * A reply is only treated as a founder command when it arrives on one of these threads (anti-spoofing).
 */
export const founderEmailThreads = pgTable("founder_email_threads", {
  threadId: text("thread_id").primaryKey(),
  /** The approval this thread asked about; null for the daily report thread. */
  approvalId: uuid("approval_id").references(() => founderApprovals.id, { onDelete: "set null" }),
  /** approval | report */
  kind: text("kind").notNull(),
  createdAt,
});

/** Founder free-text email replies that are not commands. Data only: surfaced in /operator and the next daily report, never acted on. */
export const founderNotes = pgTable("founder_notes", {
  id: uuid("id").primaryKey().defaultRandom(),
  body: text("body").notNull(),
  threadId: text("thread_id").notNull(),
  /** Inbound AgentMail message id (unique: a replayed webhook cannot duplicate a note). */
  messageId: text("message_id").notNull(),
  /** Approval seq the thread was about, when known. */
  approvalSeq: integer("approval_seq"),
  /** Set when the note was included in a daily report. */
  reportedAt: ts("reported_at"),
  createdAt,
}, (t) => [uniqueIndex("founder_notes_message_uq").on(t.messageId), index("founder_notes_created_idx").on(t.createdAt)]);

/* ---------------- Agent-run company (packages/core/src/company, apps/web/src/server/company) ---------------- */

/** Per-agent on/off toggle set from the operator console. Absent row = registry default for the environment. */
export const companyAgentSettings = pgTable("company_agent_settings", {
  /** Registry id (packages/core/src/company/registry.ts CompanyAgentId). */
  agentId: text("agent_id").primaryKey(),
  enabled: boolean("enabled").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** One row per agent run (cron tick, webhook turn, manual trigger). Summary/detail must not carry secrets. */
export const companyAgentActivity = pgTable("company_agent_activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: text("agent_id").notNull(),
  /** cron | manual | webhook | planner | chat */
  trigger: text("trigger").notNull(),
  /** running | ok | skipped | failed | budget */
  status: text("status").notNull().default("running"),
  /** Operator-facing summary (may name leads; the public /company view never shows it). */
  summary: text("summary"),
  /** Public-safe one-liner (no PII, no company names) shown on /company. */
  publicSummary: text("public_summary"),
  /** Counters for the org chart, e.g. { leads: 12, drafts: 3 }. */
  counts: jsonb("counts").notNull().$type<Record<string, number>>().default(sql`'{}'::jsonb`),
  detail: jsonb("detail").notNull().$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
  costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
  budgetMicroUsd: bigint("budget_micro_usd", { mode: "number" }).notNull().default(0),
  error: text("error"),
  dryRun: boolean("dry_run").notNull().default(false),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
}, (t) => [index("company_agent_activity_agent_idx").on(t.agentId, t.startedAt), index("company_agent_activity_started_idx").on(t.startedAt)]);

/** Dated market brief written by the market research agent. */
export const marketBriefs = pgTable("market_briefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** YYYY-MM-DD (UTC). One brief per day (re-runs overwrite). */
  briefDate: text("brief_date").notNull(),
  activityId: uuid("activity_id").references(() => companyAgentActivity.id, { onDelete: "set null" }),
  /** MarketBrief (packages/core/src/company/schemas.ts). */
  brief: jsonb("brief").notNull().$type<unknown>(),
  sources: jsonb("sources").notNull().$type<Array<{ url: string; title?: string }>>().default(sql`'[]'::jsonb`),
  costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
  createdAt,
}, (t) => [uniqueIndex("market_briefs_date_uq").on(t.briefDate)]);

/** Companies shipping customer-facing AI agents, found from PUBLIC sources only. Nothing here is ever contacted directly. */
export const prospectLeads = pgTable("prospect_leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Normalized registrable domain, the dedupe key (e.g. acme.ai). */
  domain: text("domain").notNull(),
  company: text("company").notNull(),
  segment: text("segment").notNull(),
  agentDescription: text("agent_description").notNull(),
  /** Public evidence URLs (product pages, launch posts, docs). */
  evidence: jsonb("evidence").notNull().$type<Array<{ url: string; note?: string }>>().default(sql`'[]'::jsonb`),
  /** 0..100 */
  fitScore: integer("fit_score").notNull(),
  fitReason: text("fit_reason").notNull().default(""),
  /** PlanId from packages/core/src/pricing/plans.ts. */
  recommendedPlan: text("recommended_plan").notNull(),
  /** Publicly listed work email (via Monid), with the URL where it was published. */
  contactEmail: text("contact_email"),
  contactName: text("contact_name"),
  contactRole: text("contact_role"),
  contactSource: text("contact_source"),
  /** new | drafted | contacted | replied | opted_in | disqualified | suppressed */
  status: text("status").notNull().default("new"),
  outreachDraftId: uuid("outreach_draft_id").references(() => outreachDrafts.id, { onDelete: "set null" }),
  activityId: uuid("activity_id").references(() => companyAgentActivity.id, { onDelete: "set null" }),
  createdAt,
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("prospect_leads_domain_uq").on(t.domain), index("prospect_leads_status_idx").on(t.status, t.fitScore)]);

/** Tasks the CEO/Planner agent assigns to other company agents. */
export const companyTasks = pgTable("company_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** YYYY-MM-DD plan this task belongs to. */
  planDate: text("plan_date").notNull(),
  assignee: text("assignee").notNull(),
  title: text("title").notNull(),
  rationale: text("rationale").notNull().default(""),
  /** 1 (highest) .. 5 */
  priority: integer("priority").notNull().default(3),
  /** open | running | done | skipped | failed */
  status: text("status").notNull().default("open"),
  /** Activity row of the run that executed it. */
  activityId: uuid("activity_id").references(() => companyAgentActivity.id, { onDelete: "set null" }),
  createdBy: text("created_by").notNull().default("planner"),
  createdAt,
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("company_tasks_plan_idx").on(t.planDate, t.assignee)]);

/** The planner's daily plan (one per day), included in the operator digest. */
export const companyPlans = pgTable("company_plans", {
  planDate: text("plan_date").primaryKey(),
  summary: text("summary").notNull(),
  metrics: jsonb("metrics").notNull().$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
  activityId: uuid("activity_id").references(() => companyAgentActivity.id, { onDelete: "set null" }),
  createdAt,
});

/** Customer Success conversations: a signed-up customer asked for help setting up a run (email thread or in-app chat). */
export const onboardingConversations = pgTable("onboarding_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  /** email | chat */
  channel: text("channel").notNull(),
  /** AgentMail thread id for email conversations. */
  threadId: text("thread_id"),
  /** collecting | building | running | reported | blocked | closed */
  status: text("status").notNull().default("collecting"),
  /** OnboardingRequirements collected so far (no secrets: API keys are refused and never stored here). */
  collected: jsonb("collected").notNull().$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
  /** [{role: customer|agent, text, at}] trimmed transcript. */
  transcript: jsonb("transcript").notNull().$type<Array<{ role: string; text: string; at: string }>>().default(sql`'[]'::jsonb`),
  environmentId: text("environment_id"),
  suiteId: text("suite_id"),
  runId: text("run_id"),
  reportedAt: ts("reported_at"),
  costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
  createdAt,
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("onboarding_conversations_customer_idx").on(t.customerId, t.createdAt), uniqueIndex("onboarding_conversations_thread_uq").on(t.threadId)]);

/**
 * Eval copilot: one chat thread per (owner, eval). eval_kind is sandbox_run | job; eval_id is the run or job id.
 * Each row is one AI SDK UIMessage (role + parts). Tool outputs are stored redacted.
 */
export const evalChatMessages = pgTable("eval_chat_messages", {
  id: text("id").primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  evalKind: text("eval_kind").notNull(),
  evalId: text("eval_id").notNull(),
  /** user | assistant */
  role: text("role").notNull(),
  message: jsonb("message").notNull().$type<Record<string, unknown>>(),
  createdAt,
}, (t) => [index("eval_chat_messages_thread_idx").on(t.ownerId, t.evalKind, t.evalId, t.createdAt)]);

/**
 * Eval copilot actions the model proposed. The client can only confirm/cancel by id; the server executes the payload it stored,
 * never client-supplied parameters. status: proposed | confirmed | executed | cancelled | failed | expired
 */
export const evalChatActions = pgTable("eval_chat_actions", {
  id: text("id").primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  evalKind: text("eval_kind").notNull(),
  evalId: text("eval_id").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
  status: text("status").notNull().default("proposed"),
  /** What executing produced (draft id, run id, share url, error). */
  result: jsonb("result").$type<Record<string, unknown>>(),
  expiresAt: ts("expires_at").notNull(),
  createdAt,
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("eval_chat_actions_owner_idx").on(t.ownerId, t.evalKind, t.evalId, t.createdAt)]);
