"""Shim for the LangGraph "Build a Customer Support Bot" tutorial agent, Part 1 (langchain-ai/langgraph, MIT).
Upstream: docs/docs/tutorials/customer-support/customer-support.ipynb @ 23961cff61a42b52525f3b20b4094d8d2fba1744
(the tutorial was later moved out of the repo; this is the last in-repo revision).

What runs is the tutorial's REAL code: the notebook's own code cells are executed in order (DB setup with its
update_dates, the policy retriever, every flight / car / hotel / excursion tool, the tool-error fallback, the State,
the Assistant class with its re-prompt loop, the Swiss Airlines primary_assistant_prompt, and the Part 1 graph
compiled with its InMemorySaver checkpointer). Each conversation is a LangGraph thread with the tutorial's own example
passenger ("3442 587242"); turns are `part_1_graph.invoke({"messages": ("user", text)}, config)`.

Swapped, nothing else:
  1. MODEL: the cell's `ChatAnthropic(model="claude-3-sonnet-20240229", temperature=1)` resolves to
     ChatOpenAI(model=<gateway id>, temperature=1, base_url=AI Gateway). Cells 19-23 (State, Assistant, prompt, graph)
     run once per model so each leaderboard row's graph is bound to its own model.
  2. WEB SEARCH: `TavilySearchResults(max_results=1)` is a third-party product API that we do not call. A tool with
     the same name and description is bound in its place and returns "Web search is unavailable."
  3. Embeddings for lookup_policy (`openai.Client()`) and the tutorial's data downloads (travel2.sqlite and
     swiss_faq.md from the tutorial's public storage bucket) run as written; OpenAI calls go to the gateway via
     OPENAI_BASE_URL / OPENAI_API_KEY (our key).
Tools write to the tutorial's SQLite DB, which is reset (update_dates) when the shim starts; all conversations share it,
as all of the tutorial's turns do.

Start: LG_TUTORIAL=<path to customer-support.ipynb> LG_WORKDIR=<scratch dir> python langgraph_cs_shim.py --port 8774 --env-file .env
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
import types
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oss_bb_common import GATEWAY, PROVIDER_REFUSAL, TURN_TIMEOUT_S, Adapter, Turn, gateway_key, gateway_model_id, gateway_url, neon_http_clients, load_env, serve  # noqa: E402

ARGS = load_env()
NOTEBOOK = Path(os.environ["LG_TUTORIAL"])
WORKDIR = Path(os.environ["LG_WORKDIR"])
# The tutorial's policy retriever embeds with OpenAIEmbeddings (env OPENAI_*). Neon's gateway has no embeddings model, so
# under SHIM_GATEWAY=neon only the chat model moves to Neon; embeddings (a few cents) stay on the Vercel gateway.
os.environ["OPENAI_API_KEY"] = os.environ["AI_GATEWAY_API_KEY"]
os.environ["OPENAI_BASE_URL"] = GATEWAY

from langchain_core.tools import tool  # noqa: E402
from langchain_openai import ChatOpenAI  # noqa: E402

SETUP_CELLS = [5, 7, 9, 11, 13, 15, 17]  # DB, policy retriever, tools, utilities
GRAPH_CELLS = [19, 21, 23]  # Part 1 State, Assistant + prompt + tools, graph
PASSENGER_ID = "3442 587242"  # the tutorial's example passenger


@tool
def tavily_search_results_json(query: str) -> str:
    """A search engine optimized for comprehensive, accurate, and trusted results. Useful for when you need to answer questions about current events. Input should be a search query."""
    return "Web search is unavailable."


def _install_tavily_stand_in() -> None:
    for name in ("langchain_community", "langchain_community.tools"):
        sys.modules.setdefault(name, types.ModuleType(name))
    mod = types.ModuleType("langchain_community.tools.tavily_search")
    mod.TavilySearchResults = lambda **_: tavily_search_results_json
    sys.modules["langchain_community.tools.tavily_search"] = mod


class ProviderRefusal(Exception):
    """The model provider's safety system stopped the reply (finish_reason content_filter / refusal)."""


REFUSAL_FINISH = {"content_filter", "refusal"}


class TurnAbandoned(Exception):
    """The harness has already given up on this turn (shim turn timeout); stop calling the model."""


# Per-thread turn deadline. asyncio.wait_for cannot stop the worker thread running graph.invoke, so without this a
# timed-out turn (e.g. the re-prompt loop above) would keep calling the model, and spending, after the harness left.
_TURN = threading.local()
TURN_BUDGET_S = TURN_TIMEOUT_S


class GatewayChat(ChatOpenAI):
    """ChatOpenAI that surfaces a provider safety stop instead of an empty reply. Without this, the tutorial's
    Assistant re-prompts "Respond with a real output." forever on an empty message, so a provider refusal would hang
    the turn until the harness times out (a harness-caused failure, not the agent's answer)."""

    def _generate(self, *args, **kwargs):  # type: ignore[override]
        if time.monotonic() > getattr(_TURN, "deadline", float("inf")):
            raise TurnAbandoned()
        return super()._generate(*args, **kwargs)

    def _create_chat_result(self, response, generation_info=None):  # type: ignore[override]
        result = super()._create_chat_result(response, generation_info)
        for g in result.generations:
            if (g.generation_info or {}).get("finish_reason") in REFUSAL_FINISH and not getattr(g.message, "tool_calls", None):
                raise ProviderRefusal(g.generation_info.get("finish_reason"))
        return result


def _install_model(model: str) -> None:
    mod = types.ModuleType("langchain_anthropic")
    mod.ChatAnthropic = lambda model=None, temperature=None, **_: GatewayChat(  # noqa: ARG005
        model=gateway_model_id(CURRENT_MODEL), temperature=temperature, base_url=gateway_url(), api_key=gateway_key(), timeout=100, max_retries=2,
        http_client=neon_http_clients()[0], http_async_client=neon_http_clients()[1])
    sys.modules["langchain_anthropic"] = mod
    globals()["CURRENT_MODEL"] = model


CURRENT_MODEL = ""
CELLS = [c for c in json.loads(NOTEBOOK.read_text())["cells"]]


def _code(i: int) -> str:
    c = CELLS[i]
    assert c["cell_type"] == "code", i
    return "".join(c["source"])


_install_tavily_stand_in()
WORKDIR.mkdir(parents=True, exist_ok=True)
os.chdir(WORKDIR)  # the tutorial writes travel2.sqlite (+ backup) to the current directory
# Cells run in real module namespaces registered in sys.modules (as a notebook kernel's __main__ is), so LangGraph can
# resolve the State TypedDict's annotations (typing.get_type_hints looks the module up by name).
_BASE_MOD = types.ModuleType("langgraph_tutorial")
sys.modules[_BASE_MOD.__name__] = _BASE_MOD
BASE = _BASE_MOD.__dict__
for i in SETUP_CELLS:
    exec(compile(_code(i), f"{NOTEBOOK.name}:cell{i}", "exec"), BASE)  # noqa: S102 (the tutorial's own code)
GRAPHS: dict[str, object] = {}
_GRAPH_LOCK = threading.Lock()


def graph_for(model: str):
    with _GRAPH_LOCK:
        return _graph_for(model)


def _graph_for(model: str):
    if model not in GRAPHS:
        mod = types.ModuleType(f"langgraph_tutorial_{len(GRAPHS)}")
        mod.__dict__.update({k: v for k, v in BASE.items() if k not in ("__name__", "__spec__", "__loader__")})
        sys.modules[mod.__name__] = mod
        ns = mod.__dict__
        _install_model(model)
        for i in GRAPH_CELLS:
            exec(compile(_code(i), f"{NOTEBOOK.name}:cell{i}", "exec"), ns)  # noqa: S102
        GRAPHS[model] = ns["part_1_graph"]
    return GRAPHS[model]


async def new_state(model: str) -> dict:
    return {"configurable": {"passenger_id": PASSENGER_ID, "thread_id": str(uuid.uuid4())}}


def _invoke(config: dict, model: str, text: str) -> Turn:
    graph = graph_for(model)
    before = len(graph.get_state(config).values.get("messages", []) or [])
    _TURN.deadline = time.monotonic() + TURN_BUDGET_S
    try:
        out = graph.invoke({"messages": ("user", text)}, config)
    except TurnAbandoned:
        raise TimeoutError("turn abandoned after the shim turn timeout") from None
    except ProviderRefusal:
        return Turn(reply=PROVIDER_REFUSAL, prompt_tokens=0, completion_tokens=0, tools=[], refused_by_provider=True)
    new = out["messages"][before:]
    tools = [tc["name"] for m in new for tc in (getattr(m, "tool_calls", None) or [])]
    last = out["messages"][-1]
    content = last.content
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    pt = sum((getattr(m, "usage_metadata", None) or {}).get("input_tokens", 0) for m in new)
    ct = sum((getattr(m, "usage_metadata", None) or {}).get("output_tokens", 0) for m in new)
    return Turn(reply=str(content or ""), prompt_tokens=pt, completion_tokens=ct, tools=tools)


async def turn(config: dict, model: str, text: str) -> Turn:
    return await asyncio.to_thread(_invoke, config, model, text)


if __name__ == "__main__":
    serve(Adapter("langgraph-customer-support-part1", new_state, turn, {"commit": "23961cf"}), ARGS)
