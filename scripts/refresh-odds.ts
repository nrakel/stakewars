import { refreshOdds } from "../src/server/odds.js";
import { generateAiPicks, snapshotAiCandidates } from "../src/server/ai.js";
import { pool } from "../src/server/db.js";
import { refreshMlbGameContext } from "../src/server/mlbContext.js";

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

const addDays = (date: string, days: number) => {
  const copy = new Date(`${date}T00:00:00Z`);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
};

try {
  const result = await refreshOdds();
  const todayCentral = centralDate();
  let mlbContext: unknown;
  try {
    mlbContext = await refreshMlbGameContext({ startDate: todayCentral, endDate: addDays(todayCentral, 1) });
  } catch (error) {
    mlbContext = { error: error instanceof Error ? error.message : "MLB context refresh failed" };
    console.error("MLB context refresh failed", error);
  }
  const snapshot = await snapshotAiCandidates({ sport: "MLB", source: "odds-refresh" });
  const picks = await generateAiPicks({
    sport: "MLB",
    maxPicks: 5,
    placeWagers: true,
    marketKey: "h2h",
    sortBy: "confidence",
    uniqueGames: true
  });
  console.log(JSON.stringify({ ...result, mlbContext, snapshot, picks }, null, 2));
} finally {
  await pool.end();
}
