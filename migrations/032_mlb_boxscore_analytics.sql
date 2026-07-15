CREATE TABLE IF NOT EXISTS mlb_boxscore_game (
  provider_game_id text PRIMARY KEY,
  starts_on date NOT NULL,
  starts_at timestamptz NOT NULL,
  season integer NOT NULL,
  away_team_id integer NOT NULL,
  away_team text NOT NULL,
  home_team_id integer NOT NULL,
  home_team text NOT NULL,
  away_score integer,
  home_score integer,
  status text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mlb_boxscore_game_starts_on_idx
  ON mlb_boxscore_game (starts_on);

CREATE TABLE IF NOT EXISTS mlb_boxscore_pitcher (
  id uuid PRIMARY KEY,
  provider_game_id text NOT NULL REFERENCES mlb_boxscore_game(provider_game_id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  starts_at timestamptz NOT NULL,
  season integer NOT NULL,
  team_id integer NOT NULL,
  team_name text NOT NULL,
  opponent_team_id integer NOT NULL,
  opponent_team_name text NOT NULL,
  is_home boolean NOT NULL,
  player_id integer NOT NULL,
  player_name text NOT NULL,
  is_starter boolean NOT NULL DEFAULT false,
  outs integer NOT NULL DEFAULT 0,
  innings_pitched numeric(5,1) NOT NULL DEFAULT 0,
  earned_runs integer NOT NULL DEFAULT 0,
  runs integer NOT NULL DEFAULT 0,
  hits integer NOT NULL DEFAULT 0,
  walks integer NOT NULL DEFAULT 0,
  intentional_walks integer NOT NULL DEFAULT 0,
  hit_batsmen integer NOT NULL DEFAULT 0,
  strikeouts integer NOT NULL DEFAULT 0,
  home_runs integer NOT NULL DEFAULT 0,
  batters_faced integer NOT NULL DEFAULT 0,
  pitches integer NOT NULL DEFAULT 0,
  ground_outs integer NOT NULL DEFAULT 0,
  air_outs integer NOT NULL DEFAULT 0,
  fly_outs integer NOT NULL DEFAULT 0,
  pop_outs integer NOT NULL DEFAULT 0,
  line_outs integer NOT NULL DEFAULT 0,
  inherited_runners integer NOT NULL DEFAULT 0,
  inherited_runners_scored integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_game_id, team_id, player_id)
);

CREATE INDEX IF NOT EXISTS mlb_boxscore_pitcher_player_date_idx
  ON mlb_boxscore_pitcher (player_id, starts_on);

CREATE INDEX IF NOT EXISTS mlb_boxscore_pitcher_team_date_idx
  ON mlb_boxscore_pitcher (team_id, starts_on);

CREATE TABLE IF NOT EXISTS mlb_pitcher_rolling_metric (
  id uuid PRIMARY KEY,
  as_of_date date NOT NULL,
  player_id integer NOT NULL,
  player_name text NOT NULL,
  team_id integer,
  team_name text,
  role text NOT NULL,
  window_days integer NOT NULL,
  games integer NOT NULL,
  starts integer NOT NULL,
  relief_appearances integer NOT NULL,
  outs integer NOT NULL,
  innings_pitched numeric(7,1) NOT NULL,
  earned_runs integer NOT NULL,
  home_runs integer NOT NULL,
  expected_home_runs numeric(8,3),
  walks integer NOT NULL,
  intentional_walks integer NOT NULL,
  hit_batsmen integer NOT NULL,
  strikeouts integer NOT NULL,
  batters_faced integer NOT NULL,
  pitches integer NOT NULL,
  ground_outs integer NOT NULL,
  air_outs integer NOT NULL,
  fly_ball_proxy integer NOT NULL,
  era numeric(7,3),
  fip numeric(7,3),
  xfip_like numeric(7,3),
  k_pct numeric(7,5),
  bb_pct numeric(7,5),
  k_minus_bb_pct numeric(7,5),
  hr_per_9 numeric(7,3),
  pitches_per_inning numeric(7,3),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (as_of_date, player_id, role, window_days)
);

CREATE INDEX IF NOT EXISTS mlb_pitcher_rolling_metric_lookup_idx
  ON mlb_pitcher_rolling_metric (as_of_date, player_id, role, window_days);

CREATE TABLE IF NOT EXISTS mlb_team_bullpen_rolling_metric (
  id uuid PRIMARY KEY,
  as_of_date date NOT NULL,
  team_id integer NOT NULL,
  team_name text NOT NULL,
  window_days integer NOT NULL,
  games integer NOT NULL,
  reliever_appearances integer NOT NULL,
  outs integer NOT NULL,
  innings_pitched numeric(7,1) NOT NULL,
  earned_runs integer NOT NULL,
  home_runs integer NOT NULL,
  expected_home_runs numeric(8,3),
  walks integer NOT NULL,
  intentional_walks integer NOT NULL,
  hit_batsmen integer NOT NULL,
  strikeouts integer NOT NULL,
  batters_faced integer NOT NULL,
  pitches integer NOT NULL,
  ground_outs integer NOT NULL,
  air_outs integer NOT NULL,
  fly_ball_proxy integer NOT NULL,
  era numeric(7,3),
  fip numeric(7,3),
  xfip_like numeric(7,3),
  k_pct numeric(7,5),
  bb_pct numeric(7,5),
  k_minus_bb_pct numeric(7,5),
  hr_per_9 numeric(7,3),
  pitches_per_inning numeric(7,3),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (as_of_date, team_id, window_days)
);

CREATE INDEX IF NOT EXISTS mlb_team_bullpen_rolling_metric_lookup_idx
  ON mlb_team_bullpen_rolling_metric (as_of_date, team_id, window_days);
