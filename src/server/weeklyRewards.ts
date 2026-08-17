import { randomUUID } from "node:crypto";
import type pg from "pg";
import { config } from "./config.js";

export type WeeklyRewardAward = {
  userId: string;
  displayName: string;
  rank: number;
  sharePercent: number;
  rewardCents: number;
};

export type WeeklyRewardAwardResult = {
  weekStart: string;
  finalized: boolean;
  reason?: string;
  awards: WeeklyRewardAward[];
};

const rewardShares = [50, 35, 15] as const;

export const awardWeeklyRewardsIfFinal = async (
  client: pg.PoolClient,
  weekStart: string
): Promise<WeeklyRewardAwardResult> => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`weekly_reward_award:${weekStart}`]);

  const weekState = await client.query<{
    week_start: string;
    current_week_start: string;
    pending_wagers: string;
    future_lines: string;
    cash_prize_cents: number | null;
    first_place_bonus: string | null;
  }>(
    `
      WITH selected_week AS (
        SELECT $1::date AS week_start
      ),
      current_week AS (
        SELECT (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date AS week_start
      )
      SELECT
        sw.week_start::text AS week_start,
        cw.week_start::text AS current_week_start,
        (
          SELECT count(*)::text
          FROM wager w
          JOIN weekly_entry e ON e.id = w.weekly_entry_id
          WHERE e.week_starts_on = sw.week_start
            AND w.status = 'pending'
        ) AS pending_wagers,
        (
          SELECT count(*)::text
          FROM game_line gl
          WHERE gl.is_active
            AND (gl.starts_at AT TIME ZONE 'America/Chicago')::date >= sw.week_start
            AND (gl.starts_at AT TIME ZONE 'America/Chicago')::date < sw.week_start + interval '7 days'
            AND gl.starts_at > now()
        ) AS future_lines,
        wp.cash_prize_cents,
        wp.first_place_bonus
      FROM selected_week sw
      CROSS JOIN current_week cw
      LEFT JOIN weekly_prize wp ON wp.week_starts_on = sw.week_start
    `,
    [weekStart]
  );
  const state = weekState.rows[0];
  if (!state) {
    return { weekStart, finalized: false, reason: "week_not_found", awards: [] };
  }
  if (state.week_start > state.current_week_start) {
    return { weekStart, finalized: false, reason: "week_in_future", awards: [] };
  }
  if (state.week_start === state.current_week_start && Number(state.future_lines) > 0) {
    return { weekStart, finalized: false, reason: "week_still_active", awards: [] };
  }
  if (Number(state.pending_wagers) > 0) {
    return { weekStart, finalized: false, reason: "pending_wagers", awards: [] };
  }
  const cashPrizeCents = Number(state.cash_prize_cents ?? 0);
  if (cashPrizeCents <= 0) {
    return { weekStart, finalized: false, reason: "no_cash_prize", awards: [] };
  }

  const contenders = await client.query<{
    user_id: string;
    display_name: string;
    rank: number;
    leaderboard_cents: number;
    settled_profit_cents: number;
    weekly_wagers: number;
    weekly_stake_cents: number;
    eligible: boolean;
  }>(
    `
      WITH selected_week AS (
        SELECT $2::date AS week_start
      ),
      wager_activity AS (
        SELECT
          w.weekly_entry_id,
          count(*)::int AS weekly_wagers,
          coalesce(sum(w.stake_cents), 0)::int AS weekly_stake_cents,
          COALESCE(sum(CASE
            WHEN w.kind = 'round_robin' THEN COALESCE(rr.profit_cents, 0)
            WHEN w.status = 'won' THEN w.potential_payout_cents - w.stake_cents
            WHEN w.status = 'lost' THEN -w.stake_cents
            WHEN w.status IN ('push', 'void') THEN 0
            ELSE 0
          END), 0)::int AS settled_profit_cents
        FROM wager w
        LEFT JOIN (
          SELECT wager_id, sum(profit_cents)::int AS profit_cents
          FROM round_robin_way_settlement
          GROUP BY wager_id
        ) rr ON rr.wager_id = w.id
        GROUP BY w.weekly_entry_id
      ),
      ai AS (
        SELECT e.starting_bankroll_cents + e.settled_profit_cents AS leaderboard_cents
        FROM weekly_entry e
        JOIN app_user u ON u.id = e.user_id
        JOIN selected_week sw ON sw.week_start = e.week_starts_on
        WHERE u.username = $1
        LIMIT 1
      ),
      ranked AS (
        SELECT
          u.id AS user_id,
          COALESCE(NULLIF(u.display_name, ''), u.username) AS display_name,
          u.role,
          u.email_verified,
          COALESCE(wa.weekly_wagers, 0)::int AS weekly_wagers,
          COALESCE(wa.weekly_stake_cents, 0)::int AS weekly_stake_cents,
          (e.starting_bankroll_cents * 1.5)::int AS required_stake_cents,
          e.starting_bankroll_cents
            + (
              SELECT COALESCE(sum(boost.amount_cents), 0)::int
              FROM referral_bankroll_boost boost
              WHERE boost.referrer_user_id = u.id
                AND boost.status = 'used'
                AND boost.used_week_starts_on = e.week_starts_on
            )
            + e.settled_profit_cents AS leaderboard_cents,
          e.settled_profit_cents AS settled_profit_cents
        FROM weekly_entry e
        JOIN app_user u ON u.id = e.user_id
        LEFT JOIN wager_activity wa ON wa.weekly_entry_id = e.id
        JOIN selected_week sw ON sw.week_start = e.week_starts_on
        WHERE u.role IN ('player', 'system')
      ),
      ordered AS (
        SELECT
          *,
          (row_number() OVER (ORDER BY leaderboard_cents DESC, settled_profit_cents DESC))::int AS rank
        FROM ranked
      )
      SELECT
        user_id,
        display_name,
        rank,
        leaderboard_cents,
        settled_profit_cents,
        weekly_wagers,
        weekly_stake_cents,
        CASE
          WHEN role = 'system' THEN false
          WHEN email_verified
            AND weekly_wagers >= 10
            AND weekly_stake_cents >= required_stake_cents
            AND (SELECT leaderboard_cents FROM ai) IS NOT NULL
            AND leaderboard_cents > (SELECT leaderboard_cents FROM ai)
            AND rank <= 3
          THEN true
          ELSE false
        END AS eligible
      FROM ordered
      WHERE role = 'player' AND rank <= 3
      ORDER BY rank
    `,
    [config.aiUsername, weekStart]
  );

  const eligible = contenders.rows.filter((row) => row.eligible);
  const awards: WeeklyRewardAward[] = [];

  for (const [index, row] of eligible.entries()) {
    const sharePercent = rewardShares[index];
    if (!sharePercent) {
      continue;
    }
    const rewardCents = Math.round(cashPrizeCents * (sharePercent / 100));
    if (rewardCents <= 0) {
      continue;
    }

    const inserted = await client.query<{ user_id: string }>(
      `
        INSERT INTO weekly_reward_award (
          id,
          week_starts_on,
          user_id,
          rank,
          share_percent,
          reward_cents,
          leaderboard_cents,
          settled_profit_cents,
          weekly_wagers,
          weekly_stake_cents,
          first_place_bonus
        )
        VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (week_starts_on, user_id) DO NOTHING
        RETURNING user_id
      `,
      [
        randomUUID(),
        weekStart,
        row.user_id,
        row.rank,
        sharePercent,
        rewardCents,
        row.leaderboard_cents,
        row.settled_profit_cents,
        row.weekly_wagers,
        row.weekly_stake_cents,
        row.rank === 1 ? state.first_place_bonus : null
      ]
    );

    if ((inserted.rowCount ?? 0) === 0) {
      continue;
    }

    await client.query(
      "UPDATE app_user SET reward_balance_cents = reward_balance_cents + $1 WHERE id = $2",
      [rewardCents, row.user_id]
    );

    awards.push({
      userId: row.user_id,
      displayName: row.display_name,
      rank: row.rank,
      sharePercent,
      rewardCents
    });
  }

  return { weekStart, finalized: true, awards };
};
