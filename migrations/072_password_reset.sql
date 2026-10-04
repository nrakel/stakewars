ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT 'epoch';

CREATE TABLE IF NOT EXISTS password_reset_token (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_token_user_active_idx
  ON password_reset_token (user_id, expires_at DESC)
  WHERE consumed_at IS NULL;
