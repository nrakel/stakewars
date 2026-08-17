CREATE TABLE IF NOT EXISTS weekly_reward_award (
  id uuid PRIMARY KEY,
  week_starts_on date NOT NULL,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 3),
  share_percent integer NOT NULL CHECK (share_percent IN (50, 35, 15)),
  reward_cents integer NOT NULL CHECK (reward_cents > 0),
  leaderboard_cents integer NOT NULL,
  settled_profit_cents integer NOT NULL,
  weekly_wagers integer NOT NULL,
  weekly_stake_cents integer NOT NULL,
  first_place_bonus text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_starts_on, user_id)
);

CREATE INDEX IF NOT EXISTS weekly_reward_award_week_idx
  ON weekly_reward_award (week_starts_on, rank);

