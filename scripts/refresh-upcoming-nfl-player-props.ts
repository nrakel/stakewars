import { pool } from "../src/server/db.js";
import { generateNflPlayerProjections } from "../src/server/nflPlayerProjections.js";
import { refreshNflPlayerProps } from "../src/server/nflPlayerProps.js";

const candidates = await pool.query<{ id: string; matchup: string; startsAt: Date }>(`
  SELECT game.id, game.away_team || ' @ ' || game.home_team AS matchup,
    game.starts_at AS "startsAt"
  FROM nfl_confidence_game game
  LEFT JOIN nfl_player_prop_refresh refresh ON refresh.game_id = game.id
  WHERE game.status = 'scheduled'
    AND game.starts_at > now()
    AND game.starts_at <= now() + interval '2 hours'
    AND (
      refresh.game_id IS NULL
      OR (refresh.status = 'failed' AND refresh.attempted_at < now() - interval '15 minutes')
      OR (refresh.status = 'running' AND refresh.attempted_at < now() - interval '30 minutes')
    )
  ORDER BY game.starts_at
`);

const results: Array<{ gameId: string; matchup: string; projections?: number; props?: number; error?: string }> = [];
for (const game of candidates.rows) {
  const claim = await pool.query(`
    INSERT INTO nfl_player_prop_refresh (game_id, status, attempted_at, completed_at, row_count, error)
    VALUES ($1, 'running', now(), NULL, 0, NULL)
    ON CONFLICT (game_id) DO UPDATE SET
      status = 'running', attempted_at = now(), completed_at = NULL, row_count = 0, error = NULL
    WHERE nfl_player_prop_refresh.status <> 'success'
      AND nfl_player_prop_refresh.attempted_at < now() - interval '15 minutes'
    RETURNING game_id
  `, [game.id]);
  if (!claim.rowCount) continue;
  try {
    const projections = await generateNflPlayerProjections(game.id);
    const props = await refreshNflPlayerProps(game.id);
    await pool.query(`
      UPDATE nfl_player_prop_refresh
      SET status = 'success', completed_at = now(), row_count = $2, error = NULL
      WHERE game_id = $1
    `, [game.id, props]);
    results.push({ gameId: game.id, matchup: game.matchup, projections, props });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(`
      UPDATE nfl_player_prop_refresh
      SET status = 'failed', completed_at = now(), error = $2
      WHERE game_id = $1
    `, [game.id, message.slice(0, 1000)]);
    results.push({ gameId: game.id, matchup: game.matchup, error: message });
  }
}

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), candidates: candidates.rowCount, results }, null, 2));
await pool.end();
if (results.some((result) => result.error)) process.exitCode = 1;
