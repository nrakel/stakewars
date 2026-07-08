CREATE TABLE IF NOT EXISTS parlay_usage_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  credits_before integer NOT NULL,
  credits_after integer NOT NULL,
  credits_delta integer NOT NULL,
  credits_remaining integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS parlay_usage_log_created_at_idx
  ON parlay_usage_log (created_at);

CREATE INDEX IF NOT EXISTS parlay_usage_log_job_created_at_idx
  ON parlay_usage_log (job_name, created_at);
