ALTER TABLE game_line
  DROP CONSTRAINT IF EXISTS game_line_check;

CREATE UNIQUE INDEX IF NOT EXISTS app_user_username_lower_unique_idx
  ON app_user (lower(username));
