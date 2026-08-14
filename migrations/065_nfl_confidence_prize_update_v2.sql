UPDATE nfl_confidence_pool
SET season_winner_prize_cents = 180000,
    season_runner_up_prize_cents = 75000,
    season_third_place_prize_cents = 45000
WHERE status = 'active'
  AND season = 2026;
