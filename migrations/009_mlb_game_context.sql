CREATE TABLE IF NOT EXISTS mlb_game_context (
  id uuid PRIMARY KEY,
  provider_game_id text NOT NULL UNIQUE,
  starts_on date NOT NULL,
  starts_at timestamptz NOT NULL,
  away_team text NOT NULL,
  home_team text NOT NULL,
  away_team_id integer,
  home_team_id integer,
  away_probable_pitcher_id integer,
  away_probable_pitcher_name text,
  home_probable_pitcher_id integer,
  home_probable_pitcher_name text,
  away_pitcher_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  home_pitcher_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  away_bullpen jsonb NOT NULL DEFAULT '{}'::jsonb,
  home_bullpen jsonb NOT NULL DEFAULT '{}'::jsonb,
  away_injuries jsonb NOT NULL DEFAULT '{}'::jsonb,
  home_injuries jsonb NOT NULL DEFAULT '{}'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mlb_game_context_matchup_idx
  ON mlb_game_context (starts_on, away_team, home_team);

CREATE INDEX IF NOT EXISTS mlb_game_context_team_date_idx
  ON mlb_game_context (starts_on, away_team_id, home_team_id);
