import type pg from "pg";
import { pool } from "./db.js";

export type CollegeSport = "NCAAF" | "NCAAMB";

type EspnTeam = {
  id: string;
  displayName?: string;
  shortDisplayName?: string;
  location?: string;
  nickname?: string;
  abbreviation?: string;
  slug?: string;
  isActive?: boolean;
};

type ResolvedTeam = { id: string; canonicalName: string; shortName: string };

export const normalizeCollegeAlias = (value: string) => value
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[’']/g, "")
  .replace(/\bsaint\b/g, "st")
  .replace(/\buniversity\b/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");

let aliases = new Map<string, ResolvedTeam | null>();

const aliasKey = (sport: CollegeSport, provider: string, name: string) =>
  `${sport}|${provider}|${normalizeCollegeAlias(name)}`;

export const primeCollegeTeamAliases = async (client: pg.Pool | pg.PoolClient = pool) => {
  const result = await client.query<{
    sport: CollegeSport; provider: string; normalized_alias: string;
    espn_team_id: string | null; is_ambiguous: boolean; canonical_name: string; short_name: string;
  }>(`
    SELECT alias.sport, alias.provider, alias.normalized_alias, alias.espn_team_id,
           alias.is_ambiguous, sport.canonical_name, sport.short_name
    FROM college_program_alias alias
    LEFT JOIN college_program_sport sport
      ON sport.espn_team_id = alias.espn_team_id AND sport.sport = alias.sport
  `);
  aliases = new Map(result.rows.map((row) => [
    `${row.sport}|${row.provider}|${row.normalized_alias}`,
    row.is_ambiguous || !row.espn_team_id ? null : {
      id: row.espn_team_id, canonicalName: row.canonical_name, shortName: row.short_name
    }
  ]));
  return aliases.size;
};

export const resolveCollegeTeam = (sport: CollegeSport, name: string, provider = "*") => {
  const exact = aliases.get(aliasKey(sport, provider, name));
  if (exact !== undefined) return exact;
  return aliases.get(aliasKey(sport, "*", name));
};

export const collegeTeamKey = (sport: CollegeSport, name: string, provider = "*") =>
  resolveCollegeTeam(sport, name, provider)?.id ?? `name:${normalizeCollegeAlias(name)}`;

const directory = {
  NCAAF: ["football", "college-football"],
  NCAAMB: ["basketball", "mens-college-basketball"]
} as const;

const fetchTeams = async (sport: CollegeSport): Promise<EspnTeam[]> => {
  const [category, league] = directory[sport];
  const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${category}/${league}/teams?limit=1000`);
  if (!response.ok) throw new Error(`ESPN ${sport} team directory failed with ${response.status}`);
  const body: any = await response.json();
  return (body.sports?.[0]?.leagues?.[0]?.teams ?? []).map((entry: any) => entry.team);
};

const generatedAliases = (team: EspnTeam) => [...new Set([
  team.displayName,
  team.shortDisplayName,
  team.location,
  team.abbreviation,
  team.slug?.replaceAll("-", " "),
  team.location && team.nickname ? `${team.location} ${team.nickname}` : null
].filter((value): value is string => Boolean(value?.trim())))];

export const syncCollegePrograms = async (client: pg.PoolClient) => {
  const totals: Record<CollegeSport, { teams: number; aliases: number; ambiguous: number }> = {
    NCAAF: { teams: 0, aliases: 0, ambiguous: 0 },
    NCAAMB: { teams: 0, aliases: 0, ambiguous: 0 }
  };
  for (const sport of Object.keys(directory) as CollegeSport[]) {
    const teams = await fetchTeams(sport);
    const candidates = new Map<string, Array<{ team: EspnTeam; alias: string }>>();
    for (const team of teams) {
      if (!team.id || !team.displayName) continue;
      const canonicalName = team.displayName;
      const shortName = team.shortDisplayName ?? team.location ?? canonicalName;
      await client.query(`
        INSERT INTO college_program (
          espn_team_id, canonical_name, short_name, location, nickname, abbreviation, slug, is_active, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
        ON CONFLICT (espn_team_id) DO UPDATE SET
          canonical_name=EXCLUDED.canonical_name, short_name=EXCLUDED.short_name,
          location=EXCLUDED.location, nickname=EXCLUDED.nickname,
          abbreviation=EXCLUDED.abbreviation, slug=EXCLUDED.slug,
          is_active=EXCLUDED.is_active, updated_at=now()
      `, [team.id, canonicalName, shortName, team.location ?? shortName, team.nickname ?? "",
        team.abbreviation ?? "", team.slug ?? "", team.isActive !== false]);
      await client.query(`
        INSERT INTO college_program_sport (espn_team_id, sport, canonical_name, short_name, is_active, updated_at)
        VALUES ($1,$2,$3,$4,$5,now())
        ON CONFLICT (espn_team_id, sport) DO UPDATE SET
          canonical_name=EXCLUDED.canonical_name, short_name=EXCLUDED.short_name,
          is_active=EXCLUDED.is_active, updated_at=now()
      `, [team.id, sport, canonicalName, shortName, team.isActive !== false]);
      totals[sport].teams += 1;
      for (const alias of generatedAliases(team)) {
        const key = normalizeCollegeAlias(alias);
        candidates.set(key, [...(candidates.get(key) ?? []), { team, alias }]);
      }
    }
    for (const [normalized, matches] of candidates) {
      const ids = [...new Set(matches.map(({ team }) => team.id))];
      const ambiguous = ids.length !== 1;
      await client.query(`
        INSERT INTO college_program_alias (
          sport, provider, normalized_alias, alias_name, espn_team_id, is_ambiguous, source, updated_at
        ) VALUES ($1,'*',$2,$3,$4,$5,'espn-directory',now())
        ON CONFLICT (sport, provider, normalized_alias) DO UPDATE SET
          alias_name=EXCLUDED.alias_name, espn_team_id=EXCLUDED.espn_team_id,
          is_ambiguous=EXCLUDED.is_ambiguous, source=EXCLUDED.source, updated_at=now()
      `, [sport, normalized, matches[0].alias, ambiguous ? null : ids[0], ambiguous]);
      totals[sport].aliases += 1;
      if (ambiguous) totals[sport].ambiguous += 1;
    }
  }
  return totals;
};
