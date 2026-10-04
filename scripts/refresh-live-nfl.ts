import { pool, query } from "../src/server/db.js";
import { refreshLiveNfl } from "../src/server/live.js";

try {
  const activeWindow = await query<{ shouldRefresh: boolean }>(
    `
      SELECT (
        EXISTS (
          SELECT 1
          FROM game_line
          WHERE sport = 'NFL'
            AND starts_at BETWEEN now() - INTERVAL '5 hours' AND now() + INTERVAL '10 minutes'
        )
        OR EXISTS (
          SELECT 1
          FROM nfl_confidence_game
          WHERE starts_at BETWEEN now() - INTERVAL '5 hours' AND now() + INTERVAL '10 minutes'
        )
        OR EXISTS (
          SELECT 1
          FROM live_game_state
          WHERE sport = 'NFL'
            AND in_play = true
            AND fetched_at >= now() - INTERVAL '10 minutes'
        )
      ) AS "shouldRefresh"
    `
  );

  if (!activeWindow.rows[0]?.shouldRefresh) {
    console.log(JSON.stringify({ sport: "NFL", skipped: true, reason: "no game in active window" }));
  } else {
    const summary = await refreshLiveNfl();
    console.log(JSON.stringify(summary, null, 2));
  }
} finally {
  await pool.end();
}
