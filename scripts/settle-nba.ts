import { pool } from "../src/server/db.js";
import { settleNbaWagers } from "../src/server/settlement.js";

const [, , startDate, endDate] = process.argv;

try {
  console.log(JSON.stringify(await settleNbaWagers(startDate, endDate), null, 2));
} finally {
  await pool.end();
}
