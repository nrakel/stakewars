CREATE TABLE IF NOT EXISTS ai_snapshot_evaluation (
  id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES ai_candidate_snapshot(id) ON DELETE CASCADE,
  result_id uuid NOT NULL REFERENCES game_result(id),
  sport sport_key NOT NULL,
  market_key text NOT NULL,
  selected_team text NOT NULL,
  away_team text NOT NULL,
  home_team text NOT NULL,
  starts_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  odds_american integer NOT NULL,
  spread numeric(5, 1) NOT NULL,
  implied_probability numeric(7, 6) NOT NULL,
  fair_probability numeric(7, 6) NOT NULL,
  edge numeric(7, 6) NOT NULL,
  model_score numeric(8, 4) NOT NULL,
  confidence numeric(5, 4) NOT NULL,
  features jsonb NOT NULL,
  outcome wager_status NOT NULL,
  profit_cents_per_100 integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id)
);

CREATE INDEX IF NOT EXISTS ai_snapshot_evaluation_sport_market_idx
  ON ai_snapshot_evaluation (sport, market_key, starts_at);

CREATE INDEX IF NOT EXISTS ai_snapshot_evaluation_outcome_idx
  ON ai_snapshot_evaluation (outcome);

CREATE INDEX IF NOT EXISTS ai_snapshot_evaluation_confidence_idx
  ON ai_snapshot_evaluation (confidence, edge);
