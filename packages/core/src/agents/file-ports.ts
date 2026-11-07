/**
 * JSON-file-backed ports for operator scripts (live diagnostics) that must survive a rerun.
 * SINGLE PROCESS ONLY: no cross-process locking. Production uses Track A's Neon implementations.
 * Never stores secrets: records hold redacted prompts, IDs, states and usage.
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentTaskPatch, AgentTaskRecord, BudgetReservationRequest, MicroUsd } from "../evals/types";
import { InMemoryAgentTaskStore, InMemoryBudgetLedger } from "./memory-ports";

interface FileState {
  tasks: Record<string, AgentTaskRecord>;
  caps: Record<string, MicroUsd>;
  reservations: Record<string, unknown>;
}

export class FileBackedPorts {
  readonly store: InMemoryAgentTaskStore;
  readonly ledger: InMemoryBudgetLedger;

  constructor(private readonly file: string) {
    this.store = new InMemoryAgentTaskStore();
    this.ledger = new InMemoryBudgetLedger();
    if (fs.existsSync(file)) {
      const state = JSON.parse(fs.readFileSync(file, "utf8")) as FileState;
      for (const [k, v] of Object.entries(state.tasks)) this.store.rows.set(k, v);
      for (const [k, v] of Object.entries(state.caps)) this.ledger.caps.set(k, v);
      for (const [k, v] of Object.entries(state.reservations)) this.ledger.reservations.set(k, v as never);
    }
    const store = this.store;
    const ledger = this.ledger;
    const save = () => this.save();
    const insert = store.insertIfAbsent.bind(store);
    const cas = store.compareAndSet.bind(store);
    const reserve = ledger.reserve.bind(ledger);
    const settle = ledger.settle.bind(ledger);
    store.insertIfAbsent = async (r: AgentTaskRecord) => {
      const out = await insert(r);
      save();
      return out;
    };
    store.compareAndSet = async (k: string, rev: number, p: AgentTaskPatch) => {
      const out = await cas(k, rev, p);
      save();
      return out;
    };
    ledger.reserve = async (r: BudgetReservationRequest) => {
      const out = await reserve(r);
      save();
      return out;
    };
    ledger.settle = async (id: string, c: MicroUsd) => {
      const out = await settle(id, c);
      save();
      return out;
    };
  }

  private save() {
    const state: FileState = {
      tasks: Object.fromEntries(this.store.rows),
      caps: Object.fromEntries(this.ledger.caps),
      reservations: Object.fromEntries(this.ledger.reservations),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
