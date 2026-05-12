-- 013: Add retry_count for tracking download retry attempts

ALTER TABLE documents ADD COLUMN retry_count INTEGER DEFAULT 0;
