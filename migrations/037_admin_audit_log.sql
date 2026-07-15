CREATE TABLE IF NOT EXISTS admin_audit_log (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  action text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_log_user_created_idx
  ON admin_audit_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_audit_log_action_created_idx
  ON admin_audit_log (action, created_at DESC);
