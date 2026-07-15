INSERT INTO reddit_pick_track (
  id,
  pick_date,
  ai_pick_id,
  game_line_id,
  selected_team,
  units,
  decimal_odds,
  status,
  profit_units,
  settled_at
)
SELECT
  '5989227a-a4fb-4a7b-9d67-43ebb60d0ae4'::uuid,
  DATE '2026-07-10',
  p.id,
  p.game_line_id,
  p.selected_team,
  CASE
    WHEN p.confidence >= 0.80 THEN 3.00
    WHEN p.confidence >= 0.77 THEN 2.00
    ELSE 1.00
  END,
  (CASE
    WHEN gl.odds_american > 0 THEN 1 + gl.odds_american / 100.0
    ELSE 1 + 100.0 / abs(gl.odds_american)
  END)::numeric(8,3),
  'lost'::wager_status,
  -(
    CASE
      WHEN p.confidence >= 0.80 THEN 3.00
      WHEN p.confidence >= 0.77 THEN 2.00
      ELSE 1.00
    END
  )::numeric(8,2),
  now()
FROM ai_pick p
JOIN game_line gl ON gl.id = p.game_line_id
WHERE p.published_for = DATE '2026-07-10'
  AND p.selected_team = 'Minnesota Twins'
ORDER BY p.created_at DESC
LIMIT 1
ON CONFLICT (pick_date) DO UPDATE
SET ai_pick_id = EXCLUDED.ai_pick_id,
    game_line_id = EXCLUDED.game_line_id,
    selected_team = EXCLUDED.selected_team,
    units = EXCLUDED.units,
    decimal_odds = EXCLUDED.decimal_odds,
    status = EXCLUDED.status,
    profit_units = EXCLUDED.profit_units,
    settled_at = EXCLUDED.settled_at;

UPDATE reddit_parlay_track
SET status = 'lost'::wager_status,
    profit_units = -1.00,
    settled_at = now()
WHERE pick_date = DATE '2026-07-10';

DELETE FROM reddit_parlay_leg_track
WHERE parlay_id IN (
  SELECT id
  FROM reddit_parlay_track
  WHERE pick_date = DATE '2026-07-10'
);

WITH tracked_parlay AS (
  SELECT id
  FROM reddit_parlay_track
  WHERE pick_date = DATE '2026-07-10'
),
posted_legs(id, selected_team, leg_index, decimal_odds, odds_american) AS (
  VALUES
    ('3ca8cf6f-2d3d-4f74-9738-5e8c1706dd89'::uuid, 'Los Angeles Dodgers', 1, 1.488::numeric(8,3), -205),
    ('33230467-4ec6-436d-9933-e8fd19c15e0f'::uuid, 'Minnesota Twins', 2, 1.633::numeric(8,3), -158),
    ('363bb95e-5d67-4389-9c6c-f47a24fa825c'::uuid, 'Chicago Cubs', 3, 1.862::numeric(8,3), -116)
),
pick_rows AS (
  SELECT DISTINCT ON (posted_legs.leg_index)
    posted_legs.*,
    p.id AS ai_pick_id,
    p.game_line_id
  FROM posted_legs
  JOIN ai_pick p
    ON p.published_for = DATE '2026-07-10'
   AND p.selected_team = posted_legs.selected_team
  ORDER BY posted_legs.leg_index, p.created_at DESC
)
INSERT INTO reddit_parlay_leg_track (
  id,
  parlay_id,
  ai_pick_id,
  game_line_id,
  selected_team,
  leg_index,
  decimal_odds,
  odds_american,
  status,
  settled_at
)
SELECT
  pick_rows.id,
  tracked_parlay.id,
  pick_rows.ai_pick_id,
  pick_rows.game_line_id,
  pick_rows.selected_team,
  pick_rows.leg_index,
  pick_rows.decimal_odds,
  pick_rows.odds_american,
  'lost'::wager_status,
  now()
FROM tracked_parlay
JOIN pick_rows ON true
ON CONFLICT (parlay_id, leg_index) DO UPDATE
SET ai_pick_id = EXCLUDED.ai_pick_id,
    game_line_id = EXCLUDED.game_line_id,
    selected_team = EXCLUDED.selected_team,
    decimal_odds = EXCLUDED.decimal_odds,
    odds_american = EXCLUDED.odds_american,
    status = EXCLUDED.status,
    settled_at = EXCLUDED.settled_at;
