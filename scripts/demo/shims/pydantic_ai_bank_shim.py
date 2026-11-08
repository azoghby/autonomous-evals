"""Shim for the Pydantic AI `bank_support` example (pydantic/pydantic-ai, MIT).
Upstream: examples/pydantic_ai_examples/bank_support.py @ 0f7648a1b0685389ea368ea4f7b754b393cea8c7.

What runs is the REAL example module: `support_agent` with its instructions, the dynamic customer-name instruction,
the `customer_balance` tool, structured SupportOutput and its Caching capability. The SQLite fixture is built exactly
as the example's __main__ does (customer 123 'John', balance 123.45), including the module-level `cur` its
DatabaseConn reads. The customer sees `support_advice`, which is what the shim returns; block_card / risk are
reported in x_tools.

Swapped: the model, per request, via `run(model=OpenAIChatModel(<gateway id>, OpenAIProvider(base_url=AI Gateway)))`.
Multi-turn continuity uses the agent's own message_history.

Start: PYDANTIC_AI_DIR=<pydantic-ai checkout> python pydantic_ai_bank_shim.py --port 8768 --env-file .env
"""
from __future__ import annotations

import importlib.util
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oss_bb_common import GATEWAY, Adapter, Turn, gateway_key, load_env, serve  # noqa: E402

ARGS = load_env()
ROOT = Path(os.environ["PYDANTIC_AI_DIR"])
# The module builds Agent("openai:gpt-5.2") at import, which needs an OpenAI provider; point that default at the
# gateway too (it is overridden per request anyway), so nothing can reach api.openai.com.
os.environ["OPENAI_API_KEY"] = gateway_key()
os.environ["OPENAI_BASE_URL"] = GATEWAY

from pydantic_ai.models.openai import OpenAIChatModel  # noqa: E402
from pydantic_ai.providers.openai import OpenAIProvider  # noqa: E402

_spec = importlib.util.spec_from_file_location("bank_support", ROOT / "examples/pydantic_ai_examples/bank_support.py")
bank = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bank)  # the real example module (its __main__ block does not run)

# Fixture, verbatim from the example's __main__.
con = sqlite3.connect(":memory:", check_same_thread=False)
cur = con.cursor()
cur.execute("CREATE TABLE customers(id, name, balance)")
cur.execute("INSERT INTO customers VALUES (123, 'John', 123.45)")
con.commit()
bank.cur = cur  # DatabaseConn's methods read the module-global `cur`, as in the example's __main__
DEPS = bank.SupportDependencies(customer_id=123, db=bank.DatabaseConn(sqlite_conn=con))
PROVIDER = OpenAIProvider(base_url=GATEWAY, api_key=gateway_key())


class State:
    def __init__(self) -> None:
        self.history: list = []


async def new_state(model: str) -> State:
    return State()


async def turn(s: State, model: str, text: str) -> Turn:
    result = await bank.support_agent.run(text, deps=DEPS, model=OpenAIChatModel(model, provider=PROVIDER), message_history=s.history)
    s.history = result.all_messages()
    out = result.output
    u = result.usage
    calls = [p.tool_name for m in result.new_messages() for p in getattr(m, "parts", []) if getattr(p, "part_kind", "") == "tool-call" and p.tool_name != "final_result"]
    return Turn(reply=out.support_advice, prompt_tokens=u.input_tokens or 0, completion_tokens=u.output_tokens or 0,
                tools=calls + [f"block_card={out.block_card}", f"risk={out.risk}"])


if __name__ == "__main__":
    serve(Adapter("pydantic-ai-bank-support", new_state, turn, {"commit": "0f7648a"}), ARGS)
