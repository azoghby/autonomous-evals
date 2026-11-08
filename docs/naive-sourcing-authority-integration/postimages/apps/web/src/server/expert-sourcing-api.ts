import "server-only";
import { z } from "zod";
import { readBoundedJson } from "./body-limit";
import type { Viewer } from "./access";

/** Only safe status metadata crosses this interface; proposals, intake and credentials never do. */
export interface SharingStatus {
  status: "not_consented" | "active" | "revoked" | "expired" | "input_changed";
  topic: string | null;
  eligibleTopics: string[];
}
export interface ExpertSourcingApiDependencies {
  currentViewer(): Promise<Viewer | null>;
  disclosure: { version: string; text: string };
  getSharingStatus(input: { jobId: string; customerId: string }): Promise<SharingStatus | null>;
  /** Under the job mutex and row lock: recheck ownership/session, recompute canonical digest, select exact eligible owner topic. */
  issueConsent(input: { jobId: string; customerId: string; topic: string; disclosureVersion: string; currentCustomer: () => Promise<string | null> }): Promise<void>;
  /** Takes the job mutex only; must not acquire a policy mutex afterward. */
  revokeConsent(input: { jobId: string; customerId: string; currentCustomer: () => Promise<string | null> }): Promise<void>;
  getPolicies(input: { tenantId: string }): Promise<Array<{ id: string; topic: string; environment: "test" | "live"; status: "active" | "revoked" | "expired"; expiresAt: string }>>;
  /** Immutable standing envelope: enables future eligible opted-in jobs without per-job operator approval. */
  issuePolicy(input: { tenantId: string; topic: string; environment: "test" | "live"; capsPolicyId: string; expiresAt: string; maxRequirements: number; maxContextChars: number; grantLifetimeSeconds: number; currentOperator: () => Promise<string | null> }): Promise<void>;
  /** Takes the same policy mutex as dispatch, and rechecks the callback before committing. */
  revokePolicy(input: { policyId: string; reason: string; currentOperator: () => Promise<string | null> }): Promise<void>;
}
export class ExpertSourcingApiError extends Error {
  constructor(readonly status: 403 | 404 | 409, message: string) { super(message); }
}
const uuid = z.uuid();
const topic = z.string().trim().min(1).max(160);
const CustomerBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("consent"), consent: z.literal(true), disclosureVersion: z.string().min(1).max(120), topic }).strict(),
  z.object({ action: z.literal("revoke") }).strict(),
]);
const OperatorBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issue"), tenantId: uuid, topic, environment: z.enum(["test", "live"]), capsPolicyId: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.:-]+$/), expiresAt: z.iso.datetime(), maxRequirements: z.number().int().min(1).max(36).default(36), maxContextChars: z.number().int().min(1).max(16000).default(16000), grantLifetimeSeconds: z.number().int().min(60).max(604800).default(604800) }).strict(),
  z.object({ action: z.literal("revoke"), policyId: uuid, reason: z.string().trim().min(1).max(500) }).strict(),
]);
const privateHeaders = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: privateHeaders });
const failure = (status: number, error: string) => json({ error }, status);
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Session-cookie mutation requires positive browser-origin evidence; missing headers fail closed.
  if (!origin || origin !== new URL(request.url).origin) return false;
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin";
}
async function parse<S extends z.ZodType>(request: Request, schema: S) {
  if (!request.headers.get("content-type")?.split(";")[0].trim().toLowerCase().match(/^application\/json$/)) return { error: failure(415, "JSON required") } as const;
  const body = await readBoundedJson(request, 4096);
  if (!body.ok) return { error: json(await body.res.json(), body.res.status) } as const;
  const value = schema.safeParse(body.value);
  return value.success ? { data: value.data } as const : { error: failure(400, "Invalid request") } as const;
}
async function mutation(work: () => Promise<void>) {
  try { await work(); return json({ ok: true }); }
  catch (error) {
    if (error instanceof ExpertSourcingApiError) return failure(error.status, error.message);
    // Do not expose SQL errors, proposals, credentials or canonical input.
    return failure(409, "Sourcing authorization unavailable; refresh and retry");
  }
}
export const sourcingUnavailable = () => failure(503, "Sourcing authorization unavailable");
export async function withSourcingApiResponse(work: () => Promise<Response>): Promise<Response> {
  try { return await work(); } catch { return sourcingUnavailable(); }
}
export function createExpertSourcingApi(deps: ExpertSourcingApiDependencies) {
  const currentCustomer = (id: string) => async () => (await deps.currentViewer())?.id === id ? id : null;
  const currentOperator = async () => { const viewer = await deps.currentViewer(); return viewer?.isOperator ? viewer.id : null; };
  const handlers = {
    async customerGet(_request: Request, jobId: string) {
      const viewer = await deps.currentViewer();
      if (!viewer) return failure(401, "Authentication required");
      if (!uuid.safeParse(jobId).success) return failure(404, "Job not found");
      try {
        const state = await deps.getSharingStatus({ jobId, customerId: viewer.id });
        if (!state) return failure(404, "Job not found");
        return json({ disclosure: deps.disclosure, status: state.status, topic: state.topic, eligibleTopics: state.eligibleTopics });
      } catch { return failure(503, "Sharing status unavailable"); }
    },
    async customerPost(request: Request, jobId: string) {
      const viewer = await deps.currentViewer();
      if (!viewer) return failure(401, "Authentication required");
      if (!sameOrigin(request)) return failure(403, "Same-origin request required");
      if (!uuid.safeParse(jobId).success) return failure(404, "Job not found");
      const body = await parse(request, CustomerBody);
      if (body.error) return body.error;
      if (body.data.action === "consent" && body.data.disclosureVersion !== deps.disclosure.version) return failure(409, "Disclosure changed; review current disclosure");
      const identity = { jobId, customerId: viewer.id, currentCustomer: currentCustomer(viewer.id) };
      const response = await mutation(async () => {
        if (body.data.action === "consent") await deps.issueConsent({ ...identity, topic: body.data.topic, disclosureVersion: deps.disclosure.version });
        else await deps.revokeConsent(identity);
      });
      return body.data.action === "revoke" && response.ok ? json({ ok: true, boundary: "Future dispatch is blocked. A dispatch that began before revocation may complete; delivered messages cannot be recalled." }) : response;
    },
    async operatorGet(request: Request) {
      const viewer = await deps.currentViewer();
      if (!viewer) return failure(401, "Authentication required");
      if (!viewer.isOperator) return failure(403, "Operator access required");
      const params = new URL(request.url).searchParams;
      const tenantId = params.get("tenantId");
      if (!uuid.safeParse(tenantId).success || [...params.keys()].some(key => key !== "tenantId") || params.getAll("tenantId").length !== 1) return failure(400, "Valid tenantId required");
      try {
        const policies = await deps.getPolicies({ tenantId: tenantId! });
        return json({ policies: policies.slice(0, 100).map(row => ({ id: row.id, topic: row.topic, environment: row.environment, status: row.status, expiresAt: row.expiresAt })) });
      } catch { return failure(503, "Sourcing policies unavailable"); }
    },
    async operatorPost(request: Request) {
      const viewer = await deps.currentViewer();
      if (!viewer) return failure(401, "Authentication required");
      if (!viewer.isOperator) return failure(403, "Operator access required");
      if (!sameOrigin(request)) return failure(403, "Same-origin request required");
      const body = await parse(request, OperatorBody);
      if (body.error) return body.error;
      const response = await mutation(async () => {
        if (body.data.action === "issue") {
          const { action: _, ...input } = body.data;
          await deps.issuePolicy({ ...input, currentOperator });
        } else await deps.revokePolicy({ policyId: body.data.policyId, reason: body.data.reason, currentOperator });
      });
      return body.data.action === "revoke" && response.ok ? json({ ok: true, boundary: "Future dispatch is blocked. A dispatch that began before revocation may complete; delivered messages cannot be recalled." }) : response;
    },
  };
  return {
    customerGet: (request: Request, jobId: string) => withSourcingApiResponse(() => handlers.customerGet(request, jobId)),
    customerPost: (request: Request, jobId: string) => withSourcingApiResponse(() => handlers.customerPost(request, jobId)),
    operatorGet: (request: Request) => withSourcingApiResponse(() => handlers.operatorGet(request)),
    operatorPost: (request: Request) => withSourcingApiResponse(() => handlers.operatorPost(request)),
  };
}
