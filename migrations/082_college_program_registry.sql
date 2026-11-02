CREATE TABLE IF NOT EXISTS college_program (
  espn_team_id text PRIMARY KEY,
  canonical_name text NOT NULL,
  short_name text NOT NULL,
  location text NOT NULL,
  nickname text NOT NULL,
  abbreviation text NOT NULL,
  slug text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS college_program_sport (
  espn_team_id text NOT NULL REFERENCES college_program(espn_team_id) ON DELETE CASCADE,
  sport sport_key NOT NULL CHECK (sport IN ('NCAAF', 'NCAAMB')),
  canonical_name text NOT NULL,
  short_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (espn_team_id, sport)
);

CREATE TABLE IF NOT EXISTS college_program_alias (
  sport sport_key NOT NULL CHECK (sport IN ('NCAAF', 'NCAAMB')),
  provider text NOT NULL DEFAULT '*',
  normalized_alias text NOT NULL,
  alias_name text NOT NULL,
  espn_team_id text REFERENCES college_program(espn_team_id) ON DELETE CASCADE,
  is_ambiguous boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'espn-directory',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sport, provider, normalized_alias),
  CHECK ((is_ambiguous AND espn_team_id IS NULL) OR (NOT is_ambiguous AND espn_team_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS college_program_alias_team_idx
  ON college_program_alias (espn_team_id, sport);
