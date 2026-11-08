import type { ToolBinding } from "../spec";

/** Binding every parser emits; bindings.ts replaces it. */
export const PLACEHOLDER_BINDING: ToolBinding = { kind: "simulated", instructions: "", readsTables: [], recordsOutbox: false };

/** Explicit SQL supplied by the customer/author (OpenAPI `x-sandbox-sql`); still safety-checked. */
export interface SqlHint {
  statements: string[];
  resultFrom?: number;
  resultShape?: "rows" | "row" | "count" | "none";
}

/** Executes SQL against a scratch Postgres. Positional params ($1..$n). */
export interface SqlExec {
  exec(sql: string): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

export type BindingOrigin = "hint" | "rule" | "llm" | "simulated";
