UPDATE tower_config_version
SET active = false
WHERE active = true;

INSERT INTO tower_config_version (id, version_label, active, config)
VALUES (
  '00000000-0000-0000-0000-000000000052',
  'tower-height-payout-v2',
  true,
  '{
    "version": "tower-height-payout-v2",
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
      { "minHeight": 3, "maxHeight": 3, "payout": { "numerator": 5, "denominator": 1 } },
      { "minHeight": 4, "maxHeight": 4, "payout": { "numerator": 10, "denominator": 1 } },
      { "minHeight": 5, "maxHeight": 5, "payout": { "numerator": 20, "denominator": 1 } },
      { "minHeight": 6, "maxHeight": 6, "payout": { "numerator": 40, "denominator": 1 } },
      { "minHeight": 7, "maxHeight": 7, "payout": { "numerator": 75, "denominator": 1 } },
      { "minHeight": 8, "maxHeight": null, "payout": { "numerator": 150, "denominator": 1 } }
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
ON CONFLICT (id) DO UPDATE SET
  version_label = EXCLUDED.version_label,
  config = EXCLUDED.config,
  active = EXCLUDED.active;
