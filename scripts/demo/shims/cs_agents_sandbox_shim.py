"""Sandbox shim for the REAL openai-cs-agents-demo airline agent graph (openai/openai-cs-agents-demo, MIT).

The demo clone is imported UNTOUCHED (agents, prompts, handoffs, guardrails, handoff hooks). This file changes exactly
two things at import time, both documented below:

  1. MODEL ROUTING. Every agent and both guardrail agents get a `SessionModel`: an OpenAIChatCompletionsModel on the
     Vercel AI Gateway (https://ai-gateway.vercel.sh/v1, AI_GATEWAY_API_KEY) whose model id is read per call from a
     contextvar, so each session (and each black-box request) runs ALL its LLM calls on its own `model`.
  2. TOOL PATCH (sandbox sessions only). For each FunctionTool the agents use, `on_invoke_tool` is wrapped: inside a
     sandbox session the call is sent as  POST {bridge_url} {"tool": name, "args": {...}}  and the sandbox's
     {"result": {...}} | {"error": "..."} is turned back into the string the original tool would return (the SQL
     bindings return the original reply text in `message`). The context fields the original tool would have set
     (confirmation_number, flight_number, seat_number, ...) are mirrored onto the run context from the result, so the
     agents' dynamic instructions keep working; the source of truth for state is the sandbox DB. Outside a sandbox
     session (POST /v1/chat/completions) the original in-memory tool runs unchanged.

Endpoints:
  POST /session/start   {session_id, model, bridge_url}  -> {ok: true}
  POST /session/message {session_id, message}            -> {reply, usage: {prompt_tokens, completion_tokens, cost_usd}, agent, error?}
  POST /session/end     {session_id}                     -> {ok: true}
  POST /v1/chat/completions  OpenAI-compatible black box (model from body), original in-memory tools.
  GET  /health, GET /stats

Run:  CS_DEMO_DIR=<openai-cs-agents-demo clone>/python-backend python cs_agents_sandbox_shim.py --port 8765 --env-file <repo>/.env
"""
from __future__ import annotations

import argparse, asyncio, contextvars, hashlib, json, os, sys, time, uuid
from datetime import datetime

DEMO = os.environ.get("CS_DEMO_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cs-agents-demo", "python-backend")
sys.path.insert(0, os.path.abspath(DEMO))


def _load_env_file(path: str | None) -> None:
    if not path:
        return
    for line in open(path, encoding="utf8"):
        if line.startswith("AI_GATEWAY_API_KEY=") and not os.environ.get("AI_GATEWAY_API_KEY"):
            os.environ["AI_GATEWAY_API_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")


_ap = argparse.ArgumentParser()
_ap.add_argument("--port", type=int, default=8765)
_ap.add_argument("--env-file", default=None)
ARGS = _ap.parse_args()
_load_env_file(ARGS.env_file)

import httpx2 as httpx
from openai import AsyncOpenAI
from agents import (InputGuardrailTripwireTriggered, Runner, RunConfig, ModelSettings, set_tracing_disabled,
                    ToolCallItem, HandoffOutputItem, FunctionTool)
from agents.exceptions import MaxTurnsExceeded
from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel
from chatkit.types import ThreadMetadata
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

GATEWAY = "https://ai-gateway.vercel.sh/v1"
DEFAULT_MODEL = "openai/gpt-5-mini"
REFUSAL = "Sorry, I can only answer questions related to airline travel."  # verbatim from the demo's server.py
MAX_TURNS = 20
BRIDGE_TIMEOUT_S = 60

KEY = os.environ.get("AI_GATEWAY_API_KEY")
if not KEY:
    sys.exit("AI_GATEWAY_API_KEY missing (env or --env-file)")
client = AsyncOpenAI(base_url=GATEWAY, api_key=KEY, timeout=180, max_retries=2)
set_tracing_disabled(True)

# ---- per-session routing state (contextvars propagate into the SDK's guardrail/tool tasks) ----
CURRENT_MODEL: contextvars.ContextVar[str] = contextvars.ContextVar("cs_model", default=DEFAULT_MODEL)
CURRENT_BRIDGE: contextvars.ContextVar[str | None] = contextvars.ContextVar("cs_bridge", default=None)
CURRENT_USAGE: contextvars.ContextVar[dict | None] = contextvars.ContextVar("cs_usage", default=None)
STATS = {"requests": 0, "model_calls": 0, "cost_usd": 0.0, "bridge_calls": 0, "bridge_errors": 0, "guardrail_tripwires": 0, "errors": 0, "by_model": {}}

# ---- (1) model routing + usage metering ----
_orig_create = client.chat.completions.create


def _cost_of(u) -> float:
    c = getattr(u, "cost", None)
    if c is None and getattr(u, "model_extra", None):
        c = u.model_extra.get("cost")
    try:
        return float(c or 0.0)
    except (TypeError, ValueError):
        return 0.0


async def _metered_create(*a, **kw):
    model = kw.get("model", "?")
    # Model quirks on the gateway's OpenAI-compatible API (see report): only the Agents SDK defaults are sent;
    # reasoning models reject temperature/top_p, so drop them if a ModelSettings ever sets them.
    if any(model.startswith(p) for p in ("openai/gpt-5", "openai/o")):
        kw.pop("temperature", None); kw.pop("top_p", None)
    resp = await _orig_create(*a, **kw)
    u = getattr(resp, "usage", None)
    if u is not None:
        pin, pout, cost = u.prompt_tokens or 0, u.completion_tokens or 0, _cost_of(u)
        acc = CURRENT_USAGE.get()
        if acc is not None:
            acc["prompt_tokens"] += pin; acc["completion_tokens"] += pout; acc["cost_usd"] += cost; acc["calls"] += 1
        STATS["model_calls"] += 1; STATS["cost_usd"] += cost
        m = STATS["by_model"].setdefault(model, {"calls": 0, "cost_usd": 0.0}); m["calls"] += 1; m["cost_usd"] += cost
    return resp

client.chat.completions.create = _metered_create  # type: ignore[method-assign]


class SessionModel(OpenAIChatCompletionsModel):
    """Chat-completions model whose id is the current session's `model` (read at call time)."""

    @property
    def model(self):  # type: ignore[override]
        return CURRENT_MODEL.get()

    @model.setter
    def model(self, _v):  # the base __init__ assigns self.model; the id always comes from the contextvar
        pass


SESSION_MODEL = SessionModel(model=DEFAULT_MODEL, openai_client=client)

# ---- import the REAL demo graph ----
from airline import agents as A, guardrails as G  # noqa: E402
from airline.context import AirlineAgentChatContext, create_initial_context  # noqa: E402
from memory_store import MemoryStore  # noqa: E402

ALL_AGENTS = [A.triage_agent, A.faq_agent, A.seat_special_services_agent, A.flight_information_agent,
              A.booking_cancellation_agent, A.refunds_compensation_agent]
for _ag in ALL_AGENTS + [G.guardrail_agent, G.jailbreak_guardrail_agent]:
    _ag.model = SESSION_MODEL
BY_NAME = {a.name: a for a in ALL_AGENTS}

# ---- (2) tool patch: route to the sandbox bridge inside sandbox sessions ----
# Fields of AirlineAgentContext a tool result may carry; mirrored onto the run context (what the original tool set).
CTX_FIELDS = ("scenario", "confirmation_number", "flight_number", "seat_number", "passenger_name",
              "special_service_note", "compensation_case_id", "vouchers")
_http = httpx.AsyncClient(timeout=BRIDGE_TIMEOUT_S)


def _mirror_context(tool_ctx, result: dict) -> None:
    state = getattr(getattr(tool_ctx, "context", None), "state", None)
    if state is None:
        return
    for f in CTX_FIELDS:
        v = result.get(f)
        if v is not None and hasattr(state, f):
            setattr(state, f, v)


def _as_tool_string(result) -> str:
    if isinstance(result, dict) and isinstance(result.get("message"), str):
        return result["message"]
    if isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict) and "message" in result[0]:
        return str(result[0]["message"])
    return json.dumps(result, ensure_ascii=False, default=str)


def _patch_tool(tool: FunctionTool) -> None:
    if getattr(tool, "_cs_sandbox_patched", False):
        return
    original = tool.on_invoke_tool
    name = tool.name

    async def invoke(tool_ctx, raw_args: str):
        bridge = CURRENT_BRIDGE.get()
        if not bridge:
            return await original(tool_ctx, raw_args)  # black-box mode: the demo's own in-memory tool
        try:
            parsed = json.loads(raw_args) if raw_args else {}
        except json.JSONDecodeError:
            return f"Error: invalid JSON arguments for {name}"
        args = {k: v for k, v in (parsed or {}).items() if v is not None}  # optional params arrive as null
        STATS["bridge_calls"] += 1
        try:
            r = await _http.post(bridge, json={"tool": name, "args": args})
            body = r.json()
        except Exception as e:  # noqa: BLE001 - surfaced to the agent like the SDK's default failure handler
            STATS["bridge_errors"] += 1
            return f"An error occurred while running the tool. Please try again. Error: {type(e).__name__}"
        if body.get("error"):
            STATS["bridge_errors"] += 1
            return f"Error: {body['error']}"
        result = body.get("result")
        if isinstance(result, dict):
            _mirror_context(tool_ctx, result)
        return _as_tool_string(result)

    tool.on_invoke_tool = invoke  # type: ignore[assignment]
    tool._cs_sandbox_patched = True  # type: ignore[attr-defined]


for _ag in ALL_AGENTS:
    for _t in _ag.tools:
        if isinstance(_t, FunctionTool):
            _patch_tool(_t)

# ---- conversation runner (mirrors server.py: input items + current agent persist across turns) ----
store = MemoryStore()


class Conv:
    def __init__(self, model: str, bridge: str | None):
        self.input_items: list = []
        self.context = create_initial_context()
        self.agent = A.triage_agent.name
        self.model = model
        self.bridge = bridge
        self.lock = asyncio.Lock()


SESSIONS: dict[str, Conv] = {}
BLACKBOX: dict[str, Conv] = {}


async def run_turn(conv: Conv, text: str) -> dict:
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0, "calls": 0}
    tm, tb, tu = CURRENT_MODEL.set(conv.model), CURRENT_BRIDGE.set(conv.bridge), CURRENT_USAGE.set(usage)
    tools, handoffs, error = [], [], None
    try:
        conv.input_items.append({"content": text, "role": "user"})
        thread = ThreadMetadata(id=store.generate_thread_id({}), created_at=datetime.now())
        ctx = AirlineAgentChatContext(thread=thread, store=store, request_context={}, state=conv.context)
        try:
            result = await Runner.run(BY_NAME.get(conv.agent, A.triage_agent), conv.input_items, context=ctx, max_turns=MAX_TURNS)
            for it in result.new_items:
                if isinstance(it, ToolCallItem):
                    tools.append(f"{it.agent.name}:{getattr(it.raw_item, 'name', '?')}")
                elif isinstance(it, HandoffOutputItem):
                    handoffs.append(f"{it.source_agent.name}->{it.target_agent.name}")
            conv.input_items = result.to_input_list()
            conv.agent = result.last_agent.name
            reply = result.final_output if isinstance(result.final_output, str) else str(result.final_output)
        except InputGuardrailTripwireTriggered as exc:
            STATS["guardrail_tripwires"] += 1
            reply = REFUSAL
            conv.input_items.append({"role": "assistant", "content": REFUSAL})
            g = exc.guardrail_result.guardrail
            tools.append(f"guardrail_tripwire:{getattr(g, 'name', None) or type(g).__name__}")
        except MaxTurnsExceeded:
            reply = "Sorry, I wasn't able to complete that request."
            conv.input_items.append({"role": "assistant", "content": reply})
            error = "max_turns_exceeded"
        except Exception as e:  # noqa: BLE001 - the driver records it as an agent error
            STATS["errors"] += 1
            print(f"[cs-sandbox-shim] {conv.model}: {type(e).__name__}: {str(e)[:400]}", flush=True)
            conv.input_items.pop()  # drop the user message so a retry starts clean
            reply, error = "", f"{type(e).__name__}: {str(e)[:300]}"
    finally:
        CURRENT_MODEL.reset(tm); CURRENT_BRIDGE.reset(tb); CURRENT_USAGE.reset(tu)
    usage["cost_usd"] = round(usage["cost_usd"], 6)
    return {"reply": reply, "usage": usage, "agent": conv.agent, "tools": tools, "handoffs": handoffs, "error": error}


app = FastAPI()


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.get("/stats")
async def stats():
    return {**STATS, "cost_usd": round(STATS["cost_usd"], 6), "sessions": len(SESSIONS)}


def _is_local_bridge(url: str) -> bool:
    return isinstance(url, str) and (url.startswith("http://127.0.0.1:") or url.startswith("http://localhost:"))


@app.post("/session/start")
async def session_start(req: Request):
    b = await req.json()
    sid, model, bridge = b.get("session_id"), b.get("model"), b.get("bridge_url")
    if not isinstance(sid, str) or not sid or not isinstance(model, str) or not model:
        return JSONResponse({"ok": False, "error": "session_id and model required"}, status_code=400)
    if not _is_local_bridge(bridge):
        return JSONResponse({"ok": False, "error": "bridge_url must be a local http URL"}, status_code=400)
    SESSIONS[sid] = Conv(model, bridge)  # fresh conversation state (replaces any previous session with this id)
    return {"ok": True}


@app.post("/session/message")
async def session_message(req: Request):
    b = await req.json()
    conv = SESSIONS.get(b.get("session_id"))
    if conv is None:
        return JSONResponse({"error": "unknown session"}, status_code=404)
    msg = b.get("message")
    if not isinstance(msg, str):
        return JSONResponse({"error": "message required"}, status_code=400)
    STATS["requests"] += 1
    async with conv.lock:
        out = await run_turn(conv, msg)
    if not out["error"]:
        out.pop("error")
    return out


@app.post("/session/end")
async def session_end(req: Request):
    b = await req.json()
    SESSIONS.pop(b.get("session_id"), None)
    return {"ok": True}


# ---- black-box OpenAI-compatible endpoint (original in-memory tools; same conversation keying as cs_agents_shim.py) ----
def _h(msgs) -> str:
    return hashlib.sha256(json.dumps(msgs, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _text_of(m) -> str:
    c = m.get("content")
    if isinstance(c, list):
        return "".join(p.get("text", "") for p in c if isinstance(p, dict))
    return c or ""


@app.post("/v1/chat/completions")
async def chat(req: Request):
    body = await req.json()
    STATS["requests"] += 1
    model = body.get("model") or DEFAULT_MODEL
    msgs = [{"role": m["role"], "content": _text_of(m)} for m in (body.get("messages") or []) if m.get("role") in ("user", "assistant")]
    last_user = max((i for i, m in enumerate(msgs) if m["role"] == "user"), default=None)
    if last_user is None:
        return JSONResponse({"error": {"message": "no user message", "type": "invalid_request_error"}}, status_code=400)
    prefix, user_text = msgs[:last_user], msgs[last_user]["content"]
    pkey = _h([model] + prefix)
    conv = BLACKBOX.pop(pkey, None) if prefix else None
    if conv is None:
        conv = Conv(model, None)
        conv.input_items = list(prefix)
    async with conv.lock:
        out = await run_turn(conv, user_text)
    if out["error"]:
        return JSONResponse({"error": {"message": out["error"], "type": "server_error"}}, status_code=502)
    BLACKBOX[_h([model] + msgs + [{"role": "assistant", "content": out["reply"]}])] = conv
    u = out["usage"]
    return {"id": "chatcmpl-" + uuid.uuid4().hex[:24], "object": "chat.completion", "created": int(time.time()), "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": out["reply"]}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": u["prompt_tokens"], "completion_tokens": u["completion_tokens"],
                      "total_tokens": u["prompt_tokens"] + u["completion_tokens"], "cost": u["cost_usd"]},
            "x_agent": out["agent"], "x_tools": out["tools"], "x_handoffs": out["handoffs"]}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=ARGS.port, log_level="warning")
