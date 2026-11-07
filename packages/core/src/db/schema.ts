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
