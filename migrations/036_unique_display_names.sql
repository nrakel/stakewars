CREATE UNIQUE INDEX IF NOT EXISTS app_user_display_name_unique_lower_idx
  ON app_user (lower(trim(display_name)))
  WHERE nullif(trim(display_name), '') IS NOT NULL;
