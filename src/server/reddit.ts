import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { query, transaction } from "./db.js";

export type RedditPostPreview = {
  subreddit: string;
  title: string;
  body: string;
};

export type RedditQueuedPost = RedditPostPreview & {
  id: string;
  createdAt: Date;
};

const cleanSubreddit = (subreddit: string) => subreddit.trim().replace(/^r\//i, "");

export const isRedditConfigured = () => Boolean(config.redditDevvitSharedSecret);

export const buildRedditPreview = async (subredditInput?: string): Promise<RedditPostPreview> => {
  const subreddit = cleanSubreddit(subredditInput || config.redditDefaultSubreddits[0] || "sportsbook");
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric"
  });

  const picks = await query<{
    selected_team: string;
    away_team: string;
    home_team: string;
    odds_american: number;
    confidence: string;
    locked_at: Date | null;
    starts_at: Date;
  }>(
    `
      SELECT
        p.selected_team,
        gl.away_team,
        gl.home_team,
        gl.odds_american,
        p.confidence,
        p.locked_at,
        gl.starts_at
      FROM ai_pick p
      JOIN game_line gl ON gl.id = p.game_line_id
      WHERE p.published_for = (now() AT TIME ZONE 'America/Chicago')::date
      ORDER BY p.confidence DESC NULLS LAST, gl.starts_at ASC
      LIMIT 5
    `
  );

  const leaders = await query<{
    display_name: string | null;
    username: string;
    leaderboard_cents: number;
  }>(
    `
      WITH current_week AS (
        SELECT (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date AS week_start
      )
      SELECT
        u.display_name,
        u.username,
        e.starting_bankroll_cents + e.settled_profit_cents AS leaderboard_cents
      FROM weekly_entry e
      JOIN app_user u ON u.id = e.user_id
      JOIN current_week cw ON cw.week_start = e.week_starts_on
      WHERE u.role IN ('player', 'system')
      ORDER BY leaderboard_cents DESC, e.settled_profit_cents DESC
      LIMIT 3
    `
  );

  const pickLines = picks.rows.length
    ? picks.rows.map((pick, index) => {
      const confidence = pick.confidence ? `${Math.round(Number(pick.confidence) * 100)}%` : "N/A";
      const odds = pick.odds_american > 0 ? `+${pick.odds_american}` : `${pick.odds_american}`;
      const status = pick.locked_at ? "locked" : "projected";
      return `${index + 1}. ${pick.selected_team} ${odds} (${confidence}, ${status}) - ${pick.away_team} at ${pick.home_team}`;
    })
    : ["No AI picks are posted yet today."];

  const leaderLines = leaders.rows.length
    ? leaders.rows.map((leader, index) => {
      const name = leader.display_name || leader.username;
      return `${index + 1}. ${name} - $${(leader.leaderboard_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    })
    : ["Leaderboard is not available yet."];

  return {
    subreddit,
    title: `StakeWars daily AI picks and leaderboard - ${today}`,
    body: [
      `StakeWars is a free weekly sports prediction contest where players try to beat the field and the public StakeWars AI Bot.`,
      ``,
      `Today's AI card:`,
      ...pickLines,
      ``,
      `Current weekly leaderboard:`,
      ...leaderLines,
      ``,
      `Play free: ${config.publicOrigin}`,
      ``,
      `Admin-approved post from StakeWars. No real-money wagering is offered by StakeWars.`
    ].join("\n")
  };
};

export const submitRedditPost = async ({
  userId,
  subreddit,
  title,
  body,
  dryRun
}: {
  userId: string;
  subreddit: string;
  title: string;
  body: string;
  dryRun: boolean;
}) => {
  const cleanedSubreddit = cleanSubreddit(subreddit);
  const status = dryRun ? "previewed" : "queued";
  const logResult = await query<{ id: string }>(
    `
      INSERT INTO reddit_post_log (id, user_id, subreddit, title, body, dry_run, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `,
    [randomUUID(), userId, cleanedSubreddit, title, body, dryRun, status]
  );

  return {
    dryRun,
    queued: !dryRun,
    logId: logResult.rows[0].id,
    redditUrl: null
  };
};

export const claimNextRedditPost = async (): Promise<RedditQueuedPost | null> => {
  const result = await transaction((client) => client.query<{
    id: string;
    subreddit: string;
    title: string;
    body: string;
    created_at: Date;
  }>(
    `
      WITH next_post AS (
        SELECT id
        FROM reddit_post_log
        WHERE status = 'queued' AND dry_run = false
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE reddit_post_log p
      SET status = 'claimed',
          claimed_at = now()
      FROM next_post
      WHERE p.id = next_post.id
      RETURNING p.id, p.subreddit, p.title, p.body, p.created_at
    `
  ));

  const post = result.rows[0];
  if (!post) {
    return null;
  }

  return {
    id: post.id,
    subreddit: post.subreddit,
    title: post.title,
    body: post.body,
    createdAt: post.created_at
  };
};

export const completeRedditPost = async ({
  id,
  redditFullname,
  redditUrl
}: {
  id: string;
  redditFullname?: string | null;
  redditUrl: string;
}) => {
  const result = await query<{ id: string }>(
    `
      UPDATE reddit_post_log
      SET status = 'posted',
          reddit_fullname = $2,
          reddit_url = $3,
          posted_at = now(),
          completed_at = now(),
          error_message = NULL
      WHERE id = $1 AND status IN ('queued', 'claimed')
      RETURNING id
    `,
    [id, redditFullname ?? null, redditUrl]
  );
  return Boolean(result.rowCount);
};

export const failRedditPost = async ({ id, errorMessage }: { id: string; errorMessage: string }) => {
  const result = await query<{ id: string }>(
    `
      UPDATE reddit_post_log
      SET status = 'failed',
          error_message = $2,
          completed_at = now()
      WHERE id = $1 AND status IN ('queued', 'claimed')
      RETURNING id
    `,
    [id, errorMessage]
  );
  return Boolean(result.rowCount);
};
