import { randomUUID } from "node:crypto";
import { pool } from "../src/server/db.js";
import {
  settleMlbStraightWagers,
  settleNcaafWagers,
  settleNflWagers,
  settleNhlWagers,
  settleReconciledGames,
  settleSoccerWagers,
  type FinalGame
} from "../src/server/settlement.js";
import type { SportKey } from "../src/shared/types.js";

type PendingGame = {
  sport: SportKey;
  startsAt: Date;
  awayTeam: string;
  homeTeam: string;
  wagerCount: number;
  providerEventId: string | null;
};

type ProviderGame = {
  sport: SportKey;
  id: string;
  startsAt: Date;
  awayTeam: string;
  homeTeam: string;
  state: "scheduled" | "active" | "final" | "cancelled";
  awayScore: number | null;
  homeScore: number | null;
  detail: string;
};

const dateText = (date: Date) => date.toISOString().slice(0, 10);
const shiftDate = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return dateText(value);
};
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const espnEventId = (providerEventId: string | null) => providerEventId?.match(/(?:^|\|)espn:(\d+)(?:\||$)/)?.[1] ?? null;
const sameTeams = (pending: PendingGame, provider: ProviderGame) =>
  normalize(pending.awayTeam) === normalize(provider.awayTeam) && normalize(pending.homeTeam) === normalize(provider.homeTeam);
const sameProviderGame = (pending: PendingGame, provider: ProviderGame) => {
  const storedEspnId = espnEventId(pending.providerEventId);
  return storedEspnId ? storedEspnId === provider.id : sameTeams(pending, provider);
};

const classifyStatus = (state: string, detail: string, completed = false): ProviderGame["state"] => {
  const text = `${state} ${detail}`.toLowerCase();
  if (/postpon|cancel|suspend|no contest/.test(text)) return "cancelled";
  if (completed || state === "post" || /\bfinal\b/.test(text)) return "final";
  if (state === "in" || /in progress|intermission|halftime|period|quarter|inning/.test(text)) return "active";
  return "scheduled";
};

const fetchEspn = async (sport: "NHL" | "NFL" | "NCAAF" | "EPL", startDate: string, endDate: string) => {
  const path = sport === "NHL" ? "hockey/nhl" : sport === "NFL" ? "football/nfl" : sport === "NCAAF" ? "football/college-football" : "soccer/eng.1";
  const games: ProviderGame[] = [];
  for (let cursor = startDate; cursor <= endDate; cursor = shiftDate(cursor, 1)) {
    const url = new URL(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
    url.searchParams.set("dates", cursor.replace(/-/g, ""));
    url.searchParams.set("limit", "300");
    const response = await fetch(url, { headers: { accept: "*/*", "user-agent": "curl/8.0.1" } });
    if (!response.ok) throw new Error(`ESPN ${sport} reconciliation failed with ${response.status}`);
    const body = await response.json() as any;
    for (const event of body.events ?? []) {
      const competition = event.competitions?.[0];
      const away = competition?.competitors?.find((team: any) => team.homeAway === "away");
      const home = competition?.competitors?.find((team: any) => team.homeAway === "home");
      const startsAt = new Date(event.date);
      if (!away?.team?.displayName || !home?.team?.displayName || Number.isNaN(startsAt.getTime())) continue;
      const status = event.status?.type ?? competition?.status?.type ?? {};
      const detail = status.detail ?? status.description ?? status.name ?? "";
      games.push({
        sport,
        id: String(event.id),
        startsAt,
        awayTeam: away.team.displayName,
        homeTeam: home.team.displayName,
        state: classifyStatus(status.state ?? "", detail, status.completed === true),
        awayScore: Number.isFinite(Number(away.score)) ? Number(away.score) : null,
        homeScore: Number.isFinite(Number(home.score)) ? Number(home.score) : null,
        detail
      });
    }
  }
  return games;
};

const fetchMlb = async (startDate: string, endDate: string) => {
  const url = new URL("https://statsapi.mlb.com/api/v1/schedule");
  url.searchParams.set("sportId", "1");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("hydrate", "team,linescore");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`MLB reconciliation failed with ${response.status}`);
  const body = await response.json() as any;
  return (body.dates ?? []).flatMap((date: any) => date.games ?? []).flatMap((game: any): ProviderGame[] => {
    const startsAt = new Date(game.gameDate);
    const away = game.teams?.away;
    const home = game.teams?.home;
    if (!away?.team?.name || !home?.team?.name || Number.isNaN(startsAt.getTime())) return [];
    const detail = `${game.status?.abstractGameState ?? ""} ${game.status?.detailedState ?? ""} ${game.status?.statusCode ?? ""}`;
    return [{
      sport: "MLB",
      id: String(game.gamePk),
      startsAt,
      awayTeam: away.team.name,
      homeTeam: home.team.name,
      state: classifyStatus(game.status?.abstractGameState ?? "", detail, game.status?.statusCode === "F"),
      awayScore: Number.isFinite(Number(away.score)) ? Number(away.score) : null,
      homeScore: Number.isFinite(Number(home.score)) ? Number(home.score) : null,
      detail
    }];
  });
};

const loadPending = async () => (await pool.query<PendingGame>(`
  SELECT gl.sport, min(gl.starts_at) AS "startsAt", gl.away_team AS "awayTeam", gl.home_team AS "homeTeam",
         count(DISTINCT w.id)::int AS "wagerCount", min(gl.provider_event_id) AS "providerEventId"
  FROM wager w
  JOIN wager_leg wl ON wl.wager_id = w.id
  JOIN game_line gl ON gl.id = wl.game_line_id
  WHERE w.status = 'pending' AND wl.status = 'pending'
    AND gl.starts_at <= now()
    AND gl.starts_at >= now() - INTERVAL '14 days'
  GROUP BY gl.sport, gl.away_team, gl.home_team
  ORDER BY min(gl.starts_at)
`)).rows;

const settleBySport = async (sport: SportKey, startDate: string, endDate: string) => {
  if (sport === "MLB") return settleMlbStraightWagers(startDate, endDate);
  if (sport === "NHL") return settleNhlWagers(startDate, endDate);
  if (sport === "NFL") return settleNflWagers(startDate, endDate);
  if (sport === "NCAAF") return settleNcaafWagers(startDate, endDate);
  if (sport === "EPL") return settleSoccerWagers(startDate, endDate);
  return null;
};

const initial = await loadPending();
const settledRuns: unknown[] = [];
for (const sport of [...new Set(initial.map((game) => game.sport))]) {
  const games = initial.filter((game) => game.sport === sport);
  const dates = games.map((game) => dateText(game.startsAt)).sort();
  const result = await settleBySport(sport, shiftDate(dates[0], -1), shiftDate(dates.at(-1)!, 1));
  if (result) settledRuns.push({ sport, result });
}

const unresolved = await loadPending();
const actions: Array<Record<string, unknown>> = [];
const terminalGames = new Map<SportKey, FinalGame[]>();
for (const sport of [...new Set(unresolved.map((game) => game.sport))]) {
  const games = unresolved.filter((game) => game.sport === sport);
  const dates = games.map((game) => dateText(game.startsAt)).sort();
  let providerGames: ProviderGame[] = [];
  if (sport === "MLB") providerGames = await fetchMlb(shiftDate(dates[0], -1), shiftDate(dates.at(-1)!, 1));
  else if (sport === "NHL" || sport === "NFL" || sport === "NCAAF" || sport === "EPL") providerGames = await fetchEspn(sport, shiftDate(dates[0], -1), shiftDate(dates.at(-1)!, 1));
  else {
    actions.push(...games.map((game) => ({ ...game, classification: "unsupported" })));
    continue;
  }

  for (const game of games) {
    const matches = providerGames.filter((candidate) => sameProviderGame(game, candidate));
    if (matches.length !== 1) {
      actions.push({ ...game, classification: matches.length ? "ambiguous" : "missing", candidateCount: matches.length });
      continue;
    }
    const match = matches[0];
    if (match.state === "cancelled" || match.state === "final") {
      if (match.state === "final" && (match.awayScore === null || match.homeScore === null)) {
        actions.push({ ...game, classification: "final_missing_score", providerGameId: match.id });
        continue;
      }
      terminalGames.set(sport, [...(terminalGames.get(sport) ?? []), {
        providerGameId: match.id,
        startsAt: match.startsAt.toISOString(), startsOn: dateText(match.startsAt),
        awayTeam: match.awayTeam,
        homeTeam: match.homeTeam,
        awayScore: match.awayScore ?? 0,
        homeScore: match.homeScore ?? 0,
        noAction: match.state === "cancelled",
        metadata: { source: "hourly-reconciliation", detail: match.detail }
      }]);
      actions.push({ ...game, classification: match.state, providerGameId: match.id, detail: match.detail });
    } else if (match.state === "scheduled" && Math.abs(match.startsAt.getTime() - game.startsAt.getTime()) > 5 * 60_000) {
      await pool.query(`UPDATE game_line SET starts_at=$1, updated_at=now() WHERE sport=$2 AND away_team=$3 AND home_team=$4 AND starts_at=$5`, [match.startsAt, sport, game.awayTeam, game.homeTeam, game.startsAt]);
      actions.push({ ...game, classification: "rescheduled", newStartsAt: match.startsAt.toISOString(), providerGameId: match.id });
    } else {
      actions.push({ ...game, classification: match.state, providerGameId: match.id, detail: match.detail });
    }
  }
}

for (const [sport, games] of terminalGames) await settleReconciledGames(sport as any, games);
const remaining = await loadPending();
const summary = { checked: initial.length, settledRuns, actions, remaining: remaining.length };
await pool.query(`INSERT INTO admin_audit_log (id,user_id,action,metadata,user_agent) VALUES ($1,NULL,'pending_wager_reconciliation',$2,'systemd')`, [randomUUID(), JSON.stringify(summary)]);
console.log(JSON.stringify(summary, null, 2));
await pool.end();
