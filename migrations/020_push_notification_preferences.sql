CREATE TABLE IF NOT EXISTS push_notification_preference (
  user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  game_reminder_enabled boolean NOT NULL DEFAULT false,
  game_started_enabled boolean NOT NULL DEFAULT false,
  score_change_enabled boolean NOT NULL DEFAULT false,
  game_final_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
