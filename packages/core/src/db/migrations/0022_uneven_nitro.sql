CREATE TABLE "eval_chat_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"eval_kind" text NOT NULL,
	"eval_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"eval_kind" text NOT NULL,
	"eval_id" text NOT NULL,
	"role" text NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_chat_actions" ADD CONSTRAINT "eval_chat_actions_owner_id_customers_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_chat_messages" ADD CONSTRAINT "eval_chat_messages_owner_id_customers_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_chat_actions_owner_idx" ON "eval_chat_actions" USING btree ("owner_id","eval_kind","eval_id","created_at");--> statement-breakpoint
CREATE INDEX "eval_chat_messages_thread_idx" ON "eval_chat_messages" USING btree ("owner_id","eval_kind","eval_id","created_at");