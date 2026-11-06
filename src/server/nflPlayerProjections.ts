import { randomUUID } from "node:crypto";
import { query, transaction } from "./db.js";

const MODEL_VERSION = "nfl-boxscore-projection-v2";
const ESPN_SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=";
const ESPN_ROSTER = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/";
const responseCache = new Map<string, Promise<any>>();

type Position = "QB" | "RB" | "WR" | "TE";
type StatLine = {
  completions: number; passAttempts: number; passYards: number; passTds: number;
  carries: number; rushYards: number; rushTds: number;
  receptions: number; receivingYards: number; receivingTds: number; targets: number;
};
type PlayerLine = StatLine & { playerId: string; playerName: string };
type TeamGame = { players: Map<string, PlayerLine>; totals: StatLine };
type HistoricalGame = { providerEventId: string; startsAt: Date; awayTeam: string; homeTeam: string };

const emptyLine = (): StatLine => ({
  completions: 0, passAttempts: 0, passYards: 0, passTds: 0,
  carries: 0, rushYards: 0, rushTds: 0,
  receptions: 0, receivingYards: 0, receivingTds: 0, targets: 0
});
const number = (value: unknown) => Number.parseFloat(String(value ?? "0")) || 0;
const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const parseFootballTeamBoxScore = (team: any): TeamGame => {
  const players = new Map<string, PlayerLine>();
  const getPlayer = (athlete: any) => {
    const playerId = String(athlete?.athlete?.id ?? "");
    const existing = players.get(playerId);
    if (existing) return existing;
    const created: PlayerLine = { ...emptyLine(), playerId, playerName: String(athlete?.athlete?.displayName ?? "Unknown") };
    players.set(playerId, created);
    return created;
  };
  for (const group of team?.statistics ?? []) {
    for (const athlete of group?.athletes ?? []) {
      const line = getPlayer(athlete);
      const stats = athlete?.stats ?? [];
      if (group.name === "passing") {
        const [completions, attempts] = String(stats[0] ?? "0/0").split("/").map(number);
        Object.assign(line, { completions, passAttempts: attempts, passYards: number(stats[1]), passTds: number(stats[3]) });
      } else if (group.name === "rushing") {
        Object.assign(line, { carries: number(stats[0]), rushYards: number(stats[1]), rushTds: number(stats[3]) });
      } else if (group.name === "receiving") {
        Object.assign(line, { receptions: number(stats[0]), receivingYards: number(stats[1]), receivingTds: number(stats[3]), targets: number(stats[5]) });
      }
    }
  }
  const totals = [...players.values()].reduce((sum, line) => {
    for (const key of Object.keys(sum) as (keyof StatLine)[]) sum[key] += line[key];
    return sum;
  }, emptyLine());
  return { players, totals };
};

const fetchJson = async (url: string) => {
  const cached = responseCache.get(url);
  if (cached) return cached;
  const request = fetch(url, { signal: AbortSignal.timeout(12_000) }).then(async (response) => {
    if (!response.ok) throw new Error(`NFL projection source returned ${response.status}`);
    return response.json() as Promise<any>;
  });
  responseCache.set(url, request);
  try {
    return await request;
  } catch (error) {
    responseCache.delete(url);
    throw error;
  }
};

const weightedAverage = (values: number[]) => {
  if (!values.length) return 0;
  const recent = values.slice(-5);
  const weights = recent.map((_, index) => index + 1);
  return recent.reduce((sum, value, index) => sum + value * weights[index], 0) / weights.reduce((a, b) => a + b, 0);
};

const teamAverage = (games: TeamGame[], key: keyof StatLine) => weightedAverage(games.map((game) => game.totals[key]));

const projectedTeamTotals = (offense: TeamGame[], opponentAllowed: TeamGame[]) => {
  const keys: (keyof StatLine)[] = ["completions", "passAttempts", "passYards", "passTds", "carries", "rushYards", "rushTds"];
  return Object.fromEntries(keys.map((key) => [key, round((teamAverage(offense, key) + teamAverage(opponentAllowed, key)) / 2, key.includes("Yards") ? 0 : 1)])) as Partial<StatLine>;
};

const playerWeightedLine = (games: TeamGame[], playerId: string) => {
  const keys = Object.keys(emptyLine()) as (keyof StatLine)[];
  const appearances = games.map((game) => game.players.get(playerId)).filter((line): line is PlayerLine => Boolean(line));
  return Object.fromEntries(keys.map((key) => [key, weightedAverage(appearances.map((line) => line[key]))])) as StatLine;
};

const scale = (value: number, teamRecent: number, teamProjection: number) => teamRecent > 0 ? value * teamProjection / teamRecent : value;

const projectPlayer = (position: Position, baseline: StatLine, recentTeam: TeamGame[], projected: Partial<StatLine>) => {
  if (position === "QB") return {
    completions: round(scale(baseline.completions, teamAverage(recentTeam, "completions"), projected.completions ?? 0)),
    passYards: round(scale(baseline.passYards, teamAverage(recentTeam, "passYards"), projected.passYards ?? 0), 0),
    carries: round(baseline.carries), rushYards: round(baseline.rushYards, 0),
    passTds: round(scale(baseline.passTds, teamAverage(recentTeam, "passTds"), projected.passTds ?? 0), 2), rushTds: round(baseline.rushTds, 2)
  };
  if (position === "RB") return {
    carries: round(scale(baseline.carries, teamAverage(recentTeam, "carries"), projected.carries ?? 0)),
    rushYards: round(scale(baseline.rushYards, teamAverage(recentTeam, "rushYards"), projected.rushYards ?? 0), 0),
    receptions: round(scale(baseline.receptions, teamAverage(recentTeam, "completions"), projected.completions ?? 0)),
    receivingYards: round(scale(baseline.receivingYards, teamAverage(recentTeam, "passYards"), projected.passYards ?? 0), 0),
    rushTds: round(scale(baseline.rushTds, teamAverage(recentTeam, "rushTds"), projected.rushTds ?? 0), 2),
    receivingTds: round(scale(baseline.receivingTds, teamAverage(recentTeam, "passTds"), projected.passTds ?? 0), 2)
  };
  return {
    receptions: round(scale(baseline.receptions, teamAverage(recentTeam, "completions"), projected.completions ?? 0)),
    receivingYards: round(scale(baseline.receivingYards, teamAverage(recentTeam, "passYards"), projected.passYards ?? 0), 0),
    receivingTds: round(scale(baseline.receivingTds, teamAverage(recentTeam, "passTds"), projected.passTds ?? 0), 2),
    carries: round(scale(baseline.carries, teamAverage(recentTeam, "carries"), projected.carries ?? 0)),
    rushYards: round(scale(baseline.rushYards, teamAverage(recentTeam, "rushYards"), projected.rushYards ?? 0), 0),
    rushTds: round(scale(baseline.rushTds, teamAverage(recentTeam, "rushTds"), projected.rushTds ?? 0), 2)
  };
};

export const generateNflPlayerProjections = async (gameId: string) => {
  const target = await query<{ id: string; poolId: string; season: number; week: number; providerEventId: string; awayTeam: string; homeTeam: string }>(
    `SELECT id, pool_id AS "poolId", season, week, provider_event_id AS "providerEventId", away_team AS "awayTeam", home_team AS "homeTeam" FROM nfl_confidence_game WHERE id = $1`,
    [gameId]
  );
  const game = target.rows[0];
  if (!game) throw new Error("NFL game not found");
  const history = await query<HistoricalGame>(
    `SELECT provider_event_id AS "providerEventId", starts_at AS "startsAt", away_team AS "awayTeam", home_team AS "homeTeam"
     FROM nfl_confidence_game WHERE pool_id = $1 AND week < $2 AND status = 'final'
       AND (away_team IN ($3, $4) OR home_team IN ($3, $4)) ORDER BY starts_at`,
    [game.poolId, game.week, game.awayTeam, game.homeTeam]
  );
  const upcoming = await fetchJson(`${ESPN_SUMMARY}${game.providerEventId}`);
  const teamIds = new Map<string, string>();
  for (const competitor of upcoming?.header?.competitions?.[0]?.competitors ?? []) teamIds.set(String(competitor.team.displayName), String(competitor.team.id));
  const positions = new Map<string, Position>();
  await Promise.all([game.awayTeam, game.homeTeam].map(async (teamName) => {
    const teamId = teamIds.get(teamName);
    if (!teamId) return;
    const roster = await fetchJson(`${ESPN_ROSTER}${teamId}/roster`);
    for (const group of roster?.athletes ?? []) for (const athlete of group?.items ?? []) {
      const position = athlete?.position?.abbreviation as Position;
      if (["QB", "RB", "WR", "TE"].includes(position)) positions.set(String(athlete.id), position);
    }
  }));
  const offense = new Map<string, TeamGame[]>();
  const allowed = new Map<string, TeamGame[]>();
  for (const historical of history.rows) {
    const summary = await fetchJson(`${ESPN_SUMMARY}${historical.providerEventId}`);
    const boxes = new Map<string, TeamGame>((summary?.boxscore?.players ?? []).map((team: any) => [String(team.team.displayName), parseFootballTeamBoxScore(team)]));
    for (const tracked of [game.awayTeam, game.homeTeam]) {
      const own = boxes.get(tracked);
      const opponentName = historical.awayTeam === tracked ? historical.homeTeam : historical.awayTeam;
      const opponent = boxes.get(opponentName);
      if (own) offense.set(tracked, [...(offense.get(tracked) ?? []), own]);
      if (opponent) allowed.set(tracked, [...(allowed.get(tracked) ?? []), opponent]);
    }
  }
  const rows: any[] = [];
  for (const team of [game.awayTeam, game.homeTeam]) {
    const opponent = team === game.awayTeam ? game.homeTeam : game.awayTeam;
    const teamGames = offense.get(team) ?? [];
    const opponentAllowed = allowed.get(opponent) ?? [];
    if (!teamGames.length || !opponentAllowed.length) continue;
    const teamProjection = projectedTeamTotals(teamGames, opponentAllowed);
    const playerIds = [...new Set(teamGames.flatMap((teamGame) => [...teamGame.players.keys()]))];
    const candidates = playerIds.map((playerId) => {
      const baseline = playerWeightedLine(teamGames, playerId);
      const latest = [...teamGames].reverse().find((teamGame) => teamGame.players.has(playerId))?.players.get(playerId);
      return { playerId, playerName: latest?.playerName ?? playerId, position: positions.get(playerId), baseline, latest: latest ?? emptyLine() };
    }).filter((player): player is typeof player & { position: Position } => Boolean(player.position));
    const opportunities = (line: StatLine, position: Position) => position === "QB" ? line.passAttempts : position === "RB" ? line.carries + line.targets : line.targets;
    const score = (player: typeof candidates[number]) => opportunities(player.baseline, player.position) + opportunities(player.latest, player.position) * 2;
    const limits: Record<Position, number | null> = { QB: 1, RB: null, WR: null, TE: null };
    for (const position of ["QB", "RB", "WR", "TE"] as Position[]) {
      const ranked = candidates
        .filter((player) => player.position === position && score(player) > 0)
        .sort((a, b) => score(b) - score(a));
      const selected = limits[position] === null ? ranked : ranked.slice(0, limits[position] ?? 0);
      selected.forEach((player, index) => rows.push({
        team, opponent, playerId: player.playerId, playerName: player.playerName, position, roleRank: index + 1,
        projectedStats: projectPlayer(position, player.baseline, teamGames, teamProjection),
        modelInputs: {
          gamesUsed: teamGames.length,
          offense: { passYards: round(teamAverage(teamGames, "passYards"), 0), rushYards: round(teamAverage(teamGames, "rushYards"), 0), passTds: round(teamAverage(teamGames, "passTds"), 2), rushTds: round(teamAverage(teamGames, "rushTds"), 2) },
          opponentDefense: { passYardsAllowed: round(teamAverage(opponentAllowed, "passYards"), 0), rushYardsAllowed: round(teamAverage(opponentAllowed, "rushYards"), 0), passTdsAllowed: round(teamAverage(opponentAllowed, "passTds"), 2), rushTdsAllowed: round(teamAverage(opponentAllowed, "rushTds"), 2) },
          projectedTeam: teamProjection
        }
      }));
    }
  }
  await transaction(async (client) => {
    await client.query("DELETE FROM nfl_player_projection WHERE game_id = $1", [game.id]);
    for (const row of rows) await client.query(
      `INSERT INTO nfl_player_projection (id, pool_id, game_id, season, week, team, opponent, player_id, player_name, position, role_rank, projected_stats, model_inputs, model_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [randomUUID(), game.poolId, game.id, game.season, game.week, row.team, row.opponent, row.playerId, row.playerName, row.position, row.roleRank, row.projectedStats, row.modelInputs, MODEL_VERSION]
    );
  });
  return rows.length;
};

export const generateNflWeekPlayerProjections = async (season: number, week: number) => {
  const games = await query<{ id: string; awayTeam: string; homeTeam: string; startsAt: Date }>(`
    SELECT game.id, game.away_team AS "awayTeam", game.home_team AS "homeTeam",
      game.starts_at AS "startsAt"
    FROM nfl_confidence_game game
    JOIN nfl_confidence_pool pool ON pool.id = game.pool_id
    WHERE pool.status = 'active' AND game.season = $1 AND game.week = $2
    ORDER BY game.starts_at, game.away_team
  `, [season, week]);
  const results: Array<{
    gameId: string; matchup: string; projections: number; error?: string;
  }> = [];
  for (const game of games.rows) {
    try {
      const projections = await generateNflPlayerProjections(game.id);
      results.push({ gameId: game.id, matchup: `${game.awayTeam} @ ${game.homeTeam}`, projections });
    } catch (error) {
      results.push({
        gameId: game.id,
        matchup: `${game.awayTeam} @ ${game.homeTeam}`,
        projections: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
};
