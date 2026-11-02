WITH aliases(alias_name, espn_team_id) AS (
  VALUES
    ('Appalachian State', '2026'),
    ('Arkansas Little Rock', '2031'),
    ('Charlotte U', '2429'),
    ('East Tenn State', '2193'),
    ('Miami Florida', '2390'),
    ('Miami Ohio', '193'),
    ('Mt. St. Mary''s', '116'),
    ('Saint Marys CA', '2608'),
    ('San Jose St', '23'),
    ('San Jose State', '23'),
    ('Seattle', '2547'),
    ('St. Thomas-Minnesota', '2900'),
    ('Tennessee Martin', '2630'),
    ('Texas San Antonio', '2636'),
    ('UL - Lafayette', '309'),
    ('UMKC', '140'),
    ('Wisc Milwaukee', '270')
)
INSERT INTO college_program_alias (
  sport, provider, normalized_alias, alias_name, espn_team_id, is_ambiguous, source, updated_at
)
SELECT
  'NCAAMB'::sport_key,
  'parlay-api',
  trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(alias_name), '&', ' and ', 'g'), '[’'']', '', 'g'), '\msaint\M', 'st', 'g'), '[^a-z0-9]+', ' ', 'g'), '\s+', ' ', 'g')),
  alias_name,
  espn_team_id,
  false,
  'manual-provider-alias',
  now()
FROM aliases
ON CONFLICT (sport, provider, normalized_alias) DO UPDATE SET
  alias_name=EXCLUDED.alias_name,
  espn_team_id=EXCLUDED.espn_team_id,
  is_ambiguous=false,
  source=EXCLUDED.source,
  updated_at=now();

INSERT INTO college_program_alias (
  sport, provider, normalized_alias, alias_name, espn_team_id, is_ambiguous, source, updated_at
)
SELECT 'NCAAF', 'parlay-api', 'troy', 'Troy', '2653', false, 'manual-provider-alias', now()
ON CONFLICT (sport, provider, normalized_alias) DO UPDATE SET
  espn_team_id=EXCLUDED.espn_team_id,
  is_ambiguous=false,
  source=EXCLUDED.source,
  updated_at=now();
