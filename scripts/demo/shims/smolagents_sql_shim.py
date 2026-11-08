"""Shim for the smolagents `text_to_sql` example agent (huggingface/smolagents, Apache-2.0).
Upstream: examples/text_to_sql.py @ 96f33faaf028479119ec8d34507b47694cf14e34.

What runs is the REAL example module: its in-memory SQLite `receipts` table and rows, its `sql_engine` @tool (name,
docstring and body), and a CodeAgent built exactly as the example builds it: CodeAgent(tools=[sql_engine], model=...).
smolagents' CodeAgent writes and executes Python in its LocalPythonExecutor (default authorized imports only).

Swapped: the model. The example uses InferenceClientModel (Hugging Face hosted inference); while the module is
imported, InferenceClientModel resolves to OpenAIServerModel on the Vercel AI Gateway and the module's own
top-level `agent.run(...)` demo call is skipped, so nothing reaches Hugging Face. Per conversation the shim builds the
same CodeAgent with the row's gateway model and keeps its memory across turns (run(..., reset=False)).

Start: SMOLAGENTS_DIR=<smolagents checkout> python smolagents_sql_shim.py --port 8770 --env-file .env
"""
from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oss_bb_common import Adapter, Turn, gateway_key, gateway_model_id, gateway_url, neon_http_clients, load_env, serve  # noqa: E402

ARGS = load_env()
ROOT = Path(os.environ["SMOLAGENTS_DIR"])

import smolagents  # noqa: E402
import sqlalchemy  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402
from smolagents import CodeAgent, OpenAIServerModel  # noqa: E402


def _client_kwargs() -> dict:
    sync, _ = neon_http_clients()
    return {"http_client": sync} if sync else {}


def gateway_model(model: str) -> OpenAIServerModel:
    return OpenAIServerModel(model_id=gateway_model_id(model), api_base=gateway_url(), api_key=gateway_key(), client_kwargs=_client_kwargs())


# Harness fix (not an agent change): the example's engine is an in-memory SQLite URL, which SQLAlchemy keeps per THREAD
# (SingletonThreadPool). The example is a single-threaded script, but smolagents' executor and our server call the
# tool from other threads, which then see an EMPTY database ("no such table: receipts") or hit sqlite's same-thread
# check. While the module is imported, create_engine for that URL gets StaticPool + check_same_thread=False: one
# shared in-memory database, i.e. what the example's single thread sees (SQLite serializes access to the shared connection).
EXEC = ThreadPoolExecutor(max_workers=4, thread_name_prefix="smol")
MEMORY_URL = "sqlite:///" + ":memory:"


def _load():
    real_infer, real_run, real_engine = smolagents.InferenceClientModel, CodeAgent.run, sqlalchemy.create_engine

    def shared_memory_engine(url, *a, **k):
        if str(url) == MEMORY_URL:
            k = {**k, "poolclass": StaticPool, "connect_args": {"check_same_thread": False}}
        return real_engine(url, *a, **k)

    smolagents.InferenceClientModel = lambda model_id=None, **_: gateway_model("anthropic/claude-sonnet-5.5")
    CodeAgent.run = lambda self, *a, **k: None  # skip the module's import-time demo query
    sqlalchemy.create_engine = shared_memory_engine
    try:
        spec = importlib.util.spec_from_file_location("smol_text_to_sql", ROOT / "examples/text_to_sql.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # the real example module
        return mod
    finally:
        smolagents.InferenceClientModel, CodeAgent.run, sqlalchemy.create_engine = real_infer, real_run, real_engine


sql = EXEC.submit(_load).result()


async def new_state(model: str) -> CodeAgent:
    return CodeAgent(tools=[sql.sql_engine], model=gateway_model(model))  # as in the example


def _run(agent: CodeAgent, text: str) -> Turn:
    first = len(agent.memory.steps) == 0
    out = agent.run(text, reset=first)
    tools: list[str] = []
    for st in agent.memory.steps:
        for tc in getattr(st, "tool_calls", None) or []:
            tools.append(getattr(tc, "name", "tool"))
    tu = agent.monitor.get_total_token_counts() if hasattr(agent, "monitor") else None
    pt = getattr(tu, "input_tokens", 0) or 0
    ct = getattr(tu, "output_tokens", 0) or 0
    return Turn(reply="" if out is None else str(out), prompt_tokens=pt, completion_tokens=ct, tools=tools[-20:])


async def turn(agent: CodeAgent, model: str, text: str) -> Turn:
    return await asyncio.get_running_loop().run_in_executor(EXEC, _run, agent, text)


if __name__ == "__main__":
    serve(Adapter("smolagents-text-to-sql", new_state, turn, {"commit": "96f33fa"}), ARGS)
