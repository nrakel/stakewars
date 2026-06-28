import { pool } from "../src/server/db.js";
import { reportAiSnapshotEvaluations } from "../src/server/snapshotReport.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

const today = new Date().toISOString().slice(0, 10);

try {
  const result = await reportAiSnapshotEvaluations({
    startDate: args.get("start") ?? today,
    endDate: args.get("end") ?? args.get("start") ?? today
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
