ALTER TABLE ai_daily_bankroll
  ADD COLUMN IF NOT EXISTS straight_wager_stake_cents integer,
  ADD COLUMN IF NOT EXISTS straight_wager_slots integer;

ALTER TABLE ai_daily_bankroll
  DROP CONSTRAINT IF EXISTS ai_daily_bankroll_straight_wager_stake_cents_check,
  ADD CONSTRAINT ai_daily_bankroll_straight_wager_stake_cents_check
    CHECK (straight_wager_stake_cents IS NULL OR straight_wager_stake_cents > 0);

ALTER TABLE ai_daily_bankroll
  DROP CONSTRAINT IF EXISTS ai_daily_bankroll_straight_wager_slots_check,
  ADD CONSTRAINT ai_daily_bankroll_straight_wager_slots_check
    CHECK (straight_wager_slots IS NULL OR straight_wager_slots > 0);
