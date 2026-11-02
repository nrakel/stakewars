import { pool } from "../src/server/db.js";
import { settleNcaambWagers } from "../src/server/settlement.js";

try {
  const pending = await pool.query<{ startDate: string; endDate: string }>(`
    SELECT min(gl.starts_at::date)::text AS "startDate", max(gl.starts_at::date)::text AS "endDate"
    FROM wager w
    JOIN wager_leg wl ON wl.wager_id=w.id
    JOIN game_line gl ON gl.id=wl.game_line_id
    WHERE gl.sport='NCAAMB' AND wl.status='pending'
      AND gl.starts_at <= now() AND gl.starts_at >= now() - interval '7 days'
  `);
  const range = pending.rows[0];
  console.log(JSON.stringify(!range?.startDate || !range.endDate
    ? { status: "skipped", reason: "no pending started NCAAB wagers" }
    : await settleNcaambWagers(range.startDate, range.endDate), null, 2));
} finally {
  await pool.end();
}
