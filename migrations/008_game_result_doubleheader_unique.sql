ALTER TABLE game_result
  DROP CONSTRAINT IF EXISTS game_result_sport_starts_on_away_team_home_team_source_key;

CREATE UNIQUE INDEX IF NOT EXISTS game_result_legacy_unique_idx
  ON game_result (sport, starts_on, away_team, home_team, source)
  WHERE provider_game_id IS NULL;
