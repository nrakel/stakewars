ALTER TABLE nfl_confidence_pool
  ADD COLUMN IF NOT EXISTS season_third_place_prize_cents integer NOT NULL DEFAULT 25000;

UPDATE nfl_confidence_pool
SET weekly_prize_cents = 5000,
    season_winner_prize_cents = 100000,
    season_runner_up_prize_cents = 50000,
    season_third_place_prize_cents = 25000
WHERE status = 'active'
  AND season = 2026;
