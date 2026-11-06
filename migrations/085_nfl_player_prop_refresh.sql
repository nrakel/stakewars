CREATE TABLE IF NOT EXISTS nfl_player_prop_refresh (
  game_id uuid PRIMARY KEY REFERENCES nfl_confidence_game(id) ON DELETE CASCADE,
  status text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  row_count integer NOT NULL DEFAULT 0,
  error text,
  CHECK (status IN ('running', 'success', 'failed')),
  CHECK (row_count >= 0)
);

CREATE INDEX IF NOT EXISTS nfl_player_prop_refresh_status_idx
  ON nfl_player_prop_refresh (status, attempted_at);
