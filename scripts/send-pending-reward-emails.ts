import { pool } from "../src/server/db.js";
import { sendPendingWeeklyRewardEmails } from "../src/server/weeklyRewardEmails.js";

const [, , weekStart] = process.argv;

try {
  const sent = await sendPendingWeeklyRewardEmails(weekStart);
  console.log(JSON.stringify({ weekStart: weekStart ?? null, sent }, null, 2));
} finally {
  await pool.end();
}
