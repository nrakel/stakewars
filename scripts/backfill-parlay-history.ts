import { pool } from "../src/server/db.js";
import { backfillParlayMlbHistory } from "../src/server/historicalBackfill.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

const parlayMlbCoverageEnd = "2026-05-12";
const defaultEnd = parlayMlbCoverageEnd;
const defaultStart = new Date(Date.UTC(2026, 4, 12 - 29))
  .toISOString()
  .slice(0, 10);

const endpoints = (args.get("endpoints") ?? "matches,closing-odds,odds")
  .split(",")
  .map((endpoint) => endpoint.trim())
  .filter(Boolean) as Array<"matches" | "odds" | "closing-odds">;

try {
  const result = await backfillParlayMlbHistory({
    startDate: args.get("start") ?? defaultStart,
    endDate: args.get("end") ?? defaultEnd,
    endpoints,
    dryRun: args.get("dry-run") === "true"
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
