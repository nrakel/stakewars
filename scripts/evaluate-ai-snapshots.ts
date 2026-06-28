import { pool } from "../src/server/db.js";
import { evaluateMlbCandidateSnapshots } from "../src/server/snapshotEvaluation.js";

const [, , startDate, endDate] = process.argv;

try {
  const result = await evaluateMlbCandidateSnapshots(startDate, endDate);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
