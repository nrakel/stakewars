import { randomUUID } from "node:crypto";
import type { Router } from "express";
import { z } from "zod";
import { hashPassword, passwordSchema, requireAuth, signToken, usernameSchema, verifyPassword } from "./auth.js";
import { ensureWeeklyEntry, estimatePayoutCents, roundRobinPayoutCents, roundRobinWays } from "./betting.js";
import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { getLiveMlbStates } from "./live.js";
import { getPushPreferences, getVapidPublicKey, savePushSubscription, sendTestPush, updatePushPreferences } from "./push.js";
import { buildRedditPreview, claimNextRedditPost, completeRedditPost, failRedditPost, isRedditConfigured, submitRedditPost } from "./reddit.js";
import type { MarketKey, SportKey } from "../shared/types.js";

const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema
});

const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1)
});

const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).nullable(),
  email: z.string().trim().email().max(254).nullable(),
  displayName: z.string().trim().min(2).max(40).nullable(),
  payoutMethod: z.enum(["none", "paypal", "venmo"]),
  payoutHandle: z.string().trim().min(2).max(120).nullable(),
  phoneLast4: z.string().trim().regex(/^[0-9]{4}$/, "Phone last 4 must be exactly 4 digits").nullable()
}).superRefine((input, ctx) => {
  if (input.payoutMethod !== "none" && !input.payoutHandle) {
    ctx.addIssue({
      code: "custom",
      path: ["payoutHandle"],
      message: "Payout handle is required for PayPal or Venmo"
    });
  }
});

const placeWagerSchema = z.object({
  kind: z.enum(["straight", "parlay", "round_robin"]),
  stakeCents: z.number().int().positive().max(100_000_000),
  roundRobinMaxLegs: z.number().int().min(2).max(8).optional(),
  legs: z.array(
    z.object({
      gameLineId: z.string().uuid(),
      selectedTeam: z.string().min(1).max(120)
    })
  ).min(1).max(8)
});

const historyQuerySchema = z.object({
  period: z.enum(["day", "week", "all"]).default("week"),
  includeAi: z.enum(["true", "false"]).default("false")
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  })
});

const pushPreferencesSchema = z.object({
  gameReminderEnabled: z.boolean(),
  gameStartedEnabled: z.boolean(),
  scoreChangeEnabled: z.boolean(),
  gameFinalEnabled: z.boolean()
});

const redditPreviewSchema = z.object({
  subreddit: z.string().trim().min(2).max(80).optional()
});

const redditPostSchema = z.object({
  subreddit: z.string().trim().min(2).max(80),
  title: z.string().trim().min(5).max(300),
  body: z.string().trim().min(20).max(40_000),
  dryRun: z.boolean().default(true)
});

const redditResultSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["posted", "failed"]),
  redditFullname: z.string().trim().min(1).max(120).nullable().optional(),
  redditUrl: z.string().trim().url().nullable().optional(),
  errorMessage: z.string().trim().min(1).max(1000).nullable().optional()
});

const isAdminUser = (user: Express.Request["user"]) => Boolean(
  user
  && (user.role === "admin" || config.adminUsernames.includes(user.username.toLowerCase()))
);

const requireAdmin = (req: Parameters<typeof requireAuth>[0], res: Parameters<typeof requireAuth>[1], next: Parameters<typeof requireAuth>[2]) => {
  requireAuth(req, res, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    if (!isAdminUser(req.user)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  });
};

const requireDevvit = (req: Parameters<typeof requireAuth>[0], res: Parameters<typeof requireAuth>[1], next: Parameters<typeof requireAuth>[2]) => {
  const expected = config.redditDevvitSharedSecret;
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || token !== expected) {
    res.status(401).json({ error: "Devvit authentication required" });
    return;
  }
  next();
};

export const registerRoutes = (router: Router) => {
  router.post("/auth/register", async (req, res, next) => {
    try {
      const input = registerSchema.parse(req.body);
      const passwordHash = await hashPassword(input.password);
      const result = await query<{
        id: string;
        username: string;
        fullName: string | null;
        email: string | null;
        displayName: string | null;
        rewardBalanceCents: number;
        payoutMethod: "none";
        payoutHandle: string | null;
        phoneLast4: string | null;
        role: "player";
      }>(
        `
          INSERT INTO app_user (id, username, password_hash)
          VALUES ($1, $2, $3)
          RETURNING
            id,
            username,
            full_name AS "fullName",
            email,
            display_name AS "displayName",
            reward_balance_cents AS "rewardBalanceCents",
            payout_method AS "payoutMethod",
            payout_handle AS "payoutHandle",
            phone_last4 AS "phoneLast4",
            role
        `,
        [randomUUID(), input.username, passwordHash]
      );
      const token = signToken(result.rows[0]);
      res.status(201).json({ token, user: result.rows[0] });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        res.status(409).json({ error: "Username is already taken" });
        return;
      }
      next(error);
    }
  });

  router.post("/auth/login", async (req, res, next) => {
    try {
      const input = loginSchema.parse(req.body);
      const result = await query<{
        id: string;
        username: string;
        fullName: string | null;
        email: string | null;
        displayName: string | null;
        rewardBalanceCents: number;
        payoutMethod: "none" | "paypal" | "venmo";
        payoutHandle: string | null;
        phoneLast4: string | null;
        password_hash: string;
        role: "player" | "admin" | "system";
      }>(
        `
          SELECT
            id,
            username,
            full_name AS "fullName",
            email,
            display_name AS "displayName",
            reward_balance_cents AS "rewardBalanceCents",
            payout_method AS "payoutMethod",
            payout_handle AS "payoutHandle",
            phone_last4 AS "phoneLast4",
            password_hash,
            role
          FROM app_user
          WHERE lower(username) = lower($1)
          ORDER BY created_at ASC
          LIMIT 1
        `,
        [input.username]
      );
      const user = result.rows[0];
      if (!user || !(await verifyPassword(input.password, user.password_hash))) {
        res.status(401).json({ error: "Invalid username or password" });
        return;
      }
      const sessionUser = {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        displayName: user.displayName,
        rewardBalanceCents: user.rewardBalanceCents,
        payoutMethod: user.payoutMethod,
        payoutHandle: user.payoutHandle,
        phoneLast4: user.phoneLast4,
        role: user.role
      };
      res.json({ token: signToken(sessionUser), user: sessionUser });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", requireAuth, async (req, res, next) => {
    try {
      const entry = await transaction((client) => ensureWeeklyEntry(client, req.user!.id));
      res.json({ user: req.user, bankroll: entry });
    } catch (error) {
      next(error);
    }
  });

  router.get("/push/public-key", requireAuth, async (_req, res, next) => {
    try {
      res.json({ publicKey: getVapidPublicKey() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/push/subscribe", requireAuth, async (req, res, next) => {
    try {
      const subscription = pushSubscriptionSchema.parse(req.body);
      await savePushSubscription({
        userId: req.user!.id,
        subscription,
        userAgent: req.header("user-agent") ?? undefined
      });
      res.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/push/test", requireAuth, async (req, res, next) => {
    try {
      const result = await sendTestPush(req.user!.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/push/preferences", requireAuth, async (req, res, next) => {
    try {
      const preferences = await getPushPreferences(req.user!.id);
      res.json({ preferences });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/push/preferences", requireAuth, async (req, res, next) => {
    try {
      const input = pushPreferencesSchema.parse(req.body);
      const preferences = await updatePushPreferences(req.user!.id, input);
      res.json({ preferences });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/me/profile", requireAuth, async (req, res, next) => {
    try {
      const input = profileSchema.parse(req.body);
      const result = await query<{
        id: string;
        username: string;
        fullName: string | null;
        email: string | null;
        displayName: string | null;
        rewardBalanceCents: number;
        payoutMethod: "none" | "paypal" | "venmo";
        payoutHandle: string | null;
        phoneLast4: string | null;
        role: "player" | "admin" | "system";
      }>(
        `
          UPDATE app_user
          SET full_name = $2,
              email = $3,
              display_name = $4,
              payout_method = $5,
              payout_handle = $6,
              phone_last4 = $7
          WHERE id = $1
          RETURNING
            id,
            username,
            full_name AS "fullName",
            email,
            display_name AS "displayName",
            reward_balance_cents AS "rewardBalanceCents",
            payout_method AS "payoutMethod",
            payout_handle AS "payoutHandle",
            phone_last4 AS "phoneLast4",
            role
        `,
        [
          req.user!.id,
          input.fullName,
          input.email,
          input.displayName,
          input.payoutMethod,
          input.payoutMethod === "none" ? null : input.payoutHandle,
          input.phoneLast4
        ]
      );
      const user = result.rows[0];
      res.json({ token: signToken(user), user });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/reddit/status", requireAdmin, async (req, res, next) => {
    try {
      res.json({
        configured: isRedditConfigured(),
        mode: "devvit",
        connected: isRedditConfigured(),
        redditUsername: null,
        connectedAt: null,
        scopes: [],
        defaultSubreddits: config.redditDefaultSubreddits
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/reddit/preview", requireAdmin, async (req, res, next) => {
    try {
      const input = redditPreviewSchema.parse(req.body);
      const preview = await buildRedditPreview(input.subreddit);
      await submitRedditPost({
        userId: req.user!.id,
        subreddit: preview.subreddit,
        title: preview.title,
        body: preview.body,
        dryRun: true
      });
      res.json({ preview });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/reddit/post", requireAdmin, async (req, res, next) => {
    try {
      const input = redditPostSchema.parse(req.body);
      const result = await submitRedditPost({
        userId: req.user!.id,
        subreddit: input.subreddit,
        title: input.title,
        body: input.body,
        dryRun: input.dryRun
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/devvit/reddit/claim", requireDevvit, async (_req, res, next) => {
    try {
      const post = await claimNextRedditPost();
      res.json({ post });
    } catch (error) {
      next(error);
    }
  });

  router.post("/devvit/reddit/result", requireDevvit, async (req, res, next) => {
    try {
      const input = redditResultSchema.parse(req.body);
      if (input.status === "posted" && !input.redditUrl) {
        res.status(400).json({ error: "redditUrl is required for posted results" });
        return;
      }
      const ok = input.status === "posted"
        ? await completeRedditPost({
          id: input.id,
          redditFullname: input.redditFullname ?? null,
          redditUrl: input.redditUrl!
        })
        : await failRedditPost({
          id: input.id,
          errorMessage: input.errorMessage ?? "Devvit reported Reddit post failure"
        });
      if (!ok) {
        res.status(404).json({ error: "Queued Reddit post not found" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get("/lines", async (_req, res, next) => {
    try {
      const result = await query<{
        id: string;
        providerEventId: string | null;
        sport: string;
        league: string;
        startsAt: Date;
        homeTeam: string;
        awayTeam: string;
        favoriteTeam: string;
        spread: string;
        oddsAmerican: number;
        marketKey: MarketKey;
        awayProbablePitcherId: number | null;
        awayProbablePitcherName: string | null;
        awayPitcherWins: number | null;
        awayPitcherLosses: number | null;
        awayPitcherEra: number | null;
        homeProbablePitcherId: number | null;
        homeProbablePitcherName: string | null;
        homePitcherWins: number | null;
        homePitcherLosses: number | null;
        homePitcherEra: number | null;
        context: Record<string, unknown> | null;
      }>(
        `
          SELECT
            gl.id,
            gl.provider_event_id AS "providerEventId",
            gl.sport,
            gl.league,
            gl.starts_at AS "startsAt",
            gl.home_team AS "homeTeam",
            gl.away_team AS "awayTeam",
            gl.favorite_team AS "favoriteTeam",
            gl.spread,
            gl.odds_american AS "oddsAmerican",
            gl.market_key AS "marketKey",
            mgc.away_probable_pitcher_id AS "awayProbablePitcherId",
            mgc.away_probable_pitcher_name AS "awayProbablePitcherName",
            NULLIF(mgc.away_pitcher_stats #>> '{season,wins}', '')::numeric AS "awayPitcherWins",
            NULLIF(mgc.away_pitcher_stats #>> '{season,losses}', '')::numeric AS "awayPitcherLosses",
            NULLIF(mgc.away_pitcher_stats #>> '{season,era}', '')::numeric AS "awayPitcherEra",
            mgc.home_probable_pitcher_id AS "homeProbablePitcherId",
            mgc.home_probable_pitcher_name AS "homeProbablePitcherName",
            NULLIF(mgc.home_pitcher_stats #>> '{season,wins}', '')::numeric AS "homePitcherWins",
            NULLIF(mgc.home_pitcher_stats #>> '{season,losses}', '')::numeric AS "homePitcherLosses",
            NULLIF(mgc.home_pitcher_stats #>> '{season,era}', '')::numeric AS "homePitcherEra",
            mgc.context
          FROM game_line gl
          LEFT JOIN mlb_game_context mgc
            ON mgc.starts_on = (gl.starts_at AT TIME ZONE 'UTC')::date
            AND regexp_replace(lower(mgc.away_team), '^(oakland|the)\\s+', '') = regexp_replace(lower(gl.away_team), '^(oakland|the)\\s+', '')
            AND regexp_replace(lower(mgc.home_team), '^(oakland|the)\\s+', '') = regexp_replace(lower(gl.home_team), '^(oakland|the)\\s+', '')
            AND mgc.starts_at = gl.starts_at
          WHERE gl.is_active = true AND gl.starts_at > now()
          ORDER BY gl.starts_at ASC
          LIMIT 100
        `
      );
      const lineIds = result.rows.map((row) => row.id);
      const candidateResult = lineIds.length
        ? await query<{
          gameLineId: string;
          selectedTeam: string;
          confidence: number;
          edge: number;
          score: number;
        }>(
          `
            WITH latest AS (
              SELECT id
              FROM ai_model_run
              WHERE sport = 'MLB'
              ORDER BY created_at DESC
              LIMIT 1
            )
            SELECT
              c.game_line_id AS "gameLineId",
              c.selected_team AS "selectedTeam",
              c.confidence,
              c.edge,
              c.score
            FROM ai_pick_candidate c
            JOIN latest ON latest.id = c.run_id
            WHERE c.game_line_id = ANY($1::uuid[])
          `,
          [lineIds]
        )
        : { rows: [] };
      const aiCandidateByLineId = new Map(candidateResult.rows.map((candidate) => [
        candidate.gameLineId,
        {
          selectedTeam: candidate.selectedTeam,
          confidence: Number(candidate.confidence),
          edge: Number(candidate.edge),
          score: Number(candidate.score)
        }
      ]));
      const marketMap = new Map<string, {
        eventKey: string;
        sport: string;
        league: string;
        startsAt: string;
        homeTeam: string;
        awayTeam: string;
        marketKey: MarketKey;
        awayLine: null | { id: string; team: string; spread: string; oddsAmerican: number };
        homeLine: null | { id: string; team: string; spread: string; oddsAmerican: number };
        drawLine: null | { id: string; team: string; spread: string; oddsAmerican: number };
        overLine: null | { id: string; team: string; spread: string; oddsAmerican: number };
        underLine: null | { id: string; team: string; spread: string; oddsAmerican: number };
      }>();

      for (const row of result.rows) {
        const providerEventBase = row.providerEventId?.split(":")[0];
        const eventKey = providerEventBase ?? `${row.sport}:${row.startsAt}:${row.awayTeam}:${row.homeTeam}:${row.marketKey}`;
        const key = `${eventKey}:${row.marketKey}`;
        const market = marketMap.get(key) ?? {
          eventKey,
          sport: row.sport,
          league: row.league,
          startsAt: row.startsAt.toISOString(),
          homeTeam: row.homeTeam,
          awayTeam: row.awayTeam,
          marketKey: row.marketKey,
          awayLine: null,
          homeLine: null,
          drawLine: null,
          overLine: null,
          underLine: null
        };
        const side = { id: row.id, team: row.favoriteTeam, spread: row.spread, oddsAmerican: row.oddsAmerican };
        if (row.favoriteTeam === row.awayTeam) {
          market.awayLine = side;
        }
        if (row.favoriteTeam === row.homeTeam) {
          market.homeLine = side;
        }
        if (row.marketKey === "h2h" && row.favoriteTeam === "Draw") {
          market.drawLine = side;
        }
        if (row.marketKey === "totals" && row.favoriteTeam === "Over") {
          market.overLine = side;
        }
        if (row.marketKey === "totals" && row.favoriteTeam === "Under") {
          market.underLine = side;
        }
        marketMap.set(key, market);
      }

      const markets = [...marketMap.values()]
        .filter((market) =>
          market.marketKey === "totals"
            ? market.overLine && market.underLine
            : market.awayLine && market.homeLine
        )
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      const gameMap = new Map<string, {
        eventKey: string;
        sport: string;
        league: string;
        startsAt: string;
        homeTeam: string;
        awayTeam: string;
        awayProbablePitcher: null | { id: number | null; name: string | null; wins: number | null; losses: number | null; era: number | null };
        homeProbablePitcher: null | { id: number | null; name: string | null; wins: number | null; losses: number | null; era: number | null };
        aiConfidence: null | { selectedTeam: string; confidence: number; edge: number; score: number };
        awayLineup: unknown;
        homeLineup: unknown;
        markets: typeof markets;
      }>();

      for (const market of markets) {
        const sourceRow = result.rows.find((row) => {
          const rowEventKey = row.providerEventId?.split(":")[0]
            ?? `${row.sport}:${row.startsAt}:${row.awayTeam}:${row.homeTeam}:${row.marketKey}`;
          return rowEventKey === market.eventKey;
        });
        const game = gameMap.get(market.eventKey) ?? {
          eventKey: market.eventKey,
          sport: market.sport,
          league: market.league,
          startsAt: market.startsAt,
          homeTeam: market.homeTeam,
          awayTeam: market.awayTeam,
          awayProbablePitcher: sourceRow ? {
            id: sourceRow.awayProbablePitcherId,
            name: sourceRow.awayProbablePitcherName,
            wins: sourceRow.awayPitcherWins === null ? null : Number(sourceRow.awayPitcherWins),
            losses: sourceRow.awayPitcherLosses === null ? null : Number(sourceRow.awayPitcherLosses),
            era: sourceRow.awayPitcherEra === null ? null : Number(sourceRow.awayPitcherEra)
          } : null,
          homeProbablePitcher: sourceRow ? {
            id: sourceRow.homeProbablePitcherId,
            name: sourceRow.homeProbablePitcherName,
            wins: sourceRow.homePitcherWins === null ? null : Number(sourceRow.homePitcherWins),
            losses: sourceRow.homePitcherLosses === null ? null : Number(sourceRow.homePitcherLosses),
            era: sourceRow.homePitcherEra === null ? null : Number(sourceRow.homePitcherEra)
          } : null,
          aiConfidence: null,
          awayLineup: sourceRow?.context?.awayLineup ?? null,
          homeLineup: sourceRow?.context?.homeLineup ?? null,
          markets: []
        };
        game.markets.push(market);
        for (const line of [market.awayLine, market.homeLine, market.drawLine]) {
          const candidate = line ? aiCandidateByLineId.get(line.id) : null;
          if (candidate && (!game.aiConfidence || candidate.confidence > game.aiConfidence.confidence)) {
            game.aiConfidence = candidate;
          }
        }
        gameMap.set(market.eventKey, game);
      }

      const games = [...gameMap.values()]
        .filter((game) =>
          game.sport !== "MLB"
          || game.markets.some((market) => market.marketKey === "h2h" || market.marketKey === "spreads")
        )
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      res.json({ lines: result.rows, markets, games });
    } catch (error) {
      next(error);
    }
  });

  router.get("/leaderboard", async (_req, res, next) => {
    try {
      const result = await query(
        `
          WITH current_week AS (
            SELECT (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date AS week_start
          ),
          ai AS (
            SELECT e.starting_bankroll_cents + e.settled_profit_cents AS leaderboard_cents
            FROM weekly_entry e
            JOIN app_user u ON u.id = e.user_id
            JOIN current_week cw ON cw.week_start = e.week_starts_on
            WHERE u.username = $1
            LIMIT 1
          ),
          ranked AS (
            SELECT
              u.display_name,
              u.role,
              e.starting_bankroll_cents + e.settled_profit_cents AS leaderboard_cents,
              e.settled_profit_cents
            FROM weekly_entry e
            JOIN app_user u ON u.id = e.user_id
            JOIN current_week cw ON cw.week_start = e.week_starts_on
            WHERE u.role IN ('player', 'system')
          )
          SELECT
            (row_number() OVER (ORDER BY leaderboard_cents DESC, settled_profit_cents DESC))::int AS rank,
            CASE
              WHEN role = 'system' THEN COALESCE(NULLIF(display_name, ''), 'StakeWars AI Bot')
              ELSE COALESCE(NULLIF(display_name, ''), 'Player ' || (row_number() OVER (ORDER BY leaderboard_cents DESC, settled_profit_cents DESC))::text)
            END AS "displayName",
            leaderboard_cents AS "balanceCents",
            settled_profit_cents AS "settledProfitCents",
            role,
            CASE
              WHEN role = 'system' THEN false
              WHEN (SELECT leaderboard_cents FROM ai) IS NULL THEN false
              ELSE leaderboard_cents > (SELECT leaderboard_cents FROM ai)
            END AS "beatAi"
          FROM ranked
          ORDER BY leaderboard_cents DESC, settled_profit_cents DESC
          LIMIT 100
        `,
        [config.aiUsername]
      );
      res.json({ leaderboard: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/ai-picks", async (_req, res, next) => {
    try {
      const result = await query(
        `
          SELECT p.id, p.selected_team AS "selectedTeam", p.published_for AS "publishedFor",
                 p.score, p.confidence, p.reasons, p.features, p.explanation, p.locked_at AS "lockedAt",
                 l.sport, l.league, l.starts_at AS "startsAt", l.home_team AS "homeTeam",
                 l.away_team AS "awayTeam", l.spread, l.odds_american AS "oddsAmerican",
                 l.market_key AS "marketKey"
          FROM ai_pick p
          JOIN game_line l ON l.id = p.game_line_id
          WHERE p.published_for = (now() AT TIME ZONE 'America/Chicago')::date
          ORDER BY p.locked_at DESC NULLS LAST, p.confidence DESC NULLS LAST, p.score DESC NULLS LAST, l.starts_at ASC
        `
      );
      res.json({ picks: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/live/mlb", async (_req, res, next) => {
    try {
      const games = await getLiveMlbStates();
      res.json({ games });
    } catch (error) {
      next(error);
    }
  });

  router.get("/wagers/open", requireAuth, async (req, res, next) => {
    try {
      const result = await query<{
        wagerId: string;
        kind: "straight" | "parlay" | "round_robin";
        stakeCents: number;
        potentialPayoutCents: number;
        placedAt: Date;
        legId: string;
        selectedTeam: string;
        spread: string;
        oddsAmerican: number;
        marketKey: "spreads" | "h2h";
        sport: SportKey;
        startsAt: Date;
        awayTeam: string;
        homeTeam: string;
      }>(
        `
          SELECT
            w.id AS "wagerId",
            w.kind,
            w.stake_cents AS "stakeCents",
            w.potential_payout_cents AS "potentialPayoutCents",
            w.placed_at AS "placedAt",
            wl.id AS "legId",
            wl.selected_team AS "selectedTeam",
            wl.spread,
            wl.odds_american AS "oddsAmerican",
            gl.market_key AS "marketKey",
            gl.sport,
            gl.starts_at AS "startsAt",
            gl.away_team AS "awayTeam",
            gl.home_team AS "homeTeam"
          FROM wager w
          JOIN wager_leg wl ON wl.wager_id = w.id
          JOIN game_line gl ON gl.id = wl.game_line_id
          WHERE w.user_id = $1 AND w.status = 'pending'
          ORDER BY w.placed_at DESC, gl.starts_at ASC
        `,
        [req.user!.id]
      );

      const wagers = new Map<string, {
        id: string;
        kind: "straight" | "parlay" | "round_robin";
        stakeCents: number;
        potentialPayoutCents: number;
        placedAt: string;
        legs: Array<{
          id: string;
          selectedTeam: string;
          spread: string;
          oddsAmerican: number;
          marketKey: "spreads" | "h2h";
          sport: SportKey;
          startsAt: string;
          awayTeam: string;
          homeTeam: string;
        }>;
      }>();

      for (const row of result.rows) {
        const wager = wagers.get(row.wagerId) ?? {
          id: row.wagerId,
          kind: row.kind,
          stakeCents: row.stakeCents,
          potentialPayoutCents: row.potentialPayoutCents,
          placedAt: row.placedAt.toISOString(),
          legs: []
        };
        wager.legs.push({
          id: row.legId,
          selectedTeam: row.selectedTeam,
          spread: row.spread,
          oddsAmerican: row.oddsAmerican,
          marketKey: row.marketKey,
          sport: row.sport,
          startsAt: row.startsAt.toISOString(),
          awayTeam: row.awayTeam,
          homeTeam: row.homeTeam
        });
        wagers.set(row.wagerId, wager);
      }

      res.json({ wagers: [...wagers.values()] });
    } catch (error) {
      next(error);
    }
  });

  router.get("/wagers/history", requireAuth, async (req, res, next) => {
    try {
      const input = historyQuerySchema.parse(req.query);
      const includeAi = input.includeAi === "true";
      const result = await query<{
        wagerId: string;
        owner: "user" | "ai";
        displayName: string;
        kind: "straight" | "parlay" | "round_robin";
        wagerStatus: "won" | "lost" | "push" | "void";
        stakeCents: number;
        potentialPayoutCents: number;
        placedAt: Date;
        legId: string;
        selectedTeam: string;
        spread: string;
        oddsAmerican: number;
        legStatus: "won" | "lost" | "push" | "void";
        marketKey: "spreads" | "h2h";
        sport: SportKey;
        startsAt: Date;
        awayTeam: string;
        homeTeam: string;
      }>(
        `
          WITH target_users AS (
            SELECT id, 'user'::text AS owner, COALESCE(NULLIF(display_name, ''), 'You') AS display_name
            FROM app_user
            WHERE id = $1
            UNION ALL
            SELECT id, 'ai'::text AS owner, COALESCE(NULLIF(display_name, ''), 'StakeWars AI Bot') AS display_name
            FROM app_user
            WHERE username = $2 AND $3 = true
          ),
          wager_games AS (
            SELECT
              w.id AS wager_id,
              max(gl.starts_at) AS latest_starts_at
            FROM wager w
            JOIN wager_leg wl ON wl.wager_id = w.id
            JOIN game_line gl ON gl.id = wl.game_line_id
            GROUP BY w.id
          )
          SELECT
            w.id AS "wagerId",
            tu.owner AS "owner",
            tu.display_name AS "displayName",
            w.kind,
            w.status AS "wagerStatus",
            w.stake_cents AS "stakeCents",
            w.potential_payout_cents AS "potentialPayoutCents",
            w.placed_at AS "placedAt",
            wl.id AS "legId",
            wl.selected_team AS "selectedTeam",
            wl.spread,
            wl.odds_american AS "oddsAmerican",
            wl.status AS "legStatus",
            gl.market_key AS "marketKey",
            gl.sport,
            gl.starts_at AS "startsAt",
            gl.away_team AS "awayTeam",
            gl.home_team AS "homeTeam"
          FROM wager w
          JOIN target_users tu ON tu.id = w.user_id
          JOIN wager_games wg ON wg.wager_id = w.id
          JOIN wager_leg wl ON wl.wager_id = w.id
          JOIN game_line gl ON gl.id = wl.game_line_id
          WHERE w.status <> 'pending'
            AND (
              $4 = 'all'
              OR (
                $4 = 'day'
                AND (wg.latest_starts_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date
              )
              OR (
                $4 = 'week'
                AND (wg.latest_starts_at AT TIME ZONE 'America/Chicago')::date >= (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date
              )
            )
          ORDER BY wg.latest_starts_at DESC, w.placed_at DESC, w.id, gl.starts_at ASC
          LIMIT 500
        `,
        [req.user!.id, config.aiUsername, includeAi, input.period]
      );

      const wagers = new Map<string, {
        id: string;
        owner: "user" | "ai";
        displayName: string;
        kind: "straight" | "parlay" | "round_robin";
        status: "won" | "lost" | "push" | "void";
        stakeCents: number;
        potentialPayoutCents: number;
        profitCents: number;
        placedAt: string;
        legs: Array<{
          id: string;
          selectedTeam: string;
          spread: string;
          oddsAmerican: number;
          status: "won" | "lost" | "push" | "void";
          marketKey: "spreads" | "h2h";
          sport: SportKey;
          startsAt: string;
          awayTeam: string;
          homeTeam: string;
        }>;
      }>();

      for (const row of result.rows) {
        const profitCents = row.kind === "round_robin"
          ? row.potentialPayoutCents - row.stakeCents
          : row.wagerStatus === "won"
          ? row.potentialPayoutCents - row.stakeCents
          : row.wagerStatus === "lost"
            ? -row.stakeCents
            : 0;
        const wager = wagers.get(row.wagerId) ?? {
          id: row.wagerId,
          owner: row.owner,
          displayName: row.displayName,
          kind: row.kind,
          status: row.wagerStatus,
          stakeCents: row.stakeCents,
          potentialPayoutCents: row.potentialPayoutCents,
          profitCents,
          placedAt: row.placedAt.toISOString(),
          legs: []
        };
        wager.legs.push({
          id: row.legId,
          selectedTeam: row.selectedTeam,
          spread: row.spread,
          oddsAmerican: row.oddsAmerican,
          status: row.legStatus,
          marketKey: row.marketKey,
          sport: row.sport,
          startsAt: row.startsAt.toISOString(),
          awayTeam: row.awayTeam,
          homeTeam: row.homeTeam
        });
        wagers.set(row.wagerId, wager);
      }

      res.json({ wagers: [...wagers.values()] });
    } catch (error) {
      next(error);
    }
  });

  router.post("/wagers", requireAuth, async (req, res, next) => {
    try {
      const input = placeWagerSchema.parse(req.body);
      if (input.kind === "straight" && input.legs.length !== 1) {
        res.status(400).json({ error: "Straight wagers must contain exactly one leg" });
        return;
      }
      if (input.kind !== "straight" && input.legs.length < 2) {
        res.status(400).json({ error: "Parlays and round robins need at least two legs" });
        return;
      }
      if (input.kind === "round_robin" && (!input.roundRobinMaxLegs || input.roundRobinMaxLegs > input.legs.length)) {
        res.status(400).json({ error: "Select a valid round robin size" });
        return;
      }

      const wager = await transaction(async (client) => {
        const entry = await ensureWeeklyEntry(client, req.user!.id);
        const ways = input.kind === "round_robin" ? roundRobinWays(input.legs.length, input.roundRobinMaxLegs, 2) : null;
        const totalStakeCents = input.kind === "round_robin" ? input.stakeCents * (ways ?? 0) : input.stakeCents;
        if (!ways && input.kind === "round_robin") {
          throw new Error("Select a valid round robin size");
        }
        if (entry.balance_cents < totalStakeCents) {
          throw new Error("Insufficient bankroll");
        }

        const lineResult = await client.query<{
          id: string;
          sport: SportKey;
          starts_at: Date;
          home_team: string;
          away_team: string;
          favorite_team: string;
          spread: string;
          odds_american: number;
          market_key: MarketKey;
        }>(
          "SELECT id, sport, starts_at, home_team, away_team, favorite_team, spread, odds_american, market_key FROM game_line WHERE id = ANY($1::uuid[]) AND is_active = true AND starts_at > now() FOR SHARE",
          [input.legs.map((leg) => leg.gameLineId)]
        );

        if (lineResult.rowCount !== input.legs.length) {
          throw new Error("One or more selected lines are unavailable");
        }

        const lines = new Map(lineResult.rows.map((line) => [line.id, line]));
        const selectedLines = input.legs.map((leg) => lines.get(leg.gameLineId)!);
        for (let leftIndex = 0; leftIndex < selectedLines.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < selectedLines.length; rightIndex += 1) {
            const left = selectedLines[leftIndex];
            const right = selectedLines[rightIndex];
            const sameGame = left.sport === right.sport
              && left.away_team === right.away_team
              && left.home_team === right.home_team
              && left.starts_at.getTime() === right.starts_at.getTime();
            if (!sameGame) {
              continue;
            }
            const conflictingTotals = left.market_key === "totals"
              && right.market_key === "totals"
              && left.favorite_team !== right.favorite_team;
            const conflictingSides = left.market_key !== "totals"
              && right.market_key !== "totals"
              && left.favorite_team !== right.favorite_team;
            if (conflictingTotals || conflictingSides) {
              throw new Error("Selected outcomes conflict for the same game");
            }
          }
        }
        const odds = input.legs.map((leg) => {
          const line = lines.get(leg.gameLineId)!;
          if (leg.selectedTeam !== line.favorite_team) {
            throw new Error("Selected outcome is not available");
          }
          return line.odds_american;
        });

        const potentialPayout = input.kind === "round_robin"
          ? roundRobinPayoutCents(input.stakeCents, odds, input.roundRobinMaxLegs, 2)
          : estimatePayoutCents(input.stakeCents, odds);

        const wagerResult = await client.query<{ id: string }>(
          `
            INSERT INTO wager (
              id, user_id, weekly_entry_id, kind, stake_cents, potential_payout_cents,
              legs_count, round_robin_ways, round_robin_min_legs,
              round_robin_max_legs, round_robin_stake_per_way_cents
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id
          `,
          [
            randomUUID(),
            req.user!.id,
            entry.id,
            input.kind,
            totalStakeCents,
            potentialPayout,
            input.legs.length,
            ways,
            input.kind === "round_robin" ? 2 : null,
            input.kind === "round_robin" ? input.roundRobinMaxLegs : null,
            input.kind === "round_robin" ? input.stakeCents : null
          ]
        );

        for (const leg of input.legs) {
          const line = lines.get(leg.gameLineId)!;
          await client.query(
            `
              INSERT INTO wager_leg (id, wager_id, game_line_id, selected_team, spread, odds_american)
              VALUES ($1, $2, $3, $4, $5, $6)
            `,
            [randomUUID(), wagerResult.rows[0].id, leg.gameLineId, leg.selectedTeam, line.spread, line.odds_american]
          );
        }

        await client.query("UPDATE weekly_entry SET balance_cents = balance_cents - $1 WHERE id = $2", [
          totalStakeCents,
          entry.id
        ]);

        return { id: wagerResult.rows[0].id, potentialPayoutCents: potentialPayout, roundRobinWays: ways };
      });

      res.status(201).json({ wager });
    } catch (error) {
      if ((error as Error).message === "Insufficient bankroll") {
        res.status(400).json({ error: "Insufficient bankroll" });
        return;
      }
      if ((error as Error).message.includes("unavailable") || (error as Error).message.includes("Selected outcome") || (error as Error).message.includes("conflict") || (error as Error).message.includes("round robin")) {
        res.status(400).json({ error: (error as Error).message });
        return;
      }
      next(error);
    }
  });
};
