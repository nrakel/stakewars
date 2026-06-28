import { pool } from "../src/server/db.js";
import { writeDailyModelPerformanceReport } from "../src/server/snapshotReport.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

const today = new Date().toISOString().slice(0, 10);

try {
  const result = await writeDailyModelPerformanceReport({
    startDate: args.get("start") ?? today,
    endDate: args.get("end") ?? args.get("start") ?? today,
    outputDir: args.get("output") ?? "reports",
    picksPerDay: Number(args.get("picks-per-day") ?? 5),
    stakeCentsPerPick: Number(args.get("stake-cents") ?? 10000)
  });

  console.log(`Daily model performance report written:`);
  console.log(`- ${result.files.markdown}`);
  console.log(`- ${result.files.dailyCsv}`);
  console.log(`- ${result.files.totalsCsv}`);
  console.log(`- ${result.files.picksCsv}`);
  console.log(`- ${result.files.json}`);
} finally {
  await pool.end();
}
