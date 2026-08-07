import { pool } from "../src/server/db.js";
import { settleNflWagers } from "../src/server/settlement.js";

try {
  const pending = await pool.query<{ pendingStartedLegs: string }>(
    `
      SELECT count(*)::text AS "pendingStartedLegs"
      FROM wager w
      JOIN wager_leg wl ON wl.wager_id = w.id
      JOIN game_line gl ON gl.id = wl.game_line_id
      WHERE w.status = 'pending'
        AND wl.status = 'pending'
        AND gl.sport = 'NFL'
        AND gl.starts_at <= now()
        AND gl.starts_at >= now() - interval '10 days'
    `
  );
  const pendingStartedLegs = Number(pending.rows[0]?.pendingStartedLegs ?? 0);

  if (pendingStartedLegs <= 0) {
    console.log(JSON.stringify({ skipped: "no started pending NFL legs", pendingStartedLegs }));
  } else {
    const result = await settleNflWagers();
    console.log(JSON.stringify({ pendingStartedLegs, ...result }, null, 2));
  }
} finally {
  await pool.end();
}
