CREATE TABLE IF NOT EXISTS parlay_historical_fetch (
  id uuid PRIMARY KEY,
  sport sport_key NOT NULL,
  sport_key text NOT NULL,
  endpoint text NOT NULL,
  target_date date NOT NULL,
  request_key text NOT NULL UNIQUE,
  request_params jsonb NOT NULL,
  status_code integer NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  credits_estimated integer NOT NULL DEFAULT 0,
  payload jsonb,
  error text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS parlay_historical_fetch_date_idx
  ON parlay_historical_fetch (sport, target_date, endpoint);

CREATE TABLE IF NOT EXISTS historical_game_line (
  id uuid PRIMARY KEY,
  sport sport_key NOT NULL,
  sport_key text NOT NULL,
  provider_event_id text,
  starts_at timestamptz NOT NULL,
  starts_on date NOT NULL,
  home_team text NOT NULL,
  away_team text NOT NULL,
  bookmaker_key text NOT NULL,
  market_key text NOT NULL,
  selected_team text NOT NULL,
  spread numeric(6, 2) NOT NULL DEFAULT 0,
  odds_american integer NOT NULL,
  source_endpoint text NOT NULL,
  raw_payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS historical_game_line_date_market_idx
  ON historical_game_line (sport, starts_on, market_key);

CREATE INDEX IF NOT EXISTS historical_game_line_teams_idx
  ON historical_game_line (sport, starts_on, away_team, home_team);

CREATE UNIQUE INDEX IF NOT EXISTS historical_game_line_unique_idx
  ON historical_game_line (
    sport_key,
    COALESCE(provider_event_id, ''),
    starts_at,
    bookmaker_key,
    market_key,
    selected_team,
    spread,
    source_endpoint
  );
