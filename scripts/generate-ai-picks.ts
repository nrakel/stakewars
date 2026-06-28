import { generateAiPicks } from "../src/server/ai.js";
import { pool } from "../src/server/db.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

try {
  const result = await generateAiPicks({
    sport: (args.get("sport") ?? "MLB") as "MLB",
    maxPicks: Number(args.get("max") ?? 3),
    stakeCents: Math.round(Number(args.get("stake") ?? 100) * 100),
    placeWagers: args.get("place-wagers") !== "false" && args.get("no-place-wagers") !== "true",
    marketKey: args.get("market") as "h2h" | "spreads" | undefined,
    forDate: args.get("date"),
    sortBy: (args.get("sort") ?? "score") as "score" | "confidence",
    uniqueGames: args.get("unique-games") === "true",
    stakeFractionOfBalance: args.has("stake-fraction") ? Number(args.get("stake-fraction")) : undefined
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
