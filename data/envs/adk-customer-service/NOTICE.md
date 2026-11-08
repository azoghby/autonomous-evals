# NOTICE

This environment is derived from Google's **ADK customer-service sample agent** (Cymbal Home & Garden, "Project Pro").

- Source: https://github.com/google/adk-samples, directory `python/agents/customer-service`
- Commit: `a9dc17718dc8aa2388a0c170263ef05d6e964147` (the last revision that contains the sample; it was removed
  from `main` in `3fd76cec44c48b0fb70bc6690218e7175f8ce74f`, "Deleted the 9 old/obsolete samples", 2026-09-09).
- Copyright 2025 Google LLC, Apache License 2.0 (see `LICENSE` in this directory, copied from the repo root).
- Upstream files used: `customer_service/{agent.py,prompts.py,config.py}`, `customer_service/tools/tools.py`,
  `customer_service/entities/customer.py`, `customer_service/shared_libraries/callbacks.py`.

## What was converted / adapted (by Standard Evals)

- **Tools** (`openapi.yaml`): one operation per tool function in `tools.py`, `operationId` = function name, same
  arguments and docstring text. Upstream every tool is a mock returning canned data; each `x-sandbox-sql` binding
  implements the documented behaviour against real tables instead:
  `modify_cart` really mutates `cart_items`; `access_cart_information` reads it; `schedule_planting_service` inserts
  into `appointments` and refuses a taken slot; `get_available_planting_times` returns the free slots of
  `planting_slots`; `approve_discount` / `sync_ask_for_approval` record `discount_requests` and mark approved ones
  applied (upstream `after_tool`: "Applying discount to the cart"); `update_salesforce_crm` records `crm_updates`;
  `send_care_instructions` / `send_call_companion_link` record `outbound_messages`; `generate_qr_code` records
  `qr_codes`.
- Every binding returns one column `_return` holding exactly the upstream return value (dict, list or string); the
  ADK shim unwraps it so the agent sees the original return shape.
- Business rules kept verbatim from the code: `approve_discount` rejects values above `MAX_DISCOUNT_RATE = 10` with the
  upstream message; `generate_qr_code` keeps its guardrails (percentage/empty type <= 10, `"fixed"` <= 20) and
  refusal strings. As upstream, the manager (`sync_ask_for_approval`) approves.
- Deliberate behavioural extensions (needed for state to mean something): availability comes from `inventory` (seeded
  at 10 everywhere, as the mock); unknown stores report unavailable; planting slots exist for 2024-07-22..2024-08-31
  (both mock ranges `9-12`, `13-16`) and one is pre-booked by a second, fake customer; `schedule_planting_service`
  also accepts "9:00 AM - 12:00 PM" / "1-4 PM" time formats; `get_product_recommendations` accepts `petunia` as an
  alias of `petunias`; unknown product ids in `modify_cart` are ignored (reported via `items_added: false`).
- **Database** (`schema.sql`, `seed.sql`): customer `123` is `Customer.get_customer("123")` verbatim; the cart is the
  `access_cart_information` mock; products and descriptions are the mocks' and the purchase history's. Prices other
  than the cart's (subtotal 25.98 -> 12.99 each) are set by Standard Evals so purchase totals add up. Customer `456`
  is new fake data. `session_context` stands in for the session state that `before_agent` fills with customer 123.
- **Policy** (`policies.md`): `prompts.py` INSTRUCTION quoted as numbered clauses, plus section 7 naming the rules the
  code enforces (with file references).
- **Workflows** (`workflows.json`) and **scenarios** (`scenarios.json`): new, written by Standard Evals.
- Frozen clock: 2024-07-22T16:00:00Z (the sample's examples use July 2024).

## Running the real agent against this env

The agent itself is not vendored here. `shims/adk_cs_sandbox_shim.py` (outside the repo) imports the unmodified
upstream `customer_service.agent.root_agent`, swaps only its model for ADK's `LiteLlm` over the Vercel AI Gateway
and, for sandbox sessions, swaps each tool function for a same-signature wrapper that executes the call here through
the bridge in `scripts/demo/bridge-agent.ts`. Prompts, callbacks and agent logic are untouched.
