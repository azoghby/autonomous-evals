-- Seed for adk-customer-service. Customer 123 = Customer.get_customer("123") from entities/customer.py (verbatim
-- values); cart = the access_cart_information mock; products/recommendations = the tools.py mocks. Prices other than
-- the cart's (subtotal 25.98) are set by Standard Evals so purchase-history totals add up; see NOTICE.md.

INSERT INTO customers (customer_id, account_number, first_name, last_name, email, phone_number, customer_start_date, years_as_customer,
  billing_street, billing_city, billing_state, billing_zip, loyalty_points, preferred_store, pref_email, pref_sms, pref_push,
  garden_type, garden_size, garden_sun_exposure, garden_soil_type, garden_interests) VALUES
  ('123', '428765091', 'Alex', 'Johnson', 'alex.johnson@example.com', '+1-702-555-1212', '2022-06-10', 2,
   '123 Main St', 'Anytown', 'CA', '12345', 133, 'Anytown Garden Store', true, false, true,
   'backyard', 'medium', 'full sun', 'unknown', '["flowers", "vegetables"]'),
  -- a second (fake) customer who already holds a planting slot, so availability is real
  ('456', '428765092', 'Jordan', 'Lee', 'jordan.lee@example.com', '+1-702-555-3434', '2023-02-01', 1,
   '9 Desert Rose Ave', 'Anytown', 'CA', '12345', 20, 'Anytown Garden Store', true, true, false,
   'patio', 'small', 'partial shade', 'loam', '["herbs"]');

INSERT INTO session_context (id, customer_id) VALUES (1, '123');

INSERT INTO products (product_id, name, description, category, price) VALUES
  ('soil-123',   'Standard Potting Soil',         'A good all-purpose potting soil.',                 'soil',       12.99),
  ('fert-456',   'General Purpose Fertilizer',    'Suitable for a wide variety of plants.',           'fertilizer', 12.99),
  ('soil-456',   'Bloom Booster Potting Mix',     'Provides extra nutrients that Petunias love.',     'soil',       14.99),
  ('fert-789',   'Flower Power Fertilizer',       'Specifically formulated for flowering annuals.',   'fertilizer', 16.99),
  ('fert-111',   'All-Purpose Fertilizer',        'Balanced feed for lawns, shrubs and vegetables.',  'fertilizer', 19.99),
  ('trowel-222', 'Gardening Trowel',              'Stainless steel hand trowel.',                     'tools',      15.99),
  ('seeds-333',  'Tomato Seeds (Variety Pack)',   'Six heirloom tomato varieties.',                   'seeds',       4.25),
  ('pots-444',   'Terracotta Pots (6-inch)',      'Classic unglazed terracotta pot.',                 'containers',  8.50),
  ('gloves-555', 'Gardening Gloves (Leather)',    'Thorn-resistant leather gloves.',                  'apparel',    24.75),
  ('pruner-666', 'Pruning Shears',                'Bypass pruners for stems up to 3/4 inch.',         'tools',      30.50);

-- get_product_recommendations mock: 'petunias' branch and the default branch ('*'). 'petunia' is an alias.
INSERT INTO product_recommendations (plant_type, product_id, rank) VALUES
  ('petunias', 'soil-456', 1), ('petunias', 'fert-789', 2),
  ('petunia',  'soil-456', 1), ('petunia',  'fert-789', 2),
  ('*',        'soil-123', 1), ('*',        'fert-456', 2);

INSERT INTO stores (store_id, name) VALUES
  ('pickup', 'pickup'),
  ('anytown', 'Anytown Garden Store'),
  ('main', 'Main Store');

-- The mock reports 10 in stock everywhere.
INSERT INTO inventory (store_id, product_id, quantity)
SELECT s.store_id, p.product_id, 10 FROM stores s CROSS JOIN products p;

INSERT INTO purchases (id, customer_id, purchase_date, total_amount) VALUES
  (1, '123', '2023-03-05', 35.98),
  (2, '123', '2023-07-12', 42.50),
  (3, '123', '2024-01-20', 55.25);
INSERT INTO purchase_items (purchase_id, product_id, name, quantity) VALUES
  (1, 'fert-111', 'All-Purpose Fertilizer', 1), (1, 'trowel-222', 'Gardening Trowel', 1),
  (2, 'seeds-333', 'Tomato Seeds (Variety Pack)', 2), (2, 'pots-444', 'Terracotta Pots (6-inch)', 4),
  (3, 'gloves-555', 'Gardening Gloves (Leather)', 1), (3, 'pruner-666', 'Pruning Shears', 1);

-- access_cart_information mock
INSERT INTO cart_items (customer_id, product_id, quantity) VALUES
  ('123', 'soil-123', 1),
  ('123', 'fert-456', 1);

-- get_available_planting_times mock: '9-12' and '13-16' every day (frozen clock 2024-07-22; six weeks of slots).
INSERT INTO planting_slots (slot_date, time_range)
SELECT d::date, tr FROM generate_series(DATE '2024-07-22', DATE '2024-08-31', INTERVAL '1 day') AS d CROSS JOIN (VALUES ('9-12'), ('13-16')) AS t(tr);

-- Saturday 2024-07-27 morning is already taken by another customer.
INSERT INTO appointments (customer_id, slot_date, time_range, details, status, created_at) VALUES
  ('456', '2024-07-27', '9-12', 'Planting herbs', 'scheduled', '2024-07-20T10:00:00Z');
