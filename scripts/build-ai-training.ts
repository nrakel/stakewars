import { pool } from "../src/server/db.js";
import { buildMlbTrainingExamples } from "../src/server/training.js";

const [, , startDate, endDate] = process.argv;

try {
  const result = await buildMlbTrainingExamples(startDate, endDate);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
