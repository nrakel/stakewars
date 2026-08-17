ALTER TABLE weekly_reward_award
  ADD COLUMN IF NOT EXISTS bonus_fulfilled_at timestamptz,
  ADD COLUMN IF NOT EXISTS bonus_fulfillment_message text;

ALTER TABLE weekly_reward_award
  DROP CONSTRAINT IF EXISTS weekly_reward_award_bonus_fulfillment_message_length,
  ADD CONSTRAINT weekly_reward_award_bonus_fulfillment_message_length
    CHECK (bonus_fulfillment_message IS NULL OR char_length(bonus_fulfillment_message) <= 2000);
