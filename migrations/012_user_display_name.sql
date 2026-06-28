ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS display_name text;

ALTER TABLE app_user
  DROP CONSTRAINT IF EXISTS app_user_display_name_length;

ALTER TABLE app_user
  ADD CONSTRAINT app_user_display_name_length
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 2 AND 40);
