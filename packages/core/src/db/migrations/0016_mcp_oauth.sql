CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"client_uri" text,
	"redirect_uris" jsonb NOT NULL,
	"grant_types" jsonb NOT NULL,
	"token_endpoint_auth_method" text NOT NULL,
	"client_secret_hash" text,
	"scope" text NOT NULL,
	"software_id" text,
	"software_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" text NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_codes_expires_idx" ON "oauth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_hash_uq" ON "oauth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_customer_idx" ON "oauth_tokens" USING btree ("customer_id") WHERE "oauth_tokens"."revoked_at" is null;