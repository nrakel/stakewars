import { generateNflPlayerProjections, generateNflWeekPlayerProjections } from "../src/server/nflPlayerProjections.js";
import { refreshNflPlayerProps } from "../src/server/nflPlayerProps.js";
import { pool } from "../src/server/db.js";

const gameId = process.argv[2];
if (!gameId) throw new Error("Usage: tsx scripts/generate-nfl-player-projections.ts <game-id> [--props] | --week <week> [--season <season>] [--props] | --current-week");
const includeProps = process.argv.includes("--props");
if (gameId === "--week" || gameId === "--current-week") {
  let week = Number(process.argv[3]);
  const seasonFlag = process.argv.indexOf("--season");
  let season = seasonFlag >= 0 ? Number(process.argv[seasonFlag + 1]) : new Date().getUTCFullYear();
  if (gameId === "--current-week") {
    const current = await pool.query<{ season: number; week: number }>(`
      SELECT game.season, game.week
      FROM nfl_confidence_game game
      JOIN nfl_confidence_pool confidence_pool ON confidence_pool.id = game.pool_id
      WHERE confidence_pool.status = 'active'
        AND game.starts_at >= now() - interval '2 days'
      GROUP BY game.season, game.week
      ORDER BY min(game.starts_at)
      LIMIT 1
    `);
    if (!current.rows[0]) throw new Error("No active NFL week is available for projection generation.");
    season = current.rows[0].season;
    week = current.rows[0].week;
  }
  if (!Number.isInteger(week) || week < 1 || !Number.isInteger(season)) throw new Error("A valid --week and --season are required.");
  const results = await generateNflWeekPlayerProjections(season, week);
  if (includeProps) {
    for (const result of results.filter((entry) => !entry.error)) {
      try {
        await refreshNflPlayerProps(result.gameId);
      } catch (error) {
        result.error = `Projections stored; prop refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  console.log(JSON.stringify({ season, week, games: results.length, results }, null, 2));
  if (results.some((result) => result.error)) process.exitCode = 1;
} else {
  const count = await generateNflPlayerProjections(gameId);
  console.log(`Stored ${count} NFL player projections for ${gameId}.`);
  if (includeProps) {
    const propCount = await refreshNflPlayerProps(gameId);
    console.log(`Stored ${propCount} non-wagerable NFL player prop lines for ${gameId}.`);
  }
}
await pool.end();
