import { pool } from "../src/server/db.js";
import { settleNcaafWagers, settleNflWagers } from "../src/server/settlement.js";

try {
  const pending = await pool.query<{ sport: "NFL" | "NCAAF"; pendingStartedLegs: string }>(
    `
      SELECT gl.sport, count(*)::text AS "pendingStartedLegs"
      FROM wager w
      JOIN wager_leg wl ON wl.wager_id = w.id
      JOIN game_line gl ON gl.id = wl.game_line_id
      WHERE (w.status = 'pending' OR wl.status = 'pending')
        AND wl.status = 'pending'
        AND gl.sport IN ('NFL', 'NCAAF')
        AND gl.starts_at <= now()
        AND gl.starts_at >= now() - interval '10 days'
      GROUP BY gl.sport
    `
  );
  const pendingBySport = new Map(pending.rows.map((row) => [row.sport, Number(row.pendingStartedLegs)]));
  const pendingStartedLegs = [...pendingBySport.values()].reduce((sum, count) => sum + count, 0);

  if (pendingStartedLegs <= 0) {
    console.log(JSON.stringify({ skipped: "no started pending football legs", pendingStartedLegs }));
  } else {
    const results: Record<string, unknown> = {};
    if ((pendingBySport.get("NFL") ?? 0) > 0) {
      results.nfl = await settleNflWagers();
    }
    if ((pendingBySport.get("NCAAF") ?? 0) > 0) {
      results.ncaaf = await settleNcaafWagers();
    }
    console.log(JSON.stringify({ pendingStartedLegs, pendingBySport: Object.fromEntries(pendingBySport), ...results }, null, 2));
  }
} finally {
  await pool.end();
}
