# NOTICE

This environment is derived from OpenAI's open-source **Customer Service Agents Demo** (airline).

- Source: https://github.com/openai/openai-cs-agents-demo
- Commit: `bd7bfca0f5abf50529370814c3e7c88542011925`
- Copyright 2025 OpenAI, MIT License (see `LICENSE` in this directory, copied verbatim).
- Upstream files used: `python-backend/airline/{agents.py,tools.py,context.py,demo_data.py,guardrails.py}`.

## What was converted

- **Tools** (`openapi.yaml`): one operation per tool the demo's agents actually use, with the same name and arguments
  as `tools.py`: `faq_lookup_tool`, `get_trip_details`, `update_seat`, `flight_status_tool`, `get_matching_flights`,
  `book_new_flight`, `assign_special_service_seat`, `issue_compensation`, `display_seat_map`, `cancel_flight`.
  `baggage_tool` is defined upstream but attached to no agent, so it is omitted. Each `x-sandbox-sql` binding
  re-implements the Python function against the tables and returns the function's original reply text in `message`.
- **Context as state**: the demo's tools read and hydrate the conversation context (`AirlineAgentContext`,
  `apply_itinerary_defaults`) instead of taking ids; `cancel_flight()` takes no arguments and cancels the flight in
  context. The `agent_context` table is that context (scenario / confirmation / flight), starting empty like
  `create_initial_context()`; every binding applies the same defaults (`disrupted` itinerary when nothing is known).
- **Data** (`schema.sql`, `seed.sql`): `MOCK_ITINERARIES` from `demo_data.py`, verbatim values, normalized into
  `bookings`, `flights`, `booking_segments`, `vouchers`; `compensation_cases` holds what the demo kept on the context.
- **Policy** (`policies.md`): the six agents' instructions, the FAQ answers and the two guardrail prompts, quoted
  verbatim as numbered clauses. Section 9 is a Standard Evals sandbox convention, not upstream text.
- **Workflows** (`workflows.json`) and **scenarios** (`scenarios.json`): new, written by Standard Evals.

## Deliberate differences from upstream

- Random ids are deterministic: compensation cases are `CMP-1001`, `CMP-1002`, ... (upstream `CMP-<random>`).
- `update_seat` changes only an existing, confirmed booking and requires a seat like `12C`; upstream accepted any
  confirmation number and any text. A failed precondition leaves the database unchanged and returns an error.
- `book_new_flight` / `assign_special_service_seat` / `cancel_flight` act only on a confirmed booking.
  As upstream, an unknown `flight_number` falls back to the first rebook option, and an itinerary without options
  returns the placeholder "Booked flight ..." text without changing anything.
- `book_new_flight` replaces the booked leg with the same origin/destination as the new flight (upstream: drops the
  New York -> Austin leg of the disrupted itinerary). Stored seats drop the label (`2A`); replies keep it (`2A (front row)`).
- `cancel_flight` cancels the flight in context on the booking in context and marks the booking cancelled once no
  flight on it remains confirmed (upstream only returned a string).
- `ProgressUpdateEvent` streaming is UI-only and not reproduced.

## Running the real agent against this env

The real demo graph runs unmodified behind `cs_agents_sandbox_shim.py` (scratchpad `real-agents/shims/`), which
patches only the tools' `on_invoke_tool` so each call is executed by this sandbox through the bridge in
`scripts/demo/bridge-agent.ts`. Converted by Standard Evals.
