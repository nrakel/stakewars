CREATE TABLE IF NOT EXISTS reddit_parlay_track (
  id uuid PRIMARY KEY,
  pick_date date NOT NULL UNIQUE,
  units numeric(5,2) NOT NULL DEFAULT 1.00,
  status wager_status NOT NULL DEFAULT 'pending',
  profit_units numeric(8,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE TABLE IF NOT EXISTS reddit_parlay_leg_track (
  id uuid PRIMARY KEY,
  parlay_id uuid NOT NULL REFERENCES reddit_parlay_track(id) ON DELETE CASCADE,
  ai_pick_id uuid NOT NULL REFERENCES ai_pick(id) ON DELETE CASCADE,
  game_line_id uuid NOT NULL REFERENCES game_line(id),
  selected_team text NOT NULL,
  leg_index integer NOT NULL CHECK (leg_index BETWEEN 1 AND 3),
  decimal_odds numeric(8,3) NOT NULL,
  odds_american integer NOT NULL,
  status wager_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (parlay_id, leg_index),
  UNIQUE (parlay_id, ai_pick_id)
);

CREATE INDEX IF NOT EXISTS reddit_parlay_track_status_date_idx
  ON reddit_parlay_track (status, pick_date);

CREATE INDEX IF NOT EXISTS reddit_parlay_leg_track_status_idx
  ON reddit_parlay_leg_track (status);
