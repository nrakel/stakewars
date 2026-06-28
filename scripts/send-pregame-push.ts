import { pool } from "../src/server/db.js";
import { sendDailyPregameNotification } from "../src/server/pregameNotifications.js";

try {
  const result = await sendDailyPregameNotification();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
