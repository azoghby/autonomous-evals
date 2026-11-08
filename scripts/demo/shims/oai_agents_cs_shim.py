"""Shim for the OpenAI Agents SDK `examples/customer_service` airline agent (openai/openai-agents-python, MIT).
Upstream: openai/openai-agents-python examples/customer_service/main.py @ 27c75c5f9c5fd957d28c04fb7e9eeacaad4630a9.

What runs is the REAL example module: its triage / FAQ / seat-booking agents, handoffs, on_handoff hook, tools and
AirlineAgentContext, driven exactly like its own main() loop (Runner.run(current_agent, input_items, context) and
current_agent = result.last_agent, input_items = result.to_input_list()).

Swapped: the model. RunConfig(model=OpenAIChatCompletionsModel(<gateway id>, AsyncOpenAI(base_url=AI Gateway))) so
every agent in the graph runs on the leaderboard row's model. Tracing is disabled (no calls to OpenAI's trace API).
`examples.auto_mode` (only used by main()'s console loop) is stubbed.

Start: OAI_AGENTS_DIR=<openai-agents-python checkout> python oai_agents_cs_shim.py --port 8767 --env-file .env
"""
from __future__ import annotations

import importlib.util
import os
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oss_bb_common import GATEWAY, Adapter, Turn, gateway_key, load_env, serve  # noqa: E402

ARGS = load_env()
ROOT = Path(os.environ["OAI_AGENTS_DIR"])

from agents import RunConfig, Runner, ToolCallItem, HandoffOutputItem, set_tracing_disabled  # noqa: E402
from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel  # noqa: E402
from openai import AsyncOpenAI  # noqa: E402

set_tracing_disabled(True)
_stub = types.ModuleType("examples.auto_mode")
_stub.input_with_fallback = lambda prompt, fallback: fallback
_stub.is_auto_mode = lambda: True
sys.modules.setdefault("examples", types.ModuleType("examples"))
sys.modules["examples.auto_mode"] = _stub
_spec = importlib.util.spec_from_file_location("oai_customer_service", ROOT / "examples/customer_service/main.py")
cs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cs)  # the real example module

client = AsyncOpenAI(base_url=GATEWAY, api_key=gateway_key(), timeout=100, max_retries=2)


class State:
    def __init__(self) -> None:
        self.agent = cs.triage_agent
        self.items: list = []
        self.ctx = cs.AirlineAgentContext()


async def new_state(model: str) -> State:
    return State()


async def turn(s: State, model: str, text: str) -> Turn:
    cfg = RunConfig(model=OpenAIChatCompletionsModel(model=model, openai_client=client), tracing_disabled=True)
    s.items.append({"content": text, "role": "user"})
    result = await Runner.run(s.agent, s.items, context=s.ctx, run_config=cfg)
    tools = [getattr(i.raw_item, "name", "tool") for i in result.new_items if isinstance(i, ToolCallItem)]
    tools += [f"handoff:{i.target_agent.name}" for i in result.new_items if isinstance(i, HandoffOutputItem)]
    s.items, s.agent = result.to_input_list(), result.last_agent
    u = result.context_wrapper.usage
    return Turn(reply=str(result.final_output or ""), prompt_tokens=u.input_tokens, completion_tokens=u.output_tokens, tools=tools)


if __name__ == "__main__":
    serve(Adapter("openai-agents-customer-service", new_state, turn, {"commit": "27c75c5"}), ARGS)
