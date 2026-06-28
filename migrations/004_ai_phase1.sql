CREATE TABLE IF NOT EXISTS ai_model_run (
  id uuid PRIMARY KEY,
  model_version text NOT NULL,
  sport sport_key NOT NULL,
  run_for date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  UNIQUE (model_version, sport, run_for)
);

CREATE TABLE IF NOT EXISTS ai_pick_candidate (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES ai_model_run(id) ON DELETE CASCADE,
  game_line_id uuid NOT NULL REFERENCES game_line(id),
  selected_team text NOT NULL,
  score numeric(8, 4) NOT NULL,
  confidence numeric(5, 4) NOT NULL,
  implied_probability numeric(7, 6) NOT NULL,
  fair_probability numeric(7, 6) NOT NULL,
  edge numeric(7, 6) NOT NULL,
  features jsonb NOT NULL,
  reasons text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, game_line_id)
);

ALTER TABLE ai_pick
  ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES ai_model_run(id),
  ADD COLUMN IF NOT EXISTS score numeric(8, 4),
  ADD COLUMN IF NOT EXISTS confidence numeric(5, 4),
  ADD COLUMN IF NOT EXISTS reasons text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb;
