import { snapshotAiCandidates } from "../src/server/ai.js";
import { pool } from "../src/server/db.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

try {
  const result = await snapshotAiCandidates({
    sport: (args.get("sport") ?? "MLB") as "MLB",
    source: args.get("source") ?? "manual"
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
