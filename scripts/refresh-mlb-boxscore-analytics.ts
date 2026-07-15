import { pool } from "../src/server/db.js";
import { refreshMlbBoxscoreAnalytics, rollingMlbWindow } from "../src/server/mlbBoxscoreAnalytics.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

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

const asOfDate = args.get("as-of") ?? centralDate();
const windowDays = Number(args.get("window-days") ?? 30);
const defaults = rollingMlbWindow(asOfDate, windowDays);
const startDate = args.get("start") ?? defaults.startDate;
const endDate = args.get("end") ?? defaults.endDate;

try {
  const result = await refreshMlbBoxscoreAnalytics({
    startDate,
    endDate,
    asOfDate,
    windowDays
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
