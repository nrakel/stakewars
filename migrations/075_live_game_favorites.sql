CREATE TABLE IF NOT EXISTS live_game_favorite (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  sport sport_key NOT NULL,
  event_key text NOT NULL,
  match_id text NOT NULL,
  starts_at timestamptz,
  away_team text NOT NULL,
  home_team text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT live_game_favorite_supported_sport CHECK (sport IN ('MLB', 'NFL', 'NHL', 'NCAAF')),
  CONSTRAINT live_game_favorite_user_event_unique UNIQUE (user_id, sport, event_key)
);

CREATE INDEX IF NOT EXISTS live_game_favorite_lookup_idx
  ON live_game_favorite (sport, event_key, user_id);
