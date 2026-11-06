-- mbox import: consecutive cron ticks that failed unexpectedly. The import is retried until this reaches 10.
ALTER TABLE mbox_imports ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
