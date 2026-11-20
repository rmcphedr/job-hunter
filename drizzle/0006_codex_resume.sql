CREATE TYPE "public"."tailor_run_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "tailorings" ADD COLUMN "provider" text DEFAULT 'openrouter' NOT NULL;--> statement-breakpoint
ALTER TABLE "tailorings" ADD COLUMN "run_status" "tailor_run_status" DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "tailorings" ADD COLUMN "changelog" jsonb;--> statement-breakpoint
ALTER TABLE "tailorings" ADD COLUMN "docx_path" text;--> statement-breakpoint
ALTER TABLE "tailorings" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tailorings" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "tailorings" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tailorings" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tailorings_run_status" ON "tailorings" USING btree ("run_status");