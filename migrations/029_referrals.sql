ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS referral_code text,
  ADD COLUMN IF NOT EXISTS referred_by_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL;

UPDATE app_user
SET referral_code = lower(substr(replace(id::text, '-', ''), 1, 12))
WHERE referral_code IS NULL;

ALTER TABLE app_user
  ALTER COLUMN referral_code SET NOT NULL,
  DROP CONSTRAINT IF EXISTS app_user_referral_code_format,
  DROP CONSTRAINT IF EXISTS app_user_not_self_referred,
  ADD CONSTRAINT app_user_referral_code_format
    CHECK (referral_code ~ '^[a-z0-9_-]{6,64}$'),
  ADD CONSTRAINT app_user_not_self_referred
    CHECK (referred_by_user_id IS NULL OR referred_by_user_id <> id);

CREATE UNIQUE INDEX IF NOT EXISTS app_user_referral_code_unique_idx
  ON app_user (referral_code);

CREATE INDEX IF NOT EXISTS app_user_referred_by_idx
  ON app_user (referred_by_user_id);
