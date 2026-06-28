import { randomUUID } from "node:crypto";
import type pg from "pg";
import { config } from "./config.js";

export const currentWeekStart = (date = new Date()) => {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setUTCDate(copy.getUTCDate() + diff);
  return copy.toISOString().slice(0, 10);
};

export const americanToDecimal = (american: number) => {
  if (american > 0) {
    return 1 + american / 100;
  }
  return 1 + 100 / Math.abs(american);
};

export const estimatePayoutCents = (stakeCents: number, odds: number[]) => {
  const decimal = odds.reduce((product, line) => product * americanToDecimal(line), 1);
  return Math.floor(stakeCents * decimal);
};

export const combinations = (n: number, k: number) => {
  let result = 1;
  for (let i = 1; i <= k; i += 1) {
    result = (result * (n - i + 1)) / i;
  }
  return result;
};

export const roundRobinWays = (legs: number, maxLegs = legs, minLegs = 2) => {
  if (legs < 2 || legs > 8 || minLegs < 2 || maxLegs < minLegs || maxLegs > legs) {
    return 0;
  }
  let total = 0;
  for (let size = minLegs; size <= maxLegs; size += 1) {
    total += combinations(legs, size);
  }
  return total;
};

export const roundRobinPayoutCents = (stakePerWayCents: number, odds: number[], maxLegs = odds.length, minLegs = 2) => {
  let total = 0;
  const visit = (start: number, size: number, selected: number[]) => {
    if (selected.length === size) {
      total += estimatePayoutCents(stakePerWayCents, selected.map((index) => odds[index]));
      return;
    }

    for (let index = start; index <= odds.length - (size - selected.length); index += 1) {
      visit(index + 1, size, [...selected, index]);
    }
  };

  for (let size = minLegs; size <= maxLegs; size += 1) {
    visit(0, size, []);
  }

  return total;
};

export const ensureWeeklyEntry = async (client: pg.PoolClient, userId: string) => {
  const weekStart = currentWeekStart();
  const result = await client.query<{ id: string; balance_cents: number }>(
    `
      INSERT INTO weekly_entry (id, user_id, week_starts_on, starting_bankroll_cents, balance_cents)
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (user_id, week_starts_on) DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING id, balance_cents
    `,
    [randomUUID(), userId, weekStart, config.weeklyBankrollCents]
  );
  return result.rows[0];
};
