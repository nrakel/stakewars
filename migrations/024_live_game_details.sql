ALTER TABLE live_game_state
  ADD COLUMN IF NOT EXISTS last_play text,
  ADD COLUMN IF NOT EXISTS inning text,
  ADD COLUMN IF NOT EXISTS balls integer,
  ADD COLUMN IF NOT EXISTS strikes integer,
  ADD COLUMN IF NOT EXISTS outs integer,
  ADD COLUMN IF NOT EXISTS pitcher_pitches integer,
  ADD COLUMN IF NOT EXISTS batter_hits integer,
  ADD COLUMN IF NOT EXISTS batter_at_bats integer;
