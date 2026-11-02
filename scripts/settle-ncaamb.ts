import { pool } from "../src/server/db.js";
import { settleNcaambWagers } from "../src/server/settlement.js";

const [, , startDate, endDate] = process.argv;
try {
  console.log(JSON.stringify(await settleNcaambWagers(startDate, endDate), null, 2));
} finally {
  await pool.end();
}
