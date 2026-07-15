ALTER TABLE mlb_pitcher_rolling_metric
  ADD COLUMN IF NOT EXISTS sw_fip numeric(7,3),
  ADD COLUMN IF NOT EXISTS sw_xfip numeric(7,3),
  ADD COLUMN IF NOT EXISTS sw_siera numeric(7,3);

ALTER TABLE mlb_team_bullpen_rolling_metric
  ADD COLUMN IF NOT EXISTS sw_fip numeric(7,3),
  ADD COLUMN IF NOT EXISTS sw_xfip numeric(7,3),
  ADD COLUMN IF NOT EXISTS sw_siera numeric(7,3);
