CREATE TABLE IF NOT EXISTS ai_candidate_snapshot (
  id uuid PRIMARY KEY,
  captured_at timestamptz NOT NULL DEFAULT now(),
  model_version text NOT NULL,
  sport sport_key NOT NULL,
  game_line_id uuid NOT NULL REFERENCES game_line(id),
  provider_event_id text,
  market_key text NOT NULL,
  selected_team text NOT NULL,
  away_team text NOT NULL,
  home_team text NOT NULL,
  starts_at timestamptz NOT NULL,
  odds_american integer NOT NULL,
  spread numeric(5, 1) NOT NULL,
  score numeric(8, 4) NOT NULL,
  confidence numeric(5, 4) NOT NULL,
  implied_probability numeric(7, 6) NOT NULL,
  fair_probability numeric(7, 6) NOT NULL,
  edge numeric(7, 6) NOT NULL,
  features jsonb NOT NULL,
  reasons text[] NOT NULL,
  source text NOT NULL DEFAULT 'active-odds-refresh',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_candidate_snapshot_captured_idx
  ON ai_candidate_snapshot (captured_at DESC);

CREATE INDEX IF NOT EXISTS ai_candidate_snapshot_sport_market_idx
  ON ai_candidate_snapshot (sport, market_key, starts_at);

CREATE INDEX IF NOT EXISTS ai_candidate_snapshot_game_line_idx
  ON ai_candidate_snapshot (game_line_id, captured_at DESC);
