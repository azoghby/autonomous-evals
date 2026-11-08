"""Shared black-box harness for the open-source agent shims (leaderboard kind `local_reference`).

Each per-agent shim imports a REAL open-source agent from a pinned upstream checkout (path in an env var), swaps only
the model client for the Vercel AI Gateway (our key, AI_GATEWAY_API_KEY), and hands this module an `Adapter`:

    async def new_state(model: str) -> Any                       # fresh conversation (agent context, history, deps)
    async def turn(state, model: str, text: str) -> Turn         # one user turn through the agent's own runner

This module serves it as an OpenAI-compatible endpoint on 127.0.0.1:
    POST /v1/chat/completions   model from the body; system messages from the client are ignored (the agent has its own)
    GET  /health, GET /stats

Rules shared by every shim (so leaderboard rows are comparable):
  * Conversation continuity: the state after a reply is cached under hash(model + messages-so-far); a request whose
    prefix matches continues that state, otherwise a fresh state starts (unknown history is passed as a transcript).
  * Provider safety blocks (the MODEL PROVIDER refusing, not the agent) become the reply PROVIDER_REFUSAL, counted in
    /stats as provider_refusals. Graders score that like any other refusal. A production app shows the user a refusal.
  * Any other agent exception -> HTTP 502 (the run aborts; it is never silently scored as an agent answer).
  * No hosted third-party agent or product API is called. Only the gateway, via the key in AI_GATEWAY_API_KEY.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

GATEWAY = "https://ai-gateway.vercel.sh/v1"
PROVIDER_REFUSAL = "Sorry, I can't help with that request."
MAX_CACHED = 300
# Per-turn wall-clock cap. Generous: multi-agent graphs on reasoning models can take a while; the TS transport for local
# agents waits 120s, so stay under it to return a clean 502 instead of a client-side timeout.
TURN_TIMEOUT_S = float(os.environ.get("SHIM_TURN_TIMEOUT_S", "110"))

# USD per token, gateway list prices (GET /v1/models). Estimates only, for /stats.
PRICES = {
    "anthropic/claude-sonnet-5.5": (2e-6, 10e-6),
    "anthropic/claude-opus-5.5": (4e-6, 20e-6),
    "openai/gpt-5.5": (5e-6, 30e-6),
    "google/gemini-3.8-flash": (0.75e-6, 3.75e-6),
}
DEFAULT_PRICE = (2e-6, 10e-6)

_SAFETY_MARKERS = (
    "modelrefusalerror", "refused to produce output", "safeguards flagged", "flagged for possible",
    "content_filter", "content-filter", "content filter", "content management policy", "violate anthropic's terms",
    "usage policies", "finish_reason: safety", "blocked due to safety", "prohibited_content", "invalid_prompt",
)


# Some frameworks turn the provider's refusal into the assistant message text instead of raising. Narrow markers only
# (an agent saying "that violates our usage policies" is the agent's own refusal and is left alone).
_REPLY_SAFETY_MARKERS = ("safeguards flagged this message", "modelrefusalerror", "refused to produce output",
                         "flagged for possible cybersecurity risk")


def is_provider_refusal_text(reply: str) -> bool:
    r = (reply or "").lower()
    return any(m in r for m in _REPLY_SAFETY_MARKERS)


def is_provider_safety_block(err: object) -> bool:
    """True when an exception (or its cause chain) is the model provider refusing the request on safety grounds."""
    seen = 0
    e: Any = err
    while e is not None and seen < 6:
        text = (f"{type(e).__name__}: {e}" if isinstance(e, BaseException) else str(e)).lower()
        if any(m in text for m in _SAFETY_MARKERS):
            return True
        e = getattr(e, "__cause__", None) or getattr(e, "__context__", None)
        seen += 1
    return False


@dataclass
class Turn:
    reply: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    tools: list[str] = field(default_factory=list)
    refused_by_provider: bool = False


@dataclass
class Adapter:
    name: str
    new_state: Callable[[str], Awaitable[Any]]
    turn: Callable[[Any, str, str], Awaitable[Turn]]
    info: dict = field(default_factory=dict)


def load_env(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse --port/--env-file; load ONLY AI_GATEWAY_API_KEY from the env file (nothing else reaches the agent)."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--env-file", default=None)
    args, _ = ap.parse_known_args(argv)
    if args.env_file and not os.environ.get("AI_GATEWAY_API_KEY"):
        for line in open(args.env_file, encoding="utf8"):
            if line.startswith("AI_GATEWAY_API_KEY="):
                os.environ["AI_GATEWAY_API_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not os.environ.get("AI_GATEWAY_API_KEY"):
        sys.exit("AI_GATEWAY_API_KEY missing (env or --env-file)")
    return args


def gateway_key() -> str:
    return os.environ["AI_GATEWAY_API_KEY"]


def _text(m: dict) -> str:
    c = m.get("content")
    if isinstance(c, list):
        return "".join(p.get("text", "") for p in c if isinstance(p, dict))
    return c or ""


def _h(model: str, msgs: list[dict]) -> str:
    return hashlib.sha256((model + json.dumps(msgs, sort_keys=True)).encode()).hexdigest()


def serve(adapter: Adapter, args: argparse.Namespace) -> None:
    app = FastAPI()
    cache: dict[str, Any] = {}
    stats: dict[str, Any] = {"requests": 0, "turns": 0, "errors": 0, "provider_refusals": 0, "timeouts": 0,
                             "prompt_tokens": 0, "completion_tokens": 0, "est_cost_usd": 0.0}

    @app.get("/health")
    async def health():
        return {"ok": True, "agent": adapter.name, **adapter.info}

    @app.get("/stats")
    async def get_stats():
        return {**stats, "est_cost_usd": round(stats["est_cost_usd"], 6), "cached_states": len(cache)}

    @app.post("/v1/chat/completions")
    async def chat(req: Request):
        body = await req.json()
        stats["requests"] += 1
        model = body.get("model") or "anthropic/claude-sonnet-5.5"
        msgs = [{"role": m["role"], "content": _text(m)} for m in body.get("messages") or [] if m.get("role") in ("user", "assistant")]
        last = max((i for i, m in enumerate(msgs) if m["role"] == "user"), default=None)
        if last is None:
            return JSONResponse({"error": {"message": "no user message", "type": "invalid_request_error"}}, status_code=400)
        prefix, user_text = msgs[:last], msgs[last]["content"]
        state = cache.pop(_h(model, prefix), None) if prefix else None
        if state is None:
            state = await adapter.new_state(model)
            if prefix:
                user_text = "Conversation so far:\n" + "\n".join(f"{m['role']}: {m['content']}" for m in prefix) + f"\n\nuser: {user_text}"
        try:
            t = await asyncio.wait_for(adapter.turn(state, model, user_text), TURN_TIMEOUT_S)
        except asyncio.TimeoutError:
            stats["timeouts"] += 1
            print(f"[{adapter.name}] turn timeout ({model})", flush=True)
            return JSONResponse({"error": {"message": "agent turn timed out", "type": "server_error"}}, status_code=504)
        except Exception as e:  # noqa: BLE001
            if is_provider_safety_block(e):
                t = Turn(reply=PROVIDER_REFUSAL, refused_by_provider=True)
            else:
                stats["errors"] += 1
                print(f"[{adapter.name}] turn error ({model}): {type(e).__name__}: {str(e)[:300]}", flush=True)
                traceback.print_exc(limit=3)
                return JSONResponse({"error": {"message": f"{type(e).__name__}: {str(e)[:200]}", "type": "server_error"}}, status_code=502)
        if not t.refused_by_provider and is_provider_refusal_text(t.reply):
            t = Turn(reply=PROVIDER_REFUSAL, prompt_tokens=t.prompt_tokens, completion_tokens=t.completion_tokens, tools=t.tools, refused_by_provider=True)
        if t.refused_by_provider:
            stats["provider_refusals"] += 1
            t.tools.append("provider_refusal")
            print(f"[{adapter.name}] {model}: provider safety block -> refusal reply", flush=True)
        stats["turns"] += 1
        pin, pout = PRICES.get(model, DEFAULT_PRICE)
        cost = t.prompt_tokens * pin + t.completion_tokens * pout
        stats["prompt_tokens"] += t.prompt_tokens
        stats["completion_tokens"] += t.completion_tokens
        stats["est_cost_usd"] += cost
        if len(cache) >= MAX_CACHED:
            cache.pop(next(iter(cache)))
        cache[_h(model, msgs + [{"role": "assistant", "content": t.reply}])] = state
        return {
            "id": "chatcmpl-" + uuid.uuid4().hex[:24], "object": "chat.completion", "created": int(time.time()), "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": t.reply}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": t.prompt_tokens, "completion_tokens": t.completion_tokens,
                      "total_tokens": t.prompt_tokens + t.completion_tokens, "cost_usd": round(cost, 6)},
            "x_tools": t.tools,
        }

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
