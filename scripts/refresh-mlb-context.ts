import { pool } from "../src/server/db.js";
import { refreshMlbGameContext } from "../src/server/mlbContext.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

const today = new Date().toISOString().slice(0, 10);
const startDate = args.get("start") ?? today;
const endDate = args.get("end") ?? startDate;

try {
  const result = await refreshMlbGameContext({ startDate, endDate });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
