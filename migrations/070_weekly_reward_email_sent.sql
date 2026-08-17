ALTER TABLE weekly_reward_award
  ADD COLUMN IF NOT EXISTS reward_email_sent_at timestamptz;
