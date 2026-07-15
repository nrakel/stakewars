ALTER TABLE reddit_pick_track
  ADD COLUMN IF NOT EXISTS odds_american integer;

UPDATE reddit_pick_track rpt
SET odds_american = gl.odds_american
FROM game_line gl
WHERE gl.id = rpt.game_line_id
  AND rpt.odds_american IS NULL;

INSERT INTO reddit_pick_track (
  id,
  pick_date,
  ai_pick_id,
  game_line_id,
  selected_team,
  units,
  decimal_odds,
  odds_american,
  status,
  profit_units,
  settled_at,
  locked_at,
  locked_title,
  locked_body
)
VALUES (
  '42331d69-58ef-4d38-8d71-f8b5a2953c61'::uuid,
  DATE '2026-07-11',
  '6984f891-2852-45bc-a613-7004ed31c8d7'::uuid,
  'a9207ce5-2851-4957-904b-05df880a87ca'::uuid,
  'Minnesota Twins',
  3.00,
  1.552,
  -181,
  'won'::wager_status,
  1.66,
  now(),
  now(),
  'StakeWars Chine pick - Jul 11, 2026',
  'Record: 1-1 W/L

Net Units: +0.24u

Previous: Loss -2.00u

✗ Minnesota Twins to Win (-157) - 19:10 CST

Saturday, 11. 7. 2026. 13:10 CST

Event: MLB

Los Angeles Angels vs Minnesota Twins

Pick:

• Minnesota Twins to Win

ODDS -181

UNITS 3u to return 4.66u

Minnesota Twins are Chine''s highest-confidence play today at 86%. The model points to home-field advantage, strong moneyline profile and recent form advantage, with a projected edge of 10.2%. The price is good enough for a 3u play.'
)
ON CONFLICT (pick_date) DO UPDATE
SET ai_pick_id = EXCLUDED.ai_pick_id,
    game_line_id = EXCLUDED.game_line_id,
    selected_team = EXCLUDED.selected_team,
    units = EXCLUDED.units,
    decimal_odds = EXCLUDED.decimal_odds,
    odds_american = EXCLUDED.odds_american,
    status = EXCLUDED.status,
    profit_units = EXCLUDED.profit_units,
    settled_at = EXCLUDED.settled_at,
    locked_at = COALESCE(reddit_pick_track.locked_at, EXCLUDED.locked_at),
    locked_title = EXCLUDED.locked_title,
    locked_body = EXCLUDED.locked_body;

WITH tracked_parlay AS (
  INSERT INTO reddit_parlay_track (
    id,
    pick_date,
    units,
    status,
    profit_units,
    settled_at,
    locked_at,
    locked_title
  )
  VALUES (
    'd49b9929-69e1-468f-b060-ec6d4b4d9b60'::uuid,
    DATE '2026-07-11',
    1.00,
    'lost'::wager_status,
    -1.00,
    now(),
    now(),
    'StakeWars Chine 3-team parlay - Jul 11, 2026'
  )
  ON CONFLICT (pick_date) DO UPDATE
  SET status = 'lost'::wager_status,
      profit_units = -1.00,
      settled_at = now(),
      locked_at = COALESCE(reddit_parlay_track.locked_at, now()),
      locked_title = 'StakeWars Chine 3-team parlay - Jul 11, 2026'
  RETURNING id
),
removed AS (
  DELETE FROM reddit_parlay_leg_track
  WHERE parlay_id IN (SELECT id FROM tracked_parlay)
),
posted_legs(id, ai_pick_id, game_line_id, selected_team, leg_index, decimal_odds, odds_american, status) AS (
  VALUES
    ('80ccb760-d4a7-4d88-a2a9-f3e6e8e80ec1'::uuid, '6984f891-2852-45bc-a613-7004ed31c8d7'::uuid, 'a9207ce5-2851-4957-904b-05df880a87ca'::uuid, 'Minnesota Twins', 1, 1.581::numeric(8,3), -172, 'won'::wager_status),
    ('8a452b35-5137-4351-ac06-3a61f4411651'::uuid, '23c16bb4-27c1-4a68-8a87-de9273a6756e'::uuid, '1307867d-d4fe-4260-be64-d8d34e3a0dde'::uuid, 'Miami Marlins', 2, 1.649::numeric(8,3), -154, 'lost'::wager_status),
    ('bb7f8f3f-7f24-4a20-95cd-c8a77b04bf1d'::uuid, 'bcc12b46-2334-4e37-861b-2b56c363d459'::uuid, '2e4b2302-dabb-48dc-8216-d96637547ef8'::uuid, 'Los Angeles Dodgers', 3, 1.345::numeric(8,3), -290, 'lost'::wager_status)
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
  posted_legs.id,
  tracked_parlay.id,
  posted_legs.ai_pick_id,
  posted_legs.game_line_id,
  posted_legs.selected_team,
  posted_legs.leg_index,
  posted_legs.decimal_odds,
  posted_legs.odds_american,
  posted_legs.status,
  now()
FROM tracked_parlay
JOIN posted_legs ON true
ON CONFLICT (parlay_id, leg_index) DO UPDATE
SET ai_pick_id = EXCLUDED.ai_pick_id,
    game_line_id = EXCLUDED.game_line_id,
    selected_team = EXCLUDED.selected_team,
    decimal_odds = EXCLUDED.decimal_odds,
    odds_american = EXCLUDED.odds_american,
    status = EXCLUDED.status,
    settled_at = EXCLUDED.settled_at;
