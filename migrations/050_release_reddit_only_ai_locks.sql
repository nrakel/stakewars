UPDATE ai_pick p
SET locked_at = NULL
WHERE p.wager_id IS NULL
  AND p.locked_at IS NOT NULL
  AND (
    EXISTS (
      SELECT 1
      FROM reddit_pick_track rpt
      WHERE rpt.ai_pick_id = p.id
        AND rpt.locked_at IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM reddit_parlay_leg_track rplt
      JOIN reddit_parlay_track rpt ON rpt.id = rplt.parlay_id
      WHERE rplt.ai_pick_id = p.id
        AND rpt.locked_at IS NOT NULL
    )
  );
