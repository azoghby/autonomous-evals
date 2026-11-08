CREATE TABLE "sandbox_environments" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"org_id" text,
	"name" text NOT NULL,
	"domain" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"prebuilt_id" text,
	"spec" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"org_id" text,
	"environment_id" text NOT NULL,
	"suite_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"k" integer NOT NULL,
	"scenarios" jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb,
	"pass_at_1" double precision,
	"pass_hat_k" double precision,
	"ci95_low" double precision,
	"ci95_high" double precision,
	"versions" jsonb,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"budget_micro_usd" bigint NOT NULL,
	"trials_done" integer DEFAULT 0 NOT NULL,
	"trials_total" integer DEFAULT 0 NOT NULL,
	"world_id" text,
	"workflow_run_id" text,
	"error" text,
	"error_kind" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_suites" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"org_id" text,
	"status" text DEFAULT 'generating' NOT NULL,
	"generated" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scenarios" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"budget_micro_usd" bigint NOT NULL,
	"error" text,
	"workflow_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_environments" ADD CONSTRAINT "sandbox_environments_owner_id_customers_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_owner_id_customers_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_environment_id_sandbox_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."sandbox_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_suite_id_sandbox_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."sandbox_suites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_suites" ADD CONSTRAINT "sandbox_suites_environment_id_sandbox_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."sandbox_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_suites" ADD CONSTRAINT "sandbox_suites_owner_id_customers_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_environments_owner_idx" ON "sandbox_environments" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_owner_idx" ON "sandbox_runs" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_runs_status_idx" ON "sandbox_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sandbox_suites_owner_idx" ON "sandbox_suites" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "sandbox_suites_env_idx" ON "sandbox_suites" USING btree ("environment_id");