ALTER TABLE game_line
  ADD COLUMN IF NOT EXISTS market_key text NOT NULL DEFAULT 'spreads';

CREATE INDEX IF NOT EXISTS game_line_market_key_idx ON game_line (market_key);
