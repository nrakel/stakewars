import { generateNflPlayerProjections } from "../src/server/nflPlayerProjections.js";
import { pool } from "../src/server/db.js";

const gameId = process.argv[2];
if (!gameId) throw new Error("Usage: tsx scripts/generate-nfl-player-projections.ts <game-id>");
const count = await generateNflPlayerProjections(gameId);
console.log(`Stored ${count} NFL player projections for ${gameId}.`);
await pool.end();
