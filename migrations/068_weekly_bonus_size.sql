ALTER TABLE weekly_reward_award
  ADD COLUMN IF NOT EXISTS bonus_size text;

ALTER TABLE weekly_reward_award
  DROP CONSTRAINT IF EXISTS weekly_reward_award_bonus_size_length,
  ADD CONSTRAINT weekly_reward_award_bonus_size_length
    CHECK (bonus_size IS NULL OR char_length(bonus_size) BETWEEN 1 AND 20);
