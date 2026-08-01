CREATE TABLE IF NOT EXISTS reddit_post_snapshot (
  id uuid PRIMARY KEY,
  post_date date NOT NULL,
  post_type text NOT NULL CHECK (post_type IN ('single', 'parlay', 'all')),
  locked_at timestamptz NOT NULL DEFAULT now(),
  locked_by_user_id uuid REFERENCES app_user(id),
  title text NOT NULL,
  body text NOT NULL,
  units numeric(8,2) NOT NULL DEFAULT 1.00,
  status wager_status NOT NULL DEFAULT 'pending',
  profit_units numeric(8,2) NOT NULL DEFAULT 0,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_date, post_type)
);

CREATE TABLE IF NOT EXISTS reddit_post_pick_snapshot (
  id uuid PRIMARY KEY,
  reddit_post_id uuid NOT NULL REFERENCES reddit_post_snapshot(id) ON DELETE CASCADE,
  leg_index integer NOT NULL CHECK (leg_index >= 1),
  selected_team text NOT NULL,
  sport sport_key NOT NULL,
  league text NOT NULL,
  market_key text NOT NULL,
  spread numeric(8,2) NOT NULL,
  odds_american integer NOT NULL,
  decimal_odds numeric(8,3) NOT NULL,
  units numeric(8,2) NOT NULL DEFAULT 1.00,
  away_team text NOT NULL,
  home_team text NOT NULL,
  starts_at timestamptz NOT NULL,
  confidence numeric(6,4),
  edge text,
  explanation text,
  source_ai_pick_id uuid,
  source_game_line_id uuid,
  status wager_status NOT NULL DEFAULT 'pending',
  profit_units numeric(8,2) NOT NULL DEFAULT 0,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reddit_post_id, leg_index)
);

CREATE INDEX IF NOT EXISTS reddit_post_snapshot_type_date_idx
  ON reddit_post_snapshot (post_type, post_date);

CREATE INDEX IF NOT EXISTS reddit_post_pick_snapshot_status_idx
  ON reddit_post_pick_snapshot (status);

INSERT INTO reddit_post_snapshot (
  id, post_date, post_type, locked_at, locked_by_user_id, title, body, units, status, profit_units, settled_at, created_at
)
SELECT
  gen_random_uuid(),
  rpt.pick_date,
  'single',
  rpt.locked_at,
  rpt.locked_by_user_id,
  COALESCE(rpt.locked_title, 'StakeWars Chine pick'),
  COALESCE(rpt.locked_body, ''),
  rpt.units,
  rpt.status,
  rpt.profit_units,
  rpt.settled_at,
  COALESCE(rpt.locked_at, now())
FROM reddit_pick_track rpt
WHERE rpt.locked_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM reddit_post_snapshot rps
    WHERE rps.post_date = rpt.pick_date AND rps.post_type = 'single'
  );

INSERT INTO reddit_post_pick_snapshot (
  id, reddit_post_id, leg_index, selected_team, sport, league, market_key, spread,
  odds_american, decimal_odds, units, away_team, home_team, starts_at, confidence,
  edge, explanation, source_ai_pick_id, source_game_line_id, status, profit_units, settled_at, created_at
)
SELECT
  gen_random_uuid(),
  rps.id,
  1,
  rpt.selected_team,
  gl.sport,
  gl.league,
  gl.market_key,
  gl.spread,
  COALESCE(rpt.odds_american, gl.odds_american),
  rpt.decimal_odds,
  rpt.units,
  gl.away_team,
  gl.home_team,
  gl.starts_at,
  p.confidence,
  p.features->>'edge',
  p.explanation,
  rpt.ai_pick_id,
  rpt.game_line_id,
  rpt.status,
  rpt.profit_units,
  rpt.settled_at,
  COALESCE(rpt.locked_at, now())
FROM reddit_pick_track rpt
JOIN reddit_post_snapshot rps ON rps.post_date = rpt.pick_date AND rps.post_type = 'single'
JOIN ai_pick p ON p.id = rpt.ai_pick_id
JOIN game_line gl ON gl.id = rpt.game_line_id
WHERE rpt.locked_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM reddit_post_pick_snapshot rpps
    WHERE rpps.reddit_post_id = rps.id AND rpps.leg_index = 1
  );

INSERT INTO reddit_post_snapshot (
  id, post_date, post_type, locked_at, locked_by_user_id, title, body, units, status, profit_units, settled_at, created_at
)
SELECT
  gen_random_uuid(),
  rpt.pick_date,
  'parlay',
  rpt.locked_at,
  rpt.locked_by_user_id,
  COALESCE(rpt.locked_title, 'StakeWars Chine 3-team parlay'),
  COALESCE(rpt.locked_body, ''),
  rpt.units,
  rpt.status,
  rpt.profit_units,
  rpt.settled_at,
  COALESCE(rpt.locked_at, now())
FROM reddit_parlay_track rpt
WHERE rpt.locked_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM reddit_post_snapshot rps
    WHERE rps.post_date = rpt.pick_date AND rps.post_type = 'parlay'
  );

INSERT INTO reddit_post_pick_snapshot (
  id, reddit_post_id, leg_index, selected_team, sport, league, market_key, spread,
  odds_american, decimal_odds, units, away_team, home_team, starts_at, confidence,
  edge, explanation, source_ai_pick_id, source_game_line_id, status, profit_units, settled_at, created_at
)
SELECT
  gen_random_uuid(),
  rps.id,
  rplt.leg_index,
  rplt.selected_team,
  gl.sport,
  gl.league,
  gl.market_key,
  gl.spread,
  rplt.odds_american,
  rplt.decimal_odds,
  rpt.units,
  gl.away_team,
  gl.home_team,
  gl.starts_at,
  p.confidence,
  p.features->>'edge',
  p.explanation,
  rplt.ai_pick_id,
  rplt.game_line_id,
  rplt.status,
  0,
  rplt.settled_at,
  COALESCE(rpt.locked_at, now())
FROM reddit_parlay_leg_track rplt
JOIN reddit_parlay_track rpt ON rpt.id = rplt.parlay_id
JOIN reddit_post_snapshot rps ON rps.post_date = rpt.pick_date AND rps.post_type = 'parlay'
JOIN ai_pick p ON p.id = rplt.ai_pick_id
JOIN game_line gl ON gl.id = rplt.game_line_id
WHERE rpt.locked_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM reddit_post_pick_snapshot rpps
    WHERE rpps.reddit_post_id = rps.id AND rpps.leg_index = rplt.leg_index
  );

INSERT INTO reddit_post_snapshot (
  id, post_date, post_type, locked_at, locked_by_user_id, title, body, units, status, profit_units, settled_at, created_at
)
SELECT
  gen_random_uuid(),
  rapt.pick_date,
  'all',
  rapt.locked_at,
  rapt.locked_by_user_id,
  COALESCE(rapt.locked_title, 'StakeWars Chine all picks'),
  COALESCE(rapt.locked_body, ''),
  1.00,
  CASE
    WHEN count(*) FILTER (WHERE rapl.status = 'pending') > 0 THEN 'pending'::wager_status
    WHEN count(*) FILTER (WHERE rapl.status = 'lost') > 0 THEN 'lost'::wager_status
    WHEN count(*) FILTER (WHERE rapl.status = 'won') > 0 THEN 'won'::wager_status
    ELSE 'push'::wager_status
  END,
  COALESCE(sum(rapl.profit_units), 0)::numeric(8,2),
  max(rapl.settled_at),
  COALESCE(rapt.locked_at, now())
FROM reddit_all_pick_track rapt
JOIN reddit_all_pick_leg_track rapl ON rapl.all_pick_id = rapt.id
WHERE rapt.locked_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM reddit_post_snapshot rps
    WHERE rps.post_date = rapt.pick_date AND rps.post_type = 'all'
  )
GROUP BY rapt.id, rapt.pick_date, rapt.locked_at, rapt.locked_by_user_id, rapt.locked_title, rapt.locked_body;

INSERT INTO reddit_post_pick_snapshot (
  id, reddit_post_id, leg_index, selected_team, sport, league, market_key, spread,
  odds_american, decimal_odds, units, away_team, home_team, starts_at, confidence,
  edge, explanation, source_ai_pick_id, source_game_line_id, status, profit_units, settled_at, created_at
)
SELECT
  gen_random_uuid(),
  rps.id,
  rapl.leg_index,
  rapl.selected_team,
  gl.sport,
  gl.league,
  gl.market_key,
  gl.spread,
  rapl.odds_american,
  rapl.decimal_odds,
  1.00,
  gl.away_team,
  gl.home_team,
  gl.starts_at,
  p.confidence,
  p.features->>'edge',
  p.explanation,
  rapl.ai_pick_id,
  rapl.game_line_id,
  rapl.status,
  rapl.profit_units,
  rapl.settled_at,
  COALESCE(rapt.locked_at, now())
FROM reddit_all_pick_leg_track rapl
JOIN reddit_all_pick_track rapt ON rapt.id = rapl.all_pick_id
JOIN reddit_post_snapshot rps ON rps.post_date = rapt.pick_date AND rps.post_type = 'all'
JOIN ai_pick p ON p.id = rapl.ai_pick_id
JOIN game_line gl ON gl.id = rapl.game_line_id
WHERE rapt.locked_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM reddit_post_pick_snapshot rpps
    WHERE rpps.reddit_post_id = rps.id AND rpps.leg_index = rapl.leg_index
  );
