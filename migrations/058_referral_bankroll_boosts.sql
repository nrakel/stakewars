CREATE TABLE IF NOT EXISTS referral_bankroll_boost (
  id uuid PRIMARY KEY,
  referrer_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  referred_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL DEFAULT 100000,
  status text NOT NULL DEFAULT 'earned',
  earned_at timestamptz NOT NULL DEFAULT now(),
  used_week_starts_on date,
  used_at timestamptz,
  CHECK (amount_cents > 0),
  CHECK (status IN ('earned', 'used')),
  CHECK (
    (status = 'earned' AND used_week_starts_on IS NULL AND used_at IS NULL)
    OR (status = 'used' AND used_week_starts_on IS NOT NULL AND used_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS referral_bankroll_boost_referred_unique_idx
  ON referral_bankroll_boost (referred_user_id);

CREATE INDEX IF NOT EXISTS referral_bankroll_boost_referrer_status_idx
  ON referral_bankroll_boost (referrer_user_id, status);

CREATE INDEX IF NOT EXISTS referral_bankroll_boost_used_week_idx
  ON referral_bankroll_boost (referrer_user_id, used_week_starts_on);

CREATE TABLE IF NOT EXISTS referral_boost_weekly_waiver (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  week_starts_on date NOT NULL,
  waived_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_starts_on)
);

CREATE INDEX IF NOT EXISTS referral_boost_weekly_waiver_user_week_idx
  ON referral_boost_weekly_waiver (user_id, week_starts_on);

INSERT INTO referral_bankroll_boost (id, referrer_user_id, referred_user_id, earned_at)
SELECT gen_random_uuid(), referred.referred_by_user_id, referred.id, min(w.placed_at)
FROM app_user referred
JOIN wager w ON w.user_id = referred.id
WHERE referred.referred_by_user_id IS NOT NULL
GROUP BY referred.id, referred.referred_by_user_id
ON CONFLICT (referred_user_id) DO NOTHING;
