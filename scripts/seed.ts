import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "../src/server/config.js";
import { pool } from "../src/server/db.js";

const aiHash = await bcrypt.hash(randomUUID(), 12);

await pool.query(
  `
    INSERT INTO app_user (id, username, password_hash, role)
    VALUES ($1, $2, $3, 'system')
    ON CONFLICT (username) DO NOTHING
  `,
  [randomUUID(), config.aiUsername, aiHash]
);

await pool.query(
  `
    INSERT INTO weekly_entry (id, user_id, week_starts_on, starting_bankroll_cents, balance_cents)
    SELECT $1, id, (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date, $2, $2
    FROM app_user
    WHERE username = $3
    ON CONFLICT (user_id, week_starts_on) DO NOTHING
  `,
  [randomUUID(), config.weeklyBankrollCents, config.aiUsername]
);

await pool.end();
console.log("Seed data ready");
