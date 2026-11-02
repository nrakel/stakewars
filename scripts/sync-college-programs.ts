import { pool, transaction } from "../src/server/db.js";
import { primeCollegeTeamAliases, syncCollegePrograms } from "../src/server/collegeTeams.js";

try {
  const result = await transaction((client) => syncCollegePrograms(client));
  const loadedAliases = await primeCollegeTeamAliases();
  console.log(JSON.stringify({ ...result, loadedAliases }, null, 2));
} finally {
  await pool.end();
}
