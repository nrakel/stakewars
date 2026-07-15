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
  '61f83514-dbba-4509-8079-a46b5a069c7c'::uuid,
  DATE '2026-07-09',
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
  'won'::wager_status,
  (
    CASE
      WHEN p.confidence >= 0.80 THEN 3.00
      WHEN p.confidence >= 0.77 THEN 2.00
      ELSE 1.00
    END
    *
    (
      (CASE
        WHEN gl.odds_american > 0 THEN 1 + gl.odds_american / 100.0
        ELSE 1 + 100.0 / abs(gl.odds_american)
      END)
      - 1
    )
  )::numeric(8,2),
  now()
FROM ai_pick p
JOIN game_line gl ON gl.id = p.game_line_id
WHERE p.published_for = DATE '2026-07-09'
  AND gl.odds_american BETWEEN -200 AND 200
ORDER BY p.confidence DESC NULLS LAST, p.score DESC NULLS LAST, gl.starts_at ASC
LIMIT 1
ON CONFLICT (pick_date) DO NOTHING;
