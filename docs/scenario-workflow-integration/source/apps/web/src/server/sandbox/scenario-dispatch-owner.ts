import "server-only";
import type { ScenarioDispatchOwner } from "./pipeline";
import type { SandboxStore } from "./store";

/** Owner activation seam, deliberately unavailable until real adapters are reviewed and supplied.
 * Construct PostgresTextCheckpointStore with a trusted transactional SQL adapter; authorize fresh
 * owner/plan/run/environment/suite/world/inventory identity; return current/retired known secrets;
 * validate the entire ScenarioExecutionRecord and every trial's scenario/version binding without
 * dropping any evidence. Never use request JSON, an always-true authorization callback, or in-memory
 * checkpoints here. This factory must not perform provider I/O or return a legacy unfenced executor.
 * Replace this function as part of owner adoption; environment variables alone do not activate it.
 */
export function loadScenarioDispatchOwner(_store: SandboxStore): ScenarioDispatchOwner | undefined {
  return undefined;
}
