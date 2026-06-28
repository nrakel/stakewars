ALTER TABLE wager
  DROP CONSTRAINT IF EXISTS wager_legs_count_check,
  ADD CONSTRAINT wager_legs_count_check CHECK (legs_count BETWEEN 1 AND 8);

ALTER TABLE wager
  DROP CONSTRAINT IF EXISTS wager_round_robin_ways_check,
  ADD CONSTRAINT wager_round_robin_ways_check CHECK (round_robin_ways IS NULL OR round_robin_ways BETWEEN 1 AND 247);
