import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { EnvironmentSpec, SandboxScenario, type ToolSpec } from "../spec";
import { compileNamedParams } from "../runtime/sql-text";
import { WORLD_PREAMBLE_SQL } from "../runtime/world-sql";
import { buildCsAgentsAirline, CS_AIRLINE_FROZEN_NOW } from "./cs-agents-airline";
import { createPgliteExec } from "./validate";

const envDir = resolve(fileURLToPath(import.meta.url), "../../../../../../data/envs/cs-agents-airline");
const haveEnv = ["openapi.yaml", "schema.sql", "seed.sql", "policies.md", "workflows.json", "LICENSE", "NOTICE.md"].every((f) => existsSync(resolve(envDir, f)));

/** The tools the demo's six agents use (python-backend/airline/agents.py). baggage_tool is defined but unused upstream. */
const TOOLS = ["faq_lookup_tool", "get_trip_details", "update_seat", "flight_status_tool", "get_matching_flights", "book_new_flight", "assign_special_service_seat", "issue_compensation", "display_seat_map", "cancel_flight"];
const WRITES = ["update_seat", "book_new_flight", "assign_special_service_seat", "issue_compensation", "cancel_flight"];

describe.skipIf(!haveEnv)("buildCsAgentsAirline", () => {
  let built: Awaited<ReturnType<typeof buildCsAgentsAirline>>;
  beforeAll(async () => { built = await buildCsAgentsAirline(createPgliteExec(new PGlite())); }, 120_000);

  it("builds a valid spec with the demo's 10 tools, all SQL-bound from hints, nothing downgraded", () => {
    const { spec, report } = built;
    expect(EnvironmentSpec.safeParse(spec).success).toBe(true);
    expect(spec.id).toBe("cs_agents_airline");
    expect(spec.state.frozenNow).toBe(CS_AIRLINE_FROZEN_NOW);
    expect(spec.tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
    for (const t of spec.tools) {
      expect(t.binding.kind, t.name).toBe("sql");
      expect(report.bindings[t.name]!.origin, t.name).toBe("hint");
      expect(t.effect, t.name).toBe(WRITES.includes(t.name) ? "write" : "read");
    }
    expect(report.validation?.ok).toBe(true);
    expect(report.validation?.downgraded ?? []).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("policies parse into clauses and workflows reference existing clauses and tools", () => {
    const ids = new Set(built.spec.policies[0]!.clauses.map((c) => c.id));
    expect(ids.size).toBeGreaterThanOrEqual(30);
    for (const wf of built.spec.workflows) {
      for (const ref of wf.policyRefs) expect(ids.has(ref), `${wf.id}:${ref}`).toBe(true);
      for (const t of wf.tools) expect(TOOLS).toContain(t);
    }
  });

  it("scenarios.json parses, references existing workflows/tools and only allows known tables", async () => {
    const { readFileSync } = await import("node:fs");
    const file = JSON.parse(readFileSync(resolve(envDir, "scenarios.json"), "utf8")) as { envId: string; accepted: unknown[] };
    expect(file.envId).toBe("cs_agents_airline");
    expect(file.accepted).toHaveLength(3);
    const wfs = new Set(built.spec.workflows.map((w) => w.id));
    for (const raw of file.accepted) {
      const s = SandboxScenario.parse(raw);
      expect(wfs.has(s.workflowId), s.id).toBe(true);
      for (const t of s.allowedWriteTables) expect(built.spec.state.reportTables).toContain(t);
      for (const t of s.trajectoryAssertions) for (const n of [("tool" in t ? t.tool : undefined), ("first" in t ? t.first : undefined), ("then" in t ? t.then : undefined)]) if (n) expect(TOOLS).toContain(n);
    }
  });
});

/* ---- behavioural checks: the real bindings against the seeded world ---- */

describe.skipIf(!haveEnv)("cs-agents-airline tool semantics", () => {
  let db: PGlite;
  let tools: Map<string, ToolSpec>;
  let ddl = "";
  let seed = "";

  async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any> | null> {
    const b = tools.get(name)!.binding;
    if (b.kind !== "sql") throw new Error("not sql");
    await db.exec("BEGIN");
    const rows: Array<Array<Record<string, any>>> = [];
    for (const stmt of b.statements) {
      const { text, values } = compileNamedParams(stmt, args);
      rows.push((await db.query(text, values as unknown[])).rows as Array<Record<string, any>>);
    }
    await db.exec("COMMIT");
    return rows[b.resultFrom ?? rows.length - 1]![0] ?? null;
  }
  const one = async (sql: string): Promise<any> => (await db.query(sql)).rows[0];
  const segs = async (conf: string): Promise<string> =>
    (await one(`SELECT string_agg(flight_number || ':' || status, ',' ORDER BY seq) AS s FROM booking_segments WHERE confirmation_number = '${conf}'`)).s;

  beforeAll(async () => {
    const { spec } = await buildCsAgentsAirline();
    tools = new Map(spec.tools.map((t) => [t.name, t]));
    ddl = spec.state.ddl;
    seed = spec.state.seedSql;
  }, 120_000);
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(WORLD_PREAMBLE_SQL);
    await db.exec(`INSERT INTO sandbox_clock (id, frozen_now) VALUES (1, '${CS_AIRLINE_FROZEN_NOW}')`);
    await db.exec(ddl);
    await db.exec(seed);
  });

  it("faq_lookup_tool and display_seat_map return the demo's strings", async () => {
    expect((await call("faq_lookup_tool", { question: "How many bags can I bring?" }))!.message).toMatch(/^You are allowed to bring one bag/);
    expect((await call("faq_lookup_tool", { question: "compensation for delays?" }))!.message).toMatch(/over 3 hours or causes a missed connection/);
    expect((await call("faq_lookup_tool", { question: "what is the meaning of life" }))!.message).toBe("I'm sorry, I don't know the answer to that question.");
    expect((await call("display_seat_map"))!.message).toBe("DISPLAY_SEAT_MAP");
  });

  it("get_trip_details hydrates the disrupted or on-time itinerary like the demo", async () => {
    const r = (await call("get_trip_details", { message: "My Paris to Austin trip is delayed" }))!;
    expect(r.message).toBe("Hydrated disrupted itinerary: flight PA441, confirmation IR-D204, origin Paris (CDG), destination Austin (AUS). PA441 Paris (CDG) -> New York (JFK) status: Delayed 5 hours due to weather, expected departure 19:55; NY802 New York (JFK) -> Austin (AUS) status: Connection missed because of first leg delay");
    db = new PGlite(); await db.exec(WORLD_PREAMBLE_SQL); await db.exec(`INSERT INTO sandbox_clock (id, frozen_now) VALUES (1, '${CS_AIRLINE_FROZEN_NOW}')`); await db.exec(ddl); await db.exec(seed);
    const o = (await call("get_trip_details", { message: "cancel my SFO flight please" }))!;
    expect([o.scenario, o.confirmation_number, o.flight_number]).toEqual(["on_time", "LL0EZ6", "FLT-123"]);
  });

  it("update_seat changes only the named booking and rejects unknown confirmations / bad seats", async () => {
    expect((await call("update_seat", { confirmation_number: "IR-D204", new_seat: "10a" }))!.message).toBe("Updated seat to 10a for confirmation number IR-D204");
    expect((await one("SELECT seat_number FROM bookings WHERE confirmation_number = 'IR-D204'")).seat_number).toBe("10A");
    expect((await one("SELECT seat_number FROM bookings WHERE confirmation_number = 'LL0EZ6'")).seat_number).toBe("23A");
    expect(await call("update_seat", { confirmation_number: "XX0000", new_seat: "10A" })).toBeNull();
    expect(await call("update_seat", { confirmation_number: "LL0EZ6", new_seat: "window please" })).toBeNull();
  });

  it("flight_status_tool reports delay + missed connection, replacements, and unknown flights", async () => {
    expect((await call("flight_status_tool", { flight_number: "PA441" }))!.message).toBe("Flight PA441 (Paris (CDG) to New York (JFK)) | Status: Delayed 5 hours due to weather, expected departure 19:55 | Gate: B18 | Scheduled 2024-12-09 14:10 -> 2024-12-09 17:40 | This delay will cause a missed connection to NY802. Reaccommodation is recommended.");
    expect((await call("flight_status_tool", { flight_number: "NY950" }))!.message).toMatch(/^Replacement flight NY950 .* Seat 2A \(front row\) held\.$/);
    expect((await call("flight_status_tool", { flight_number: "ZZ1" }))!.message).toBe("Flight ZZ1 is on time and scheduled to depart at gate A10.");
  });

  it("disruption flow: matching flights, rebook onto NY950 (replaces NY802), one compensation case", async () => {
    await call("flight_status_tool", { flight_number: "PA441" });
    expect((await call("get_matching_flights", { destination: "Austin" }))!.message).toMatch(/^Matching flights:\nNY950 .*\nNY982 .*\nThese options arrive in Austin the next day/);
    const b = (await call("book_new_flight", { flight_number: "NY950" }))!;
    expect(b.message).toBe("Rebooked to NY950 from New York (JFK) to Austin (AUS). Departure 2024-12-10 09:45, arrival 2024-12-10 12:30 (next day arrival in Austin). Seat assigned: 2A (front row). Confirmation IR-D204.");
    expect(await segs("IR-D204")).toBe("PA441:confirmed,NY802:replaced,NY950:confirmed");
    expect((await one("SELECT seat_number FROM bookings WHERE confirmation_number = 'IR-D204'")).seat_number).toBe("2A");
    const c = (await call("issue_compensation", { reason: "Missed connection" }))!;
    expect(c.compensation_case_id).toBe("CMP-1001");
    expect(c.message).toMatch(/^Opened compensation case CMP-1001 for: Missed connection\. Issued: Overnight hotel .*; \$60 meal credit .*; \$40 ground/);
    expect((await call("issue_compensation"))!.compensation_case_id).toBe("CMP-1001");
    expect((await one("SELECT count(*)::int AS n FROM compensation_cases")).n).toBe(1);
  });

  it("cancel_flight acts on the context: default context is the disrupted booking (the demo's behaviour)", async () => {
    expect((await call("cancel_flight"))!.message).toBe("Flight PA441 successfully cancelled for confirmation IR-D204");
    expect(await segs("IR-D204")).toBe("PA441:cancelled,NY802:confirmed");
    expect(await call("cancel_flight")).toBeNull();
  });

  it("cancel_flight after get_trip_details for the on-time trip cancels LL0EZ6 and the booking", async () => {
    await call("get_trip_details", { message: "I need to cancel my flight from San Francisco, confirmation LL0EZ6" });
    expect((await call("cancel_flight"))!.message).toBe("Flight FLT-123 successfully cancelled for confirmation LL0EZ6");
    expect((await one("SELECT status FROM bookings WHERE confirmation_number = 'LL0EZ6'")).status).toBe("cancelled");
    expect(await segs("IR-D204")).toBe("PA441:confirmed,NY802:confirmed");
  });

  it("assign_special_service_seat assigns 1A for front-row requests and records the note", async () => {
    const r = (await call("assign_special_service_seat", {}))!;
    expect(r.message).toBe("Secured front row for medical needs seat 1A on flight PA441. Confirmation IR-D204 noted with special service flag.");
    expect((await one("SELECT special_service_note FROM bookings WHERE confirmation_number = 'IR-D204'")).special_service_note).toBe("front row for medical needs");
  });
});
