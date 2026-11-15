import { refreshChineSp500Benchmarks } from "../src/server/chineBenchmark.js";
import { pool } from "../src/server/db.js";

try {
  console.log(JSON.stringify(await refreshChineSp500Benchmarks(), null, 2));
} finally {
  await pool.end();
}

