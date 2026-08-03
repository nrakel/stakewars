CREATE TABLE IF NOT EXISTS survivor_pool (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  season integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  starts_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('active', 'completed', 'archived')),
  CHECK (length(name) BETWEEN 2 AND 120)
);

CREATE UNIQUE INDEX IF NOT EXISTS survivor_pool_active_unique_idx
  ON survivor_pool ((status))
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS survivor_entry (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL REFERENCES survivor_pool(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  eliminated_week_start date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('active', 'eliminated', 'winner')),
  CHECK (
    (status = 'active' AND eliminated_week_start IS NULL)
    OR (status <> 'active')
  ),
  UNIQUE (pool_id, user_id)
);

CREATE INDEX IF NOT EXISTS survivor_entry_pool_status_idx
  ON survivor_entry (pool_id, status, created_at);

CREATE TABLE IF NOT EXISTS survivor_pick (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL REFERENCES survivor_pool(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES survivor_entry(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  game_line_id uuid REFERENCES game_line(id) ON DELETE SET NULL,
  selected_team text NOT NULL,
  away_team text NOT NULL,
  home_team text NOT NULL,
  starts_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  locked_at timestamptz,
  settled_at timestamptz,
  admin_overridden_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  admin_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('pending', 'won', 'lost', 'tie', 'no_pick', 'void')),
  CHECK (length(selected_team) BETWEEN 1 AND 120),
  CHECK (admin_note IS NULL OR length(admin_note) <= 500),
  UNIQUE (entry_id, week_start),
  UNIQUE (entry_id, selected_team)
);

CREATE INDEX IF NOT EXISTS survivor_pick_pool_week_idx
  ON survivor_pick (pool_id, week_start, status, starts_at);

CREATE INDEX IF NOT EXISTS survivor_pick_user_idx
  ON survivor_pick (user_id, week_start DESC);

INSERT INTO survivor_pool (id, name, season, starts_on)
SELECT gen_random_uuid(), 'StakeWars NFL Survivor', 2026, '2026-09-07'::date
WHERE NOT EXISTS (SELECT 1 FROM survivor_pool WHERE status = 'active');
