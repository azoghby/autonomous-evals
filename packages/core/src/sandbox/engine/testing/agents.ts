/** Hand-scripted agents for engine tests. */
import type { SandboxRun } from "../../spec";
import type { AgentFactory, AgentStartInput, TranscriptEntry } from "../types";

export type Script = (run: SandboxRun, turn: number, input: AgentStartInput) => Promise<string>;

export function scriptedAgent(name: string, script: Script): AgentFactory {
  return {
    name,
    start(input) {
      let turn = 0;
      return {
        async send() {
          const before = input.run.trajectory().length;
          const reply = await script(input.run, turn++, input);
          const tools: TranscriptEntry[] = input.run.trajectory().slice(before).map((c) => ({ role: "tool", content: `${c.tool}(${JSON.stringify(c.args)}) -> ${JSON.stringify(c.error ?? c.result)}` }));
          return { reply, transcript: [...tools, { role: "assistant", content: reply }], costMicroUsd: 0 };
        },
      };
    },
  };
}

/** Correct solution for fixtures.refundScenario (acts once, then just chats). */
export const solveRefund: Script = async (run, turn) => {
  if (turn > 0) return "Anything else I can help with?";
  await run.callTool("verify_identity", { customer_id: "c_1", email: "ann@example.com" });
  await run.callTool("lookup_order", { order_id: "o_100" });
  await run.callTool("refund_order", { order_id: "o_100", amount: 47.2 });
  return "Done: your refund of $47.20 for order o_100 has been issued.";
};
export const refundOracle = scriptedAgent("test:oracle", solveRefund);
