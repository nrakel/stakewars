import { pool } from "../src/server/db.js";
import { refreshLiveSports } from "../src/server/live.js";

try {
  const summary = await refreshLiveSports();
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await pool.end();
}
