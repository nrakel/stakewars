WITH tracked_parlay AS (
  INSERT INTO reddit_parlay_track (
    id,
    pick_date,
    units,
    status,
    profit_units,
    settled_at
  )
  VALUES (
    'fb9b5846-76f8-4c79-b265-178f23b103bd'::uuid,
    DATE '2026-07-09',
    1.00,
    'lost'::wager_status,
    -1.00,
    now()
  )
  ON CONFLICT (pick_date) DO UPDATE
  SET status = 'lost'::wager_status,
      profit_units = -1.00,
      settled_at = coalesce(reddit_parlay_track.settled_at, now())
  RETURNING id
),
posted_legs(id, selected_team, leg_index, decimal_odds, odds_american, status) AS (
  VALUES
    ('f892d6e4-2dcb-490e-bd01-f52a805527f0'::uuid, 'Texas Rangers', 1, 1.735::numeric(8,3), -136, 'won'::wager_status),
    ('22165b18-86d0-4b8d-961f-1a58bce55caf'::uuid, 'Seattle Mariners', 2, 1.781::numeric(8,3), -128, 'lost'::wager_status),
    ('0956a3bc-e827-4c67-9297-79f1a83ecc49'::uuid, 'Philadelphia Phillies', 3, 1.610::numeric(8,3), -164, 'won'::wager_status)
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
  p.id,
  p.game_line_id,
  posted_legs.selected_team,
  posted_legs.leg_index,
  posted_legs.decimal_odds,
  posted_legs.odds_american,
  posted_legs.status,
  now()
FROM tracked_parlay
JOIN posted_legs ON true
JOIN ai_pick p
  ON p.published_for = DATE '2026-07-09'
 AND p.selected_team = posted_legs.selected_team
ON CONFLICT (parlay_id, leg_index) DO UPDATE
SET ai_pick_id = EXCLUDED.ai_pick_id,
    game_line_id = EXCLUDED.game_line_id,
    selected_team = EXCLUDED.selected_team,
    decimal_odds = EXCLUDED.decimal_odds,
    odds_american = EXCLUDED.odds_american,
    status = EXCLUDED.status,
    settled_at = EXCLUDED.settled_at;
