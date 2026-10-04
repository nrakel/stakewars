CREATE TABLE IF NOT EXISTS chine_nfl_weekly_pick (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL REFERENCES nfl_confidence_pool(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES nfl_confidence_game(id) ON DELETE CASCADE,
  game_line_id uuid REFERENCES game_line(id) ON DELETE SET NULL,
  season integer NOT NULL,
  week integer NOT NULL,
  away_team text NOT NULL,
  home_team text NOT NULL,
  starts_at timestamptz NOT NULL,
  selected_team text NOT NULL,
  spread numeric(5, 1) NOT NULL,
  odds_american integer NOT NULL,
  confidence numeric(7, 6) NOT NULL,
  model_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (week BETWEEN 1 AND 25),
  CHECK (selected_team IN (away_team, home_team)),
  CHECK (confidence BETWEEN 0 AND 1),
  UNIQUE (pool_id, week, game_id)
);

CREATE INDEX IF NOT EXISTS chine_nfl_weekly_pick_pool_week_idx
  ON chine_nfl_weekly_pick (pool_id, week, starts_at);
