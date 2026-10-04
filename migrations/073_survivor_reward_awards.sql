CREATE TABLE IF NOT EXISTS survivor_reward_award (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL REFERENCES survivor_pool(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  reward_cents integer NOT NULL CHECK (reward_cents > 0),
  reward_email_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id),
  UNIQUE (pool_id, user_id)
);

CREATE INDEX IF NOT EXISTS survivor_reward_award_user_idx
  ON survivor_reward_award (user_id, created_at DESC);
