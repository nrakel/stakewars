CREATE TABLE IF NOT EXISTS reddit_oauth_state (
  state text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS reddit_oauth_state_expires_idx
  ON reddit_oauth_state (expires_at);

CREATE TABLE IF NOT EXISTS reddit_connection (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  reddit_username text,
  refresh_token text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS reddit_post_log (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  subreddit text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  dry_run boolean NOT NULL DEFAULT true,
  status text NOT NULL,
  reddit_fullname text,
  reddit_url text,
  error_message text,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reddit_post_log_user_created_idx
  ON reddit_post_log (user_id, created_at DESC);
