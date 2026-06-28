ALTER TABLE live_game_state
  ADD COLUMN IF NOT EXISTS in_play boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz;

CREATE INDEX IF NOT EXISTS live_game_state_recent_idx
  ON live_game_state (sport, in_play, last_event_at DESC);
