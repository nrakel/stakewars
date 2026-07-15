CREATE TABLE IF NOT EXISTS weekly_prize (
  week_starts_on date PRIMARY KEY,
  cash_prize_cents integer NOT NULL DEFAULT 0,
  first_place_bonus text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_prize_cash_nonnegative CHECK (cash_prize_cents >= 0),
  CONSTRAINT weekly_prize_bonus_length CHECK (first_place_bonus IS NULL OR length(first_place_bonus) <= 240)
);

CREATE INDEX IF NOT EXISTS weekly_prize_updated_idx ON weekly_prize(updated_at DESC);
