CREATE TABLE IF NOT EXISTS round_robin_way_settlement (
  wager_id uuid NOT NULL REFERENCES wager(id) ON DELETE CASCADE,
  way_key text NOT NULL,
  leg_ids uuid[] NOT NULL,
  leg_count integer NOT NULL CHECK (leg_count > 0),
  status wager_status NOT NULL,
  payout_cents integer NOT NULL CHECK (payout_cents >= 0),
  profit_cents integer NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wager_id, way_key)
);

CREATE INDEX IF NOT EXISTS round_robin_way_settlement_wager_idx
  ON round_robin_way_settlement (wager_id, status);
