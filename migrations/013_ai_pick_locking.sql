ALTER TABLE ai_pick
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS wager_id uuid REFERENCES wager(id);

CREATE INDEX IF NOT EXISTS ai_pick_published_locked_idx
  ON ai_pick (published_for, locked_at);
