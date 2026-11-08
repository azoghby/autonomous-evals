CREATE TABLE job_budget.gateway_turns (
 operation_id text PRIMARY KEY REFERENCES job_budget.operations(operation_id),
 job_id uuid NOT NULL REFERENCES jobs(id),
 owner_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('test','live')),
 package text NOT NULL,
 message_id text NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 allowance_micro_usd bigint NOT NULL CHECK(allowance_micro_usd>0),
 UNIQUE(job_id,message_id)
);
CREATE TABLE job_budget.gateway_steps (
 operation_id text NOT NULL REFERENCES job_budget.gateway_turns(operation_id),
 step_index integer NOT NULL CHECK(step_index BETWEEN 0 AND 5),
 cost_id uuid NOT NULL UNIQUE REFERENCES costs(id),
 identity text NOT NULL,
 measured boolean NOT NULL,
 PRIMARY KEY(operation_id,step_index)
);
CREATE TRIGGER retain_gateway_turn BEFORE UPDATE OR DELETE ON job_budget.gateway_turns
 FOR EACH ROW EXECUTE FUNCTION job_budget.guard_retained();
CREATE TRIGGER retain_gateway_step BEFORE UPDATE OR DELETE ON job_budget.gateway_steps
 FOR EACH ROW EXECUTE FUNCTION job_budget.guard_retained();
