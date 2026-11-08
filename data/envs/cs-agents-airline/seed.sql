-- Seed = MOCK_ITINERARIES from openai-cs-agents-demo python-backend/airline/demo_data.py (verbatim values).
INSERT INTO bookings (confirmation_number, scenario_key, itinerary_name, passenger_name, seat_number, baggage_tag, status, special_service_note, rebook_note) VALUES
  ('IR-D204', 'disrupted', 'Paris to New York to Austin', 'Morgan Lee', '14C', 'BG20488', 'confirmed', NULL, 'These options arrive in Austin the next day. Overnight hotel and meals are covered.'),
  ('LL0EZ6',  'on_time',   'On-time commuter flight',     'Taylor Lee', '23A', 'BG55678', 'confirmed', NULL, NULL);

INSERT INTO flights (flight_number, scenario_key, kind, seq, origin, destination, departure, arrival, status, gate, impact_note, seat, seat_label, note) VALUES
  ('PA441',   'disrupted', 'segment',       1, 'Paris (CDG)',         'New York (JFK)',     '2024-12-09 14:10', '2024-12-09 17:40', 'Delayed 5 hours due to weather, expected departure 19:55', 'B18', 'This delay will cause a missed connection to NY802. Reaccommodation is recommended.', NULL, NULL, NULL),
  ('NY802',   'disrupted', 'segment',       2, 'New York (JFK)',      'Austin (AUS)',       '2024-12-09 19:10', '2024-12-09 22:35', 'Connection missed because of first leg delay', 'C7', NULL, NULL, NULL, NULL),
  ('NY950',   'disrupted', 'rebook_option', 1, 'New York (JFK)',      'Austin (AUS)',       '2024-12-10 09:45', '2024-12-10 12:30', NULL, NULL, NULL, '2A', '2A (front row)', 'Partner flight secured with auto-reaccommodation for disrupted travelers'),
  ('NY982',   'disrupted', 'rebook_option', 2, 'New York (JFK)',      'Austin (AUS)',       '2024-12-10 13:20', '2024-12-10 16:05', NULL, NULL, NULL, '3C', '3C', 'Backup option if the morning flight is full'),
  ('FLT-123', 'on_time',   'segment',       1, 'San Francisco (SFO)', 'Los Angeles (LAX)',  '2024-12-09 16:10', '2024-12-09 17:35', 'On time and operating as scheduled', 'A10', NULL, NULL, NULL, NULL);

INSERT INTO booking_segments (confirmation_number, flight_number, seq, status) VALUES
  ('IR-D204', 'PA441',   1, 'confirmed'),
  ('IR-D204', 'NY802',   2, 'confirmed'),
  ('LL0EZ6',  'FLT-123', 1, 'confirmed');

INSERT INTO vouchers (scenario_key, kind, seq, description) VALUES
  ('disrupted', 'hotel',  1, 'Overnight hotel covered up to $180 near JFK Terminal 5 partner hotel'),
  ('disrupted', 'meal',   2, '$60 meal credit for the delay'),
  ('disrupted', 'ground', 3, '$40 ground transport credit to the hotel');

INSERT INTO agent_context (id, scenario, confirmation_number, flight_number) VALUES (1, NULL, NULL, NULL);
