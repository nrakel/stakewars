import { pool } from "../src/server/db.js";
import { settleMlbStraightWagers } from "../src/server/settlement.js";

const [, , startDate, endDate] = process.argv;

try {
  const result = await settleMlbStraightWagers(startDate, endDate);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
