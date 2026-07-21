CREATE TABLE IF NOT EXISTS reddit_all_pick_track (
  id uuid PRIMARY KEY,
  pick_date date NOT NULL UNIQUE,
  locked_at timestamptz,
  locked_by_user_id uuid REFERENCES app_user(id),
  locked_title text,
  locked_body text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reddit_all_pick_leg_track (
  id uuid PRIMARY KEY,
  all_pick_id uuid NOT NULL REFERENCES reddit_all_pick_track(id) ON DELETE CASCADE,
  ai_pick_id uuid NOT NULL REFERENCES ai_pick(id) ON DELETE CASCADE,
  game_line_id uuid NOT NULL REFERENCES game_line(id),
  selected_team text NOT NULL,
  leg_index integer NOT NULL CHECK (leg_index >= 1),
  decimal_odds numeric(8,3) NOT NULL,
  odds_american integer NOT NULL,
  status wager_status NOT NULL DEFAULT 'pending',
  profit_units numeric(8,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (all_pick_id, leg_index),
  UNIQUE (all_pick_id, ai_pick_id)
);

CREATE INDEX IF NOT EXISTS reddit_all_pick_track_date_idx
  ON reddit_all_pick_track (pick_date);

CREATE INDEX IF NOT EXISTS reddit_all_pick_leg_track_status_idx
  ON reddit_all_pick_leg_track (status);
