import { pool } from "../src/server/db.js";
import { settleNbaWagers } from "../src/server/settlement.js";

try {
  const pending = await pool.query<{ startDate: string; endDate: string }>(
    `
      SELECT
        min((gl.starts_at AT TIME ZONE 'UTC')::date)::text AS "startDate",
        max((gl.starts_at AT TIME ZONE 'UTC')::date)::text AS "endDate"
      FROM wager w
      JOIN wager_leg wl ON wl.wager_id = w.id
      JOIN game_line gl ON gl.id = wl.game_line_id
      WHERE gl.sport = 'NBA'
        AND wl.status = 'pending'
        AND gl.starts_at <= now()
        AND gl.starts_at >= now() - INTERVAL '7 days'
    `
  );
  const range = pending.rows[0];
  if (!range?.startDate || !range.endDate) {
    console.log(JSON.stringify({ status: "skipped", reason: "no pending started NBA wagers" }));
  } else {
    console.log(JSON.stringify(await settleNbaWagers(range.startDate, range.endDate), null, 2));
  }
} finally {
  await pool.end();
}
