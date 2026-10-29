import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { query, transaction } from "./db.js";

type Usage = { credits_used: number; credits_remaining: number };
type Outcome = { name?: string; description?: string; price?: number | null; point?: number | null };
type Event = { id: string; away_team: string; home_team: string; commence_time: string };

const requestedMarkets = [
  "player_pass_completions", "player_pass_yds", "player_pass_tds",
  "player_rush_attempts", "player_rush_yds", "player_rush_tds",
  "player_receptions", "player_reception_yds", "player_reception_tds"
];

const statAliases: Record<string, string> = {
  player_pass_completions: "completions", player_passing_completions: "completions",
  player_pass_yds: "passYards", player_passing_yards: "passYards",
  player_pass_tds: "passTds", player_passing_touchdowns: "passTds", player_touchdown_passes: "passTds",
  player_rush_attempts: "carries", player_rushing_attempts: "carries",
  player_rush_yds: "rushYards", player_rushing_yards: "rushYards",
  player_rush_tds: "rushTds", player_rushing_touchdowns: "rushTds",
  player_receptions: "receptions",
  player_rec_yds: "receivingYards", player_reception_yds: "receivingYards", player_receiving_yards: "receivingYards",
  player_rec_tds: "receivingTds", player_reception_tds: "receivingTds", player_receiving_touchdowns: "receivingTds"
};

export const nflPlayerKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

const api = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { headers: { "X-API-Key": config.parlayApiKey ?? "" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Parlay player props failed with ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json() as Promise<T>;
};

const usage = () => api<Usage>(`${config.parlayApiBaseUrl.replace(/\/$/, "")}/usage`);

export const refreshNflPlayerProps = async (gameId: string) => {
  if (!config.parlayApiKey) return 0;
  const gameResult = await query<{ awayTeam: string; homeTeam: string; startsAt: Date }>(
    `SELECT away_team AS "awayTeam", home_team AS "homeTeam", starts_at AS "startsAt" FROM nfl_confidence_game WHERE id = $1`, [gameId]
  );
  const game = gameResult.rows[0];
  if (!game) throw new Error("NFL game not found for player props");
  const base = config.parlayApiBaseUrl.replace(/\/$/, "");
  const from = new Date(game.startsAt.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const to = new Date(game.startsAt.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const eventsUrl = new URL(`${base}/sports/americanfootball_nfl/events`);
  eventsUrl.searchParams.set("commenceTimeFrom", from);
  eventsUrl.searchParams.set("commenceTimeTo", to);
  eventsUrl.searchParams.set("dateFormat", "iso");
  const before = await usage();
  const events = await api<Event[]>(eventsUrl.toString());
  const event = events.find((candidate) => candidate.away_team === game.awayTeam && candidate.home_team === game.homeTeam);
  if (!event) throw new Error(`Parlay event not found for ${game.awayTeam} @ ${game.homeTeam}`);
  const oddsUrl = new URL(`${base}/sports/americanfootball_nfl/events/${event.id}/odds`);
  oddsUrl.searchParams.set("regions", "us");
  oddsUrl.searchParams.set("markets", requestedMarkets.join(","));
  oddsUrl.searchParams.set("oddsFormat", "american");
  oddsUrl.searchParams.set("dateFormat", "iso");
  const odds = await api<any>(oddsUrl.toString());
  const rows = new Map<string, any>();
  for (const bookmaker of odds?.bookmakers ?? []) for (const market of bookmaker?.markets ?? []) {
    const statKey = statAliases[String(market.key)];
    if (!statKey) continue;
    for (const outcome of market?.outcomes ?? [] as Outcome[]) {
      const playerName = String(outcome.description ?? "").trim();
      const point = Number(outcome.point);
      if (!playerName || !Number.isFinite(point)) continue;
      const key = `${nflPlayerKey(playerName)}|${statKey}|${bookmaker.key}`;
      const row = rows.get(key) ?? { playerName, playerKey: nflPlayerKey(playerName), statKey, bookmakerKey: bookmaker.key, bookmakerTitle: bookmaker.title, marketKey: market.key, point, overOdds: null, underOdds: null };
      if (/^over\b/i.test(String(outcome.name))) row.overOdds = Number.isFinite(Number(outcome.price)) ? Number(outcome.price) : null;
      if (/^under\b/i.test(String(outcome.name))) row.underOdds = Number.isFinite(Number(outcome.price)) ? Number(outcome.price) : null;
      rows.set(key, row);
    }
  }
  await transaction(async (client) => {
    await client.query("DELETE FROM nfl_player_prop_line WHERE game_id = $1", [gameId]);
    for (const row of rows.values()) await client.query(
      `INSERT INTO nfl_player_prop_line (id, game_id, provider_event_id, player_name, player_key, stat_key, bookmaker_key, bookmaker_title, market_key, point, over_odds, under_odds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [randomUUID(), gameId, event.id, row.playerName, row.playerKey, row.statKey, row.bookmakerKey, row.bookmakerTitle, row.marketKey, row.point, row.overOdds, row.underOdds]
    );
  });
  const after = await usage();
  await query(
    `INSERT INTO parlay_usage_log (job_name, credits_before, credits_after, credits_delta, credits_remaining, metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
    ["refresh-nfl-player-props", before.credits_used, after.credits_used, Math.max(after.credits_used - before.credits_used, 0), after.credits_remaining, { gameId, providerEventId: event.id, rows: rows.size }]
  );
  return rows.size;
};
