import { sendMail } from "../src/server/mail.js";
import { query, pool } from "../src/server/db.js";
import { buildRewardConfirmationEmail } from "../src/server/rewardEmail.js";

const allowedTestRecipient = "nathanielrakel@gmail.com";
const recipient = (process.env.REWARD_EMAIL_TO ?? allowedTestRecipient).trim().toLowerCase();

if (recipient !== allowedTestRecipient) {
  throw new Error(`Reward email test is locked to ${allowedTestRecipient}. Refusing to send to ${recipient}.`);
}

const userResult = await query<{
  display_name: string;
  username: string;
  email: string | null;
  week_start: string;
  reward_cents: number;
  rank: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  top_profit_cents: number | null;
  top_legs: string | null;
}>(
  `
    WITH award AS (
      SELECT a.week_starts_on, a.reward_cents, a.rank, a.user_id
      FROM weekly_reward_award a
      JOIN app_user u ON u.id = a.user_id
      WHERE lower(u.username) = lower($1)
      ORDER BY a.week_starts_on DESC
      LIMIT 1
    ),
    wager_stats AS (
      SELECT
        count(*) FILTER (WHERE w.status = 'won')::int AS wins,
        count(*) FILTER (WHERE w.status = 'lost')::int AS losses,
        count(*) FILTER (WHERE w.status = 'push')::int AS pushes,
        count(*) FILTER (WHERE w.status = 'void')::int AS voids
      FROM wager w
      JOIN weekly_entry e ON e.id = w.weekly_entry_id
      JOIN award a ON a.user_id = e.user_id AND a.week_starts_on = e.week_starts_on
    ),
    top_wager AS (
      SELECT
        CASE
          WHEN w.kind = 'round_robin' THEN COALESCE(rr.profit_cents, 0)
          WHEN w.status = 'won' THEN w.potential_payout_cents - w.stake_cents
          WHEN w.status = 'lost' THEN -w.stake_cents
          ELSE 0
        END AS profit_cents,
        string_agg(
          wl.selected_team
            || ' '
            || CASE WHEN gl.market_key = 'spreads' AND wl.spread::numeric <> 0 THEN wl.spread::text ELSE 'ML' END
            || ' ('
            || CASE WHEN wl.odds_american > 0 THEN '+' ELSE '' END
            || wl.odds_american::text
            || ')',
          ', '
          ORDER BY gl.starts_at
        ) AS legs
      FROM wager w
      JOIN weekly_entry e ON e.id = w.weekly_entry_id
      JOIN award a ON a.user_id = e.user_id AND a.week_starts_on = e.week_starts_on
      JOIN wager_leg wl ON wl.wager_id = w.id
      JOIN game_line gl ON gl.id = wl.game_line_id
      LEFT JOIN (
        SELECT wager_id, sum(profit_cents)::int AS profit_cents
        FROM round_robin_way_settlement
        GROUP BY wager_id
      ) rr ON rr.wager_id = w.id
      WHERE w.status = 'won'
      GROUP BY w.id, w.kind, w.stake_cents, w.potential_payout_cents, rr.profit_cents
      ORDER BY profit_cents DESC
      LIMIT 1
    )
    SELECT
      COALESCE(NULLIF(u.display_name, ''), u.username) AS display_name,
      u.username,
      u.email,
      a.week_starts_on::text AS week_start,
      a.reward_cents,
      a.rank,
      ws.wins,
      ws.losses,
      ws.pushes,
      ws.voids,
      tw.profit_cents AS top_profit_cents,
      tw.legs AS top_legs
    FROM award a
    JOIN app_user u ON u.id = a.user_id
    CROSS JOIN wager_stats ws
    LEFT JOIN top_wager tw ON true
  `,
  [allowedTestRecipient]
);

const row = userResult.rows[0];
if (!row) {
  await pool.end();
  throw new Error(`No reward award found for ${allowedTestRecipient}.`);
}

const origin = (process.env.REWARD_EMAIL_ORIGIN ?? "https://stakewars.ai").replace(/\/+$/, "");
const email = buildRewardConfirmationEmail({
  displayName: row.display_name,
  weekStart: row.week_start,
  rewardCents: row.reward_cents,
  rank: row.rank,
  wins: row.wins,
  losses: row.losses,
  pushes: row.pushes,
  voids: row.voids,
  topWagerDescription: row.top_legs,
  topWagerProfitCents: row.top_profit_cents,
  accountUrl: `${origin}/?view=account`
});

const result = await sendMail({
  to: [{ email: recipient, name: row.display_name }],
  subject: email.subject,
  text: email.text,
  html: email.html
});

await pool.end();

console.log(JSON.stringify({
  recipient,
  messageId: result.messageId,
  accepted: result.accepted,
  weekStart: row.week_start,
  rewardCents: row.reward_cents
}, null, 2));
