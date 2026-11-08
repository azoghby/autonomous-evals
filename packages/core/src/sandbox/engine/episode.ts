/** One conversation: simulated user ⇄ agent, inside one SandboxRun. */
import type { EnvironmentSpec, SandboxRun, SandboxScenario } from "../spec";
import type { AgentFactory, ConversationMessage, Episode, SimulatorFactory, StopReason, TranscriptEntry, Variant } from "./types";
import { clip } from "./util";

export interface EpisodeInput {
  env: EnvironmentSpec;
  scenario: SandboxScenario;
  run: SandboxRun;
  agent: AgentFactory;
  simulator: SimulatorFactory;
  variant?: Variant;
  trial?: number;
  /** Overrides persona.maxTurns (user messages). */
  maxTurns?: number;
}

const errText = (e: unknown) => clip(e instanceof Error ? e.message : String(e), 300);

export async function runEpisode(input: EpisodeInput): Promise<Episode> {
  const { env, scenario, run } = input;
  const maxTurns = input.maxTurns ?? scenario.persona.maxTurns;
  const sim = input.simulator.start({ env, scenario, variant: input.variant ?? "base", trial: input.trial ?? 0 });
  const agent = input.agent.start({ env, scenario, run });
  const transcript: TranscriptEntry[] = [];
  const conversation: ConversationMessage[] = [];
  let cost = 0;
  let stopReason: StopReason = "max_turns";
  let error: string | undefined;

  for (let turn = 0; turn < maxTurns; turn++) {
    let simTurn;
    try {
      simTurn = await sim.next([...conversation]);
    } catch (e) {
      // Simulator failure: environment-side, never the agent's fault.
      return { transcript, conversation, stopReason: "abandoned", costMicroUsd: cost, error: `simulator_error: ${errText(e)}` };
    }
    cost += simTurn.costMicroUsd;
    if (turn > 0 && simTurn.status !== "continue") {
      if (simTurn.message.trim()) {
        transcript.push({ role: "user", content: simTurn.message });
        conversation.push({ role: "user", content: simTurn.message });
      }
      stopReason = simTurn.status;
      break;
    }
    transcript.push({ role: "user", content: simTurn.message });
    conversation.push({ role: "user", content: simTurn.message });
    let reply;
    try {
      reply = await agent.send(simTurn.message);
    } catch (e) {
      error = `agent_error: ${errText(e)}`;
      stopReason = "agent_error";
      break;
    }
    cost += reply.costMicroUsd;
    transcript.push(...reply.transcript);
    conversation.push({ role: "assistant", content: reply.reply });
    if (reply.error) {
      error = reply.error;
      stopReason = "agent_error";
      break;
    }
  }
  return { transcript, conversation, stopReason, costMicroUsd: cost, ...(error ? { error } : {}) };
}
