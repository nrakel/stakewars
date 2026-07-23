CREATE TABLE IF NOT EXISTS ai_daily_bankroll (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  bankroll_date date NOT NULL,
  starting_balance_cents integer NOT NULL CHECK (starting_balance_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, bankroll_date)
);

CREATE INDEX IF NOT EXISTS ai_daily_bankroll_user_date_idx
  ON ai_daily_bankroll (user_id, bankroll_date DESC);
