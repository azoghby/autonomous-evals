import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, timestamp, integer, bigint, jsonb, boolean, uniqueIndex, index, pgEnum,
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
  source: text("source").notNull(), // naive | ai_gateway
  agent: text("agent"),
  sessionId: text("session_id"),
  microUsd: bigint("micro_usd", { mode: "number" }).notNull(),
  meta: jsonb("meta").notNull().default({}),
  createdAt,
}, (t) => [index("costs_job_idx").on(t.jobId)]);

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
  purpose: text("purpose").notNull(), // auth | commercial | job | expert_outreach
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
