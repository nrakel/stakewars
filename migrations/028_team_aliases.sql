CREATE TABLE IF NOT EXISTS team_alias (
  id uuid PRIMARY KEY,
  sport sport_key,
  provider text,
  canonical_name text NOT NULL,
  alias_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport, provider, alias_name)
);

CREATE INDEX IF NOT EXISTS team_alias_lookup_idx
  ON team_alias (sport, provider, alias_name);

INSERT INTO team_alias (id, sport, provider, canonical_name, alias_name)
VALUES
  ('4f46d6d2-4b41-4bb9-9e16-8292a1ab2d11', 'WORLDCUP', 'espn-scoreboard', 'Congo DR', 'DR Congo'),
  ('598165c3-823b-4f8b-a857-4d88e3cfb5a5', 'WORLDCUP', 'espn-scoreboard', 'Congo DR', 'Democratic Republic of the Congo'),
  ('8667fa03-4576-491b-b476-876153ac84f1', 'WORLDCUP', 'espn-scoreboard', 'Congo DR', 'Democratic Republic of Congo'),
  ('ec7ec031-d6e1-4a8a-88e1-b5d30ea9c4f2', 'WORLDCUP', 'espn-scoreboard', 'Bosnia-Herzegovina', 'Bosnia and Herzegovina'),
  ('4a681269-cb05-4e29-8c38-a0f6b0f03275', 'WORLDCUP', 'espn-scoreboard', 'United States', 'USA'),
  ('c737dc68-4e84-420c-bc62-229d9993ee4a', 'WORLDCUP', 'espn-scoreboard', 'United States', 'United States of America'),
  ('d1953a4f-8be4-4c58-9783-77db5dbb8cfb', 'WORLDCUP', 'espn-scoreboard', 'Ivory Coast', 'Cote d''Ivoire'),
  ('d9958fdc-6df9-4fa3-81b2-f5751b8c51dd', 'EPL', 'espn-scoreboard', 'Man United', 'Manchester United'),
  ('077142f7-c237-4c3f-a733-b9f0b7690aa2', 'EPL', 'espn-scoreboard', 'Man City', 'Manchester City'),
  ('af1f7f4f-a876-4475-a0db-1f1b1f556003', 'EPL', 'espn-scoreboard', 'Tottenham', 'Tottenham Hotspur'),
  ('63527f64-5ef8-43e8-8521-fc6c6d6a9278', 'EPL', 'espn-scoreboard', 'Wolves', 'Wolverhampton Wanderers'),
  ('a35a061b-bb6a-47cc-8255-cf5e99a4f492', 'EPL', 'espn-scoreboard', 'Brighton', 'Brighton & Hove Albion'),
  ('76cf344f-aafd-452d-9ed7-51804a8d769f', 'EPL', 'espn-scoreboard', 'Newcastle', 'Newcastle United'),
  ('02af162f-42d8-4e19-8717-5893e54afe99', 'EPL', 'espn-scoreboard', 'Nottingham Forest', 'Nottm Forest')
ON CONFLICT (sport, provider, alias_name) DO UPDATE SET
  canonical_name = EXCLUDED.canonical_name;
