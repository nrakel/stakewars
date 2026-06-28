import { pool } from "../src/server/db.js";
import { refreshLiveMlb } from "../src/server/live.js";

try {
  const summary = await refreshLiveMlb();
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await pool.end();
}
