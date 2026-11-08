"""Shim for Semantic Kernel's customer-support handoff sample (microsoft/semantic-kernel, MIT).
Upstream: python/samples/getting_started_with_agents/multi_agent_orchestration/step4_handoff.py
          @ df1cb33d0d32699c8d6a2e5b3ea7e5f8990d86d5.

What runs is the REAL sample module: `get_agents()` (TriageAgent, RefundAgent, OrderStatusAgent, OrderReturnAgent with
their instructions and kernel_function plugins) and its OrchestrationHandoffs, in a HandoffOrchestration on an
InProcessRuntime, as in its main(). The sample's human-in-the-loop `human_response_function` (input()) is the
customer's side of the chat, so the shim supplies an async equivalent that waits for the next user message; the
reply for a turn is what the agents said (agent_response_callback) before they asked the human again (or completed).

Swapped: the chat service. While get_agents() runs, the module's AzureChatCompletion(credential=AzureCliCredential())
resolves to OpenAIChatCompletion(ai_model_id=<gateway id>, async_client=AsyncOpenAI(base_url=AI Gateway)).

Start: SK_DIR=<semantic-kernel checkout> python sk_handoff_shim.py --port 8771 --env-file .env
"""
from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oss_bb_common import GATEWAY, Adapter, Turn, gateway_key, load_env, serve  # noqa: E402

ARGS = load_env()
ROOT = Path(os.environ["SK_DIR"])

from openai import AsyncOpenAI  # noqa: E402
from semantic_kernel.agents import HandoffOrchestration  # noqa: E402
from semantic_kernel.agents.runtime import InProcessRuntime  # noqa: E402
from semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion  # noqa: E402
from semantic_kernel.contents import AuthorRole, ChatMessageContent, FunctionCallContent  # noqa: E402

_spec = importlib.util.spec_from_file_location("sk_step4_handoff", ROOT / "python/samples/getting_started_with_agents/multi_agent_orchestration/step4_handoff.py")
sample = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sample)  # the real sample module (main() does not run)
CLIENT = AsyncOpenAI(base_url=GATEWAY, api_key=gateway_key(), timeout=100, max_retries=2)
_build_lock = asyncio.Lock()


def build_agents(model: str):
    real_svc, real_cred = sample.AzureChatCompletion, sample.AzureCliCredential
    sample.AzureChatCompletion = lambda **_: OpenAIChatCompletion(ai_model_id=model, async_client=CLIENT)
    sample.AzureCliCredential = lambda: None
    try:
        return sample.get_agents()
    finally:
        sample.AzureChatCompletion, sample.AzureCliCredential = real_svc, real_cred


class State:
    def __init__(self, model: str) -> None:
        self.model = model
        self.inbox: asyncio.Queue[str] = asyncio.Queue()
        self.events: asyncio.Queue[str] = asyncio.Queue()
        self.texts: list[str] = []
        self.tools: list[str] = []
        self.task: asyncio.Task | None = None
        self.runtime: InProcessRuntime | None = None

    def on_response(self, message) -> None:
        for m in message if isinstance(message, list) else [message]:
            for item in m.items:
                if isinstance(item, FunctionCallContent):
                    self.tools.append(item.name or "tool")
            if m.content and str(m.content).strip():
                self.texts.append(str(m.content))

    async def human(self) -> ChatMessageContent:
        await self.events.put("await_user")
        return ChatMessageContent(role=AuthorRole.USER, content=await self.inbox.get())

    async def start(self, text: str) -> None:
        async with _build_lock:
            agents, handoffs = build_agents(self.model)
        orch = HandoffOrchestration(members=agents, handoffs=handoffs, agent_response_callback=self.on_response, human_response_function=self.human)
        self.runtime = InProcessRuntime()
        self.runtime.start()

        async def drive() -> None:
            try:
                result = await orch.invoke(task=text, runtime=self.runtime)
                await result.get()
                await self.events.put("done")
            except Exception as e:  # noqa: BLE001
                await self.events.put(f"error:{type(e).__name__}: {e}")
            finally:
                try:
                    await self.runtime.stop_when_idle()
                except Exception:  # noqa: BLE001
                    pass

        self.task = asyncio.create_task(drive())


async def new_state(model: str) -> State:
    return State(model)


async def turn(s: State, model: str, text: str) -> Turn:
    s.texts, s.tools = [], []
    if s.task is None or s.task.done():
        await s.start(text)
    else:
        await s.inbox.put(text)
    ev = await s.events.get()
    if ev.startswith("error:"):
        raise RuntimeError(ev[6:])
    return Turn(reply="\n\n".join(s.texts), tools=list(s.tools))


if __name__ == "__main__":
    serve(Adapter("sk-handoff-customer-support", new_state, turn, {"commit": "df1cb33"}), ARGS)
