DO $$
DECLARE
  target_post_id uuid;
BEGIN
  SELECT id INTO target_post_id
  FROM reddit_post_snapshot
  WHERE post_type = 'all'
    AND post_date = '2026-07-31';

  IF target_post_id IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM reddit_post_pick_snapshot
  WHERE reddit_post_id = target_post_id;

  WITH posted AS (
    SELECT * FROM (VALUES
      (1, '863eada9-7ae7-45b0-a0fd-d7e2d1aedbef'::uuid, '08d2a405-87b4-4a6c-b928-3b82f979bf00'::uuid, 'Cleveland Guardians', -138, 0.8600::numeric, '0.11550000000000005'::text, 'lost'::wager_status, -1.00::numeric),
      (2, 'd0a7d8e9-62d3-4da7-9563-5b9581667a43'::uuid, 'de1e596c-db1e-4a9a-8f7a-1a09d9a77a2a'::uuid, 'Seattle Mariners', -175, 0.8600::numeric, '0.10350000000000004'::text, 'lost'::wager_status, -1.00::numeric),
      (3, 'b0af6e70-fe16-4103-95a3-fabd69c85931'::uuid, 'e885862e-84e1-4d7b-83b2-1a4a3424c004'::uuid, 'Toronto Blue Jays', -185, 0.7414::numeric, '0.044500000000000095'::text, 'won'::wager_status, 0.54::numeric),
      (4, 'c8b1aca2-2a80-4da1-bc3a-1780ceed8543'::uuid, '6f8941fe-63c8-4500-8704-6daecac12000'::uuid, 'Tampa Bay Rays', -143, 0.7050::numeric, '0.0625'::text, 'lost'::wager_status, -1.00::numeric),
      (5, 'bfd61404-98e5-4c99-9497-2015147d7744'::uuid, '6835703b-1bbc-40ea-a196-59e4bcdb23c4'::uuid, 'Chicago Cubs', -157, 0.7358::numeric, '0.05249999999999999'::text, 'lost'::wager_status, -1.00::numeric)
    ) AS v(leg_index, ai_pick_id, game_line_id, selected_team, odds_american, confidence, edge, status, profit_units)
  )
  INSERT INTO reddit_post_pick_snapshot (
    id, reddit_post_id, leg_index, selected_team, sport, league, market_key, spread,
    odds_american, decimal_odds, units, away_team, home_team, starts_at, confidence,
    edge, explanation, source_ai_pick_id, source_game_line_id, status, profit_units, settled_at
  )
  SELECT
    gen_random_uuid(),
    target_post_id,
    posted.leg_index,
    posted.selected_team,
    gl.sport,
    gl.league,
    gl.market_key,
    gl.spread,
    posted.odds_american,
    (1 + 100.0 / abs(posted.odds_american))::numeric(8,3),
    1.00,
    gl.away_team,
    gl.home_team,
    gl.starts_at,
    posted.confidence,
    posted.edge,
    p.explanation,
    posted.ai_pick_id,
    posted.game_line_id,
    posted.status,
    posted.profit_units,
    now()
  FROM posted
  JOIN game_line gl ON gl.id = posted.game_line_id
  LEFT JOIN ai_pick p ON p.id = posted.ai_pick_id
  ORDER BY posted.leg_index;

  UPDATE reddit_post_snapshot
  SET status = 'lost',
      profit_units = -3.46,
      settled_at = now()
  WHERE id = target_post_id;
END $$;

UPDATE reddit_post_snapshot
SET body = regexp_replace(
  body,
  '### Yesterday[\s\S]*?\n---',
  E'### Yesterday\n\n✗ Cleveland Guardians to Win (-138) - 18:10 CST (-1.00u)\n✗ Seattle Mariners to Win (-175) - 21:10 CST (-1.00u)\n✓ Toronto Blue Jays to Win (-185) - 18:07 CST (+0.54u)\n✗ Tampa Bay Rays to Win (-143) - 18:10 CST (-1.00u)\n✗ Chicago Cubs to Win (-157) - 13:20 CST (-1.00u)\n\n**Daily Result:** **-3.46u**\n\n---'
)
WHERE post_type = 'all'
  AND post_date = '2026-08-01';
