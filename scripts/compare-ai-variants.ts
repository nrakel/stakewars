import { pool } from "../src/server/db.js";
import { evaluateHistoricalAi } from "../src/server/evaluation.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

const bookmakers = (args.get("bookmakers") ?? "draftkings_an,fanatics_an,fanduel_an,betmgm_an,caesars_an")
  .split(",")
  .map((book) => book.trim())
  .filter(Boolean);
const variants = (args.get("variants") ?? "baseline,favorite-price-v1,favorite-form-v1")
  .split(",")
  .map((variant) => variant.trim())
  .filter(Boolean) as Array<"baseline" | "favorite-price-v1" | "favorite-form-v1">;

try {
  const rows = [];
  for (const bookmaker of bookmakers) {
    for (const variant of variants) {
      const result = await evaluateHistoricalAi({
        startDate: args.get("start") ?? "2026-03-25",
        endDate: args.get("end") ?? "2026-05-12",
        sourceEndpoint: args.get("source") ?? "closing-odds",
        bookmaker,
        market: (args.get("market") ?? "h2h") as "h2h" | "spreads",
        picksPerDay: Number(args.get("picks-per-day") ?? 3),
        variant
      });
      rows.push({
        bookmaker,
        variant,
        picks: result.overall.picks,
        record: `${result.overall.wins}-${result.overall.losses}`,
        roi: Number((result.overall.roi * 100).toFixed(2)),
        profitCents: result.overall.profitCents
      });
    }
  }

  console.table(rows);
} finally {
  await pool.end();
}
