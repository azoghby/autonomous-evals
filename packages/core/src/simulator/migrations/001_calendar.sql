-- Apply only to the simulator seed branch. No application tables are touched.
CREATE TABLE IF NOT EXISTS sim_runs (
 job_id text NOT NULL, run_id text NOT NULL, version text NOT NULL,
 fail_next_mutation boolean NOT NULL DEFAULT false,
 PRIMARY KEY(job_id, run_id, version)
);
CREATE TABLE IF NOT EXISTS sim_calendars (
 job_id text NOT NULL, run_id text NOT NULL, version text NOT NULL,
 id text NOT NULL, owner_id text NOT NULL,
 PRIMARY KEY(job_id, run_id, version, id),
 FOREIGN KEY(job_id, run_id, version) REFERENCES sim_runs ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sim_permissions (
 job_id text NOT NULL, run_id text NOT NULL, version text NOT NULL,
 calendar_id text NOT NULL, actor_id text NOT NULL, access text NOT NULL CHECK(access IN ('read','write')),
 PRIMARY KEY(job_id, run_id, version, calendar_id, actor_id),
 FOREIGN KEY(job_id, run_id, version, calendar_id) REFERENCES sim_calendars ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sim_events (
 job_id text NOT NULL, run_id text NOT NULL, version text NOT NULL,
 id text NOT NULL, calendar_id text NOT NULL, owner_id text NOT NULL, title text NOT NULL,
 start_utc timestamptz NOT NULL, end_utc timestamptz NOT NULL, time_zone text NOT NULL,
 status text NOT NULL CHECK(status IN ('active','cancelled')), CHECK(start_utc < end_utc),
 PRIMARY KEY(job_id, run_id, version, id),
 FOREIGN KEY(job_id, run_id, version, calendar_id) REFERENCES sim_calendars ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sim_events_interval ON sim_events(job_id, run_id, version, calendar_id, start_utc, end_utc) WHERE status='active';
CREATE TABLE IF NOT EXISTS sim_tool_calls (
 job_id text NOT NULL, run_id text NOT NULL, version text NOT NULL,
 id text NOT NULL, actor_id text NOT NULL, name text NOT NULL, arguments text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(job_id, run_id, version, id),
 FOREIGN KEY(job_id, run_id, version) REFERENCES sim_runs ON DELETE CASCADE
);
