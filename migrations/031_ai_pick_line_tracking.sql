ALTER TABLE ai_pick
  ADD COLUMN IF NOT EXISTS model_version text,
  ADD COLUMN IF NOT EXISTS locked_odds_american integer,
  ADD COLUMN IF NOT EXISTS locked_spread numeric(5, 1),
  ADD COLUMN IF NOT EXISTS locked_line_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS closing_game_line_id uuid REFERENCES game_line(id),
  ADD COLUMN IF NOT EXISTS closing_odds_american integer,
  ADD COLUMN IF NOT EXISTS closing_spread numeric(5, 1),
  ADD COLUMN IF NOT EXISTS closing_captured_at timestamptz;

CREATE INDEX IF NOT EXISTS ai_pick_model_version_idx
  ON ai_pick (model_version);

CREATE INDEX IF NOT EXISTS ai_pick_closing_line_pending_idx
  ON ai_pick (published_for, closing_odds_american)
  WHERE locked_at IS NOT NULL AND closing_odds_american IS NULL;
