import { config } from "./config.js";
import { query } from "./db.js";
import { sendMail } from "./mail.js";
import { buildRewardConfirmationEmail } from "./rewardEmail.js";

type RewardEmailAwardRow = {
  id: string;
  displayName: string;
  email: string | null;
  weekStart: string;
  rewardCents: number;
  rank: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  topProfitCents: number | null;
  topLegs: string | null;
};

export type RewardEmailSendResult = {
  awardId: string;
  email: string;
  messageId: string | null;
};

export const sendPendingWeeklyRewardEmails = async (weekStart?: string) => {
  const result = await query<RewardEmailAwardRow>(
    `
      WITH awards AS (
        SELECT a.id, a.week_starts_on, a.reward_cents, a.rank, a.user_id
        FROM weekly_reward_award a
        WHERE a.reward_email_sent_at IS NULL
          AND ($1::date IS NULL OR a.week_starts_on = $1::date)
      ),
      wager_stats AS (
        SELECT
          a.id AS award_id,
          count(*) FILTER (WHERE w.status = 'won')::int AS wins,
          count(*) FILTER (WHERE w.status = 'lost')::int AS losses,
          count(*) FILTER (WHERE w.status = 'push')::int AS pushes,
          count(*) FILTER (WHERE w.status = 'void')::int AS voids
        FROM awards a
        JOIN weekly_entry e ON e.user_id = a.user_id AND e.week_starts_on = a.week_starts_on
        LEFT JOIN wager w ON w.weekly_entry_id = e.id
        GROUP BY a.id
      ),
      top_wagers AS (
        SELECT DISTINCT ON (a.id)
          a.id AS award_id,
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
        FROM awards a
        JOIN weekly_entry e ON e.user_id = a.user_id AND e.week_starts_on = a.week_starts_on
        JOIN wager w ON w.weekly_entry_id = e.id
        JOIN wager_leg wl ON wl.wager_id = w.id
        JOIN game_line gl ON gl.id = wl.game_line_id
        LEFT JOIN (
          SELECT wager_id, sum(profit_cents)::int AS profit_cents
          FROM round_robin_way_settlement
          GROUP BY wager_id
        ) rr ON rr.wager_id = w.id
        WHERE w.status = 'won'
        GROUP BY a.id, w.id, w.kind, w.stake_cents, w.potential_payout_cents, rr.profit_cents
        ORDER BY a.id, profit_cents DESC
      )
      SELECT
        a.id,
        COALESCE(NULLIF(u.display_name, ''), u.username) AS "displayName",
        u.email,
        a.week_starts_on::text AS "weekStart",
        a.reward_cents AS "rewardCents",
        a.rank,
        COALESCE(ws.wins, 0)::int AS wins,
        COALESCE(ws.losses, 0)::int AS losses,
        COALESCE(ws.pushes, 0)::int AS pushes,
        COALESCE(ws.voids, 0)::int AS voids,
        tw.profit_cents AS "topProfitCents",
        tw.legs AS "topLegs"
      FROM awards a
      JOIN app_user u ON u.id = a.user_id
      LEFT JOIN wager_stats ws ON ws.award_id = a.id
      LEFT JOIN top_wagers tw ON tw.award_id = a.id
      WHERE u.email IS NOT NULL
        AND u.email_verified
      ORDER BY a.week_starts_on DESC, a.rank ASC
    `,
    [weekStart ?? null]
  );

  const sent: RewardEmailSendResult[] = [];
  const origin = config.publicOrigin.replace(/\/+$/, "");

  for (const row of result.rows) {
    if (!row.email) {
      continue;
    }
    const email = buildRewardConfirmationEmail({
      displayName: row.displayName,
      weekStart: row.weekStart,
      rewardCents: row.rewardCents,
      rank: row.rank,
      wins: row.wins,
      losses: row.losses,
      pushes: row.pushes,
      voids: row.voids,
      topWagerDescription: row.topLegs,
      topWagerProfitCents: row.topProfitCents,
      accountUrl: `${origin}/?view=account`
    });
    const mailResult = await sendMail({
      to: [{ email: row.email, name: row.displayName }],
      subject: email.subject,
      text: email.text,
      html: email.html
    });
    await query(
      "UPDATE weekly_reward_award SET reward_email_sent_at = now() WHERE id = $1 AND reward_email_sent_at IS NULL",
      [row.id]
    );
    sent.push({
      awardId: row.id,
      email: row.email,
      messageId: mailResult.messageId
    });
  }

  return sent;
};
