-- cs-agents-airline sandbox world, converted from openai/openai-cs-agents-demo (MIT, OpenAI).
-- Postgres 15+. No extensions, no roles. sandbox_clock / sandbox_now() / sandbox_outbox come from the runtime preamble.
-- Source of the data: python-backend/airline/demo_data.py (MOCK_ITINERARIES) and context.py (AirlineAgentContext).

-- One row per mock itinerary in MOCK_ITINERARIES ("disrupted", "on_time"): the booking the passenger holds.
CREATE TABLE bookings (
  confirmation_number  text PRIMARY KEY,            -- e.g. 'IR-D204'
  scenario_key         text NOT NULL UNIQUE,        -- MOCK_ITINERARIES key
  itinerary_name       text NOT NULL,               -- e.g. 'Paris to New York to Austin'
  passenger_name       text NOT NULL,
  seat_number          text NOT NULL,
  baggage_tag          text,
  status               text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  special_service_note text,                         -- set by assign_special_service_seat
  rebook_note          text                          -- trailer get_matching_flights adds for this itinerary
);

-- Every flight the demo knows: itinerary segments and rebook options (MOCK_ITINERARIES[*].segments / .rebook_options).
CREATE TABLE flights (
  flight_number  text PRIMARY KEY,                   -- e.g. 'PA441'
  scenario_key   text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('segment', 'rebook_option')),
  seq            int  NOT NULL,                      -- order within the itinerary (segments) or option list
  origin         text NOT NULL,
  destination    text NOT NULL,
  departure      text NOT NULL,                      -- 'YYYY-MM-DD HH:MM' local, as in demo_data.py
  arrival        text NOT NULL,
  status         text,                               -- segments only
  gate           text,                               -- segments only
  impact_note    text,                               -- extra status line flight_status_tool adds (PA441 missed connection)
  seat           text,                               -- rebook options: seat held, e.g. '2A'
  seat_label     text,                               -- rebook options: seat as the demo prints it, e.g. '2A (front row)'
  note           text                                -- rebook options: note
);

-- Which flights a booking currently holds. book_new_flight replaces a leg, cancel_flight cancels one.
CREATE TABLE booking_segments (
  confirmation_number text NOT NULL REFERENCES bookings(confirmation_number),
  flight_number       text NOT NULL REFERENCES flights(flight_number),
  seq                 int  NOT NULL,
  status              text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'replaced', 'cancelled')),
  PRIMARY KEY (confirmation_number, flight_number)
);

-- Duty-of-care vouchers per itinerary (MOCK_ITINERARIES[*].vouchers).
CREATE TABLE vouchers (
  scenario_key text NOT NULL,
  kind         text NOT NULL,                        -- hotel | meal | ground
  seq          int  NOT NULL,
  description  text NOT NULL,
  PRIMARY KEY (scenario_key, kind)
);

-- Compensation cases opened by issue_compensation (the demo keeps compensation_case_id + vouchers on the context).
CREATE TABLE compensation_cases (
  case_id             text PRIMARY KEY,              -- 'CMP-1001', 'CMP-1002', ... (demo: CMP-<random 4 digits>)
  confirmation_number text NOT NULL UNIQUE REFERENCES bookings(confirmation_number),
  reason              text NOT NULL,
  vouchers            jsonb NOT NULL DEFAULT '[]'::jsonb,
  opened_at           timestamptz NOT NULL
);

-- The agent's conversation context (AirlineAgentContext.scenario / confirmation_number / flight_number), one row.
-- The demo's tools read and hydrate this context instead of taking ids as arguments (cancel_flight() takes none),
-- so it is part of the world state. Starts empty, like create_initial_context().
CREATE TABLE agent_context (
  id                  int PRIMARY KEY CHECK (id = 1),
  scenario            text,
  confirmation_number text,
  flight_number       text
);
