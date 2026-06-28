ALTER TABLE wager
  ADD COLUMN IF NOT EXISTS round_robin_min_legs integer,
  ADD COLUMN IF NOT EXISTS round_robin_max_legs integer,
  ADD COLUMN IF NOT EXISTS round_robin_stake_per_way_cents integer;

ALTER TABLE wager
  DROP CONSTRAINT IF EXISTS wager_round_robin_leg_range_check,
  ADD CONSTRAINT wager_round_robin_leg_range_check CHECK (
    kind <> 'round_robin'
    OR round_robin_max_legs IS NULL
    OR (
      round_robin_min_legs = 2
      AND round_robin_max_legs BETWEEN round_robin_min_legs AND legs_count
      AND round_robin_stake_per_way_cents > 0
    )
  );
