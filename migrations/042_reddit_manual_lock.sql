ALTER TABLE reddit_pick_track
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by_user_id uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS locked_title text,
  ADD COLUMN IF NOT EXISTS locked_body text;

ALTER TABLE reddit_parlay_track
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by_user_id uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS locked_title text,
  ADD COLUMN IF NOT EXISTS locked_body text;
