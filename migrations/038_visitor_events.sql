CREATE TABLE IF NOT EXISTS visitor_event (
  event_key text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  local_date date NOT NULL,
  host text NOT NULL,
  visitor_key text NOT NULL,
  is_human boolean NOT NULL,
  path text NOT NULL,
  status_code integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS visitor_event_local_date_idx
  ON visitor_event (local_date);

CREATE INDEX IF NOT EXISTS visitor_event_local_date_human_idx
  ON visitor_event (local_date, is_human);

CREATE INDEX IF NOT EXISTS visitor_event_visitor_date_idx
  ON visitor_event (visitor_key, local_date);
