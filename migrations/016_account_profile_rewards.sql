ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS reward_balance_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_method text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS payout_handle text,
  ADD COLUMN IF NOT EXISTS phone_last4 text;

ALTER TABLE app_user
  DROP CONSTRAINT IF EXISTS app_user_full_name_length,
  DROP CONSTRAINT IF EXISTS app_user_email_length,
  DROP CONSTRAINT IF EXISTS app_user_reward_balance_nonnegative,
  DROP CONSTRAINT IF EXISTS app_user_payout_method_valid,
  DROP CONSTRAINT IF EXISTS app_user_payout_handle_length,
  DROP CONSTRAINT IF EXISTS app_user_phone_last4_digits;

ALTER TABLE app_user
  ADD CONSTRAINT app_user_full_name_length
    CHECK (full_name IS NULL OR char_length(full_name) BETWEEN 2 AND 120),
  ADD CONSTRAINT app_user_email_length
    CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 254),
  ADD CONSTRAINT app_user_reward_balance_nonnegative
    CHECK (reward_balance_cents >= 0),
  ADD CONSTRAINT app_user_payout_method_valid
    CHECK (payout_method IN ('none', 'paypal', 'venmo')),
  ADD CONSTRAINT app_user_payout_handle_length
    CHECK (payout_handle IS NULL OR char_length(payout_handle) BETWEEN 2 AND 120),
  ADD CONSTRAINT app_user_phone_last4_digits
    CHECK (phone_last4 IS NULL OR phone_last4 ~ '^[0-9]{4}$');
