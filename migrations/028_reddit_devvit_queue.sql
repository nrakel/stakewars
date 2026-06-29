ALTER TABLE reddit_post_log
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE INDEX IF NOT EXISTS reddit_post_log_status_created_idx
  ON reddit_post_log (status, created_at);
