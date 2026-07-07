import { generateAiPicks } from "../src/server/ai.js";
import { pool } from "../src/server/db.js";

type MlbScheduleResponse = {
  dates?: Array<{
    games?: Array<{
      gameDate: string;
    }>;
  }>;
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

const run = async () => {
  const now = new Date();
  const todayCentral = centralDate(now);
  const games = await fetchMlbGamesForCentralDate(todayCentral);

  if (!games.length) {
    return {
      status: "skipped",
      reason: "no MLB games found for today",
      todayCentral
    };
  }

  const picks = await generateAiPicks({
    sport: "MLB",
    maxPicks: 5,
    placeWagers: true,
    marketKey: "h2h",
    forDate: todayCentral,
    sortBy: "confidence",
    uniqueGames: true
  });

  return {
    status: "checked",
    todayCentral,
    firstPitch: games[0].toISOString(),
    lastPitch: games[games.length - 1].toISOString(),
    picks
  };
};

try {
  console.log(JSON.stringify(await run(), null, 2));
} finally {
  await pool.end();
}
