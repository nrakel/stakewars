WITH keep AS (
  SELECT p.id
  FROM ai_pick p
  JOIN wager w ON w.id = p.wager_id
  JOIN wager_leg wl ON wl.wager_id = w.id
    AND wl.game_line_id = p.game_line_id
  WHERE p.published_for = DATE '2026-07-18'
    AND p.selected_team = 'Boston Red Sox'
    AND p.wager_id = '267c6037-2bd4-4c70-98ae-1ee7bfbe8a08'::uuid
  ORDER BY p.locked_at ASC NULLS LAST
  LIMIT 1
)
DELETE FROM ai_pick p
WHERE p.published_for = DATE '2026-07-18'
  AND p.selected_team = 'Boston Red Sox'
  AND p.wager_id = '267c6037-2bd4-4c70-98ae-1ee7bfbe8a08'::uuid
  AND p.id NOT IN (SELECT id FROM keep);
