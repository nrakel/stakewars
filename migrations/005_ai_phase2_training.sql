CREATE TABLE IF NOT EXISTS game_result (
  id uuid PRIMARY KEY,
  sport sport_key NOT NULL,
  starts_on date NOT NULL,
  away_team text NOT NULL,
  home_team text NOT NULL,
  away_score integer NOT NULL,
  home_score integer NOT NULL,
  source text NOT NULL DEFAULT 'mlb-stats-api',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport, starts_on, away_team, home_team, source)
);

CREATE TABLE IF NOT EXISTS ai_training_example (
  id uuid PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES ai_pick_candidate(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES ai_model_run(id) ON DELETE CASCADE,
  game_line_id uuid NOT NULL REFERENCES game_line(id),
  sport sport_key NOT NULL,
  market_key text NOT NULL,
  selected_team text NOT NULL,
  away_team text NOT NULL,
  home_team text NOT NULL,
  starts_at timestamptz NOT NULL,
  odds_american integer NOT NULL,
  spread numeric(5, 1) NOT NULL,
  implied_probability numeric(7, 6) NOT NULL,
  fair_probability numeric(7, 6) NOT NULL,
  edge numeric(7, 6) NOT NULL,
  model_score numeric(8, 4) NOT NULL,
  confidence numeric(5, 4) NOT NULL,
  features jsonb NOT NULL,
  result_id uuid NOT NULL REFERENCES game_result(id),
  outcome wager_status NOT NULL,
  profit_cents_per_100 integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id)
);

CREATE INDEX IF NOT EXISTS ai_training_example_sport_market_idx ON ai_training_example (sport, market_key);
CREATE INDEX IF NOT EXISTS ai_training_example_outcome_idx ON ai_training_example (outcome);
