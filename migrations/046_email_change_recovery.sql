CREATE TABLE IF NOT EXISTS email_change_recovery (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  old_email text NOT NULL,
  new_email text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_change_recovery_user_active_idx
  ON email_change_recovery (user_id, expires_at DESC)
  WHERE consumed_at IS NULL;
