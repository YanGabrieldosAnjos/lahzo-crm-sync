CREATE TABLE IF NOT EXISTS "api_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid,
	"direction" text DEFAULT 'outbound' NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"request_body" jsonb,
	"response_status" integer,
	"response_body" jsonb,
	"attempt" integer DEFAULT 1 NOT NULL,
	"latency_ms" integer NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crm_source" text NOT NULL,
	"crm_id" text NOT NULL,
	"email" text,
	"first_name" text,
	"last_name" text,
	"score" double precision,
	"status" text DEFAULT 'received' NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"sync_event_id" uuid NOT NULL,
	"event_occurred_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crm_source" text NOT NULL,
	"event_id" text NOT NULL,
	"crm_object_id" text NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sync_event_id_sync_events_id_fk" FOREIGN KEY ("sync_event_id") REFERENCES "public"."sync_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_calls_contact_created_idx" ON "api_calls" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_crm_identity_idx" ON "contacts" USING btree ("crm_source","crm_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_status_last_event_idx" ON "contacts" USING btree ("status","last_event_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_poll_idx" ON "jobs" USING btree ("status","next_run_at") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_locked_at_idx" ON "jobs" USING btree ("locked_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_events_event_id_uniq" ON "sync_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sync_events_object_idx" ON "sync_events" USING btree ("crm_source","crm_object_id","occurred_at");