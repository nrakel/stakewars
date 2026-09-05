import { pool } from "../src/server/db.js";
import { settleNcaafWagers } from "../src/server/settlement.js";

const [, , startDate, endDate] = process.argv;

try {
  const result = await settleNcaafWagers(startDate, endDate);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
