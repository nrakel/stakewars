UPDATE reddit_pick_track
SET locked_at = COALESCE(locked_at, created_at)
WHERE pick_date < DATE '2026-07-12';

UPDATE reddit_parlay_track
SET locked_at = COALESCE(locked_at, created_at)
WHERE pick_date < DATE '2026-07-12';
