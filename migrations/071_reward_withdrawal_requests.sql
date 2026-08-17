CREATE TABLE IF NOT EXISTS reward_withdrawal_request (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents >= 2000),
  payout_method text NOT NULL CHECK (payout_method IN ('paypal', 'venmo')),
  payout_handle text NOT NULL CHECK (char_length(payout_handle) BETWEEN 2 AND 120),
  phone_last4 text NOT NULL CHECK (phone_last4 ~ '^[0-9]{4}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'canceled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  canceled_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS reward_withdrawal_request_one_pending_idx
  ON reward_withdrawal_request (user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS reward_withdrawal_request_requested_idx
  ON reward_withdrawal_request (requested_at DESC);
