ALTER TABLE weekly_reward_award
  ADD COLUMN IF NOT EXISTS bonus_selection text,
  ADD COLUMN IF NOT EXISTS shipping_name text,
  ADD COLUMN IF NOT EXISTS shipping_address_line1 text,
  ADD COLUMN IF NOT EXISTS shipping_address_line2 text,
  ADD COLUMN IF NOT EXISTS shipping_city text,
  ADD COLUMN IF NOT EXISTS shipping_region text,
  ADD COLUMN IF NOT EXISTS shipping_postal_code text,
  ADD COLUMN IF NOT EXISTS shipping_country text,
  ADD COLUMN IF NOT EXISTS bonus_fulfillment_submitted_at timestamptz;

ALTER TABLE weekly_reward_award
  DROP CONSTRAINT IF EXISTS weekly_reward_award_bonus_selection_length,
  DROP CONSTRAINT IF EXISTS weekly_reward_award_shipping_name_length,
  DROP CONSTRAINT IF EXISTS weekly_reward_award_shipping_address_line1_length,
  DROP CONSTRAINT IF EXISTS weekly_reward_award_shipping_address_line2_length,
  DROP CONSTRAINT IF EXISTS weekly_reward_award_shipping_city_length,
  DROP CONSTRAINT IF EXISTS weekly_reward_award_shipping_region_length,
  DROP CONSTRAINT IF EXISTS weekly_reward_award_shipping_postal_code_length,
  DROP CONSTRAINT IF EXISTS weekly_reward_award_shipping_country_length,
  ADD CONSTRAINT weekly_reward_award_bonus_selection_length
    CHECK (bonus_selection IS NULL OR char_length(bonus_selection) BETWEEN 1 AND 80),
  ADD CONSTRAINT weekly_reward_award_shipping_name_length
    CHECK (shipping_name IS NULL OR char_length(shipping_name) BETWEEN 2 AND 120),
  ADD CONSTRAINT weekly_reward_award_shipping_address_line1_length
    CHECK (shipping_address_line1 IS NULL OR char_length(shipping_address_line1) BETWEEN 2 AND 160),
  ADD CONSTRAINT weekly_reward_award_shipping_address_line2_length
    CHECK (shipping_address_line2 IS NULL OR char_length(shipping_address_line2) <= 160),
  ADD CONSTRAINT weekly_reward_award_shipping_city_length
    CHECK (shipping_city IS NULL OR char_length(shipping_city) BETWEEN 2 AND 100),
  ADD CONSTRAINT weekly_reward_award_shipping_region_length
    CHECK (shipping_region IS NULL OR char_length(shipping_region) BETWEEN 2 AND 80),
  ADD CONSTRAINT weekly_reward_award_shipping_postal_code_length
    CHECK (shipping_postal_code IS NULL OR char_length(shipping_postal_code) BETWEEN 3 AND 20),
  ADD CONSTRAINT weekly_reward_award_shipping_country_length
    CHECK (shipping_country IS NULL OR char_length(shipping_country) BETWEEN 2 AND 80);

