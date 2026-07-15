ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

UPDATE app_user
SET email_verified = true,
    email_verified_at = COALESCE(email_verified_at, created_at, now())
WHERE email IS NOT NULL
  AND trim(email) <> ''
  AND email_verified = false;

CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_unique_lower_idx
  ON app_user (lower(trim(email)))
  WHERE email IS NOT NULL AND trim(email) <> '';

CREATE TABLE IF NOT EXISTS email_verification_code (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verification_code_user_active_idx
  ON email_verification_code (user_id, expires_at DESC)
  WHERE consumed_at IS NULL;
