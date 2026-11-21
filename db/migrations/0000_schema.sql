CREATE TYPE "public"."actor_type" AS ENUM('staff', 'customer', 'system');--> statement-breakpoint
CREATE TYPE "public"."closed_reason" AS ENUM('customer_no_reply', 'resolution_window_elapsed');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('public', 'note');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('new', 'open', 'waiting_on_customer', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('agent', 'lead');--> statement-breakpoint
CREATE TABLE "customers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_name_chk" CHECK (length(btrim("customers"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"holiday_date" date PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ticket_id" bigint NOT NULL,
	"kind" "message_kind" NOT NULL,
	"author_type" "actor_type" NOT NULL,
	"author_user_id" bigint,
	"author_customer_id" bigint,
	"recipient_user_id" bigint,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "messages_body_chk" CHECK (length(btrim("messages"."body")) > 0 AND length("messages"."body") <= 10000),
	CONSTRAINT "messages_author_chk" CHECK (
    ("messages"."author_type" = 'staff'    AND "messages"."author_user_id" IS NOT NULL AND "messages"."author_customer_id" IS NULL) OR
    ("messages"."author_type" = 'customer' AND "messages"."author_customer_id" IS NOT NULL AND "messages"."author_user_id" IS NULL) OR
    ("messages"."author_type" = 'system'   AND "messages"."author_user_id" IS NULL AND "messages"."author_customer_id" IS NULL)),
	CONSTRAINT "messages_note_staff_only" CHECK ("messages"."kind" = 'public' OR "messages"."author_type" = 'staff'),
	CONSTRAINT "messages_recipient_chk" CHECK ("messages"."recipient_user_id" IS NULL OR "messages"."author_type" = 'customer')
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "sla_cycles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sla_cycles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ticket_id" bigint NOT NULL,
	"cycle_no" integer NOT NULL,
	"is_reopen" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"clock_start_at" timestamp with time zone NOT NULL,
	"priority" "ticket_priority" NOT NULL,
	"reply_budget_minutes" integer NOT NULL,
	"resolve_budget_minutes" integer NOT NULL,
	"reply_due_at" timestamp with time zone NOT NULL,
	"resolve_due_at" timestamp with time zone NOT NULL,
	"first_response_at" timestamp with time zone,
	"first_response_message_id" bigint,
	"resolved_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"reply_breached_at" timestamp with time zone,
	"resolve_breached_at" timestamp with time zone,
	CONSTRAINT "sla_cycles_ticket_cycle_uq" UNIQUE("ticket_id","cycle_no"),
	CONSTRAINT "sla_cycles_cycle_no_chk" CHECK ("sla_cycles"."cycle_no" >= 1),
	CONSTRAINT "sla_cycles_budgets_chk" CHECK ("sla_cycles"."reply_budget_minutes" > 0 AND "sla_cycles"."resolve_budget_minutes" > 0),
	CONSTRAINT "sla_cycles_first_response_pair" CHECK (("sla_cycles"."first_response_at" IS NULL) = ("sla_cycles"."first_response_message_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sla_pauses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sla_pauses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"cycle_id" bigint NOT NULL,
	"ticket_id" bigint NOT NULL,
	"paused_at" timestamp with time zone NOT NULL,
	"resumed_at" timestamp with time zone,
	"business_minutes" integer,
	CONSTRAINT "sla_pauses_minutes_chk" CHECK ("sla_pauses"."business_minutes" >= 0),
	CONSTRAINT "sla_pauses_order" CHECK ("sla_pauses"."resumed_at" IS NULL OR "sla_pauses"."resumed_at" >= "sla_pauses"."paused_at"),
	CONSTRAINT "sla_pauses_closed" CHECK (("sla_pauses"."resumed_at" IS NULL) = ("sla_pauses"."business_minutes" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"priority" "ticket_priority" PRIMARY KEY NOT NULL,
	"reply_minutes" integer NOT NULL,
	"resolve_minutes" integer,
	"resolve_same_day" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sla_policies_reply_chk" CHECK ("sla_policies"."reply_minutes" > 0),
	CONSTRAINT "sla_policies_resolve_chk" CHECK (("sla_policies"."resolve_same_day" AND "sla_policies"."resolve_minutes" IS NULL) OR (NOT "sla_policies"."resolve_same_day" AND "sla_policies"."resolve_minutes" > 0))
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ticket_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ticket_id" bigint NOT NULL,
	"chain_seq" integer NOT NULL,
	"type" text NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" bigint,
	"actor_customer_id" bigint,
	"message_id" bigint,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"prev_hash" "bytea",
	"hash" "bytea" NOT NULL,
	CONSTRAINT "ticket_events_chain_uq" UNIQUE("ticket_id","chain_seq"),
	CONSTRAINT "ticket_events_type_chk" CHECK ("ticket_events"."type" IN (
    'ticket_created','claimed','released','reassigned',
    'public_reply_sent','customer_replied','note_added',
    'status_changed','priority_changed',
    'sla_cycle_started','sla_paused','sla_resumed',
    'reply_breached','resolve_breached',
    'resolved','reopened','auto_closed','closed',
    'linked_ticket_created','export_generated')),
	CONSTRAINT "ticket_events_actor_chk" CHECK (
    ("ticket_events"."actor_type" = 'staff'    AND "ticket_events"."actor_user_id" IS NOT NULL AND "ticket_events"."actor_customer_id" IS NULL) OR
    ("ticket_events"."actor_type" = 'customer' AND "ticket_events"."actor_customer_id" IS NOT NULL AND "ticket_events"."actor_user_id" IS NULL) OR
    ("ticket_events"."actor_type" = 'system'   AND "ticket_events"."actor_user_id" IS NULL AND "ticket_events"."actor_customer_id" IS NULL)),
	CONSTRAINT "ticket_events_payload_chk" CHECK (jsonb_typeof("ticket_events"."payload") = 'object' AND NOT ("ticket_events"."payload" ? 'body'))
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tickets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ticket_no" integer GENERATED ALWAYS AS IDENTITY (sequence name "tickets_ticket_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"customer_id" bigint NOT NULL,
	"subject" text NOT NULL,
	"priority" "ticket_priority" DEFAULT 'medium' NOT NULL,
	"status" "ticket_status" DEFAULT 'new' NOT NULL,
	"assignee_id" bigint,
	"claimed_at" timestamp with time zone,
	"parent_ticket_id" bigint,
	"access_token_hash" "bytea" NOT NULL,
	"waiting_since" timestamp with time zone,
	"auto_close_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"reopen_until" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_reason" "closed_reason",
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_ticket_no_unique" UNIQUE("ticket_no"),
	CONSTRAINT "tickets_access_token_hash_unique" UNIQUE("access_token_hash"),
	CONSTRAINT "tickets_subject_chk" CHECK (length(btrim("tickets"."subject")) > 0 AND length("tickets"."subject") <= 200),
	CONSTRAINT "tickets_no_self_parent" CHECK ("tickets"."parent_ticket_id" IS NULL OR "tickets"."parent_ticket_id" <> "tickets"."id"),
	CONSTRAINT "tickets_new_unassigned" CHECK ("tickets"."status" <> 'new' OR "tickets"."assignee_id" IS NULL),
	CONSTRAINT "tickets_waiting_fields" CHECK (("tickets"."status" = 'waiting_on_customer') = ("tickets"."waiting_since" IS NOT NULL AND "tickets"."auto_close_at" IS NOT NULL)),
	CONSTRAINT "tickets_resolved_fields" CHECK ("tickets"."status" <> 'resolved' OR ("tickets"."resolved_at" IS NOT NULL AND "tickets"."reopen_until" IS NOT NULL)),
	CONSTRAINT "tickets_closed_fields" CHECK (("tickets"."status" = 'closed') = ("tickets"."closed_at" IS NOT NULL AND "tickets"."closed_reason" IS NOT NULL)),
	CONSTRAINT "tickets_reopen_count_chk" CHECK ("tickets"."reopen_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'agent' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_name_chk" CHECK (length(btrim("users"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_customer_id_customers_id_fk" FOREIGN KEY ("author_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_cycles" ADD CONSTRAINT "sla_cycles_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_cycles" ADD CONSTRAINT "sla_cycles_first_response_message_id_messages_id_fk" FOREIGN KEY ("first_response_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_pauses" ADD CONSTRAINT "sla_pauses_cycle_id_sla_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."sla_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_pauses" ADD CONSTRAINT "sla_pauses_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actor_customer_id_customers_id_fk" FOREIGN KEY ("actor_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_parent_ticket_id_tickets_id_fk" FOREIGN KEY ("parent_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_email_uq" ON "customers" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("ticket_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_cycles_one_active_idx" ON "sla_cycles" USING btree ("ticket_id") WHERE "sla_cycles"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sla_cycles_reply_due_idx" ON "sla_cycles" USING btree ("reply_due_at") WHERE "sla_cycles"."ended_at" IS NULL AND "sla_cycles"."first_response_at" IS NULL AND "sla_cycles"."reply_breached_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sla_cycles_resolve_due_idx" ON "sla_cycles" USING btree ("resolve_due_at") WHERE "sla_cycles"."ended_at" IS NULL AND "sla_cycles"."resolve_breached_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sla_pauses_one_open_idx" ON "sla_pauses" USING btree ("cycle_id") WHERE "sla_pauses"."resumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sla_pauses_cycle_idx" ON "sla_pauses" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_idx" ON "ticket_events" USING btree ("ticket_id","chain_seq");--> statement-breakpoint
CREATE INDEX "ticket_events_type_idx" ON "ticket_events" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "tickets_assignee_status_idx" ON "tickets" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "tickets_status_idx" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tickets_customer_idx" ON "tickets" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "tickets_parent_idx" ON "tickets" USING btree ("parent_ticket_id") WHERE "tickets"."parent_ticket_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tickets_auto_close_idx" ON "tickets" USING btree ("auto_close_at") WHERE "tickets"."status" = 'waiting_on_customer';--> statement-breakpoint
CREATE INDEX "tickets_reopen_until_idx" ON "tickets" USING btree ("reopen_until") WHERE "tickets"."status" = 'resolved';--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));