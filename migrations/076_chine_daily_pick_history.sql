CREATE TABLE IF NOT EXISTS chine_daily_pick (
  id uuid PRIMARY KEY,
  pick_date date NOT NULL,
  sport sport_key NOT NULL,
  game_key text NOT NULL,
  game_line_id uuid REFERENCES game_line(id) ON DELETE SET NULL,
  away_team text NOT NULL,
  home_team text NOT NULL,
  starts_at timestamptz NOT NULL,
  selected_team text NOT NULL,
  market_key text NOT NULL,
  spread numeric(5, 1) NOT NULL,
  odds_american integer NOT NULL,
  confidence numeric(7, 6) NOT NULL,
  model_version text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (confidence BETWEEN 0 AND 1),
  UNIQUE (pick_date, sport, game_key)
);

CREATE INDEX IF NOT EXISTS chine_daily_pick_date_sport_idx
  ON chine_daily_pick (pick_date DESC, sport, confidence DESC);

WITH historical AS (
  SELECT
    c.id,
    r.run_for AS pick_date,
    r.sport,
    COALESCE(
      NULLIF(CASE
        WHEN split_part(gl.provider_event_id, '|', 1) LIKE 'americanfootball\_%' ESCAPE '\'
          THEN split_part(gl.provider_event_id, '|', 2)
        ELSE split_part(split_part(gl.provider_event_id, ':', 1), '|', 1)
      END, ''),
      concat_ws('|', r.sport::text, gl.away_team, gl.home_team, gl.starts_at::date::text)
    ) AS game_key,
    c.game_line_id,
    gl.away_team,
    gl.home_team,
    gl.starts_at,
    c.selected_team,
    gl.market_key,
    gl.spread,
    gl.odds_american,
    c.confidence,
    r.model_version,
    c.created_at,
    row_number() OVER (
      PARTITION BY
        r.run_for,
        r.sport,
        COALESCE(
          NULLIF(CASE
            WHEN split_part(gl.provider_event_id, '|', 1) LIKE 'americanfootball\_%' ESCAPE '\'
              THEN split_part(gl.provider_event_id, '|', 2)
            ELSE split_part(split_part(gl.provider_event_id, ':', 1), '|', 1)
          END, ''),
          concat_ws('|', r.sport::text, gl.away_team, gl.home_team, gl.starts_at::date::text)
        )
      ORDER BY c.confidence DESC, c.score DESC, c.created_at ASC
    ) AS game_rank
  FROM ai_pick_candidate c
  JOIN ai_model_run r ON r.id = c.run_id
  JOIN game_line gl ON gl.id = c.game_line_id
  WHERE (
      r.sport IN ('NFL', 'NCAAF') AND gl.market_key = 'spreads'
    ) OR (
      r.sport IN ('MLB', 'NHL', 'NBA', 'NCAAMB') AND gl.market_key = 'h2h'
    )
)
INSERT INTO chine_daily_pick (
  id, pick_date, sport, game_key, game_line_id, away_team, home_team,
  starts_at, selected_team, market_key, spread, odds_american,
  confidence, model_version, recorded_at
)
SELECT
  id, pick_date, sport, game_key, game_line_id, away_team, home_team,
  starts_at, selected_team, market_key, spread, odds_american,
  confidence, model_version, created_at
FROM historical
WHERE game_rank = 1
ON CONFLICT (pick_date, sport, game_key) DO NOTHING;
