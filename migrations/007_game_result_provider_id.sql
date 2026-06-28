ALTER TABLE game_result
  ADD COLUMN IF NOT EXISTS provider_game_id text,
  ADD COLUMN IF NOT EXISTS starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS game_number integer,
  ADD COLUMN IF NOT EXISTS result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS game_result_provider_game_idx
  ON game_result (source, provider_game_id)
  WHERE provider_game_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS game_result_provider_lookup_idx
  ON game_result (sport, source, starts_on, away_team, home_team, provider_game_id);
