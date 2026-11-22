ALTER TABLE "users" ADD COLUMN "customer_id" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_change_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_customer_id_uq" ON "users" USING btree ("customer_id") WHERE "users"."customer_id" IS NOT NULL;