import { generateAiPicks, placeDailyAiParlay, recordDailyChinePicks } from "../src/server/ai.js";
import { pool } from "../src/server/db.js";

type MlbScheduleResponse = {
  dates?: Array<{
    games?: Array<{
      gameDate: string;
    }>;
  }>;
};

type ParlayEvent = {
  commence_time: string;
};

const centralDate = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const fetchMlbGamesForCentralDate = async (targetDate: string) => {
  const response = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${targetDate}&endDate=${targetDate}`);
  if (!response.ok) {
    throw new Error(`MLB schedule failed with ${response.status}`);
  }

  const body = (await response.json()) as MlbScheduleResponse;
  return (body.dates ?? [])
    .flatMap((date) => date.games ?? [])
    .map((game) => new Date(game.gameDate))
    .filter((date) => Number.isFinite(date.getTime()) && centralDate(date) === targetDate)
    .sort((left, right) => left.getTime() - right.getTime());
};

const fetchNcaafGamesForCentralDate = async (targetDate: string) => {
  if (!process.env.PARLAY_API_KEY) {
    return [];
  }

  const base = (process.env.PARLAY_API_BASE_URL ?? "https://parlay-api.com/v1").replace(/\/$/, "");
  const from = new Date(`${targetDate}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${targetDate}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 2);
  const url = new URL(`${base}/sports/americanfootball_ncaaf/events`);
  url.searchParams.set("commenceTimeFrom", from.toISOString());
  url.searchParams.set("commenceTimeTo", to.toISOString());
  url.searchParams.set("dateFormat", "iso");

  const response = await fetch(url, {
    headers: { "X-API-Key": process.env.PARLAY_API_KEY }
  });
  if (!response.ok) {
    throw new Error(`NCAAF schedule failed with ${response.status}`);
  }

  return ((await response.json()) as ParlayEvent[])
    .map((event) => new Date(event.commence_time))
    .filter((date) => Number.isFinite(date.getTime()) && centralDate(date) === targetDate)
    .sort((left, right) => left.getTime() - right.getTime());
};

const fetchNflGamesForCentralDate = async (targetDate: string) => {
  if (!process.env.PARLAY_API_KEY) {
    return [];
  }

  const base = (process.env.PARLAY_API_BASE_URL ?? "https://parlay-api.com/v1").replace(/\/$/, "");
  const from = new Date(`${targetDate}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${targetDate}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 2);
  const url = new URL(`${base}/sports/americanfootball_nfl/events`);
  url.searchParams.set("commenceTimeFrom", from.toISOString());
  url.searchParams.set("commenceTimeTo", to.toISOString());
  url.searchParams.set("dateFormat", "iso");

  const response = await fetch(url, {
    headers: { "X-API-Key": process.env.PARLAY_API_KEY }
  });
  if (!response.ok) {
    throw new Error(`NFL schedule failed with ${response.status}`);
  }

  return ((await response.json()) as ParlayEvent[])
    .map((event) => new Date(event.commence_time))
    .filter((date) => Number.isFinite(date.getTime()) && centralDate(date) === targetDate)
    .sort((left, right) => left.getTime() - right.getTime());
};

const fetchNhlGamesForCentralDate = async (targetDate: string) => {
  const result = await pool.query<{ starts_at: Date }>(
    `
      SELECT DISTINCT starts_at
      FROM game_line
      WHERE sport = 'NHL'
        AND is_active = true
        AND market_key = 'h2h'
        AND (starts_at AT TIME ZONE 'America/Chicago')::date = $1::date
        AND starts_at > now()
      ORDER BY starts_at
    `,
    [targetDate]
  );
  return result.rows.map((row) => row.starts_at);
};

const run = async () => {
  const now = new Date();
  const todayCentral = centralDate(now);
  const [mlbGames, nhlGames, ncaafGames, nflGames] = await Promise.all([
    fetchMlbGamesForCentralDate(todayCentral),
    fetchNhlGamesForCentralDate(todayCentral),
    fetchNcaafGamesForCentralDate(todayCentral),
    fetchNflGamesForCentralDate(todayCentral)
  ]);
  const dailyPicks = await recordDailyChinePicks(todayCentral);

  if (!mlbGames.length && !nhlGames.length && !ncaafGames.length && !nflGames.length) {
    return {
      status: "skipped",
      reason: "no MLB, NHL, NCAAF, or NFL games found for today",
      todayCentral,
      dailyPicks
    };
  }

  const sports = [];
  if (mlbGames.length) {
    sports.push({
      sport: "MLB",
      firstStart: mlbGames[0].toISOString(),
      lastStart: mlbGames[mlbGames.length - 1].toISOString(),
      picks: await generateAiPicks({
        sport: "MLB",
        maxPicks: 5,
        placeWagers: true,
        marketKey: "h2h",
        forDate: todayCentral,
        sortBy: "confidence",
        uniqueGames: true
      })
    });
  }
  if (nhlGames.length) {
    sports.push({
      sport: "NHL",
      firstStart: nhlGames[0].toISOString(),
      lastStart: nhlGames[nhlGames.length - 1].toISOString(),
      picks: await generateAiPicks({
        sport: "NHL",
        maxPicks: 5,
        placeWagers: true,
        marketKey: "h2h",
        forDate: todayCentral,
        sortBy: "confidence",
        uniqueGames: true
      })
    });
  }
  if (nflGames.length) {
    sports.push({
      sport: "NFL",
      firstStart: nflGames[0].toISOString(),
      lastStart: nflGames[nflGames.length - 1].toISOString(),
      picks: await generateAiPicks({
        sport: "NFL",
        maxPicks: 5,
        placeWagers: true,
        marketKey: "spreads",
        forDate: todayCentral,
        sortBy: "confidence",
        uniqueGames: true
      })
    });
  }
  if (ncaafGames.length) {
    sports.push({
      sport: "NCAAF",
      firstStart: ncaafGames[0].toISOString(),
      lastStart: ncaafGames[ncaafGames.length - 1].toISOString(),
      picks: await generateAiPicks({
        sport: "NCAAF",
        maxPicks: 5,
        placeWagers: true,
        marketKey: "spreads",
        forDate: todayCentral,
        sortBy: "confidence",
        uniqueGames: true
      })
    });
  }

  const dailyParlay = await placeDailyAiParlay({ forDate: todayCentral });

  return {
    status: "checked",
    todayCentral,
    sports,
    dailyParlay,
    dailyPicks
  };
};

try {
  console.log(JSON.stringify(await run(), null, 2));
} finally {
  await pool.end();
}
