INSERT INTO college_program (
  espn_team_id, canonical_name, short_name, location, nickname, abbreviation, slug, is_active, updated_at
) VALUES
  ('2815', 'Lindenwood Lions', 'Lindenwood', 'Lindenwood', 'Lions', 'LIN', 'lindenwood-lions', true, now()),
  ('88', 'Southern Indiana Screaming Eagles', 'Southern Indiana', 'Southern Indiana', 'Screaming Eagles', 'USI', 'southern-indiana-screaming-eagles', true, now())
ON CONFLICT (espn_team_id) DO UPDATE SET
  canonical_name=EXCLUDED.canonical_name,
  short_name=EXCLUDED.short_name,
  location=EXCLUDED.location,
  nickname=EXCLUDED.nickname,
  abbreviation=EXCLUDED.abbreviation,
  slug=EXCLUDED.slug,
  is_active=true,
  updated_at=now();

INSERT INTO college_program_sport (
  espn_team_id, sport, canonical_name, short_name, is_active, updated_at
) VALUES
  ('2815', 'NCAAMB', 'Lindenwood Lions', 'Lindenwood', true, now()),
  ('88', 'NCAAMB', 'Southern Indiana Screaming Eagles', 'Southern Indiana', true, now())
ON CONFLICT (espn_team_id, sport) DO UPDATE SET
  canonical_name=EXCLUDED.canonical_name,
  short_name=EXCLUDED.short_name,
  is_active=true,
  updated_at=now();

INSERT INTO college_program_alias (
  sport, provider, normalized_alias, alias_name, espn_team_id, is_ambiguous, source, updated_at
) VALUES
  ('NCAAMB', 'parlay-api', 'lindenwood', 'Lindenwood', '2815', false, 'manual-provider-alias', now()),
  ('NCAAMB', 'parlay-api', 'southern indiana', 'Southern Indiana', '88', false, 'manual-provider-alias', now())
ON CONFLICT (sport, provider, normalized_alias) DO UPDATE SET
  espn_team_id=EXCLUDED.espn_team_id,
  is_ambiguous=false,
  source=EXCLUDED.source,
  updated_at=now();
