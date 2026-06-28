CREATE TABLE IF NOT EXISTS notification_log (
  id uuid PRIMARY KEY,
  notification_key text NOT NULL UNIQUE,
  title text NOT NULL,
  body text NOT NULL,
  url text NOT NULL DEFAULT '/',
  target_count integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  removed_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
