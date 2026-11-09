import { pool } from "../src/server/db.js";
import { settleNcaambWagers } from "../src/server/settlement.js";

try {
  const pending = await pool.query<{ startDate: string; endDate: string }>(`
    WITH candidates AS (
      SELECT gl.starts_at
      FROM wager w
      JOIN wager_leg wl ON wl.wager_id=w.id
      JOIN game_line gl ON gl.id=wl.game_line_id
      WHERE gl.sport='NCAAMB' AND wl.status='pending'
        AND gl.starts_at <= now() AND gl.starts_at >= now() - interval '7 days'
      UNION
      SELECT pick.starts_at
      FROM chine_daily_pick pick
      WHERE pick.sport='NCAAMB'
        AND pick.starts_at <= now() - interval '2 hours'
        AND pick.starts_at >= now() - interval '7 days'
        AND NOT EXISTS (
          SELECT 1 FROM game_result result
          WHERE result.sport=pick.sport
            AND result.away_team=pick.away_team
            AND result.home_team=pick.home_team
            AND abs(extract(epoch from coalesce(result.starts_at, result.starts_on::timestamptz) - pick.starts_at)) <= 43200
        )
    )
    SELECT min(starts_at::date)::text AS "startDate", max(starts_at::date)::text AS "endDate"
    FROM candidates
  `);
  const range = pending.rows[0];
  console.log(JSON.stringify(!range?.startDate || !range.endDate
    ? { status: "skipped", reason: "no pending wagers or unresolved Daily Picks" }
    : await settleNcaambWagers(range.startDate, range.endDate), null, 2));
} finally {
  await pool.end();
}
