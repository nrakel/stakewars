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
  locked_title
)
SELECT
  '3d1c2024-83ce-4500-aa82-80ca6456727f'::uuid,
  DATE '2026-07-17',
  p.id,
  gl.id,
  p.selected_team,
  3.00,
  (CASE WHEN gl.odds_american > 0 THEN 1 + gl.odds_american / 100.0 ELSE 1 + 100.0 / abs(gl.odds_american) END)::numeric(8,3),
  gl.odds_american,
  'lost'::wager_status,
  -3.00,
  now(),
  '2026-07-17 18:47:32.734449+00'::timestamptz,
  'StakeWars Chine pick - Jul 17, 2026'
FROM ai_pick p
JOIN game_line gl ON gl.id = p.game_line_id
WHERE p.id = '632fbfad-080b-4427-aa68-9ce95aa0fec0'
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
    locked_title = EXCLUDED.locked_title;

UPDATE ai_pick
SET locked_at = COALESCE(locked_at, '2026-07-17 18:47:32.734449+00'::timestamptz)
WHERE id = '632fbfad-080b-4427-aa68-9ce95aa0fec0';

UPDATE reddit_parlay_track
SET status = 'lost'::wager_status,
    profit_units = -1.00,
    settled_at = now()
WHERE id = 'e2c5748d-7667-4e45-b043-75dace910c1d';

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
VALUES
  ('9a464526-c1a8-4c0d-9ef7-202607170001'::uuid, 'e2c5748d-7667-4e45-b043-75dace910c1d'::uuid, '632fbfad-080b-4427-aa68-9ce95aa0fec0'::uuid, '7c5ec619-bf11-4c67-8853-4531142f26db'::uuid, 'Seattle Mariners', 1, 1.543, -184, 'lost'::wager_status, now()),
  ('9a464526-c1a8-4c0d-9ef7-202607170002'::uuid, 'e2c5748d-7667-4e45-b043-75dace910c1d'::uuid, '73324a4d-c530-4530-bcee-d625d32d847b'::uuid, '163e773b-90d9-4b56-823a-32035685a890'::uuid, 'St. Louis Cardinals', 2, 1.962, -104, 'won'::wager_status, now()),
  ('9a464526-c1a8-4c0d-9ef7-202607170003'::uuid, 'e2c5748d-7667-4e45-b043-75dace910c1d'::uuid, '0bc5e571-adb9-48ee-b26c-fcc898535521'::uuid, '0d303a3f-c02b-4e4d-9deb-3924994e72f8'::uuid, 'Colorado Rockies', 3, 1.862, -116, 'lost'::wager_status, now())
ON CONFLICT (parlay_id, leg_index) DO UPDATE
SET ai_pick_id = EXCLUDED.ai_pick_id,
    game_line_id = EXCLUDED.game_line_id,
    selected_team = EXCLUDED.selected_team,
    decimal_odds = EXCLUDED.decimal_odds,
    odds_american = EXCLUDED.odds_american,
    status = EXCLUDED.status,
    settled_at = EXCLUDED.settled_at;

UPDATE ai_pick
SET locked_at = COALESCE(locked_at, '2026-07-17 18:57:19.518461+00'::timestamptz)
WHERE id IN (
  '632fbfad-080b-4427-aa68-9ce95aa0fec0',
  '73324a4d-c530-4530-bcee-d625d32d847b',
  '0bc5e571-adb9-48ee-b26c-fcc898535521'
);
