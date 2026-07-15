import { pool } from "../src/server/db.js";
import { refreshVisitorEvents } from "../src/server/visitorMetrics.js";

try {
  const result = await refreshVisitorEvents();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
