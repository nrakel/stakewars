DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('player', 'admin', 'system');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE sport_key AS ENUM ('MLB', 'NHL', 'NFL', 'NBA', 'NCAAMB', 'NCAAF');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE wager_kind AS ENUM ('straight', 'parlay', 'round_robin');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE wager_status AS ENUM ('pending', 'won', 'lost', 'push', 'void');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS app_user (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (char_length(username) BETWEEN 3 AND 32),
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'player',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_line (
  id uuid PRIMARY KEY,
  provider_event_id text,
  sport sport_key NOT NULL,
  league text NOT NULL,
  starts_at timestamptz NOT NULL,
  home_team text NOT NULL,
  away_team text NOT NULL,
  favorite_team text NOT NULL,
  spread numeric(5, 1) NOT NULL,
  odds_american integer NOT NULL DEFAULT -110,
  source text NOT NULL DEFAULT 'manual',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  CHECK (favorite_team IN (home_team, away_team))
);

CREATE INDEX IF NOT EXISTS game_line_active_starts_idx ON game_line (is_active, starts_at);
CREATE INDEX IF NOT EXISTS game_line_sport_idx ON game_line (sport);

CREATE TABLE IF NOT EXISTS weekly_entry (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  week_starts_on date NOT NULL,
  starting_bankroll_cents integer NOT NULL,
  balance_cents integer NOT NULL,
  settled_profit_cents integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_starts_on)
);

CREATE INDEX IF NOT EXISTS weekly_entry_week_balance_idx ON weekly_entry (week_starts_on, balance_cents DESC);

CREATE TABLE IF NOT EXISTS wager (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  weekly_entry_id uuid NOT NULL REFERENCES weekly_entry(id) ON DELETE CASCADE,
  kind wager_kind NOT NULL,
  stake_cents integer NOT NULL CHECK (stake_cents > 0),
  potential_payout_cents integer NOT NULL CHECK (potential_payout_cents >= 0),
  status wager_status NOT NULL DEFAULT 'pending',
  legs_count integer NOT NULL CHECK (legs_count BETWEEN 1 AND 5),
  round_robin_ways integer CHECK (round_robin_ways IS NULL OR round_robin_ways BETWEEN 1 AND 26),
  placed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wager_user_status_idx ON wager (user_id, status);
CREATE INDEX IF NOT EXISTS wager_week_idx ON wager (weekly_entry_id);

CREATE TABLE IF NOT EXISTS wager_leg (
  id uuid PRIMARY KEY,
  wager_id uuid NOT NULL REFERENCES wager(id) ON DELETE CASCADE,
  game_line_id uuid NOT NULL REFERENCES game_line(id),
  selected_team text NOT NULL,
  spread numeric(5, 1) NOT NULL,
  odds_american integer NOT NULL,
  status wager_status NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS ai_pick (
  id uuid PRIMARY KEY,
  game_line_id uuid NOT NULL REFERENCES game_line(id),
  selected_team text NOT NULL,
  published_for date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_line_id, published_for)
);
