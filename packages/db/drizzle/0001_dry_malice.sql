CREATE TABLE "downtime_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_downtime_id" text NOT NULL,
	"issuer" text,
	"method" text,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"severity" text,
	"status" text,
	"scheduled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "downtime_windows_provider_downtime_id_unique" UNIQUE("provider_downtime_id")
);
--> statement-breakpoint
CREATE TABLE "llm_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cache_key" text NOT NULL,
	"model" text NOT NULL,
	"slot" text NOT NULL,
	"response" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "llm_cache_cache_key_unique" UNIQUE("cache_key")
);
--> statement-breakpoint
CREATE INDEX "downtime_windows_issuer_method_idx" ON "downtime_windows" USING btree ("issuer","method");--> statement-breakpoint
CREATE INDEX "downtime_windows_active_idx" ON "downtime_windows" USING btree ("resolved_at","started_at");--> statement-breakpoint
CREATE INDEX "llm_cache_model_slot_idx" ON "llm_cache" USING btree ("model","slot");