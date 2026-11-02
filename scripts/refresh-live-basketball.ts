import { pool } from "../src/server/db.js";
import { refreshLiveBasketball } from "../src/server/live.js";

try {
  console.log(JSON.stringify(await refreshLiveBasketball(), null, 2));
} finally {
  await pool.end();
}
