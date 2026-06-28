CREATE TABLE IF NOT EXISTS live_game_state (
  match_id text PRIMARY KEY,
  sport sport_key NOT NULL,
  provider text NOT NULL DEFAULT 'parlay-api',
  event_key text,
  starts_at timestamptz,
  away_team text NOT NULL,
  home_team text NOT NULL,
  away_score integer,
  home_score integer,
  period text,
  game_status text,
  description text,
  batter text,
  pitcher text,
  in_play boolean NOT NULL DEFAULT false,
  last_event_at timestamptz,
  bases jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_game_state_sport_fetched_idx
  ON live_game_state (sport, fetched_at DESC);

CREATE INDEX IF NOT EXISTS live_game_state_event_key_idx
  ON live_game_state (event_key);

CREATE INDEX IF NOT EXISTS live_game_state_recent_idx
  ON live_game_state (sport, in_play, last_event_at DESC);
