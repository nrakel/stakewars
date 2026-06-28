import { refreshOdds } from "../src/server/odds.js";
import { generateAiPicks, snapshotAiCandidates } from "../src/server/ai.js";
import { pool } from "../src/server/db.js";

try {
  const result = await refreshOdds();
  const snapshot = await snapshotAiCandidates({ sport: "MLB", source: "odds-refresh" });
  const picks = await generateAiPicks({
    sport: "MLB",
    maxPicks: 5,
    placeWagers: true,
    marketKey: "h2h",
    sortBy: "confidence",
    uniqueGames: true,
    stakeFractionOfBalance: 0.05
  });
  console.log(JSON.stringify({ ...result, snapshot, picks }, null, 2));
} finally {
  await pool.end();
}
