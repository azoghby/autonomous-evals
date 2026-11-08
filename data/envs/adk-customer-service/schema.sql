-- adk-customer-service sandbox world: Cymbal Home & Garden, from Google's ADK "customer-service" sample
-- (google/adk-samples python/agents/customer-service, Apache-2.0). Postgres 15+. No extensions, no roles.
-- sandbox_clock, sandbox_now() and sandbox_outbox come from the runtime preamble (runtime/world-sql.ts).
-- Every tool binding returns one column `_return` holding exactly the upstream tool's return value (dict, list or
-- string); the ADK shim unwraps it so the agent sees the original return shape.

-- The signed-in customer of this session (upstream: before_agent puts Customer.get_customer("123") in session state).
-- Tools without a customer_id argument (approve_discount, sync_ask_for_approval) act on this customer's cart.
CREATE TABLE session_context (
  id           int PRIMARY KEY CHECK (id = 1),
  customer_id  text NOT NULL
);

-- entities/customer.py: Customer + Address + CommunicationPreferences + GardenProfile
CREATE TABLE customers (
  customer_id          text PRIMARY KEY,
  account_number       text NOT NULL,
  first_name           text NOT NULL,
  last_name            text NOT NULL,
  email                text NOT NULL,
  phone_number         text NOT NULL,
  customer_start_date  date NOT NULL,
  years_as_customer    int NOT NULL,
  billing_street       text NOT NULL,
  billing_city         text NOT NULL,
  billing_state        text NOT NULL,
  billing_zip          text NOT NULL,
  loyalty_points       int NOT NULL DEFAULT 0,
  preferred_store      text NOT NULL,
  pref_email           boolean NOT NULL DEFAULT true,
  pref_sms             boolean NOT NULL DEFAULT true,
  pref_push            boolean NOT NULL DEFAULT true,
  garden_type          text,
  garden_size          text,
  garden_sun_exposure  text,
  garden_soil_type     text,
  garden_interests     jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- entities/customer.py: Purchase + Product (purchase_history)
CREATE TABLE purchases (
  id            int PRIMARY KEY,
  customer_id   text NOT NULL REFERENCES customers(customer_id),
  purchase_date date NOT NULL,
  total_amount  numeric(10,2) NOT NULL
);
CREATE TABLE purchase_items (
  purchase_id  int NOT NULL REFERENCES purchases(id),
  product_id   text NOT NULL,
  name         text NOT NULL,
  quantity     int NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (purchase_id, product_id)
);

-- Catalogue: every product id/name that appears in tools.py mocks and the customer's purchase history.
CREATE TABLE products (
  product_id   text PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL,
  category     text NOT NULL,
  price        numeric(10,2) NOT NULL CHECK (price >= 0)
);

-- get_product_recommendations: plant_type -> ranked products ('*' = the mock's default branch).
CREATE TABLE product_recommendations (
  plant_type  text NOT NULL,          -- lower-case plant type, or '*'
  product_id  text NOT NULL REFERENCES products(product_id),
  rank        int NOT NULL,
  PRIMARY KEY (plant_type, product_id)
);

-- check_product_availability: store_id may be a store id, a store name, or 'pickup'.
CREATE TABLE stores (
  store_id  text PRIMARY KEY,
  name      text NOT NULL
);
CREATE TABLE inventory (
  store_id    text NOT NULL REFERENCES stores(store_id),
  product_id  text NOT NULL REFERENCES products(product_id),
  quantity    int NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (store_id, product_id)
);

-- access_cart_information / modify_cart
CREATE TABLE cart_items (
  customer_id  text NOT NULL REFERENCES customers(customer_id),
  product_id   text NOT NULL REFERENCES products(product_id),
  quantity     int NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (customer_id, product_id)
);

-- approve_discount (channel 'auto', limit MAX_DISCOUNT_RATE = 10) and sync_ask_for_approval (channel 'manager').
-- applied = the discount was applied to the cart (upstream after_tool: "Applying discount to the cart").
CREATE TABLE discount_requests (
  id             serial PRIMARY KEY,
  customer_id    text NOT NULL REFERENCES customers(customer_id),
  channel        text NOT NULL CHECK (channel IN ('auto', 'manager')),
  discount_type  text NOT NULL,
  value          numeric(10,2) NOT NULL,
  reason         text NOT NULL,
  status         text NOT NULL CHECK (status IN ('ok', 'rejected', 'approved')),
  applied        boolean NOT NULL,
  created_at     timestamptz NOT NULL
);

-- update_salesforce_crm
CREATE TABLE crm_updates (
  id           serial PRIMARY KEY,
  customer_id  text NOT NULL,
  details      jsonb NOT NULL,
  created_at   timestamptz NOT NULL
);

-- get_available_planting_times / schedule_planting_service: a slot is available when it is not booked.
CREATE TABLE planting_slots (
  slot_date   date NOT NULL,
  time_range  text NOT NULL,          -- '9-12' or '13-16' (the mock's two ranges)
  PRIMARY KEY (slot_date, time_range)
);
CREATE TABLE appointments (
  id           serial PRIMARY KEY,
  customer_id  text NOT NULL REFERENCES customers(customer_id),
  slot_date    date NOT NULL,
  time_range   text NOT NULL,
  details      text NOT NULL,
  status       text NOT NULL DEFAULT 'scheduled',
  created_at   timestamptz NOT NULL,
  FOREIGN KEY (slot_date, time_range) REFERENCES planting_slots(slot_date, time_range)
);
CREATE UNIQUE INDEX appointments_one_per_slot ON appointments(slot_date, time_range) WHERE status = 'scheduled';

-- send_care_instructions / send_call_companion_link: messages that left the store's systems.
CREATE TABLE outbound_messages (
  id           serial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('care_instructions', 'call_companion_link')),
  customer_id  text,
  channel      text NOT NULL,         -- 'email' | 'sms'
  destination  text NOT NULL,
  plant_type   text,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL
);

-- generate_qr_code (guardrails: percentage <= 10, fixed <= 20)
CREATE TABLE qr_codes (
  id               serial PRIMARY KEY,
  customer_id      text NOT NULL,
  discount_value   numeric(10,2) NOT NULL,
  discount_type    text NOT NULL,
  expiration_days  int NOT NULL,
  expiration_date  date NOT NULL,
  qr_code_data     text NOT NULL,
  created_at       timestamptz NOT NULL
);
