import { generateAiPicks } from "../src/server/ai.js";
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

const run = async () => {
  const now = new Date();
  const todayCentral = centralDate(now);
  const [mlbGames, ncaafGames] = await Promise.all([
    fetchMlbGamesForCentralDate(todayCentral),
    fetchNcaafGamesForCentralDate(todayCentral)
  ]);

  if (!mlbGames.length && !ncaafGames.length) {
    return {
      status: "skipped",
      reason: "no MLB or NCAAF games found for today",
      todayCentral
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

  return {
    status: "checked",
    todayCentral,
    sports
  };
};

try {
  console.log(JSON.stringify(await run(), null, 2));
} finally {
  await pool.end();
}
