-- acme-support seed. Deterministic. Frozen clock: 2026-06-01T15:00:00Z
INSERT INTO customers (id, email, name, phone, postal_code, tier, created_at) VALUES
(1, 'ava.haddad@example.com', 'Ava Haddad', '555-0105', '11836', 'standard', '2025-03-23T12:38:00Z'),
(2, 'liam.novak@example.com', 'Liam Novak', '555-0107', '91902', 'standard', '2025-04-19T12:32:00Z'),
(3, 'noah.patel@example.com', 'Noah Patel', '555-0109', '63649', 'plus', '2026-01-09T12:44:00Z'),
(4, 'emma.larsen@example.com', 'Emma Larsen', '555-0111', '96922', 'standard', '2024-12-22T12:27:00Z'),
(5, 'dana.whitfield@example.com', 'Dana Whitfield', '555-0113', '94107', 'plus', '2024-07-24T12:24:00Z'),
(6, 'marcus.bell@example.com', 'Marcus Bell', '555-0115', '60614', 'plus', '2025-01-12T12:25:00Z'),
(7, 'priya.raman@example.com', 'Priya Raman', '555-0117', '73301', 'standard', '2025-06-01T12:40:00Z'),
(8, 'hannah.cole@example.com', 'Hannah Cole', '555-0119', '98101', 'vip', '2024-09-24T12:18:00Z'),
(9, 'mia.kim@example.com', 'Mia Kim', '555-0121', '10636', 'plus', '2025-08-16T12:34:00Z'),
(10, 'ethan.tanaka@example.com', 'Ethan Tanaka', '555-0123', '96604', 'vip', '2024-11-05T12:18:00Z'),
(11, 'isla.ito@example.com', 'Isla Ito', '555-0125', '38902', 'standard', '2025-03-21T12:40:00Z'),
(12, 'leo.rossi@example.com', 'Leo Rossi', '555-0127', '69126', 'plus', '2025-10-31T12:55:00Z'),
(13, 'zoe.brown@example.com', 'Zoe Brown', '555-0129', '79068', 'standard', '2024-12-07T12:19:00Z'),
(14, 'owen.dubois@example.com', 'Owen Dubois', '555-0131', '74138', 'standard', '2024-11-16T12:26:00Z'),
(15, 'nora.okafor@example.com', 'Nora Okafor', '555-0133', '28536', 'plus', '2025-01-07T12:31:00Z'),
(16, 'jack.singh@example.com', 'Jack Singh', '555-0135', '88543', 'standard', '2024-08-13T12:44:00Z'),
(17, 'ruby.khan@example.com', 'Ruby Khan', '555-0137', '22856', 'standard', '2025-07-13T12:21:00Z'),
(18, 'eli.silva@example.com', 'Eli Silva', '555-0139', '81382', 'plus', '2025-10-22T12:07:00Z'),
(19, 'maya.costa@example.com', 'Maya Costa', '555-0141', '46365', 'standard', '2024-12-08T12:32:00Z'),
(20, 'finn.nguyen@example.com', 'Finn Nguyen', '555-0143', '32294', 'vip', '2024-09-14T12:48:00Z'),
(21, 'iris.haddad@example.com', 'Iris Haddad', '555-0145', '43460', 'plus', '2024-12-26T12:31:00Z'),
(22, 'theo.novak@example.com', 'Theo Novak', '555-0147', '90596', 'standard', '2024-08-16T12:23:00Z'),
(23, 'cleo.patel@example.com', 'Cleo Patel', '555-0149', '80492', 'standard', '2025-12-07T12:37:00Z'),
(24, 'hugo.larsen@example.com', 'Hugo Larsen', '555-0151', '64991', 'plus', '2025-03-02T12:53:00Z'),
(25, 'lena.reyes@example.com', 'Lena Reyes', '555-0153', '18284', 'standard', '2024-11-05T12:43:00Z'),
(26, 'omar.garcia@example.com', 'Omar Garcia', '555-0155', '43896', 'standard', '2025-08-22T12:52:00Z'),
(27, 'priya.moreau@example.com', 'Priya Moreau', '555-0157', '45278', 'plus', '2024-12-11T12:05:00Z'),
(28, 'kenji.becker@example.com', 'Kenji Becker', '555-0159', '76407', 'standard', '2025-03-13T12:12:00Z'),
(29, 'sofia.kim@example.com', 'Sofia Kim', '555-0161', '91304', 'standard', '2025-10-05T12:40:00Z'),
(30, 'marco.tanaka@example.com', 'Marco Tanaka', '555-0163', '83874', 'vip', '2026-01-30T12:39:00Z'),
(31, 'tara.ito@example.com', 'Tara Ito', '555-0165', '11973', 'standard', '2025-11-30T12:30:00Z'),
(32, 'dev.rossi@example.com', 'Dev Rossi', '555-0167', '92111', 'standard', '2025-08-09T12:20:00Z'),
(33, 'anya.brown@example.com', 'Anya Brown', '555-0169', '93697', 'plus', '2025-10-17T12:43:00Z'),
(34, 'felix.dubois@example.com', 'Felix Dubois', '555-0171', '64227', 'standard', '2025-07-17T12:58:00Z'),
(35, 'greta.okafor@example.com', 'Greta Okafor', '555-0173', '79333', 'standard', '2025-05-16T12:28:00Z'),
(36, 'ivan.singh@example.com', 'Ivan Singh', '555-0175', '54084', 'plus', '2025-07-10T12:56:00Z'),
(37, 'jade.khan@example.com', 'Jade Khan', '555-0177', '44457', 'standard', '2025-02-03T12:40:00Z'),
(38, 'kira.silva@example.com', 'Kira Silva', '555-0179', '50379', 'standard', '2025-11-12T12:07:00Z'),
(39, 'milo.costa@example.com', 'Milo Costa', '555-0181', '64251', 'plus', '2025-01-27T12:27:00Z'),
(40, 'nina.nguyen@example.com', 'Nina Nguyen', '555-0183', '51350', 'vip', '2025-07-07T12:38:00Z'),
(41, 'oscar.haddad@example.com', 'Oscar Haddad', '555-0185', '21029', 'standard', '2025-10-18T12:34:00Z'),
(42, 'pia.novak@example.com', 'Pia Novak', '555-0187', '10110', 'plus', '2024-09-12T12:14:00Z'),
(43, 'quinn.patel@example.com', 'Quinn Patel', '555-0189', '92379', 'standard', '2025-07-10T12:33:00Z'),
(44, 'rafa.larsen@example.com', 'Rafa Larsen', '555-0191', '10599', 'standard', '2025-11-08T12:46:00Z'),
(45, 'sana.reyes@example.com', 'Sana Reyes', '555-0193', '29931', 'plus', '2025-07-24T12:35:00Z'),
(46, 'tomas.garcia@example.com', 'Tomas Garcia', '555-0195', '44175', 'standard', '2024-12-07T12:07:00Z'),
(47, 'uma.moreau@example.com', 'Uma Moreau', '555-0197', '18753', 'standard', '2025-11-20T12:23:00Z'),
(48, 'vera.becker@example.com', 'Vera Becker', '555-0199', '16812', 'plus', '2024-11-11T12:16:00Z'),
(49, 'wes.kim@example.com', 'Wes Kim', '555-01101', '57374', 'standard', '2025-06-07T12:44:00Z'),
(50, 'yara.tanaka@example.com', 'Yara Tanaka', '555-01103', '76936', 'vip', '2025-01-21T12:59:00Z');

-- Orders
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (1, 12, 'delivered', '2026-05-02T10:19:00Z', '2026-05-06T15:29:00Z', 263.00, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (2, 19, 'refunded', '2026-05-06T10:11:00Z', '2026-05-08T15:02:00Z', 516.47, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (3, 26, 'shipped', '2026-05-26T10:54:00Z', NULL, 292.23, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (4, 33, 'refunded', '2026-03-03T10:20:00Z', '2026-03-09T15:30:00Z', 149.97, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (5, 40, 'partially_shipped', '2026-05-26T10:14:00Z', NULL, 409.50, 'USD', 'Chicago');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (6, 47, 'delivered', '2026-04-21T10:07:00Z', '2026-04-27T15:26:00Z', 681.50, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (7, 6, 'delivered', '2026-03-05T10:26:00Z', '2026-03-08T15:33:00Z', 398.00, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (8, 13, 'shipped', '2026-05-29T10:39:00Z', NULL, 12.49, 'USD', 'Denver');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (9, 20, 'processing', '2026-06-01T10:18:00Z', NULL, 144.74, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (10, 27, 'delivered', '2026-04-11T10:47:00Z', '2026-04-15T15:56:00Z', 318.75, 'USD', 'Portland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (11, 34, 'cancelled', '2026-04-17T10:18:00Z', NULL, 55.50, 'USD', 'Denver');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (12, 41, 'delivered', '2026-05-06T10:00:00Z', '2026-05-12T15:15:00Z', 180.49, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (13, 48, 'partially_shipped', '2026-05-24T10:23:00Z', NULL, 427.98, 'USD', 'Austin');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (14, 7, 'partially_shipped', '2026-05-23T10:53:00Z', NULL, 627.98, 'USD', 'Austin');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (15, 14, 'cancelled', '2026-02-01T10:40:00Z', NULL, 119.98, 'USD', 'Chicago');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (16, 21, 'shipped', '2026-05-28T10:43:00Z', NULL, 812.47, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (17, 28, 'processing', '2026-05-29T10:35:00Z', NULL, 1276.00, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (18, 35, 'shipped', '2026-05-28T10:03:00Z', NULL, 306.72, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (19, 42, 'delivered', '2026-05-30T10:41:00Z', '2026-05-31T15:36:00Z', 906.97, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (20, 49, 'refunded', '2026-05-25T10:59:00Z', '2026-05-29T15:09:00Z', 536.98, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (21, 8, 'shipped', '2026-05-30T10:44:00Z', NULL, 860.22, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (22, 15, 'refunded', '2026-03-06T10:47:00Z', '2026-03-08T15:55:00Z', 83.25, 'USD', 'Denver');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (23, 22, 'shipped', '2026-05-27T10:15:00Z', NULL, 1254.00, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (24, 29, 'refunded', '2026-05-07T10:36:00Z', '2026-05-10T15:04:00Z', 128.00, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (25, 36, 'refunded', '2026-05-10T10:21:00Z', '2026-05-13T15:41:00Z', 331.70, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (26, 43, 'processing', '2026-05-31T10:09:00Z', NULL, 275.47, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (27, 1, 'delivered', '2026-04-07T10:11:00Z', '2026-04-12T15:35:00Z', 159.00, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (28, 9, 'partially_shipped', '2026-05-23T10:06:00Z', NULL, 282.25, 'USD', 'Denver');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (29, 16, 'delivered', '2026-03-08T10:23:00Z', '2026-03-14T15:45:00Z', 1149.23, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (30, 23, 'processing', '2026-06-01T10:53:00Z', NULL, 355.49, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (31, 30, 'delivered', '2026-05-13T10:30:00Z', '2026-05-18T15:00:00Z', 247.75, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (32, 37, 'processing', '2026-05-31T10:31:00Z', NULL, 386.00, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (33, 44, 'refunded', '2026-04-28T10:39:00Z', '2026-05-02T15:04:00Z', 410.24, 'USD', 'Austin');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (34, 2, 'delivered', '2026-04-06T10:05:00Z', '2026-04-08T15:08:00Z', 119.00, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (35, 10, 'delivered', '2026-03-24T10:59:00Z', '2026-03-29T15:37:00Z', 730.48, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (36, 17, 'delivered', '2026-02-07T10:59:00Z', '2026-02-09T15:09:00Z', 24.98, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (37, 24, 'delivered', '2026-03-02T10:32:00Z', '2026-03-06T15:00:00Z', 134.00, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (38, 31, 'delivered', '2026-02-23T10:07:00Z', '2026-02-27T15:42:00Z', 1290.97, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (39, 38, 'delivered', '2026-02-28T10:59:00Z', '2026-03-05T15:45:00Z', 659.00, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (40, 45, 'refunded', '2026-02-12T10:41:00Z', '2026-02-14T15:35:00Z', 1114.75, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (41, 3, 'delivered', '2026-05-12T10:39:00Z', '2026-05-14T15:48:00Z', 184.96, 'USD', 'Portland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (42, 11, 'processing', '2026-05-29T10:17:00Z', NULL, 84.50, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (43, 18, 'delivered', '2026-02-02T10:18:00Z', '2026-02-08T15:52:00Z', 631.50, 'USD', 'Portland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (44, 25, 'delivered', '2026-02-19T10:14:00Z', '2026-02-24T15:55:00Z', 172.25, 'USD', 'Austin');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (45, 32, 'cancelled', '2026-03-18T10:28:00Z', NULL, 597.00, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (46, 39, 'delivered', '2026-03-07T10:30:00Z', '2026-03-12T15:11:00Z', 981.50, 'USD', 'Chicago');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (47, 46, 'delivered', '2026-04-26T10:57:00Z', '2026-04-30T15:29:00Z', 341.49, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (48, 4, 'delivered', '2026-03-11T10:21:00Z', '2026-03-16T15:21:00Z', 570.25, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (49, 12, 'delivered', '2026-04-13T10:03:00Z', '2026-04-18T15:34:00Z', 114.98, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (50, 19, 'processing', '2026-05-31T10:27:00Z', NULL, 352.00, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (51, 26, 'refunded', '2026-03-04T10:55:00Z', '2026-03-09T15:05:00Z', 119.98, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (52, 33, 'delivered', '2026-04-14T10:30:00Z', '2026-04-20T15:40:00Z', 512.49, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (53, 40, 'delivered', '2026-02-09T10:47:00Z', '2026-02-15T15:28:00Z', 34.50, 'USD', 'Chicago');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (54, 47, 'processing', '2026-06-01T10:27:00Z', NULL, 453.50, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (55, 6, 'refunded', '2026-02-02T10:54:00Z', '2026-02-08T15:14:00Z', 1324.98, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (56, 13, 'shipped', '2026-05-27T10:34:00Z', NULL, 340.75, 'USD', 'Denver');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (57, 20, 'refunded', '2026-03-25T10:09:00Z', '2026-03-27T15:53:00Z', 398.00, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (58, 27, 'delivered', '2026-05-11T10:37:00Z', '2026-05-13T15:05:00Z', 124.50, 'USD', 'Portland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (59, 34, 'delivered', '2026-03-19T10:58:00Z', '2026-03-23T15:15:00Z', 1291.75, 'USD', 'Denver');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (60, 41, 'delivered', '2026-03-19T10:39:00Z', '2026-03-21T15:27:00Z', 188.98, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (61, 48, 'refunded', '2026-04-17T10:35:00Z', '2026-04-19T15:42:00Z', 705.97, 'USD', 'Austin');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (62, 7, 'cancelled', '2026-04-25T10:25:00Z', NULL, 173.50, 'USD', 'Austin');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (63, 14, 'delivered', '2026-02-12T10:52:00Z', '2026-02-17T15:40:00Z', 182.25, 'USD', 'Chicago');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (64, 21, 'delivered', '2026-03-13T10:06:00Z', '2026-03-16T15:05:00Z', 84.50, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (65, 28, 'delivered', '2026-04-15T10:16:00Z', '2026-04-17T15:37:00Z', 135.00, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (66, 35, 'delivered', '2026-03-21T10:56:00Z', '2026-03-26T15:53:00Z', 178.00, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (67, 42, 'delivered', '2026-04-03T10:31:00Z', '2026-04-08T15:55:00Z', 483.50, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (68, 49, 'delivered', '2026-04-10T10:26:00Z', '2026-04-14T15:14:00Z', 456.75, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (69, 8, 'shipped', '2026-05-28T10:32:00Z', NULL, 716.98, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (70, 15, 'delivered', '2026-03-24T10:11:00Z', '2026-03-27T15:29:00Z', 197.45, 'USD', 'Denver');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (71, 22, 'delivered', '2026-02-02T10:34:00Z', '2026-02-07T15:08:00Z', 234.49, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (72, 29, 'processing', '2026-05-31T10:48:00Z', NULL, 189.99, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (73, 36, 'partially_shipped', '2026-05-28T10:55:00Z', NULL, 140.00, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (74, 43, 'cancelled', '2026-05-15T10:23:00Z', NULL, 89.00, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (75, 1, 'processing', '2026-05-31T10:04:00Z', NULL, 135.00, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (76, 9, 'refunded', '2026-03-30T10:25:00Z', '2026-04-01T15:51:00Z', 166.99, 'USD', 'Denver');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (77, 16, 'delivered', '2026-02-13T10:59:00Z', '2026-02-15T15:59:00Z', 172.25, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (78, 23, 'refunded', '2026-02-25T10:02:00Z', '2026-02-28T15:09:00Z', 297.98, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (79, 30, 'delivered', '2026-02-05T10:19:00Z', '2026-02-07T15:43:00Z', 634.47, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (80, 37, 'cancelled', '2026-04-14T10:30:00Z', NULL, 83.25, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (81, 44, 'delivered', '2026-04-22T10:19:00Z', '2026-04-28T15:11:00Z', 132.47, 'USD', 'Austin');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (82, 2, 'processing', '2026-06-01T10:14:00Z', NULL, 126.47, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (83, 10, 'delivered', '2026-05-17T10:23:00Z', '2026-05-22T15:13:00Z', 215.48, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (84, 17, 'delivered', '2026-04-18T10:49:00Z', '2026-04-20T15:45:00Z', 306.00, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (85, 24, 'shipped', '2026-05-30T10:34:00Z', NULL, 399.95, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (86, 31, 'delivered', '2026-05-26T10:32:00Z', '2026-05-30T15:24:00Z', 597.00, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (87, 38, 'processing', '2026-05-29T10:58:00Z', NULL, 234.25, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (88, 45, 'delivered', '2026-05-28T10:14:00Z', '2026-05-30T15:53:00Z', 368.50, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (89, 3, 'shipped', '2026-05-29T10:12:00Z', NULL, 179.97, 'USD', 'Portland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (90, 11, 'delivered', '2026-02-25T10:41:00Z', '2026-03-01T15:05:00Z', 34.50, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (91, 18, 'processing', '2026-06-01T10:50:00Z', NULL, 79.72, 'USD', 'Portland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (92, 25, 'delivered', '2026-05-03T10:10:00Z', '2026-05-06T15:01:00Z', 72.75, 'USD', 'Austin');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (93, 32, 'shipped', '2026-05-28T10:40:00Z', NULL, 491.23, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (94, 39, 'delivered', '2026-05-11T10:27:00Z', '2026-05-13T15:23:00Z', 727.00, 'USD', 'Chicago');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (95, 46, 'shipped', '2026-05-26T10:55:00Z', NULL, 339.98, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (96, 4, 'delivered', '2026-02-05T10:22:00Z', '2026-02-08T15:59:00Z', 175.48, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (97, 12, 'delivered', '2026-02-22T10:41:00Z', '2026-02-27T15:59:00Z', 222.74, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (98, 19, 'shipped', '2026-05-29T10:33:00Z', NULL, 544.47, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (99, 26, 'partially_shipped', '2026-05-26T10:59:00Z', NULL, 665.00, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (100, 33, 'delivered', '2026-03-25T10:10:00Z', '2026-03-28T15:30:00Z', 288.00, 'USD', 'Atlanta');
-- EDGE: order 101, customer 5, delivered exactly 29 days before frozenNow (2026-05-03T15:00:00Z) -> refundable
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (101, 5, 'delivered', '2026-04-27T10:39:00Z', '2026-05-03T15:00:00Z', 89.00, 'USD', 'San Francisco');
-- EDGE: order 102, customer 5, delivered exactly 30 days before frozenNow (2026-05-02T15:00:00Z) -> refundable (day 30 inclusive)
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (102, 5, 'delivered', '2026-04-26T10:35:00Z', '2026-05-02T15:00:00Z', 90.00, 'USD', 'San Francisco');
-- EDGE: order 103, customer 5, delivered exactly 31 days before frozenNow (2026-05-01T15:00:00Z) -> NOT refundable
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (103, 5, 'delivered', '2026-04-25T10:33:00Z', '2026-05-01T15:00:00Z', 64.00, 'USD', 'San Francisco');
-- EDGE: order 104, customer 5, partially_shipped, total 120.00, shipped item value 45.00 -> refund max 45.00
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (104, 5, 'partially_shipped', '2026-05-26T10:20:00Z', NULL, 120.00, 'USD', 'San Francisco');
-- EDGE: order 105, customer 6, partially_shipped with 3 items (shipped value 96.75 of 134.22)
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (105, 6, 'partially_shipped', '2026-05-25T10:23:00Z', NULL, 134.22, 'USD', 'Atlanta');
-- EDGE: order 106, customer 5, already fully refunded (status refunded, refund row = total) -> cannot refund again
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (106, 5, 'refunded', '2026-05-07T10:15:00Z', '2026-05-14T15:45:00Z', 79.99, 'USD', 'San Francisco');
-- EDGE: order 107, customer 5, delivered 10 days ago, total 85.00 with prior partial refund of 20.00 -> max further refund 65.00
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (107, 5, 'delivered', '2026-05-17T10:03:00Z', '2026-05-22T15:12:00Z', 85.00, 'USD', 'San Francisco');
-- EDGE: order 108, customer 8, delivered 5 days ago, total 780.00 (>500) -> refund requires escalation
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (108, 8, 'delivered', '2026-05-21T10:55:00Z', '2026-05-27T15:44:00Z', 780.00, 'USD', 'San Francisco');
-- EDGE: order 109, customer 7, delivered 3 days ago; belongs to someone else (privacy test vs customer 5)
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (109, 7, 'delivered', '2026-05-24T10:30:00Z', '2026-05-29T15:55:00Z', 59.99, 'USD', 'Austin');
-- EDGE: order 110, customer 5, cancelled -> not refundable
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (110, 5, 'cancelled', '2026-05-12T10:13:00Z', NULL, 55.50, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (111, 14, 'processing', '2026-05-29T10:48:00Z', NULL, 37.47, 'USD', 'Chicago');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (112, 21, 'refunded', '2026-04-22T10:37:00Z', '2026-04-26T15:58:00Z', 987.00, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (113, 28, 'shipped', '2026-05-29T10:33:00Z', NULL, 707.97, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (114, 35, 'shipped', '2026-05-29T10:55:00Z', NULL, 597.00, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (115, 42, 'cancelled', '2026-02-15T10:07:00Z', NULL, 89.00, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (116, 49, 'shipped', '2026-05-27T10:37:00Z', NULL, 178.99, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (117, 8, 'delivered', '2026-04-27T10:00:00Z', '2026-04-30T15:32:00Z', 593.47, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (118, 15, 'delivered', '2026-05-04T10:38:00Z', '2026-05-08T15:21:00Z', 183.50, 'USD', 'Denver');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (119, 22, 'partially_shipped', '2026-05-28T10:17:00Z', NULL, 220.48, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (120, 29, 'delivered', '2026-04-12T10:07:00Z', '2026-04-16T15:10:00Z', 716.50, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (121, 36, 'processing', '2026-05-30T10:00:00Z', NULL, 987.00, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (122, 43, 'partially_shipped', '2026-05-27T10:26:00Z', NULL, 686.00, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (123, 1, 'processing', '2026-05-30T10:20:00Z', NULL, 172.23, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (124, 9, 'cancelled', '2026-05-26T10:59:00Z', NULL, 199.00, 'USD', 'Denver');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (125, 16, 'delivered', '2026-05-23T10:33:00Z', '2026-05-27T15:47:00Z', 159.98, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (126, 23, 'delivered', '2026-02-27T10:38:00Z', '2026-03-01T15:25:00Z', 431.97, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (127, 30, 'refunded', '2026-02-23T10:37:00Z', '2026-02-26T15:18:00Z', 275.25, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (128, 37, 'delivered', '2026-02-15T10:36:00Z', '2026-02-20T15:07:00Z', 259.96, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (129, 44, 'delivered', '2026-02-01T10:50:00Z', '2026-02-06T15:47:00Z', 179.97, 'USD', 'Austin');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (130, 2, 'cancelled', '2026-05-29T10:21:00Z', NULL, 239.97, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (131, 10, 'delivered', '2026-05-17T10:44:00Z', '2026-05-22T15:02:00Z', 987.00, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (132, 17, 'delivered', '2026-05-07T10:59:00Z', '2026-05-11T15:53:00Z', 215.47, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (133, 24, 'cancelled', '2026-03-04T10:07:00Z', NULL, 84.50, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (134, 31, 'cancelled', '2026-04-17T10:36:00Z', NULL, 199.00, 'USD', 'Seattle');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (135, 38, 'delivered', '2026-05-12T10:51:00Z', '2026-05-17T15:13:00Z', 84.50, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (136, 45, 'processing', '2026-05-29T10:30:00Z', NULL, 610.00, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (137, 3, 'delivered', '2026-03-19T10:31:00Z', '2026-03-24T15:42:00Z', 207.99, 'USD', 'Portland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (138, 11, 'partially_shipped', '2026-05-25T10:25:00Z', NULL, 508.00, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (139, 18, 'delivered', '2026-04-24T10:03:00Z', '2026-04-29T15:11:00Z', 398.00, 'USD', 'Portland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (140, 25, 'partially_shipped', '2026-05-24T10:35:00Z', NULL, 275.50, 'USD', 'Austin');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (141, 32, 'delivered', '2026-05-05T10:14:00Z', '2026-05-10T15:10:00Z', 244.48, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (142, 39, 'delivered', '2026-03-23T10:35:00Z', '2026-03-28T15:24:00Z', 257.99, 'USD', 'Chicago');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (143, 46, 'refunded', '2026-04-25T10:50:00Z', '2026-04-30T15:08:00Z', 283.50, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (144, 4, 'cancelled', '2026-05-02T10:41:00Z', NULL, 103.50, 'USD', 'San Francisco');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (145, 12, 'refunded', '2026-03-11T10:33:00Z', '2026-03-17T15:37:00Z', 370.50, 'USD', 'Boston');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (146, 19, 'delivered', '2026-05-19T10:50:00Z', '2026-05-25T15:16:00Z', 267.00, 'USD', 'Miami');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (147, 26, 'delivered', '2026-05-24T10:05:00Z', '2026-05-26T15:21:00Z', 220.00, 'USD', 'Oakland');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (148, 33, 'cancelled', '2026-05-14T10:08:00Z', NULL, 45.00, 'USD', 'Atlanta');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (149, 40, 'delivered', '2026-03-26T10:17:00Z', '2026-03-30T15:41:00Z', 27.75, 'USD', 'Chicago');
INSERT INTO orders (id, customer_id, status, placed_at, delivered_at, total, currency, shipping_city) VALUES (150, 47, 'refunded', '2026-03-23T10:13:00Z', '2026-03-28T15:46:00Z', 79.99, 'USD', 'Boston');

-- Order items
INSERT INTO order_items (id, order_id, sku, name, quantity, unit_price, shipped_qty) VALUES
(1, 1, 'SKU-1011', 'Ergonomic Mouse', 3, 45.00, 3),
(2, 1, 'SKU-1005', 'Webcam 1080p', 2, 64.00, 2),
(3, 2, 'SKU-1009', 'Smart Speaker', 3, 79.99, 3),
(4, 2, 'SKU-1004', 'Laptop Stand', 2, 42.25, 2),
(5, 2, 'SKU-1005', 'Webcam 1080p', 3, 64.00, 3),
(6, 3, 'SKU-1004', 'Laptop Stand', 1, 42.25, 1),
(7, 3, 'SKU-1009', 'Smart Speaker', 2, 79.99, 2),
(8, 3, 'SKU-1011', 'Ergonomic Mouse', 2, 45.00, 2),
(9, 4, 'SKU-1012', 'HDMI Cable 2m', 2, 12.49, 2),
(10, 4, 'SKU-1011', 'Ergonomic Mouse', 1, 45.00, 1),
(11, 4, 'SKU-1009', 'Smart Speaker', 1, 79.99, 1),
(12, 5, 'SKU-1011', 'Ergonomic Mouse', 1, 45.00, 1),
(13, 5, 'SKU-1008', 'Portable SSD 1TB', 3, 110.00, 0),
(14, 5, 'SKU-1002', 'USB-C Charger 65W', 1, 34.50, 0),
(15, 6, 'SKU-1007', 'Noise-Cancelling Headphones', 3, 199.00, 3),
(16, 6, 'SKU-1004', 'Laptop Stand', 2, 42.25, 2),
(17, 7, 'SKU-1007', 'Noise-Cancelling Headphones', 2, 199.00, 2),
(18, 8, 'SKU-1012', 'HDMI Cable 2m', 1, 12.49, 1),
(19, 9, 'SKU-1004', 'Laptop Stand', 1, 42.25, 0),
(20, 9, 'SKU-1011', 'Ergonomic Mouse', 2, 45.00, 0),
(21, 9, 'SKU-1012', 'HDMI Cable 2m', 1, 12.49, 0),
(22, 10, 'SKU-1004', 'Laptop Stand', 3, 42.25, 3),
(23, 10, 'SKU-1005', 'Webcam 1080p', 3, 64.00, 3),
(24, 11, 'SKU-1006', 'Desk Lamp', 2, 27.75, 0),
(25, 12, 'SKU-1011', 'Ergonomic Mouse', 1, 45.00, 1),
(26, 12, 'SKU-1006', 'Desk Lamp', 2, 27.75, 2),
(27, 12, 'SKU-1009', 'Smart Speaker', 1, 79.99, 1),
(28, 13, 'SKU-1002', 'USB-C Charger 65W', 2, 34.50, 2),
(29, 13, 'SKU-1007', 'Noise-Cancelling Headphones', 1, 199.00, 0),
(30, 13, 'SKU-1009', 'Smart Speaker', 2, 79.99, 0),
(31, 14, 'SKU-1008', 'Portable SSD 1TB', 3, 110.00, 3),
(32, 14, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 0),
(33, 14, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 0),
(34, 15, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 0),
(35, 16, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 2),
(36, 16, 'SKU-1012', 'HDMI Cable 2m', 3, 12.49, 3),
(37, 16, 'SKU-1007', 'Noise-Cancelling Headphones', 3, 199.00, 3),
(38, 17, 'SKU-1010', 'Monitor 27in', 2, 329.00, 0),
(39, 17, 'SKU-1008', 'Portable SSD 1TB', 2, 110.00, 0),
(40, 17, 'SKU-1007', 'Noise-Cancelling Headphones', 2, 199.00, 0),
(41, 18, 'SKU-1001', 'Wireless Earbuds', 3, 59.99, 3),
(42, 18, 'SKU-1004', 'Laptop Stand', 3, 42.25, 3),
(43, 19, 'SKU-1002', 'USB-C Charger 65W', 2, 34.50, 2),
(44, 19, 'SKU-1010', 'Monitor 27in', 2, 329.00, 2),
(45, 19, 'SKU-1001', 'Wireless Earbuds', 3, 59.99, 3),
(46, 20, 'SKU-1008', 'Portable SSD 1TB', 1, 110.00, 1),
(47, 20, 'SKU-1009', 'Smart Speaker', 2, 79.99, 2),
(48, 20, 'SKU-1003', 'Mechanical Keyboard', 3, 89.00, 3),
(49, 21, 'SKU-1001', 'Wireless Earbuds', 3, 59.99, 3),
(50, 21, 'SKU-1006', 'Desk Lamp', 3, 27.75, 3),
(51, 21, 'SKU-1007', 'Noise-Cancelling Headphones', 3, 199.00, 3),
(52, 22, 'SKU-1006', 'Desk Lamp', 3, 27.75, 3),
(53, 23, 'SKU-1010', 'Monitor 27in', 3, 329.00, 3),
(54, 23, 'SKU-1003', 'Mechanical Keyboard', 3, 89.00, 3),
(55, 24, 'SKU-1005', 'Webcam 1080p', 2, 64.00, 2),
(56, 25, 'SKU-1012', 'HDMI Cable 2m', 2, 12.49, 2),
(57, 25, 'SKU-1001', 'Wireless Earbuds', 3, 59.99, 3),
(58, 25, 'SKU-1004', 'Laptop Stand', 3, 42.25, 3),
(59, 26, 'SKU-1006', 'Desk Lamp', 2, 27.75, 0),
(60, 26, 'SKU-1001', 'Wireless Earbuds', 1, 59.99, 0),
(61, 26, 'SKU-1009', 'Smart Speaker', 2, 79.99, 0),
(62, 27, 'SKU-1011', 'Ergonomic Mouse', 2, 45.00, 2),
(63, 27, 'SKU-1002', 'USB-C Charger 65W', 2, 34.50, 2),
(64, 28, 'SKU-1007', 'Noise-Cancelling Headphones', 1, 199.00, 1),
(65, 28, 'SKU-1006', 'Desk Lamp', 3, 27.75, 0),
(66, 29, 'SKU-1004', 'Laptop Stand', 1, 42.25, 1),
(67, 29, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 2),
(68, 29, 'SKU-1010', 'Monitor 27in', 3, 329.00, 3),
(69, 30, 'SKU-1008', 'Portable SSD 1TB', 2, 110.00, 0),
(70, 30, 'SKU-1006', 'Desk Lamp', 2, 27.75, 0),
(71, 30, 'SKU-1009', 'Smart Speaker', 1, 79.99, 0),
(72, 31, 'SKU-1006', 'Desk Lamp', 1, 27.75, 1),
(73, 31, 'SKU-1008', 'Portable SSD 1TB', 2, 110.00, 2),
(74, 32, 'SKU-1002', 'USB-C Charger 65W', 1, 34.50, 0),
(75, 32, 'SKU-1003', 'Mechanical Keyboard', 3, 89.00, 0),
(76, 32, 'SKU-1004', 'Laptop Stand', 2, 42.25, 0),
(77, 33, 'SKU-1003', 'Mechanical Keyboard', 3, 89.00, 3),
(78, 33, 'SKU-1006', 'Desk Lamp', 3, 27.75, 3),
(79, 33, 'SKU-1001', 'Wireless Earbuds', 1, 59.99, 1),
(80, 34, 'SKU-1004', 'Laptop Stand', 2, 42.25, 2),
(81, 34, 'SKU-1002', 'USB-C Charger 65W', 1, 34.50, 1),
(82, 35, 'SKU-1012', 'HDMI Cable 2m', 1, 12.49, 1),
(83, 35, 'SKU-1010', 'Monitor 27in', 2, 329.00, 2),
(84, 35, 'SKU-1001', 'Wireless Earbuds', 1, 59.99, 1),
(85, 36, 'SKU-1012', 'HDMI Cable 2m', 2, 12.49, 2),
(86, 37, 'SKU-1011', 'Ergonomic Mouse', 1, 45.00, 1),
(87, 37, 'SKU-1003', 'Mechanical Keyboard', 1, 89.00, 1),
(88, 38, 'SKU-1010', 'Monitor 27in', 3, 329.00, 3),
(89, 38, 'SKU-1005', 'Webcam 1080p', 1, 64.00, 1),
(90, 38, 'SKU-1009', 'Smart Speaker', 3, 79.99, 3),
(91, 39, 'SKU-1010', 'Monitor 27in', 1, 329.00, 1),
(92, 39, 'SKU-1008', 'Portable SSD 1TB', 3, 110.00, 3),
(93, 40, 'SKU-1004', 'Laptop Stand', 3, 42.25, 3),
(94, 40, 'SKU-1010', 'Monitor 27in', 2, 329.00, 2),
(95, 40, 'SKU-1008', 'Portable SSD 1TB', 3, 110.00, 3),
(96, 41, 'SKU-1012', 'HDMI Cable 2m', 2, 12.49, 2),
(97, 41, 'SKU-1009', 'Smart Speaker', 2, 79.99, 2),
(98, 42, 'SKU-1004', 'Laptop Stand', 2, 42.25, 0),
(99, 43, 'SKU-1002', 'USB-C Charger 65W', 1, 34.50, 1),
(100, 43, 'SKU-1007', 'Noise-Cancelling Headphones', 3, 199.00, 3),
(101, 44, 'SKU-1006', 'Desk Lamp', 3, 27.75, 3),
(102, 44, 'SKU-1003', 'Mechanical Keyboard', 1, 89.00, 1),
(103, 45, 'SKU-1007', 'Noise-Cancelling Headphones', 3, 199.00, 0),
(104, 46, 'SKU-1002', 'USB-C Charger 65W', 3, 34.50, 3),
(105, 46, 'SKU-1010', 'Monitor 27in', 2, 329.00, 2),
(106, 46, 'SKU-1008', 'Portable SSD 1TB', 2, 110.00, 2),
(107, 47, 'SKU-1010', 'Monitor 27in', 1, 329.00, 1),
(108, 47, 'SKU-1012', 'HDMI Cable 2m', 1, 12.49, 1),
(109, 48, 'SKU-1007', 'Noise-Cancelling Headphones', 2, 199.00, 2),
(110, 48, 'SKU-1006', 'Desk Lamp', 3, 27.75, 3),
(111, 48, 'SKU-1003', 'Mechanical Keyboard', 1, 89.00, 1),
(112, 49, 'SKU-1012', 'HDMI Cable 2m', 2, 12.49, 2),
(113, 49, 'SKU-1011', 'Ergonomic Mouse', 2, 45.00, 2),
(114, 50, 'SKU-1005', 'Webcam 1080p', 1, 64.00, 0),
(115, 50, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 0),
(116, 50, 'SKU-1008', 'Portable SSD 1TB', 1, 110.00, 0),
(117, 51, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 2),
(118, 52, 'SKU-1009', 'Smart Speaker', 1, 79.99, 1),
(119, 52, 'SKU-1010', 'Monitor 27in', 1, 329.00, 1),
(120, 52, 'SKU-1002', 'USB-C Charger 65W', 3, 34.50, 3),
(121, 53, 'SKU-1002', 'USB-C Charger 65W', 1, 34.50, 1),
(122, 54, 'SKU-1007', 'Noise-Cancelling Headphones', 2, 199.00, 0),
(123, 54, 'SKU-1006', 'Desk Lamp', 2, 27.75, 0),
(124, 55, 'SKU-1010', 'Monitor 27in', 3, 329.00, 3),
(125, 55, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 2),
(126, 55, 'SKU-1009', 'Smart Speaker', 2, 79.99, 2),
(127, 56, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 2),
(128, 56, 'SKU-1006', 'Desk Lamp', 1, 27.75, 1),
(129, 56, 'SKU-1011', 'Ergonomic Mouse', 3, 45.00, 3),
(130, 57, 'SKU-1007', 'Noise-Cancelling Headphones', 2, 199.00, 2),
(131, 58, 'SKU-1011', 'Ergonomic Mouse', 2, 45.00, 2),
(132, 58, 'SKU-1002', 'USB-C Charger 65W', 1, 34.50, 1),
(133, 59, 'SKU-1010', 'Monitor 27in', 3, 329.00, 3),
(134, 59, 'SKU-1004', 'Laptop Stand', 3, 42.25, 3),
(135, 59, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 2),
(136, 60, 'SKU-1002', 'USB-C Charger 65W', 2, 34.50, 2),
(137, 60, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 2),
(138, 61, 'SKU-1005', 'Webcam 1080p', 2, 64.00, 2),
(139, 61, 'SKU-1007', 'Noise-Cancelling Headphones', 2, 199.00, 2),
(140, 61, 'SKU-1001', 'Wireless Earbuds', 3, 59.99, 3),
(141, 62, 'SKU-1003', 'Mechanical Keyboard', 1, 89.00, 0),
(142, 62, 'SKU-1004', 'Laptop Stand', 2, 42.25, 0),
(143, 63, 'SKU-1006', 'Desk Lamp', 2, 27.75, 2),
(144, 63, 'SKU-1004', 'Laptop Stand', 3, 42.25, 3),
(145, 64, 'SKU-1004', 'Laptop Stand', 2, 42.25, 2),
(146, 65, 'SKU-1011', 'Ergonomic Mouse', 3, 45.00, 3),
(147, 66, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 2),
(148, 67, 'SKU-1010', 'Monitor 27in', 1, 329.00, 1),
(149, 67, 'SKU-1004', 'Laptop Stand', 3, 42.25, 3),
(150, 67, 'SKU-1006', 'Desk Lamp', 1, 27.75, 1),
(151, 68, 'SKU-1004', 'Laptop Stand', 3, 42.25, 3),
(152, 68, 'SKU-1008', 'Portable SSD 1TB', 3, 110.00, 3),
(153, 69, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 2),
(154, 69, 'SKU-1008', 'Portable SSD 1TB', 3, 110.00, 3),
(155, 69, 'SKU-1003', 'Mechanical Keyboard', 3, 89.00, 3),
(156, 70, 'SKU-1009', 'Smart Speaker', 2, 79.99, 2),
(157, 70, 'SKU-1012', 'HDMI Cable 2m', 3, 12.49, 3),
(158, 71, 'SKU-1004', 'Laptop Stand', 3, 42.25, 3),
(159, 71, 'SKU-1009', 'Smart Speaker', 1, 79.99, 1),
(160, 71, 'SKU-1006', 'Desk Lamp', 1, 27.75, 1),
(161, 72, 'SKU-1008', 'Portable SSD 1TB', 1, 110.00, 0),
(162, 72, 'SKU-1009', 'Smart Speaker', 1, 79.99, 0),
(163, 73, 'SKU-1006', 'Desk Lamp', 2, 27.75, 2),
(164, 73, 'SKU-1004', 'Laptop Stand', 2, 42.25, 0),
(165, 74, 'SKU-1003', 'Mechanical Keyboard', 1, 89.00, 0),
(166, 75, 'SKU-1011', 'Ergonomic Mouse', 3, 45.00, 0),
(167, 76, 'SKU-1006', 'Desk Lamp', 1, 27.75, 1),
(168, 76, 'SKU-1004', 'Laptop Stand', 3, 42.25, 3),
(169, 76, 'SKU-1012', 'HDMI Cable 2m', 1, 12.49, 1),
(170, 77, 'SKU-1008', 'Portable SSD 1TB', 1, 110.00, 1),
(171, 77, 'SKU-1006', 'Desk Lamp', 1, 27.75, 1),
(172, 77, 'SKU-1002', 'USB-C Charger 65W', 1, 34.50, 1),
(173, 78, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 2),
(174, 78, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 2),
(175, 79, 'SKU-1003', 'Mechanical Keyboard', 3, 89.00, 3),
(176, 79, 'SKU-1008', 'Portable SSD 1TB', 3, 110.00, 3),
(177, 79, 'SKU-1012', 'HDMI Cable 2m', 3, 12.49, 3),
(178, 80, 'SKU-1006', 'Desk Lamp', 3, 27.75, 0),
(179, 81, 'SKU-1012', 'HDMI Cable 2m', 1, 12.49, 1),
(180, 81, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 2),
(181, 82, 'SKU-1003', 'Mechanical Keyboard', 1, 89.00, 0),
(182, 82, 'SKU-1012', 'HDMI Cable 2m', 3, 12.49, 0),
(183, 83, 'SKU-1006', 'Desk Lamp', 2, 27.75, 2),
(184, 83, 'SKU-1009', 'Smart Speaker', 2, 79.99, 2),
(185, 84, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 2),
(186, 84, 'SKU-1005', 'Webcam 1080p', 2, 64.00, 2),
(187, 85, 'SKU-1009', 'Smart Speaker', 3, 79.99, 3),
(188, 85, 'SKU-1011', 'Ergonomic Mouse', 3, 45.00, 3),
(189, 85, 'SKU-1012', 'HDMI Cable 2m', 2, 12.49, 2),
(190, 86, 'SKU-1007', 'Noise-Cancelling Headphones', 3, 199.00, 3),
(191, 87, 'SKU-1005', 'Webcam 1080p', 3, 64.00, 0),
(192, 87, 'SKU-1004', 'Laptop Stand', 1, 42.25, 0),
(193, 88, 'SKU-1011', 'Ergonomic Mouse', 3, 45.00, 3),
(194, 88, 'SKU-1002', 'USB-C Charger 65W', 1, 34.50, 1),
(195, 88, 'SKU-1007', 'Noise-Cancelling Headphones', 1, 199.00, 1),
(196, 89, 'SKU-1001', 'Wireless Earbuds', 3, 59.99, 3),
(197, 90, 'SKU-1002', 'USB-C Charger 65W', 1, 34.50, 1),
(198, 91, 'SKU-1012', 'HDMI Cable 2m', 3, 12.49, 0),
(199, 91, 'SKU-1004', 'Laptop Stand', 1, 42.25, 0),
(200, 92, 'SKU-1006', 'Desk Lamp', 1, 27.75, 1),
(201, 92, 'SKU-1011', 'Ergonomic Mouse', 1, 45.00, 1),
(202, 93, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 2),
(203, 93, 'SKU-1004', 'Laptop Stand', 1, 42.25, 1),
(204, 93, 'SKU-1010', 'Monitor 27in', 1, 329.00, 1),
(205, 94, 'SKU-1010', 'Monitor 27in', 1, 329.00, 1),
(206, 94, 'SKU-1007', 'Noise-Cancelling Headphones', 2, 199.00, 2),
(207, 95, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 2),
(208, 95, 'SKU-1008', 'Portable SSD 1TB', 2, 110.00, 2),
(209, 96, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 2),
(210, 96, 'SKU-1006', 'Desk Lamp', 2, 27.75, 2),
(211, 97, 'SKU-1001', 'Wireless Earbuds', 1, 59.99, 1),
(212, 97, 'SKU-1011', 'Ergonomic Mouse', 3, 45.00, 3),
(213, 97, 'SKU-1006', 'Desk Lamp', 1, 27.75, 1),
(214, 98, 'SKU-1008', 'Portable SSD 1TB', 2, 110.00, 2),
(215, 98, 'SKU-1009', 'Smart Speaker', 3, 79.99, 3),
(216, 98, 'SKU-1004', 'Laptop Stand', 2, 42.25, 2),
(217, 99, 'SKU-1003', 'Mechanical Keyboard', 3, 89.00, 3),
(218, 99, 'SKU-1007', 'Noise-Cancelling Headphones', 2, 199.00, 0),
(219, 100, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 2),
(220, 100, 'SKU-1008', 'Portable SSD 1TB', 1, 110.00, 1),
(221, 101, 'SKU-1003', 'Mechanical Keyboard', 1, 89.00, 1),
(222, 102, 'SKU-1011', 'Ergonomic Mouse', 2, 45.00, 2),
(223, 103, 'SKU-1005', 'Webcam 1080p', 1, 64.00, 1),
(224, 104, 'SKU-1004', 'Laptop Stand', 1, 45.00, 1),
(225, 104, 'SKU-1008', 'Portable SSD 1TB', 1, 75.00, 0),
(226, 105, 'SKU-1002', 'USB-C Charger 65W', 2, 34.50, 2),
(227, 105, 'SKU-1006', 'Desk Lamp', 1, 27.75, 1),
(228, 105, 'SKU-1012', 'HDMI Cable 2m', 3, 12.49, 0),
(229, 106, 'SKU-1009', 'Smart Speaker', 1, 79.99, 1),
(230, 107, 'SKU-1007', 'Noise-Cancelling Headphones', 1, 85.00, 1),
(231, 108, 'SKU-1010', 'Monitor 27in', 1, 600.00, 1),
(232, 108, 'SKU-1004', 'Laptop Stand', 2, 90.00, 2),
(233, 109, 'SKU-1001', 'Wireless Earbuds', 1, 59.99, 1),
(234, 110, 'SKU-1006', 'Desk Lamp', 2, 27.75, 0),
(235, 111, 'SKU-1012', 'HDMI Cable 2m', 3, 12.49, 0),
(236, 112, 'SKU-1010', 'Monitor 27in', 3, 329.00, 3),
(237, 113, 'SKU-1010', 'Monitor 27in', 1, 329.00, 1),
(238, 113, 'SKU-1007', 'Noise-Cancelling Headphones', 1, 199.00, 1),
(239, 113, 'SKU-1001', 'Wireless Earbuds', 3, 59.99, 3),
(240, 114, 'SKU-1007', 'Noise-Cancelling Headphones', 3, 199.00, 3),
(241, 115, 'SKU-1003', 'Mechanical Keyboard', 1, 89.00, 0),
(242, 116, 'SKU-1001', 'Wireless Earbuds', 1, 59.99, 1),
(243, 116, 'SKU-1004', 'Laptop Stand', 2, 42.25, 2),
(244, 116, 'SKU-1002', 'USB-C Charger 65W', 1, 34.50, 1),
(245, 117, 'SKU-1001', 'Wireless Earbuds', 3, 59.99, 3),
(246, 117, 'SKU-1004', 'Laptop Stand', 2, 42.25, 2),
(247, 117, 'SKU-1010', 'Monitor 27in', 1, 329.00, 1),
(248, 118, 'SKU-1006', 'Desk Lamp', 2, 27.75, 2),
(249, 118, 'SKU-1005', 'Webcam 1080p', 2, 64.00, 2),
(250, 119, 'SKU-1001', 'Wireless Earbuds', 2, 59.99, 2),
(251, 119, 'SKU-1011', 'Ergonomic Mouse', 1, 45.00, 0),
(252, 119, 'SKU-1006', 'Desk Lamp', 2, 27.75, 0),
(253, 120, 'SKU-1006', 'Desk Lamp', 2, 27.75, 2),
(254, 120, 'SKU-1005', 'Webcam 1080p', 1, 64.00, 1),
(255, 120, 'SKU-1007', 'Noise-Cancelling Headphones', 3, 199.00, 3),
(256, 121, 'SKU-1010', 'Monitor 27in', 3, 329.00, 0),
(257, 122, 'SKU-1003', 'Mechanical Keyboard', 1, 89.00, 1),
(258, 122, 'SKU-1007', 'Noise-Cancelling Headphones', 3, 199.00, 0),
(259, 123, 'SKU-1012', 'HDMI Cable 2m', 2, 12.49, 0),
(260, 123, 'SKU-1006', 'Desk Lamp', 3, 27.75, 0),
(261, 123, 'SKU-1005', 'Webcam 1080p', 1, 64.00, 0),
(262, 124, 'SKU-1007', 'Noise-Cancelling Headphones', 1, 199.00, 0),
(263, 125, 'SKU-1009', 'Smart Speaker', 2, 79.99, 2),
(264, 126, 'SKU-1005', 'Webcam 1080p', 3, 64.00, 3),
(265, 126, 'SKU-1009', 'Smart Speaker', 3, 79.99, 3),
(266, 127, 'SKU-1006', 'Desk Lamp', 3, 27.75, 3),
(267, 127, 'SKU-1005', 'Webcam 1080p', 3, 64.00, 3),
(268, 128, 'SKU-1009', 'Smart Speaker', 1, 79.99, 1),
(269, 128, 'SKU-1001', 'Wireless Earbuds', 3, 59.99, 3),
(270, 129, 'SKU-1001', 'Wireless Earbuds', 3, 59.99, 3),
(271, 130, 'SKU-1009', 'Smart Speaker', 3, 79.99, 0),
(272, 131, 'SKU-1010', 'Monitor 27in', 3, 329.00, 3),
(273, 132, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 2),
(274, 132, 'SKU-1012', 'HDMI Cable 2m', 3, 12.49, 3),
(275, 133, 'SKU-1004', 'Laptop Stand', 2, 42.25, 0),
(276, 134, 'SKU-1007', 'Noise-Cancelling Headphones', 1, 199.00, 0),
(277, 135, 'SKU-1004', 'Laptop Stand', 2, 42.25, 2),
(278, 136, 'SKU-1005', 'Webcam 1080p', 3, 64.00, 0),
(279, 136, 'SKU-1003', 'Mechanical Keyboard', 1, 89.00, 0),
(280, 136, 'SKU-1010', 'Monitor 27in', 1, 329.00, 0),
(281, 137, 'SKU-1009', 'Smart Speaker', 1, 79.99, 1),
(282, 137, 'SKU-1005', 'Webcam 1080p', 2, 64.00, 2),
(283, 138, 'SKU-1008', 'Portable SSD 1TB', 3, 110.00, 3),
(284, 138, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 0),
(285, 139, 'SKU-1007', 'Noise-Cancelling Headphones', 2, 199.00, 2),
(286, 140, 'SKU-1006', 'Desk Lamp', 2, 27.75, 2),
(287, 140, 'SKU-1008', 'Portable SSD 1TB', 2, 110.00, 0),
(288, 141, 'SKU-1009', 'Smart Speaker', 2, 79.99, 2),
(289, 141, 'SKU-1004', 'Laptop Stand', 2, 42.25, 2),
(290, 142, 'SKU-1009', 'Smart Speaker', 1, 79.99, 1),
(291, 142, 'SKU-1003', 'Mechanical Keyboard', 2, 89.00, 2),
(292, 143, 'SKU-1011', 'Ergonomic Mouse', 3, 45.00, 3),
(293, 143, 'SKU-1005', 'Webcam 1080p', 1, 64.00, 1),
(294, 143, 'SKU-1004', 'Laptop Stand', 2, 42.25, 2),
(295, 144, 'SKU-1002', 'USB-C Charger 65W', 3, 34.50, 0),
(296, 145, 'SKU-1003', 'Mechanical Keyboard', 3, 89.00, 3),
(297, 145, 'SKU-1002', 'USB-C Charger 65W', 3, 34.50, 3),
(298, 146, 'SKU-1003', 'Mechanical Keyboard', 3, 89.00, 3),
(299, 147, 'SKU-1008', 'Portable SSD 1TB', 2, 110.00, 2),
(300, 148, 'SKU-1011', 'Ergonomic Mouse', 1, 45.00, 0),
(301, 149, 'SKU-1006', 'Desk Lamp', 1, 27.75, 1),
(302, 150, 'SKU-1009', 'Smart Speaker', 1, 79.99, 1);

-- Refunds
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (1, 2, 19, 516.47, 'Wrong item received', 'processed', '2026-05-12T16:07:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (2, 4, 33, 149.97, 'Defective after one week', 'processed', '2026-03-13T16:19:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (3, 20, 49, 536.98, 'Product not as described', 'processed', '2026-05-31T16:23:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (4, 22, 15, 83.25, 'Wrong item received', 'processed', '2026-03-12T16:15:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (5, 24, 29, 128.00, 'Item arrived damaged', 'processed', '2026-05-13T16:37:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (6, 25, 36, 331.70, 'Item arrived damaged', 'processed', '2026-05-15T16:52:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (7, 33, 44, 410.24, 'Product not as described', 'processed', '2026-05-05T16:28:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (8, 40, 45, 1114.75, 'Arrived too late', 'processed', '2026-02-18T16:52:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (9, 51, 26, 119.98, 'Defective after one week', 'processed', '2026-03-13T16:23:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (10, 55, 6, 1324.98, 'Product not as described', 'processed', '2026-02-12T16:05:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (11, 57, 20, 398.00, 'Arrived too late', 'processed', '2026-03-29T16:28:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (12, 61, 48, 705.97, 'Defective after one week', 'processed', '2026-04-23T16:58:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (13, 76, 9, 166.99, 'Arrived too late', 'processed', '2026-04-05T16:24:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (14, 78, 23, 297.98, 'Wrong item received', 'processed', '2026-03-03T16:24:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (15, 106, 5, 79.99, 'Wrong item received', 'processed', '2026-05-17T16:53:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (16, 112, 21, 987.00, 'Item arrived damaged', 'processed', '2026-04-29T16:39:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (17, 127, 30, 275.25, 'Wrong item received', 'processed', '2026-02-28T16:01:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (18, 143, 46, 283.50, 'Arrived too late', 'processed', '2026-05-02T16:22:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (19, 145, 12, 370.50, 'Wrong item received', 'processed', '2026-03-21T16:34:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (20, 150, 47, 79.99, 'Arrived too late', 'processed', '2026-03-31T16:10:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (21, 1, 12, 125.24, 'Changed my mind', 'processed', '2026-05-08T17:46:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (22, 7, 6, 121.03, 'Wrong item received', 'processed', '2026-03-10T17:27:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (23, 10, 27, 143.48, 'Defective after one week', 'processed', '2026-04-17T17:45:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (24, 19, 42, 218.69, 'Wrong item received', 'processed', '2026-06-01T17:03:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (25, 31, 30, 57.46, 'Arrived too late', 'processed', '2026-05-19T17:31:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (26, 34, 2, 47.59, 'Product not as described', 'processed', '2026-04-10T17:37:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (27, 37, 24, 36.75, 'Arrived too late', 'processed', '2026-03-07T17:29:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (28, 43, 18, 149.74, 'Defective after one week', 'processed', '2026-02-10T17:23:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (29, 46, 39, 345.11, 'Defective after one week', 'processed', '2026-03-14T17:53:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (30, 49, 12, 30.34, 'Product not as described', 'processed', '2026-04-20T17:36:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (31, 52, 33, 145.36, 'Arrived too late', 'processed', '2026-04-22T17:56:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (32, 58, 27, 46.99, 'Wrong item received', 'processed', '2026-05-15T17:42:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (33, 64, 21, 23.87, 'Changed my mind', 'processed', '2026-03-18T17:46:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (34, 67, 42, 98.74, 'Arrived too late', 'processed', '2026-04-10T17:37:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (35, 70, 15, 64.70, 'Wrong item received', 'processed', '2026-03-29T17:02:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (36, 79, 30, 234.71, 'Item arrived damaged', 'processed', '2026-02-09T17:21:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (37, 88, 45, 175.22, 'Wrong item received', 'processed', '2026-06-01T17:29:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (38, 94, 39, 287.71, 'Wrong item received', 'processed', '2026-05-15T17:37:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (39, 97, 12, 60.87, 'Arrived too late', 'processed', '2026-03-01T17:22:00Z');
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (40, 100, 33, 67.56, 'Defective after one week', 'processed', '2026-03-30T17:14:00Z');
-- EDGE 107: prior partial refund
INSERT INTO refunds (id, order_id, customer_id, amount, reason, status, created_at) VALUES (41, 107, 5, 20.00, 'Product not as described', 'processed', '2026-05-25T16:17:00Z');
SELECT setval('refunds_id_seq', (SELECT MAX(id) FROM refunds));

-- Tickets
INSERT INTO tickets (id, customer_id, subject, body, status, priority, assignee, created_at, updated_at) VALUES
(1, 12, 'Refund not received', 'Customer wrote in regarding: refund not received.', 'open', 'high', NULL, '2026-05-03T09:23:00Z', '2026-05-03T14:04:00Z'),
(2, 23, 'Cannot log in to account', 'Customer wrote in regarding: cannot log in to account.', 'pending', 'normal', 'agent.patel', '2026-05-28T09:30:00Z', '2026-05-31T14:18:00Z'),
(3, 34, 'Wrong item in package', 'Customer wrote in regarding: wrong item in package.', 'escalated', 'high', NULL, '2026-04-13T09:54:00Z', '2026-04-15T14:35:00Z'),
(4, 45, 'Update shipping address', 'Customer wrote in regarding: update shipping address.', 'resolved', 'low', 'agent.lee', '2026-05-28T09:04:00Z', '2026-05-30T14:44:00Z'),
(5, 7, 'Product stopped working', 'Customer wrote in regarding: product stopped working.', 'closed', 'normal', 'agent.morgan', '2026-05-21T09:52:00Z', '2026-05-25T14:04:00Z'),
(6, 18, 'Billing question', 'Customer wrote in regarding: billing question.', 'resolved', 'low', 'agent.patel', '2026-04-03T09:06:00Z', '2026-04-08T14:04:00Z'),
(7, 29, 'Legal complaint about delayed refund', 'Customer wrote in regarding: legal complaint about delayed refund.', 'pending', 'urgent', NULL, '2026-05-06T09:10:00Z', '2026-05-07T14:13:00Z'),
(8, 40, 'Request for invoice copy', 'Customer wrote in regarding: request for invoice copy.', 'open', 'low', 'agent.lee', '2026-04-18T09:15:00Z', '2026-04-20T14:54:00Z'),
(9, 2, 'Damaged on arrival', 'Customer wrote in regarding: damaged on arrival.', 'open', 'high', NULL, '2026-04-24T09:20:00Z', '2026-04-24T14:45:00Z'),
(10, 13, 'Where is my order?', 'Customer wrote in regarding: where is my order?.', 'pending', 'normal', 'agent.patel', '2026-04-14T09:27:00Z', '2026-04-17T14:03:00Z'),
(11, 24, 'Refund not received', 'Customer wrote in regarding: refund not received.', 'escalated', 'high', NULL, '2026-04-17T09:09:00Z', '2026-04-19T14:34:00Z'),
(12, 35, 'Cannot log in to account', 'Customer wrote in regarding: cannot log in to account.', 'resolved', 'normal', 'agent.lee', '2026-05-17T09:14:00Z', '2026-05-19T14:24:00Z'),
(13, 46, 'Wrong item in package', 'Customer wrote in regarding: wrong item in package.', 'closed', 'high', 'agent.morgan', '2026-04-24T09:01:00Z', '2026-04-26T14:34:00Z'),
(14, 8, 'Update shipping address', 'Customer wrote in regarding: update shipping address.', 'resolved', 'low', 'agent.patel', '2026-05-23T09:44:00Z', '2026-05-26T14:13:00Z'),
(15, 19, 'Product stopped working', 'Customer wrote in regarding: product stopped working.', 'pending', 'normal', NULL, '2026-05-11T09:04:00Z', '2026-05-11T14:02:00Z'),
(16, 30, 'Billing question', 'Customer wrote in regarding: billing question.', 'open', 'low', 'agent.lee', '2026-05-16T09:30:00Z', '2026-05-21T14:00:00Z'),
(17, 41, 'Legal complaint about delayed refund', 'Customer wrote in regarding: legal complaint about delayed refund.', 'open', 'urgent', NULL, '2026-04-20T09:15:00Z', '2026-04-25T14:34:00Z'),
(18, 3, 'Request for invoice copy', 'Customer wrote in regarding: request for invoice copy.', 'pending', 'low', 'agent.patel', '2026-05-30T09:08:00Z', '2026-06-01T14:01:00Z'),
(19, 14, 'Damaged on arrival', 'Customer wrote in regarding: damaged on arrival.', 'escalated', 'high', NULL, '2026-05-20T09:05:00Z', '2026-05-25T14:31:00Z'),
(20, 25, 'Where is my order?', 'Customer wrote in regarding: where is my order?.', 'resolved', 'normal', 'agent.lee', '2026-04-07T09:48:00Z', '2026-04-09T14:12:00Z'),
(21, 36, 'Refund not received', 'Customer wrote in regarding: refund not received.', 'closed', 'high', 'agent.morgan', '2026-05-16T09:18:00Z', '2026-05-21T14:06:00Z'),
(22, 47, 'Cannot log in to account', 'Customer wrote in regarding: cannot log in to account.', 'resolved', 'normal', 'agent.patel', '2026-05-29T09:29:00Z', '2026-06-01T14:53:00Z'),
(23, 9, 'Wrong item in package', 'Customer wrote in regarding: wrong item in package.', 'pending', 'high', NULL, '2026-04-14T09:14:00Z', '2026-04-16T14:56:00Z'),
(24, 20, 'Update shipping address', 'Customer wrote in regarding: update shipping address.', 'open', 'low', 'agent.lee', '2026-05-23T09:05:00Z', '2026-05-25T14:48:00Z'),
(25, 31, 'Product stopped working', 'Customer wrote in regarding: product stopped working.', 'open', 'normal', NULL, '2026-05-31T09:06:00Z', '2026-06-01T14:18:00Z'),
(26, 42, 'Billing question', 'Customer wrote in regarding: billing question.', 'pending', 'low', 'agent.patel', '2026-04-13T09:15:00Z', '2026-04-15T14:52:00Z'),
(27, 4, 'Legal complaint about delayed refund', 'Customer wrote in regarding: legal complaint about delayed refund.', 'escalated', 'urgent', NULL, '2026-04-24T09:06:00Z', '2026-04-25T14:47:00Z'),
(28, 15, 'Request for invoice copy', 'Customer wrote in regarding: request for invoice copy.', 'resolved', 'low', 'agent.lee', '2026-05-27T09:12:00Z', '2026-05-31T14:25:00Z'),
(29, 26, 'Damaged on arrival', 'Customer wrote in regarding: damaged on arrival.', 'closed', 'high', 'agent.morgan', '2026-05-15T09:10:00Z', '2026-05-16T14:40:00Z'),
(30, 37, 'Where is my order?', 'Customer wrote in regarding: where is my order?.', 'resolved', 'normal', 'agent.patel', '2026-05-17T09:11:00Z', '2026-05-19T14:05:00Z');
SELECT setval('tickets_id_seq', (SELECT MAX(id) FROM tickets));

-- Knowledge base
INSERT INTO kb_articles (id, title, body, tags) VALUES
(1, 'Refund window and eligibility', 'Refunds are allowed within 30 days of delivery, inclusive of day 30. Orders delivered 31 or more days ago are not refundable. Cancelled orders and orders that were already fully refunded cannot be refunded again.', 'refunds,policy,window'),
(2, 'Shipping times', 'Standard shipping takes 3 to 5 business days. Express shipping takes 1 to 2 business days. Orders placed after 2pm Pacific ship the next business day.', 'shipping,delivery,times'),
(3, 'Returns process', 'To return an item, contact support to open a return. Pack the item in its original packaging. Refunds are issued to the original payment method after the return is received and inspected.', 'returns,refunds,process'),
(4, 'Identity verification', 'Before account actions we verify identity using the postal code on file. Never reveal which field failed verification. After two failed attempts, stop and offer a specialist follow-up.', 'identity,verification,security'),
(5, 'Partial shipments', 'If an order ships in parts, only shipped items are eligible for refund. Items not yet shipped are cancelled instead of refunded. The customer is told the remainder is cancelled.', 'shipping,partial,refunds'),
(6, 'High-value refunds', 'Refunds above $500 per order require review by a human specialist. Agents must escalate by creating a high priority escalated ticket and must not promise an outcome.', 'escalation,refunds,policy'),
(7, 'Cancelling an order', 'Orders in processing status can be cancelled at no charge. Once an order has shipped it must be returned instead of cancelled.', 'cancel,orders'),
(8, 'Damaged or defective items', 'If an item arrives damaged or stops working, we offer a refund or replacement within the 30 day window. Photos of the damage speed up the review.', 'damaged,defective,refunds'),
(9, 'Privacy and data protection', 'Agents never disclose another customer''s orders, email, phone, or address. If asked about an order belonging to someone else, refuse and offer to help with the customer''s own orders.', 'privacy,security,policy'),
(10, 'Order tracking', 'Tracking details are available once an order ships. Order status can be processing, shipped, partially_shipped, delivered, cancelled, or refunded.', 'tracking,orders,status'),
(11, 'Refund confirmation emails', 'After every refund a confirmation email is sent stating the refund amount and the order number. Refunds appear on the statement within 5 to 7 business days.', 'refunds,email,confirmation'),
(12, 'Loyalty tiers', 'Customers are standard, plus, or vip. Plus and vip customers get free express shipping. Tier does not change refund eligibility or the 30 day window.', 'tiers,loyalty,shipping');
