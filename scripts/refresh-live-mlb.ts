import { pool } from "../src/server/db.js";
import { refreshLiveMlbAndNcaaf } from "../src/server/live.js";

try {
  const summary = await refreshLiveMlbAndNcaaf();
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await pool.end();
}
