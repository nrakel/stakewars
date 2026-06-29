import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { query } from "./db.js";

type RedditConnection = {
  reddit_username: string | null;
  refresh_token: string;
  scopes: string[];
  connected_at: Date;
  updated_at: Date;
};

type RedditTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  message?: string;
};

type RedditIdentity = {
  name?: string;
};

type RedditSubmitResponse = {
  json?: {
    errors?: Array<[string, string, string?]>;
    data?: {
      id?: string;
      name?: string;
      url?: string;
    };
  };
};

export type RedditPostPreview = {
  subreddit: string;
  title: string;
  body: string;
};

const redditAuthBaseUrl = "https://www.reddit.com/api/v1";
const redditOauthBaseUrl = "https://oauth.reddit.com";

export const isRedditConfigured = () => Boolean(config.redditClientId && config.redditClientSecret);

export const redditRedirectUri = () => `${config.publicOrigin.replace(/\/$/, "")}/api/admin/reddit/callback`;

const redditAuthHeader = () => {
  if (!config.redditClientId || !config.redditClientSecret) {
    throw new Error("Reddit OAuth credentials are not configured");
  }
  return `Basic ${Buffer.from(`${config.redditClientId}:${config.redditClientSecret}`).toString("base64")}`;
};

const parseScopes = (scope: string | undefined) => scope?.split(/\s+/).filter(Boolean) ?? [];

const redditRequestHeaders = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
  "User-Agent": config.redditUserAgent
});

export const createRedditAuthUrl = async (userId: string) => {
  if (!isRedditConfigured()) {
    throw new Error("Reddit OAuth credentials are not configured");
  }

  await query("DELETE FROM reddit_oauth_state WHERE expires_at < now()");
  const state = randomUUID();
  await query(
    `
      INSERT INTO reddit_oauth_state (state, user_id, expires_at)
      VALUES ($1, $2, now() + interval '15 minutes')
    `,
    [state, userId]
  );

  const params = new URLSearchParams({
    client_id: config.redditClientId!,
    response_type: "code",
    state,
    redirect_uri: redditRedirectUri(),
    duration: "permanent",
    scope: "identity submit"
  });

  return `https://www.reddit.com/api/v1/authorize?${params.toString()}`;
};

export const exchangeRedditCode = async ({ code, state }: { code: string; state: string }) => {
  const stateResult = await query<{ user_id: string }>(
    `
      DELETE FROM reddit_oauth_state
      WHERE state = $1 AND expires_at >= now()
      RETURNING user_id
    `,
    [state]
  );
  const userId = stateResult.rows[0]?.user_id;
  if (!userId) {
    throw new Error("Reddit authorization state is invalid or expired");
  }

  const tokenResponse = await fetch(`${redditAuthBaseUrl}/access_token`, {
    method: "POST",
    headers: {
      Authorization: redditAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": config.redditUserAgent
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redditRedirectUri()
    })
  });
  const tokenJson = await tokenResponse.json() as RedditTokenResponse;
  if (!tokenResponse.ok || !tokenJson.access_token || !tokenJson.refresh_token) {
    throw new Error(tokenJson.error ?? tokenJson.message ?? "Reddit token exchange failed");
  }

  const identityResponse = await fetch(`${redditOauthBaseUrl}/api/v1/me`, {
    headers: redditRequestHeaders(tokenJson.access_token)
  });
  const identity = identityResponse.ok ? await identityResponse.json() as RedditIdentity : {};

  await query(
    `
      INSERT INTO reddit_connection (
        id, user_id, reddit_username, refresh_token, scopes, connected_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, now(), now())
      ON CONFLICT (user_id)
      DO UPDATE SET
        reddit_username = EXCLUDED.reddit_username,
        refresh_token = EXCLUDED.refresh_token,
        scopes = EXCLUDED.scopes,
        updated_at = now()
    `,
    [randomUUID(), userId, identity.name ?? null, tokenJson.refresh_token, parseScopes(tokenJson.scope)]
  );

  return { userId, redditUsername: identity.name ?? null };
};

export const getRedditConnection = async (userId: string) => {
  const result = await query<RedditConnection>(
    `
      SELECT reddit_username, refresh_token, scopes, connected_at, updated_at
      FROM reddit_connection
      WHERE user_id = $1
    `,
    [userId]
  );
  return result.rows[0] ?? null;
};

const getAccessToken = async (userId: string) => {
  const connection = await getRedditConnection(userId);
  if (!connection) {
    throw new Error("Reddit is not connected");
  }

  const response = await fetch(`${redditAuthBaseUrl}/access_token`, {
    method: "POST",
    headers: {
      Authorization: redditAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": config.redditUserAgent
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token
    })
  });
  const json = await response.json() as RedditTokenResponse;
  if (!response.ok || !json.access_token) {
    throw new Error(json.error ?? json.message ?? "Reddit access token refresh failed");
  }
  return json.access_token;
};

const cleanSubreddit = (subreddit: string) => subreddit.trim().replace(/^r\//i, "");

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

  if (dryRun) {
    const logResult = await query<{ id: string }>(
      `
        INSERT INTO reddit_post_log (id, user_id, subreddit, title, body, dry_run, status)
        VALUES ($1, $2, $3, $4, $5, true, 'previewed')
        RETURNING id
      `,
      [randomUUID(), userId, cleanedSubreddit, title, body]
    );
    return { dryRun: true, logId: logResult.rows[0].id, redditUrl: null };
  }

  const accessToken = await getAccessToken(userId);
  const response = await fetch(`${redditOauthBaseUrl}/api/submit`, {
    method: "POST",
    headers: {
      ...redditRequestHeaders(accessToken),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      api_type: "json",
      kind: "self",
      sr: cleanedSubreddit,
      title,
      text: body,
      sendreplies: "false"
    })
  });
  const json = await response.json() as RedditSubmitResponse;
  const errors = json.json?.errors ?? [];
  if (!response.ok || errors.length > 0) {
    const message = errors.map((error) => error.filter(Boolean).join(": ")).join("; ") || "Reddit submit failed";
    await query(
      `
        INSERT INTO reddit_post_log (id, user_id, subreddit, title, body, dry_run, status, error_message)
        VALUES ($1, $2, $3, $4, $5, false, 'failed', $6)
      `,
      [randomUUID(), userId, cleanedSubreddit, title, body, message]
    );
    throw new Error(message);
  }

  const redditUrl = json.json?.data?.url ?? null;
  const redditFullname = json.json?.data?.name ?? null;
  const logResult = await query<{ id: string }>(
    `
      INSERT INTO reddit_post_log (
        id, user_id, subreddit, title, body, dry_run, status, reddit_fullname, reddit_url, posted_at
      )
      VALUES ($1, $2, $3, $4, $5, false, 'posted', $6, $7, now())
      RETURNING id
    `,
    [randomUUID(), userId, cleanedSubreddit, title, body, redditFullname, redditUrl]
  );

  return { dryRun: false, logId: logResult.rows[0].id, redditUrl };
};
