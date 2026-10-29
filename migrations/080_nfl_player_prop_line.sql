CREATE TABLE IF NOT EXISTS nfl_player_prop_line (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES nfl_confidence_game(id) ON DELETE CASCADE,
  provider_event_id text NOT NULL,
  player_name text NOT NULL,
  player_key text NOT NULL,
  stat_key text NOT NULL,
  bookmaker_key text NOT NULL,
  bookmaker_title text NOT NULL,
  market_key text NOT NULL,
  point numeric(8, 2) NOT NULL,
  over_odds integer,
  under_odds integer,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CHECK (stat_key IN ('completions', 'passYards', 'passTds', 'carries', 'rushYards', 'rushTds', 'receptions', 'receivingYards', 'receivingTds')),
  UNIQUE (game_id, player_key, stat_key, bookmaker_key)
);

CREATE INDEX IF NOT EXISTS nfl_player_prop_line_game_player_idx
  ON nfl_player_prop_line (game_id, player_key, stat_key);
