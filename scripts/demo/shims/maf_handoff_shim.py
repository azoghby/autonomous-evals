"""Shim for Microsoft Agent Framework's customer-support handoff sample (microsoft/agent-framework, MIT).
Upstream: python/samples/03-workflows/orchestrations/handoff_simple.py @ 924a6e50ec0336f3c965ee8b1151c54085888b6e.

What runs is the REAL sample module: its triage / refund / order / return agents from `create_agents(client)`, their
instructions and tools (process_refund, check_order_status, process_return), and the HandoffBuilder workflow built as
in its main() (same participants, start agent and "welcome" termination condition). Turns are driven exactly like
main()'s request/response loop: the first user message starts `workflow.run(message, stream=True)`; later messages
answer the pending HandoffAgentUserRequest with `HandoffAgentUserRequest.create_response(text)`. The reply is the
agents' text from that step.

Swapped: the chat client. `create_agents()` takes the client as a parameter; we pass OpenAIChatCompletionClient on the
Vercel AI Gateway (base_url https://ai-gateway.vercel.sh/v1, our key) instead of FoundryChatClient + az login.

Start: MAF_DIR=<agent-framework checkout> python maf_handoff_shim.py --port 8769 --env-file .env
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oss_bb_common import GATEWAY, Adapter, Turn, gateway_key, load_env, serve  # noqa: E402

ARGS = load_env()
ROOT = Path(os.environ["MAF_DIR"])

from agent_framework import AgentResponse  # noqa: E402
from agent_framework.openai import OpenAIChatCompletionClient  # noqa: E402
from agent_framework.orchestrations import HandoffAgentUserRequest, HandoffBuilder  # noqa: E402

_spec = importlib.util.spec_from_file_location("maf_handoff_simple", ROOT / "python/samples/03-workflows/orchestrations/handoff_simple.py")
sample = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sample)  # the real sample module (main() does not run)


class State:
    def __init__(self, model: str) -> None:
        client = OpenAIChatCompletionClient(model, api_key=gateway_key(), base_url=GATEWAY)
        triage, refund, order, support = sample.create_agents(client)
        # Built exactly as in the sample's main().
        self.workflow = (
            HandoffBuilder(
                name="customer_support_handoff",
                participants=[triage, refund, order, support],
                termination_condition=lambda conversation: (len(conversation) > 0 and "welcome" in conversation[-1].text.lower()),
            )
            .with_start_agent(triage)
            .build()
        )
        self.pending: list = []
        self.started = False
        self.done = False


async def new_state(model: str) -> State:
    return State(model)


def _collect(events: list) -> tuple[list[str], list[str], list]:
    texts: list[str] = []
    tools: list[str] = []
    pending: list = []
    for ev in events:
        if ev.type == "handoff_sent":
            tools.append(f"handoff:{ev.data.target}")
        elif ev.type == "output" and isinstance(ev.data, AgentResponse):
            for m in ev.data.messages:
                for c in getattr(m, "contents", []) or []:
                    if getattr(c, "type", "") == "function_call":
                        tools.append(getattr(c, "name", "tool"))
                if m.text and str(m.role) == "assistant" or (m.text and getattr(m.role, "value", "") == "assistant"):
                    texts.append(m.text)
        elif ev.type == "request_info" and isinstance(ev.data, HandoffAgentUserRequest):
            pending.append(ev)
            if not texts:
                texts += [m.text for m in ev.data.agent_response.messages if m.text]
    return texts, tools, pending


async def turn(s: State, model: str, text: str) -> Turn:
    if s.done:  # the sample's termination condition ended the workflow; a new message starts a new one
        s.__init__(model)
    if not s.started:
        s.started = True
        events = [ev async for ev in s.workflow.run(text, stream=True)]
    else:
        events = await s.workflow.run(responses={r.request_id: HandoffAgentUserRequest.create_response(text) for r in s.pending})
    texts, tools, s.pending = _collect(events)
    s.done = not s.pending
    return Turn(reply="\n\n".join(texts), tools=tools)


if __name__ == "__main__":
    serve(Adapter("maf-handoff-customer-support", new_state, turn, {"commit": "924a6e5"}), ARGS)
