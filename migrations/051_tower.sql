CREATE TABLE IF NOT EXISTS tower_config_version (
  id uuid PRIMARY KEY,
  version_label text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_user(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tower_config_one_active_idx
  ON tower_config_version (active)
  WHERE active;

CREATE TABLE IF NOT EXISTS tower_shoe (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  shoe_state jsonb NOT NULL,
  current_position integer NOT NULL DEFAULT 0,
  initial_card_count integer NOT NULL DEFAULT 312,
  publicly_revealed_count integer NOT NULL DEFAULT 0,
  shuffle_commitment text NOT NULL,
  shuffle_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  shuffled_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retirement_reason text
);

CREATE INDEX IF NOT EXISTS tower_shoe_user_status_idx ON tower_shoe (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS tower_hand (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  weekly_entry_id uuid NOT NULL REFERENCES weekly_entry(id) ON DELETE CASCADE,
  shoe_id uuid NOT NULL REFERENCES tower_shoe(id) ON DELETE RESTRICT,
  status text NOT NULL,
  hand_state jsonb NOT NULL,
  starting_balance_cents integer NOT NULL,
  ending_balance_cents integer,
  original_value_wager_cents integer NOT NULL DEFAULT 0,
  original_height_wager_cents integer NOT NULL DEFAULT 0,
  final_value_wager_cents integer NOT NULL DEFAULT 0,
  final_height_wager_cents integer NOT NULL DEFAULT 0,
  player_height integer NOT NULL DEFAULT 0,
  player_value integer NOT NULL DEFAULT 0,
  dealer_height integer NOT NULL DEFAULT 0,
  dealer_value integer NOT NULL DEFAULT 0,
  player_collapsed boolean NOT NULL DEFAULT false,
  dealer_collapsed boolean NOT NULL DEFAULT false,
  value_result text NOT NULL DEFAULT 'pending' CHECK (value_result IN ('pending', 'won', 'lost', 'push', 'void')),
  height_result text NOT NULL DEFAULT 'pending' CHECK (height_result IN ('pending', 'won', 'lost', 'push', 'void')),
  value_payout_cents integer NOT NULL DEFAULT 0,
  height_payout_cents integer NOT NULL DEFAULT 0,
  dealer_opening_rank text,
  dealer_opening_value integer,
  configuration_version_id uuid NOT NULL REFERENCES tower_config_version(id) ON DELETE RESTRICT,
  action_version integer NOT NULL DEFAULT 1,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS tower_hand_user_status_idx ON tower_hand (user_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS tower_hand_shoe_idx ON tower_hand (shoe_id);

CREATE TABLE IF NOT EXISTS tower_hand_event (
  id uuid PRIMARY KEY,
  hand_id uuid NOT NULL REFERENCES tower_hand(id) ON DELETE CASCADE,
  sequence_number integer NOT NULL,
  actor text CHECK (actor IN ('player', 'dealer', 'system')),
  action_type text NOT NULL,
  card_id text,
  rank text,
  suit text,
  value integer,
  face_up boolean NOT NULL DEFAULT false,
  publicly_revealed boolean NOT NULL DEFAULT false,
  caused_collapse boolean NOT NULL DEFAULT false,
  previous_card_value integer,
  resulting_height integer,
  resulting_total integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hand_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS tower_hand_event_hand_idx ON tower_hand_event (hand_id, sequence_number);

CREATE TABLE IF NOT EXISTS tower_wager_event (
  id uuid PRIMARY KEY,
  hand_id uuid NOT NULL REFERENCES tower_hand(id) ON DELETE CASCADE,
  wager_type text NOT NULL CHECK (wager_type IN ('value', 'height')),
  event_type text NOT NULL CHECK (event_type IN ('placed', 'doubled', 'won', 'lost', 'pushed', 'refunded')),
  amount_cents integer NOT NULL,
  balance_before_cents integer NOT NULL,
  balance_after_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tower_wager_event_hand_idx ON tower_wager_event (hand_id, created_at);

INSERT INTO tower_config_version (id, version_label, active, config)
VALUES (
  '00000000-0000-0000-0000-000000000051',
  'tower-mvp-v1',
  true,
  '{
    "version": "tower-mvp-v1",
    "deckCount": 6,
    "shufflePenetrationRemainingCards": 78,
    "minWagerCents": 100,
    "maxWagerCents": 10000,
    "defaultWagerCents": 500,
    "maxExposureCents": 40000,
    "valuePayout": { "numerator": 1, "denominator": 1 },
    "valueTieRule": "push",
    "heightQualificationMinCards": 3,
    "heightPayouts": [
      { "minHeight": 3, "maxHeight": 3, "payout": { "numerator": 1, "denominator": 1 } },
      { "minHeight": 4, "maxHeight": 4, "payout": { "numerator": 6, "denominator": 5 } },
      { "minHeight": 5, "maxHeight": 5, "payout": { "numerator": 3, "denominator": 2 } },
      { "minHeight": 6, "maxHeight": 6, "payout": { "numerator": 2, "denominator": 1 } },
      { "minHeight": 7, "maxHeight": 7, "payout": { "numerator": 4, "denominator": 1 } },
      { "minHeight": 8, "maxHeight": null, "payout": { "numerator": 8, "denominator": 1 } }
    ],
    "dealer": {
      "minimumHeight": 2,
      "buildThroughValue": 7,
      "stopAtValue": 8,
      "dealerCollapsePaysValue": true,
      "dealerCollapsePaysQualifiedHeight": true,
      "highOpeningRuleEnabled": false
    }
  }'::jsonb
)
ON CONFLICT (id) DO NOTHING;
