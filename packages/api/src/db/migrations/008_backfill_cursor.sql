-- Backfill progress tracking for date-window pagination
ALTER TABLE pipeline_runs ADD COLUMN backfill_date TEXT;
ALTER TABLE pipeline_runs ADD COLUMN backfill_offset INT DEFAULT 0;
