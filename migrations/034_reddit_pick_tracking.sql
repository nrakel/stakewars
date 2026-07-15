CREATE TABLE IF NOT EXISTS reddit_pick_track (
  id uuid PRIMARY KEY,
  pick_date date NOT NULL UNIQUE,
  ai_pick_id uuid NOT NULL REFERENCES ai_pick(id) ON DELETE CASCADE,
  game_line_id uuid NOT NULL REFERENCES game_line(id),
  selected_team text NOT NULL,
  units numeric(5,2) NOT NULL DEFAULT 1.00,
  decimal_odds numeric(8,3) NOT NULL,
  status wager_status NOT NULL DEFAULT 'pending',
  profit_units numeric(8,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX IF NOT EXISTS reddit_pick_track_status_date_idx
  ON reddit_pick_track (status, pick_date);
