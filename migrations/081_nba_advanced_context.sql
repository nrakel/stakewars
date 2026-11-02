CREATE TABLE IF NOT EXISTS nba_team_game_metric (
  provider_game_id text NOT NULL,
  starts_on date NOT NULL,
  team text NOT NULL,
  opponent text NOT NULL,
  is_home boolean NOT NULL,
  possessions numeric(8, 3) NOT NULL,
  offensive_rating numeric(8, 3) NOT NULL,
  defensive_rating numeric(8, 3) NOT NULL,
  pace numeric(8, 3) NOT NULL,
  player_minutes jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_game_id, team)
);

CREATE INDEX IF NOT EXISTS nba_team_game_metric_team_date_idx
  ON nba_team_game_metric (team, starts_on DESC);

CREATE TABLE IF NOT EXISTS nba_event_availability (
  event_key text NOT NULL,
  starts_on date NOT NULL,
  team text NOT NULL,
  unavailable_players integer NOT NULL DEFAULT 0,
  questionable_players integer NOT NULL DEFAULT 0,
  unavailable_rotation_minutes numeric(8, 3) NOT NULL DEFAULT 0,
  questionable_rotation_minutes numeric(8, 3) NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_key, team)
);

CREATE INDEX IF NOT EXISTS nba_event_availability_date_team_idx
  ON nba_event_availability (starts_on, team);
