CREATE TABLE IF NOT EXISTS nfl_confidence_pool (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  season integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  starts_on date NOT NULL,
  weekly_prize_cents integer NOT NULL DEFAULT 5000,
  season_winner_prize_cents integer NOT NULL DEFAULT 50000,
  season_runner_up_prize_cents integer NOT NULL DEFAULT 25000,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('active', 'completed', 'archived')),
  CHECK (length(name) BETWEEN 2 AND 120)
);

CREATE UNIQUE INDEX IF NOT EXISTS nfl_confidence_pool_active_unique_idx
  ON nfl_confidence_pool ((status))
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS nfl_confidence_entry (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL REFERENCES nfl_confidence_pool(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('active', 'inactive')),
  UNIQUE (pool_id, user_id)
);

CREATE INDEX IF NOT EXISTS nfl_confidence_entry_pool_status_idx
  ON nfl_confidence_entry (pool_id, status, created_at);

CREATE TABLE IF NOT EXISTS nfl_confidence_game (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL REFERENCES nfl_confidence_pool(id) ON DELETE CASCADE,
  season integer NOT NULL,
  week integer NOT NULL,
  week_start date NOT NULL,
  provider_event_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  away_team text NOT NULL,
  home_team text NOT NULL,
  away_score integer,
  home_score integer,
  status text NOT NULL DEFAULT 'scheduled',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (week BETWEEN 1 AND 25),
  CHECK (status IN ('scheduled', 'in_progress', 'final', 'void')),
  CHECK (length(away_team) BETWEEN 1 AND 120),
  CHECK (length(home_team) BETWEEN 1 AND 120),
  UNIQUE (pool_id, provider_event_id),
  UNIQUE (pool_id, week, away_team, home_team, starts_at)
);

CREATE INDEX IF NOT EXISTS nfl_confidence_game_pool_week_idx
  ON nfl_confidence_game (pool_id, week, starts_at);

CREATE TABLE IF NOT EXISTS nfl_confidence_pick (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL REFERENCES nfl_confidence_pool(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES nfl_confidence_entry(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES nfl_confidence_game(id) ON DELETE CASCADE,
  season integer NOT NULL,
  week integer NOT NULL,
  selected_team text,
  confidence_points integer,
  status text NOT NULL DEFAULT 'pending',
  points_awarded integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (confidence_points IS NULL OR confidence_points BETWEEN 1 AND 32),
  CHECK (status IN ('pending', 'won', 'lost', 'void', 'no_pick')),
  CHECK (selected_team IS NULL OR length(selected_team) BETWEEN 1 AND 120),
  UNIQUE (entry_id, game_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS nfl_confidence_pick_entry_week_confidence_idx
  ON nfl_confidence_pick (entry_id, week, confidence_points)
  WHERE confidence_points IS NOT NULL;

CREATE INDEX IF NOT EXISTS nfl_confidence_pick_pool_week_idx
  ON nfl_confidence_pick (pool_id, week, status);

INSERT INTO nfl_confidence_pool (
  id,
  name,
  season,
  starts_on,
  weekly_prize_cents,
  season_winner_prize_cents,
  season_runner_up_prize_cents
)
SELECT gen_random_uuid(), 'StakeWars NFL Confidence', 2026, '2026-09-07'::date, 5000, 50000, 25000
WHERE NOT EXISTS (SELECT 1 FROM nfl_confidence_pool WHERE status = 'active');
