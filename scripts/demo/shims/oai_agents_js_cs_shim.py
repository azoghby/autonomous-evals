"""Shim for the OpenAI Agents SDK for JavaScript `examples/customer-service` airline agent (openai/openai-agents-js, MIT).
Upstream: examples/customer-service/index.ts @ 252236c32d30010ef974db77395e19dfb03bbeff.

The example is a CLI program (readline loop: "Enter your message: " -> run(currentAgent, inputItems, { context }) ->
prints `result.output: <json>`), and it exports nothing. So the shim runs the UNMODIFIED file as its own process, one
process per conversation (`node index.ts`, Node's built-in type stripping), writes each user message to its stdin and
reads `result.output` from its stdout. Its agents, handoffs, tools, context and loop are all the example's own.

Swapped: the model, through the SDK's documented environment variables only: OPENAI_BASE_URL = AI Gateway,
OPENAI_API_KEY = our gateway key, OPENAI_DEFAULT_MODEL = the row's gateway model id. OPENAI_AGENTS_DISABLE_TRACING=1
so no trace export leaves the machine. The child process gets no other env vars from us.

Start: OAI_JS_DIR=<dir with index.ts copied verbatim + node_modules (@openai/agents, zod)> \
       python oai_agents_js_cs_shim.py --port 8772 --env-file .env
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oss_bb_common import GATEWAY, PROVIDER_REFUSAL, Adapter, Turn, gateway_key, load_env, serve  # noqa: E402

ARGS = load_env()
APP_DIR = Path(os.environ["OAI_JS_DIR"])
NODE = shutil.which("node") or "node"
PROMPT = b"Enter your message: "
OUTPUT_PREFIX = "result.output: "


class Proc:
    def __init__(self, model: str) -> None:
        self.model = model
        self.p: asyncio.subprocess.Process | None = None
        self.buf = b""

    async def ensure(self) -> None:
        if self.p and self.p.returncode is None:
            return
        env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""),
               "OPENAI_BASE_URL": GATEWAY, "OPENAI_API_KEY": gateway_key(), "OPENAI_DEFAULT_MODEL": self.model,
               "OPENAI_AGENTS_DISABLE_TRACING": "1", "NODE_NO_WARNINGS": "1"}
        self.p = await asyncio.create_subprocess_exec(NODE, "index.ts", cwd=str(APP_DIR), env=env, stdin=asyncio.subprocess.PIPE,
                                                      stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        await self._until_prompt()

    async def _until_prompt(self) -> bytes:
        assert self.p and self.p.stdout
        while PROMPT not in self.buf:
            chunk = await self.p.stdout.read(65536)
            if not chunk:
                out, self.buf = self.buf, b""
                raise RuntimeError("agent process exited: " + out.decode(errors="replace").split("    at ")[0][-1500:])
            self.buf += chunk
        out, _, self.buf = self.buf.partition(PROMPT)
        return out

    async def send(self, text: str) -> str:
        await self.ensure()
        assert self.p and self.p.stdin
        self.p.stdin.write(text.replace("\r", " ").replace("\n", " ").encode() + b"\n")
        await self.p.stdin.drain()
        return (await self._until_prompt()).decode(errors="replace")


MAX_LIVE = 8  # one node process per conversation; idle ones beyond this are stopped (a later turn would restart it)
LIVE: list[Proc] = []


async def new_state(model: str) -> Proc:
    while len(LIVE) >= MAX_LIVE:
        old = LIVE.pop(0)
        if old.p and old.p.returncode is None:
            old.p.kill()
    s = Proc(model)
    LIVE.append(s)
    return s


def parse(out: str) -> tuple[str, list[str]]:
    """Pull `result.output: <JSON>` (JSON.stringify(..., null, 2), may span lines) and the tool/handoff log lines."""
    if OUTPUT_PREFIX not in out:
        raise RuntimeError("no result.output in agent output: " + out[-600:])
    rest = out.split(OUTPUT_PREFIX, 1)[1]
    dec, _ = json.JSONDecoder().raw_decode(rest)
    tools = [ln.strip() for ln in out.splitlines() if "Calling a tool" in ln or ln.startswith("Handed off")]
    if isinstance(dec, str) or dec is None:
        return dec or "", tools
    # result.output is the run's output items; the customer sees the last assistant message's output_text.
    msgs = [i for i in dec if isinstance(i, dict) and i.get("type") == "message" and i.get("role") == "assistant"]
    text = "".join(c.get("text", "") for c in (msgs[-1].get("content") or []) if isinstance(c, dict) and c.get("type") == "output_text") if msgs else ""
    return text, tools


async def turn(s: Proc, model: str, text: str) -> Turn:
    try:
        out = await s.send(text)
    except Exception as e:
        if s.p and s.p.returncode is None:
            s.p.kill()
        # The gateway's Responses API reports a provider safety block as status "incomplete" with
        # incomplete_details.reason "content_filter" (probed for Gemini and Claude on the ransomware probe); the SDK
        # surfaces only 'unsuccessful terminal state "response.incomplete"'. The example sets no max_output_tokens,
        # so the other incomplete reason does not arise here. Same refusal mapping as every other shim.
        if 'terminal state "response.incomplete"' in str(e):
            return Turn(reply=PROVIDER_REFUSAL, refused_by_provider=True)
        raise
    reply, tools = parse(out)
    return Turn(reply=reply, tools=tools)


if __name__ == "__main__":
    serve(Adapter("openai-agents-js-customer-service", new_state, turn, {"commit": "252236c"}), ARGS)
