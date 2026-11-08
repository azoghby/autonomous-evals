/**
 * Expert Network contracts (docs/EXPERT_NETWORK.md). Shared between Track A (tables, pages, approval)
 * and Track B (agents emit ExpertRequest, extract ExpertInsight).
 */
import { z } from "zod";

export const EXPERT_SOURCES = ["opt_in", "customer_nominated", "agent_researched"] as const;
export const ExpertSource = z.enum(EXPERT_SOURCES);
export type ExpertSource = z.infer<typeof ExpertSource>;

export const EXPERT_MODES = ["async", "call"] as const;
export type ExpertMode = (typeof EXPERT_MODES)[number];

/** Pilot honoraria in cents. Paid manually; logged, not automated. */
export const HONORARIUM_CENTS: Record<ExpertMode, number> = { async: 2_500, call: 7_500 };

export const MAX_QUESTIONS = 8;
export const MAX_ANSWER_CHARS = 5_000;

const Domain = z.string().trim().min(2).max(80);

export const ExpertSignup = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  title: z.string().trim().min(1).max(160),
  organization: z.string().trim().max(160).optional(),
  domains: z.array(Domain).min(1).max(5),
  profileUrl: z.url().max(500).refine((u) => u.startsWith("https://"), "Profile URL must use HTTPS").optional(),
  rateCents: z.int().min(0).max(1_000_000).optional(),
  availability: z.string().trim().min(1).max(1_000),
  consents: z.object({
    contactForPaidWork: z.literal(true),
    recordCalls: z.boolean(),
    attributeByName: z.boolean(),
  }),
});
export type ExpertSignup = z.infer<typeof ExpertSignup>;

/** Emitted by agents as structured output. Code decides whether it is allowed (budget, consent, rate limit). */
export const ExpertRequest = z.object({
  domain: Domain,
  questions: z.array(z.string().trim().min(1).max(1_000)).min(1).max(MAX_QUESTIONS),
  purpose: z.string().trim().min(1).max(1_000),
  jobId: z.uuid().optional(),
  maxBudgetCents: z.int().min(0).max(1_000_000),
});
export type ExpertRequest = z.infer<typeof ExpertRequest>;

export const QuestionnaireAnswers = z.object({
  answers: z.array(z.object({
    questionIndex: z.int().min(0).max(MAX_QUESTIONS - 1),
    answer: z.string().trim().min(1).max(MAX_ANSWER_CHARS),
  })).min(1).max(MAX_QUESTIONS),
});
export type QuestionnaireAnswers = z.infer<typeof QuestionnaireAnswers>;

/** Structured insight Track B extracts from a response, always labeled expert-sourced. */
export const ExpertInsight = z.object({
  claim: z.string().min(1).max(2_000),
  quote: z.string().min(1).max(2_000),
  confidence: z.enum(["low", "medium", "high"]),
});
export type ExpertInsight = z.infer<typeof ExpertInsight>;
