import { evaluateHistoricalAi } from "../src/server/evaluation.js";
import { pool } from "../src/server/db.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

try {
  const result = await evaluateHistoricalAi({
    startDate: args.get("start") ?? "2026-03-25",
    endDate: args.get("end") ?? "2026-05-12",
    sourceEndpoint: args.get("source") ?? "closing-odds",
    bookmaker: args.get("bookmaker"),
    market: (args.get("market") ?? "h2h") as "h2h" | "spreads",
    picksPerDay: Number(args.get("picks-per-day") ?? 3),
    variant: (args.get("variant") ?? "baseline") as "baseline" | "favorite-form-v1" | "favorite-price-v1"
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
