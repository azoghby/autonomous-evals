import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import type { InternalCredential } from "./naive-internal-store";
import { ProgressSnapshotSchema, type ProgressSnapshot } from "@ae/core/reporting/chat/types";

export type InternalDeniedReason = "auth_denied" | "rate_limited" | "request_denied" | "read_denied" | "internal_error";
export interface InternalMcpDependencies {
  authenticate(bearer: string): Promise<InternalCredential | null>;
  read(credential: InternalCredential, input: { taskToken: string }): Promise<ProgressSnapshot>;
  auditDenied(reason: InternalDeniedReason, credentialId?: string): Promise<void>;
  rateLimit(credential: InternalCredential): Promise<boolean>;
}
const MAX_BODY = 16 * 1024;
function error(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}
/** Every request owns its credential closure; no cross-request authentication state. */
export function createInternalMcpHandler(deps: InternalMcpDependencies) {
  return async (req: Request): Promise<Response> => {
    let credential: InternalCredential | null = null;
    const deny = async (reason: InternalDeniedReason, status: number) => {
      await deps.auditDenied(reason, credential?.id);
      return error(status, reason);
    };
    try {
      if (new URL(req.url).pathname !== "/api/mcp/internal/mcp") return await deny("request_denied", 404);
      if (req.method !== "POST") return await deny("request_denied", 405);
      const authorization = req.headers.get("authorization") ?? "";
      const match = /^Bearer ([\x21-\x7e]{1,2048})$/i.exec(authorization);
      if (!match) return await deny("auth_denied", 401);
      credential = await deps.authenticate(match[1]);
      if (!credential) return await deny("auth_denied", 401);
      if (!await deps.rateLimit(credential)) return await deny("rate_limited", 429);
      if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return await deny("request_denied", 415);
      const reader = req.body?.getReader();
      if (!reader) return await deny("request_denied", 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_BODY) { await reader.cancel(); return await deny("request_denied", 413); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const body = Buffer.concat(chunks);
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { return await deny("request_denied", 400); }
      // Reject batches and selectors before the SDK can include invalid input in an error.
      const envelope = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string().max(128), z.number(), z.null()]).optional(), method: z.string().max(128), params: z.unknown().optional() }).strict().safeParse(parsed);
      if (!envelope.success) return await deny("request_denied", 400);
      const method = envelope.data.method;
      if (!["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"].includes(method)) return await deny("request_denied", 400);
      if (["tools/list", "ping", "notifications/initialized"].includes(method) && envelope.data.params !== undefined && !z.object({}).strict().safeParse(envelope.data.params).success) return await deny("request_denied", 400);
      if (method === "initialize" && !z.object({
        protocolVersion: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
        capabilities: z.object({}).passthrough(),
        clientInfo: z.object({ name: z.string().min(1).max(128), version: z.string().max(128), title: z.string().max(128).optional() }).strict(),
      }).strict().safeParse(envelope.data.params).success) return await deny("request_denied", 400);
      if (envelope.data.method === "tools/call") {
        const call = z.object({ name: z.literal("get_progress_snapshot"), arguments: z.object({ task_token: z.string().min(1).max(4096) }).strict() }).strict().safeParse(envelope.data.params);
        if (!call.success) return await deny("request_denied", 400);
      }
      const ownedCredential = credential;
      const handler = createMcpHandler((server) => {
        server.registerTool("get_progress_snapshot", {
          title: "Get assigned task progress", description: "Read bounded progress for the task token supplied as task_token. This does not authenticate a provider session.",
          inputSchema: z.object({ task_token: z.string().min(1).max(4096) }).strict(),
          annotations: { readOnlyHint: true, openWorldHint: false },
        }, async ({ task_token }) => {
          try {
            const snapshot = ProgressSnapshotSchema.parse(await deps.read(ownedCredential, { taskToken: task_token }));
            return { content: [{ type: "text" as const, text: JSON.stringify(snapshot) }] };
          } catch {
            // Audit failures remain private and cannot yield progress.
            try { await deps.auditDenied("read_denied", ownedCredential.id); } catch {
              return { content: [{ type: "text" as const, text: '{"error":"internal_error"}' }], isError: true };
            }
            return { content: [{ type: "text" as const, text: '{"error":"read_denied"}' }], isError: true };
          }
        });
      }, { serverInfo: { name: "standard-evals-internal", version: "1.0.0" }, maxSubscriptions: 0, verboseLogs: false });
      const response = await handler(new Request(req.url, { method: "POST", headers: req.headers, body }));
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch {
      try { await deps.auditDenied("internal_error", credential?.id); } catch { /* Fail closed without payload logging. */ }
      return error(503, "internal_error");
    }
  };
}
