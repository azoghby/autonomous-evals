"""
Sandbox shim for Google's ADK "customer-service" sample agent (Cymbal Home & Garden, "Project Pro").
Upstream: google/adk-samples python/agents/customer-service @ a9dc17718dc8aa2388a0c170263ef05d6e964147 (Apache-2.0).
(The sample was deleted from adk-samples main in 3fd76ce; we run the last revision that contained it.)

What runs is the REAL agent: `customer_service.agent.root_agent` with its own GLOBAL_INSTRUCTION / INSTRUCTION
(prompts.py), its 12 tool functions' signatures + docstrings, and its callbacks (before_tool customer-id validation and
the sync_ask_for_approval <=10% short-circuit, after_tool, before_agent profile load, rate_limit_callback).

Exactly two things are swapped, nothing else:
  1. MODEL: `model` (default "gemini-2.5-flash" on Vertex) -> ADK's LiteLlm wrapper pointed at the Vercel AI Gateway
     OpenAI-compatible API (api_base https://ai-gateway.vercel.sh/v1, model "openai/<gateway id>").
  2. TOOLS (sandbox sessions only): each tool function in root_agent.tools is replaced by an async wrapper made with
     functools.wraps, so ADK builds the identical function declaration (same name, params, types, docstring). The
     wrapper POSTs {"tool": name, "args": {...}} to the session's bridge_url and returns the sandbox result in the
     original tool's return shape: the env's SQL bindings return one column `_return` holding exactly what the
     upstream mock returns (dict, list or string), which the wrapper unwraps. On {"error": ...} the wrapper returns
     {"status": "error", "message": ...} so the model can recover (upstream tools never raise either).
  /v1/chat/completions (black-box, leaderboard) uses the ORIGINAL mock tools untouched.

Start:  ADK_CS_DIR=<adk-samples clone>/python/agents/customer-service python adk_cs_sandbox_shim.py --port 8766 --env-file .env
"""
from __future__ import annotations

import argparse
import asyncio
import functools
import hashlib
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
AGENT_ROOT = Path(os.environ["ADK_CS_DIR"]) if os.environ.get("ADK_CS_DIR") else HERE.parent / "adk-samples" / "python" / "agents" / "customer-service"
GATEWAY = "https://ai-gateway.vercel.sh/v1"
BRIDGE_TIMEOUT_S = 30
MAX_SESSIONS = 200

# USD per token, Vercel AI Gateway list prices (GET /v1/models, 2026-11-07). Used only to estimate cost: LiteLLM drops
# the gateway's own provider_metadata.gateway.cost from the OpenAI-compatible response.
PRICES = {
    "anthropic/claude-sonnet-5.5": (2e-6, 10e-6),
    "anthropic/claude-opus-5.5": (4e-6, 20e-6),
    "openai/gpt-5.5": (5e-6, 30e-6),
    "google/gemini-3.8-flash": (0.75e-6, 3.75e-6),
}
DEFAULT_PRICE = (2e-6, 10e-6)


def _load_env_file(argv: list[str]) -> None:
    if "--env-file" in argv:
        p = argv[argv.index("--env-file") + 1]
        for line in Path(p).read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env_file(sys.argv)
API_KEY = os.environ.get("AI_GATEWAY_API_KEY")
if not API_KEY:
    sys.exit("AI_GATEWAY_API_KEY missing")
# The agent's config.py reads GOOGLE_* settings; keep it off Vertex (the model object is replaced anyway).
os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "0")
os.environ.setdefault("LITELLM_LOG", "ERROR")

sys.path.insert(0, str(AGENT_ROOT))
import httpx  # noqa: E402
import litellm  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from google.adk.models.lite_llm import LiteLlm  # noqa: E402
from google.adk.runners import InMemoryRunner  # noqa: E402
from google.genai import types  # noqa: E402
import google.auth  # noqa: E402

# customer_service/__init__.py calls google.auth.default() at import time to find a Vertex project. We never use
# Vertex (the model is replaced), so answer that one import-time lookup with a placeholder instead of real GCP creds.
_real_auth_default = google.auth.default
google.auth.default = lambda *a, **k: (None, "no-gcp-sandbox")
from customer_service.agent import root_agent  # noqa: E402,F811
google.auth.default = _real_auth_default

from customer_service.agent import root_agent  # noqa: E402  (the real agent)
from customer_service.config import Config  # noqa: E402

litellm.suppress_debug_info = True
logging.getLogger().setLevel(logging.WARNING)  # config.py sets DEBUG globally; keep the shim log readable
for name in ("customer_service", "LiteLLM", "httpx", "google_adk"):
    logging.getLogger(name).setLevel(logging.WARNING)

APP_NAME = Config().app_name
USER_ID = "user"
ORIGINAL_TOOLS = list(root_agent.tools)
http = httpx.AsyncClient(timeout=BRIDGE_TIMEOUT_S)


def gateway_model(model_id: str) -> LiteLlm:
    """ADK's LiteLlm over the gateway's OpenAI-compatible route ("openai/" prefix = OpenAI-compatible provider)."""
    return LiteLlm(model=f"openai/{model_id}", api_base=GATEWAY, api_key=API_KEY)


def bridged_tool(fn, bridge_url: str):
    """Same name/signature/docstring as `fn` (functools.wraps), but executes the call in the sandbox via the bridge."""

    @functools.wraps(fn)
    async def wrapper(**kwargs: Any) -> Any:
        try:
            r = await http.post(bridge_url, json={"tool": fn.__name__, "args": kwargs})
            body = r.json()
        except Exception as e:  # bridge unreachable: report to the model like a failed backend call
            return {"status": "error", "message": f"backend unavailable: {type(e).__name__}"}
        if body.get("error"):
            return {"status": "error", "message": str(body["error"])[:500]}
        res = body.get("result")
        if isinstance(res, dict) and set(res.keys()) == {"_return"}:
            return res["_return"]
        return res

    return wrapper


class Sess:
    def __init__(self, runner: InMemoryRunner, session_id: str, model: str):
        self.runner, self.session_id, self.model = runner, session_id, model
        self.lock = asyncio.Lock()
        self.created = time.time()


SESSIONS: dict[str, Sess] = {}
STATS = {"sessions": 0, "messages": 0, "model_calls": 0, "est_cost_usd": 0.0, "errors": 0, "provider_refusals": 0, "bb_requests": 0}

# Provider safety blocks. The model provider (not the agent) sometimes refuses a request outright: Anthropic "Cyber
# safeguards flagged this message", OpenAI "This content was flagged for possible cybersecurity risk" (surfaced by
# LiteLLM as BadRequestError), Gemini SAFETY blocks. The upstream sample has no handler, so the turn would fail. A
# production deployment shows the user a refusal, so the shim does the same: the turn returns PROVIDER_REFUSAL as the
# agent's reply (counted in STATS["provider_refusals"], tagged "provider_refusal" in tool_calls) instead of an
# error / HTTP 502. Graders then score that reply like any other refusal. Every leaderboard row runs under this rule.
PROVIDER_REFUSAL = "Sorry, I can't help with that request."
_SAFETY_MARKERS = (
    "modelrefusalerror", "refused to produce output", "safeguards flagged", "flagged for possible",
    "content_filter", "content filter", "content management policy", "violate anthropic's terms",
    "usage policies", "finish_reason: safety", "blocked due to safety", "prohibited_content",
)


# The gateway reports an Anthropic refusal as finish_reason "content-filter" (hyphen), which LiteLLM does not know and
# maps to "stop", hiding the block as an empty reply. Teach LiteLLM's table the gateway spelling so ADK sees
# FinishReason.SAFETY, which run_turn treats as a provider safety block.
from litellm.litellm_core_utils import core_helpers as _litellm_core_helpers  # noqa: E402

_litellm_core_helpers._FINISH_REASON_MAP.setdefault("content-filter", "content_filter")
_litellm_core_helpers._FINISH_REASON_MAP.setdefault("refusal", "content_filter")


def is_provider_safety_block(err: object) -> bool:
    """True when an exception or error string is the model provider refusing the request on safety grounds."""
    text = (f"{type(err).__name__}: {err}" if isinstance(err, BaseException) else str(err or "")).lower()
    return any(m in text for m in _SAFETY_MARKERS)


async def new_session(session_id: str, model: str, bridge_url: str | None) -> Sess:
    tools = [bridged_tool(t, bridge_url) for t in ORIGINAL_TOOLS] if bridge_url else ORIGINAL_TOOLS
    agent = root_agent.clone(update={"model": gateway_model(model), "tools": tools})
    runner = InMemoryRunner(agent=agent, app_name=APP_NAME)
    await runner.session_service.create_session(app_name=APP_NAME, user_id=USER_ID, session_id=session_id)
    if len(SESSIONS) >= MAX_SESSIONS:
        oldest = min(SESSIONS.values(), key=lambda s: s.created)
        SESSIONS.pop(oldest.session_id, None)
    s = Sess(runner, session_id, model)
    SESSIONS[session_id] = s
    STATS["sessions"] += 1
    return s


async def run_turn(s: Sess, message: str) -> dict:
    """One user turn through the real ADK runner. Returns final text + usage summed over every model call."""
    pt = ct = calls = 0
    texts: list[str] = []
    tool_calls: list[str] = []
    err = None
    safety_blocked = False
    content = types.Content(role="user", parts=[types.Part(text=message)])
    try:
        async for ev in s.runner.run_async(user_id=USER_ID, session_id=s.session_id, new_message=content):
            um = getattr(ev, "usage_metadata", None)
            if um is not None and ev.author != "user":
                calls += 1
                pt += um.prompt_token_count or 0
                ct += um.candidates_token_count or 0
            if ev.content and ev.content.parts:
                for p in ev.content.parts:
                    if getattr(p, "function_call", None):
                        tool_calls.append(p.function_call.name)
            if ev.is_final_response() and ev.content and ev.content.parts:
                t = "".join(p.text or "" for p in ev.content.parts if getattr(p, "text", None) and not getattr(p, "thought", False))
                if t.strip():
                    texts.append(t)
            if getattr(ev, "finish_reason", None) == types.FinishReason.SAFETY:
                safety_blocked = True
            if getattr(ev, "error_message", None):
                err = f"{ev.error_code or 'error'}: {ev.error_message}"
    except Exception as e:
        err = f"{type(e).__name__}: {str(e)[:400]}"
        if not is_provider_safety_block(err):
            STATS["errors"] += 1
            print(f"[adk-shim] turn error ({s.model}): {err}", flush=True)
    if not texts and (safety_blocked or (err and is_provider_safety_block(err))):
        STATS["provider_refusals"] += 1
        print(f"[adk-shim] {s.model}: provider safety block -> refusal reply", flush=True)
        texts.append(PROVIDER_REFUSAL)
        tool_calls.append("provider_refusal")
        err = None
    pin, pout = PRICES.get(s.model, DEFAULT_PRICE)
    cost = pt * pin + ct * pout
    STATS["model_calls"] += calls
    STATS["est_cost_usd"] += cost
    out = {"reply": texts[-1] if texts else "", "usage": {"prompt_tokens": pt, "completion_tokens": ct, "cost_usd": round(cost, 6), "model_calls": calls}, "tool_calls": tool_calls}
    if err:
        out["error"] = err
    return out


app = FastAPI()


@app.get("/health")
async def health():
    return {"ok": True, "agent": root_agent.name, "tools": [t.__name__ for t in ORIGINAL_TOOLS]}


@app.get("/stats")
async def stats():
    return {**STATS, "est_cost_usd": round(STATS["est_cost_usd"], 6), "live_sessions": len(SESSIONS)}


@app.post("/session/start")
async def session_start(req: Request):
    b = await req.json()
    sid, model, bridge = b.get("session_id"), b.get("model"), b.get("bridge_url")
    if not (isinstance(sid, str) and isinstance(model, str) and isinstance(bridge, str)):
        return JSONResponse({"ok": False, "error": "session_id, model, bridge_url required"}, status_code=400)
    if not bridge.startswith("http://127.0.0.1:"):
        return JSONResponse({"ok": False, "error": "bridge_url must be a local 127.0.0.1 URL"}, status_code=400)
    await new_session(sid, model, bridge)
    return {"ok": True}


@app.post("/session/message")
async def session_message(req: Request):
    b = await req.json()
    s = SESSIONS.get(b.get("session_id"))
    if s is None:
        return JSONResponse({"reply": "", "error": "unknown session"}, status_code=404)
    STATS["messages"] += 1
    async with s.lock:
        return await run_turn(s, str(b.get("message", "")))


@app.post("/session/end")
async def session_end(req: Request):
    b = await req.json()
    SESSIONS.pop(b.get("session_id"), None)
    return {"ok": True}


# ---------------- black-box OpenAI-compatible endpoint (original mock tools) ----------------
BB: dict[str, Sess] = {}


def _h(msgs: list[dict]) -> str:
    return hashlib.sha256(json.dumps(msgs, sort_keys=True).encode()).hexdigest()


def _text(m: dict) -> str:
    c = m.get("content")
    if isinstance(c, list):
        return "".join(p.get("text", "") for p in c if isinstance(p, dict))
    return c or ""


@app.post("/v1/chat/completions")
async def chat(req: Request):
    body = await req.json()
    STATS["bb_requests"] += 1
    model = body.get("model") or "anthropic/claude-sonnet-5.5"
    msgs = [{"role": m["role"], "content": _text(m)} for m in body.get("messages") or [] if m.get("role") in ("user", "assistant")]
    last = max((i for i, m in enumerate(msgs) if m["role"] == "user"), default=None)
    if last is None:
        return JSONResponse({"error": {"message": "no user message", "type": "invalid_request_error"}}, status_code=400)
    prefix, user_text = msgs[:last], msgs[last]["content"]
    s = BB.pop(f"{model}:{_h(prefix)}", None) if prefix else None
    if s is None:
        s = await new_session(f"bb_{uuid.uuid4().hex[:16]}", model, None)
        SESSIONS.pop(s.session_id, None)
        if prefix:  # unknown history: give the agent the prior transcript as context in one message
            user_text = "Conversation so far:\n" + "\n".join(f"{m['role']}: {m['content']}" for m in prefix) + f"\n\nuser: {user_text}"
    async with s.lock:
        out = await run_turn(s, user_text)
    if out.get("error") and not out["reply"]:
        return JSONResponse({"error": {"message": out["error"][:300], "type": "server_error"}}, status_code=502)
    BB[f"{model}:{_h(msgs + [{'role': 'assistant', 'content': out['reply']}])}"] = s
    u = out["usage"]
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex[:24], "object": "chat.completion", "created": int(time.time()), "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": out["reply"]}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": u["prompt_tokens"], "completion_tokens": u["completion_tokens"], "total_tokens": u["prompt_tokens"] + u["completion_tokens"], "cost_usd": u["cost_usd"]},
        "x_tools": out["tool_calls"],
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--env-file", default=None)
    a = ap.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=a.port, log_level="warning")
