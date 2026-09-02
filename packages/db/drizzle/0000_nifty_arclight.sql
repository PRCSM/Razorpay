CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "raw_events_provider_event_id_unique" UNIQUE("provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "recovery_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_ref" text,
	"amount_paise" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"customer_ref" text,
	"method" text,
	"issuer" text,
	"error_code" text,
	"error_source" text,
	"error_step" text,
	"error_reason" text,
	"root_cause" text,
	"cause_confidence" real,
	"cause_by" text,
	"status" text DEFAULT 'open' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"is_synthetic" boolean DEFAULT false NOT NULL,
	"ground_truth" jsonb
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"channel" text,
	"template_id" text,
	"expected_p" real NOT NULL,
	"est_cost_paise" bigint DEFAULT 0 NOT NULL,
	"policy_version" text NOT NULL,
	"model_version" text,
	"guardrail_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"executed_at" timestamp with time zone,
	"lag_seconds" integer,
	"request" jsonb,
	"response" jsonb,
	"cost_paise" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"action_id" uuid,
	"result" text NOT NULL,
	"amount_recovered_paise" bigint DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid,
	"actor" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"needs_human" boolean DEFAULT true NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bandit_arms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket_key" text NOT NULL,
	"arm" text NOT NULL,
	"alpha" real DEFAULT 1 NOT NULL,
	"beta" real DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bandit_arms_bucket_arm_unique" UNIQUE("bucket_key","arm")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "recovery_cases" ADD CONSTRAINT "recovery_cases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_case_id_recovery_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."recovery_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "raw_events_processed_at_idx" ON "raw_events" USING btree ("processed_at","received_at");--> statement-breakpoint
CREATE INDEX "raw_events_event_type_idx" ON "raw_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "recovery_cases_merchant_status_idx" ON "recovery_cases" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX "recovery_cases_root_cause_idx" ON "recovery_cases" USING btree ("root_cause");--> statement-breakpoint
CREATE INDEX "recovery_cases_is_synthetic_idx" ON "recovery_cases" USING btree ("is_synthetic");--> statement-breakpoint
CREATE INDEX "recovery_cases_source_status_idx" ON "recovery_cases" USING btree ("source","status");--> statement-breakpoint
CREATE INDEX "plans_scheduled_for_status_idx" ON "plans" USING btree ("scheduled_for","status");--> statement-breakpoint
CREATE INDEX "plans_case_id_idx" ON "plans" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "actions_case_id_idx" ON "actions" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "actions_plan_id_idx" ON "actions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "actions_executed_at_idx" ON "actions" USING btree ("executed_at");--> statement-breakpoint
CREATE INDEX "outcomes_case_id_idx" ON "outcomes" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "outcomes_action_id_idx" ON "outcomes" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "outcomes_result_idx" ON "outcomes" USING btree ("result");--> statement-breakpoint
CREATE INDEX "audit_log_case_id_idx" ON "audit_log" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_hash_idx" ON "audit_log" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "exceptions_case_id_idx" ON "exceptions" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "exceptions_needs_human_resolved_idx" ON "exceptions" USING btree ("needs_human","resolved_at");--> statement-breakpoint
CREATE INDEX "users_merchant_id_idx" ON "users" USING btree ("merchant_id");