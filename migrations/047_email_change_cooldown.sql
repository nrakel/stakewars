ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS last_email_change_at timestamptz;

CREATE INDEX IF NOT EXISTS app_user_last_email_change_idx
  ON app_user (last_email_change_at)
  WHERE last_email_change_at IS NOT NULL;
