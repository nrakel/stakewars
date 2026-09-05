import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Router } from "express";
import { z } from "zod";
import { hashPassword, optionalAuth, passwordSchema, requireAuth, signToken, usernameSchema, verifyPassword } from "./auth.js";
import { currentWeekStart, ensureWeeklyEntry, estimatePayoutCents, roundRobinPayoutCents, roundRobinWays } from "./betting.js";
import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { getLiveMlbStates, getLiveStates } from "./live.js";
import { getPushPreferences, getVapidPublicKey, savePushSubscription, sendPushToUsers, sendTestPush, updatePushPreferences } from "./push.js";
import { sendMail } from "./mail.js";
import { fetchMlbProbablePitcherFallbacks, type MlbProbablePitcherFallback } from "./mlbContext.js";
import { buildRedditAllPicksPreview, buildRedditParlayPreview, buildRedditPreview, getTodayRedditLockStatus, lockRedditPostTracking } from "./reddit.js";
import { getVisitorMetrics } from "./visitorMetrics.js";
import { getChineModelAudit } from "./modelAudit.js";
import {
  dailyAiHighBankrollStraightBankrollFraction,
  dailyAiParlayBankrollFraction,
  dailyAiReducedStraightBankrollThresholdCents,
  dailyAiStraightBankrollFraction,
  dailyAiWagerMinConfidence
} from "./ai.js";
import { isStakeWarsOwnerUsername, merchNavItemForUser } from "../shared/merch.js";
import type { DailyAiPick, DailyChineParlay } from "../shared/types.js";
import {
  buildTowerHandForUser,
  capTowerHandForUser,
  doubleTowerHandForUser,
  getActiveTowerConfig,
  getRecentTowerHands,
  getTowerAnalytics,
  getTowerState,
  simulateTowerHandsForUser,
  startTowerHandForUser,
  TowerError
} from "./tower/service.js";
import type { MarketKey, SportKey } from "../shared/types.js";

const registerSchema = z.object({
  username: usernameSchema,
  email: z.string().trim().email().max(254),
  password: passwordSchema,
  displayName: z.string().trim().min(2).max(40).regex(/^[^\x00-\x1F\x7F]+$/u, "Display name cannot contain control characters"),
  referralCode: z.string().trim().regex(/^[a-zA-Z0-9_-]{6,64}$/).optional()
});

const qrCampaignSlugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/);

const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1)
});

const resendVerificationSchema = z.object({
  userId: z.string().uuid()
});

const emailChangeRecoverySchema = z.object({
  token: z.string().trim().min(40).max(200),
  password: passwordSchema
});

const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).nullable(),
  email: z.string().trim().email().max(254).nullable(),
  allowEmailChange: z.boolean().default(false),
  displayName: z.string().trim().min(2).max(40).regex(/^[^\x00-\x1F\x7F]+$/u, "Display name cannot contain control characters").nullable(),
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

const bonusFulfillmentSchema = z.object({
  bonusSelection: z.string().trim().min(1).max(80),
  bonusSize: z.string().trim().min(1).max(20).nullable(),
  shippingName: z.string().trim().min(2).max(120),
  shippingAddressLine1: z.string().trim().min(2).max(160),
  shippingAddressLine2: z.string().trim().max(160).nullable(),
  shippingCity: z.string().trim().min(2).max(100),
  shippingRegion: z.string().trim().min(2).max(80),
  shippingPostalCode: z.string().trim().min(3).max(20),
  shippingCountry: z.string().trim().min(2).max(80)
});

const bonusFulfillmentCompleteSchema = z.object({
  message: z.string().trim().min(1).max(2000)
});

const placeWagerSchema = z.object({
  kind: z.enum(["straight", "parlay", "round_robin"]),
  stakeCents: z.number().int().positive().max(100_000_000),
  roundRobinMaxLegs: z.number().int().min(2).max(8).optional(),
  acceptLineMoves: z.boolean().default(false),
  referralBoostDecision: z.enum(["use", "waive"]).optional(),
  referralBoostCount: z.number().int().min(1).max(2).optional(),
  legs: z.array(
    z.object({
      gameLineId: z.string().uuid(),
      selectedTeam: z.string().min(1).max(120),
      expectedSpread: z.string().max(40).optional(),
      expectedOddsAmerican: z.number().int().optional()
    })
  ).min(1).max(8)
});

const towerStartHandSchema = z.object({
  valueWagerCents: z.number().int().min(0).max(100_000_000).default(0),
  heightWagerCents: z.number().int().min(0).max(100_000_000).default(0)
});

const towerSimulateSchema = towerStartHandSchema.extend({
  hands: z.number().int().min(1).max(1000)
});

const towerActionSchema = z.object({
  actionVersion: z.number().int().positive()
});

const towerDoubleSchema = towerActionSchema.extend({
  doubleValue: z.boolean().default(false),
  doubleHeight: z.boolean().default(false)
});

const redditPreviewSchema = z.object({
  subreddit: z.string().trim().min(1).max(50).optional(),
  postType: z.enum(["single", "parlay", "all"]).default("single")
});

const redditLockSchema = z.object({
  postType: z.enum(["single", "parlay", "all"]).default("single"),
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(30_000)
});

const optionalDateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

const weeklyPrizeSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Week start must be YYYY-MM-DD"),
  cashPrizeCents: z.number().int().min(0).max(100_000_000),
  firstPlaceBonus: z.string().trim().max(240).nullable().optional()
});

const survivorPickSchema = z.object({
  gameLineId: z.string().uuid(),
  selectedTeam: z.string().trim().min(1).max(120)
});

const survivorAdminPickSchema = z.object({
  status: z.enum(["won", "lost", "tie", "void"]),
  note: z.string().trim().max(500).optional()
});

const nflConfidenceSubmitSchema = z.object({
  week: z.number().int().min(1).max(25),
  picks: z.array(z.object({
    gameId: z.string().uuid(),
    selectedTeam: z.string().trim().min(1).max(120),
    confidencePoints: z.number().int().min(1).max(32)
  })).min(1).max(32)
});

const nflConfidenceSettleSchema = z.object({
  week: z.number().int().min(1).max(25).optional()
});

type WagerLineRow = {
  id: string;
  sport: SportKey;
  starts_at: Date;
  home_team: string;
  away_team: string;
  favorite_team: string;
  spread: string;
  odds_american: number;
  market_key: MarketKey;
  is_active: boolean;
};

const nflTeamNames = [
  "Arizona Cardinals",
  "Atlanta Falcons",
  "Baltimore Ravens",
  "Buffalo Bills",
  "Carolina Panthers",
  "Chicago Bears",
  "Cincinnati Bengals",
  "Cleveland Browns",
  "Dallas Cowboys",
  "Denver Broncos",
  "Detroit Lions",
  "Green Bay Packers",
  "Houston Texans",
  "Indianapolis Colts",
  "Jacksonville Jaguars",
  "Kansas City Chiefs",
  "Las Vegas Raiders",
  "Los Angeles Chargers",
  "Los Angeles Rams",
  "Miami Dolphins",
  "Minnesota Vikings",
  "New England Patriots",
  "New Orleans Saints",
  "New York Giants",
  "New York Jets",
  "Philadelphia Eagles",
  "Pittsburgh Steelers",
  "San Francisco 49ers",
  "Seattle Seahawks",
  "Tampa Bay Buccaneers",
  "Tennessee Titans",
  "Washington Commanders"
];

const nflTeamNameSet = new Set(nflTeamNames);

const isNflMatchup = (awayTeam: string | null | undefined, homeTeam: string | null | undefined) =>
  Boolean(awayTeam && homeTeam && nflTeamNameSet.has(awayTeam) && nflTeamNameSet.has(homeTeam));

const generateReferralCode = () => randomBytes(9).toString("base64url").toLowerCase();

const createUniqueReferralCode = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateReferralCode();
    const existing = await query("SELECT 1 FROM app_user WHERE referral_code = $1 LIMIT 1", [code]);
    if (!existing.rowCount) {
      return code;
    }
  }
  return randomUUID().replace(/-/g, "").slice(0, 16);
};

const htmlEscape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const publicAppOrigin = () => (config.referralPublicOrigin || config.publicOrigin).replace(/\/+$/, "");
const hashValue = (value: string) => createHash("sha256").update(value).digest("hex");
const centralDate = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const markdownEscape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

const podcastDateTime = (value: string | Date | null | undefined) => {
  if (!value) return "N/A";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return `${date.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })} CT`;
};

const centsText = (cents: number | null | undefined) => {
  if (cents == null) return "N/A";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const featureLabel = (key: string) => key
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/\bOps\b/g, "OPS")
  .replace(/\bObp\b/g, "OBP")
  .replace(/\bSlg\b/g, "SLG")
  .replace(/\bEra\b/g, "ERA")
  .replace(/\bFip\b/g, "FIP")
  .replace(/\bSwx FIP\b/g, "swxFIP")
  .replace(/\bSw FIP\b/g, "swFIP")
  .replace(/\bSiera\b/g, "SIERA")
  .replace(/\bHr\/9\b/g, "HR/9")
  .replace(/\bIl\b/g, "IL")
  .replace(/\bMlb\b/g, "MLB");

const featureValueText = (value: unknown): string => {
  if (value == null || value === "") return "N/A";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(featureValueText).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

type PodcastPickRow = {
  id: string;
  selectedTeam: string;
  publishedFor: string;
  score: number | string | null;
  confidence: number | string | null;
  reasons: string[] | null;
  features: Record<string, unknown> | null;
  explanation: string | null;
  lockedAt: string | null;
  wagerId: string | null;
  modelVersion: string | null;
  lockedOddsAmerican: number | null;
  lockedSpread: string | null;
  lockedLineCapturedAt: string | null;
  closingOddsAmerican: number | null;
  closingSpread: string | null;
  closingCapturedAt: string | null;
  wagerStatus: string | null;
  stakeCents: number | null;
  potentialReturnCents: number | null;
  sport: string;
  league: string;
  startsAt: string;
  homeTeam: string;
  awayTeam: string;
  spread: string;
  oddsAmerican: number;
  marketKey: string;
};

const buildPodcastMarkdown = (date: string, picks: PodcastPickRow[]) => {
  const generatedAt = podcastDateTime(new Date());
  const lines = [
    `# StakeWars Chine Podcast Prep - ${date}`,
    "",
    `Generated: ${generatedAt}`,
    `Picks found: ${picks.length}`,
    "",
    "Use this as a prep file for podcast notes. It includes the stored Chine pick, wager state, model explanation, reasons, and all captured model features for each game.",
    ""
  ];

  if (picks.length === 0) {
    lines.push("No Chine picks were found for this date.");
    return lines.join("\n");
  }

  picks.forEach((pick, index) => {
    const confidence = pick.confidence == null ? "N/A" : `${Math.round(Number(pick.confidence) * 100)}%`;
    const score = pick.score == null ? "N/A" : Number(pick.score).toFixed(4);
    const features = pick.features ?? {};
    const edge = featureValueText(features.edge);
    const fairProbability = featureValueText(features.fairProbability);
    const impliedProbability = featureValueText(features.impliedProbability);
    const pickLine = pick.marketKey === "h2h"
      ? `${pick.selectedTeam} ML (${pick.oddsAmerican > 0 ? "+" : ""}${pick.oddsAmerican})`
      : `${pick.selectedTeam} ${pick.spread} (${pick.oddsAmerican > 0 ? "+" : ""}${pick.oddsAmerican})`;

    lines.push(
      `## ${index + 1}. ${pick.awayTeam} at ${pick.homeTeam}`,
      "",
      `- Sport/League: ${pick.sport} / ${pick.league}`,
      `- Start: ${podcastDateTime(pick.startsAt)}`,
      `- Pick: ${pickLine}`,
      `- Confidence: ${confidence}`,
      `- Model score: ${score}`,
      `- Model edge: ${edge}`,
      `- Fair probability: ${fairProbability}`,
      `- Implied probability: ${impliedProbability}`,
      `- Wager status: ${pick.wagerId ? pick.wagerStatus ?? "pending" : "not wagered"}`,
      `- Stake: ${centsText(pick.stakeCents)}`,
      `- Potential return: ${centsText(pick.potentialReturnCents)}`,
      `- Locked at: ${podcastDateTime(pick.lockedAt)}`,
      `- Current line: spread ${pick.spread}, odds ${pick.oddsAmerican > 0 ? "+" : ""}${pick.oddsAmerican}`,
      `- Locked line: spread ${pick.lockedSpread ?? "N/A"}, odds ${pick.lockedOddsAmerican == null ? "N/A" : `${pick.lockedOddsAmerican > 0 ? "+" : ""}${pick.lockedOddsAmerican}`}`,
      `- Closing line: spread ${pick.closingSpread ?? "N/A"}, odds ${pick.closingOddsAmerican == null ? "N/A" : `${pick.closingOddsAmerican > 0 ? "+" : ""}${pick.closingOddsAmerican}`}`,
      `- Model version: ${pick.modelVersion ?? "N/A"}`,
      "",
      "### Chine Explanation",
      "",
      pick.explanation?.trim() || "No generated explanation was stored for this pick.",
      "",
      "### Model Reasons",
      ""
    );
    const reasons = pick.reasons ?? [];
    if (reasons.length > 0) {
      reasons.forEach((reason) => lines.push(`- ${reason}`));
    } else {
      lines.push("- No reason labels were stored.");
    }

    lines.push("", "### Captured Model Features", "", "| Feature | Value |", "|---|---|");
    Object.entries(features)
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([key, value]) => {
        lines.push(`| ${markdownEscape(featureLabel(key))} | ${markdownEscape(featureValueText(value))} |`);
      });
    lines.push("");
  });

  return lines.join("\n");
};

const yyyyMmDd = (date: Date) => date.toISOString().slice(0, 10);

const addDays = (date: string, days: number) => {
  const copy = new Date(`${date}T00:00:00Z`);
  copy.setUTCDate(copy.getUTCDate() + days);
  return yyyyMmDd(copy);
};

const isInContestWeek = (startsAt: Date, weekStart: string) => {
  const startsOn = centralDate(startsAt);
  return startsOn >= weekStart && startsOn < addDays(weekStart, 7);
};

const currentSurvivorWeekStart = (pool: { startsOn: string }) => {
  const weekStart = currentWeekStart();
  return weekStart < pool.startsOn ? pool.startsOn : weekStart;
};

const contestPrizePerRegisteredPlayerCents = 3_000;

const getActiveSurvivorPool = async () => {
  const result = await query<{
    id: string;
    name: string;
    season: number;
    status: "active" | "completed" | "archived";
    startsOn: string;
  }>(
    `
      SELECT id, name, season, status, starts_on::text AS "startsOn"
      FROM survivor_pool
      WHERE status = 'active'
      ORDER BY starts_on DESC
      LIMIT 1
    `
  );
  return result.rows[0] ?? null;
};

const getActiveNflConfidencePool = async () => {
  const result = await query<{
    id: string;
    name: string;
    season: number;
    startsOn: string;
    weeklyPrizeCents: number;
    seasonWinnerPrizeCents: number;
    seasonRunnerUpPrizeCents: number;
    seasonThirdPlacePrizeCents: number;
  }>(
    `
      SELECT
        id,
        name,
        season,
        starts_on::text AS "startsOn",
        weekly_prize_cents AS "weeklyPrizeCents",
        season_winner_prize_cents AS "seasonWinnerPrizeCents",
        season_runner_up_prize_cents AS "seasonRunnerUpPrizeCents",
        season_third_place_prize_cents AS "seasonThirdPlacePrizeCents"
      FROM nfl_confidence_pool
      WHERE status = 'active'
      ORDER BY starts_on DESC
      LIMIT 1
    `
  );
  return result.rows[0] ?? null;
};

const countContestEntries = async (tableName: "nfl_confidence_entry" | "survivor_entry", poolId: string) => {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${tableName} WHERE pool_id = $1`,
    [poolId]
  );
  return Number(result.rows[0]?.count ?? 0);
};

const nflConfidencePoolWithDynamicPrize = async (pool: NonNullable<Awaited<ReturnType<typeof getActiveNflConfidencePool>>>) => {
  const registeredPlayers = await countContestEntries("nfl_confidence_entry", pool.id);
  const prizePoolCents = registeredPlayers * contestPrizePerRegisteredPlayerCents;
  return {
    ...pool,
    seasonWinnerPrizeCents: Math.round(prizePoolCents * 0.6),
    seasonRunnerUpPrizeCents: Math.round(prizePoolCents * 0.25),
    seasonThirdPlacePrizeCents: Math.round(prizePoolCents * 0.15),
    registeredPlayers,
    prizePoolCents
  };
};

const survivorPoolWithDynamicPrize = async (pool: NonNullable<Awaited<ReturnType<typeof getActiveSurvivorPool>>>) => {
  const registeredPlayers = await countContestEntries("survivor_entry", pool.id);
  const prizePoolCents = registeredPlayers * contestPrizePerRegisteredPlayerCents;
  return {
    ...pool,
    registeredPlayers,
    prizePoolCents
  };
};

type EspnNflScoreboardResponse = {
  events?: Array<{
    id: string;
    date: string;
    competitions?: Array<{
      status?: {
        type?: {
          completed?: boolean;
          state?: string;
          name?: string;
        };
      };
      competitors?: Array<{
        homeAway?: "home" | "away";
        score?: string;
        team?: {
          displayName?: string;
          name?: string;
          shortDisplayName?: string;
        };
      }>;
    }>;
  }>;
};

const fetchEspnNflWeek = async (season: number, week: number) => {
  const url = new URL("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
  url.searchParams.set("year", String(season));
  url.searchParams.set("seasontype", "2");
  url.searchParams.set("week", String(week));
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { headers: { "accept": "*/*", "user-agent": "curl/8.0.1" } });
  if (!response.ok) {
    throw new Error(`ESPN NFL schedule failed with ${response.status}`);
  }
  return (await response.json()) as EspnNflScoreboardResponse;
};

const ensureNflConfidenceWeekGames = async (pool: { id: string; season: number }, week: number) => {
  const existing = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM nfl_confidence_game WHERE pool_id = $1 AND week = $2",
    [pool.id, week]
  );
  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    return;
  }

  const scoreboard = await fetchEspnNflWeek(pool.season, week);
  await transaction(async (client) => {
    for (const event of scoreboard.events ?? []) {
      const competition = event.competitions?.[0];
      const home = competition?.competitors?.find((competitor) => competitor.homeAway === "home");
      const away = competition?.competitors?.find((competitor) => competitor.homeAway === "away");
      const homeTeam = home?.team?.displayName ?? home?.team?.name ?? home?.team?.shortDisplayName;
      const awayTeam = away?.team?.displayName ?? away?.team?.name ?? away?.team?.shortDisplayName;
      const startsAt = new Date(event.date);
      if (!event.id || !homeTeam || !awayTeam || Number.isNaN(startsAt.getTime())) {
        continue;
      }
      const weekStart = currentWeekStart(startsAt);
      await client.query(
        `
          INSERT INTO nfl_confidence_game (
            id, pool_id, season, week, week_start, provider_event_id, starts_at, away_team, home_team
          )
          VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)
          ON CONFLICT (pool_id, provider_event_id) DO UPDATE
          SET starts_at = EXCLUDED.starts_at,
              away_team = EXCLUDED.away_team,
              home_team = EXCLUDED.home_team,
              updated_at = now()
        `,
        [randomUUID(), pool.id, pool.season, week, weekStart, event.id, startsAt, awayTeam, homeTeam]
      );
    }
  });
};

const currentNflConfidenceWeek = async (pool: { id: string; season: number; startsOn: string }) => {
  const today = centralDate();
  if (today < pool.startsOn) {
    return 1;
  }
  const upcoming = await query<{ week: number }>(
    `
      SELECT week
      FROM nfl_confidence_game
      WHERE pool_id = $1
        AND starts_at >= now() - interval '12 hours'
      ORDER BY week ASC, starts_at ASC
      LIMIT 1
    `,
    [pool.id]
  );
  return upcoming.rows[0]?.week ?? 1;
};

const survivorVisiblePickTeam = (startsAt: Date, selectedTeam: string, isCurrentUser: boolean, isAdmin = false) =>
  isCurrentUser || isAdmin || startsAt.getTime() <= Date.now() ? selectedTeam : null;

const survivorPickStatusForResult = (selectedTeam: string, result: { away_team: string; home_team: string; away_score: number; home_score: number }) => {
  if (result.away_score === result.home_score) return "tie" as const;
  const winner = result.away_score > result.home_score ? result.away_team : result.home_team;
  return selectedTeam === winner ? "won" as const : "lost" as const;
};

const settleSurvivorPickById = async (
  pickId: string,
  status: "won" | "lost" | "tie" | "void",
  adminUserId?: string,
  note?: string
) => {
  return transaction(async (client) => {
    const pick = await client.query<{
      id: string;
      entry_id: string;
      status: "pending" | "won" | "lost" | "tie" | "no_pick" | "void";
    }>(
      "SELECT id, entry_id, status FROM survivor_pick WHERE id = $1 FOR UPDATE",
      [pickId]
    );
    const row = pick.rows[0];
    if (!row) return null;

    await client.query(
      `
        UPDATE survivor_pick
        SET status = $2,
            settled_at = now(),
            admin_overridden_by = COALESCE($3, admin_overridden_by),
            admin_note = COALESCE($4, admin_note),
            updated_at = now()
        WHERE id = $1
      `,
      [pickId, status, adminUserId ?? null, note ?? null]
    );

    if (status === "lost" || status === "tie") {
      await client.query(
        `
          UPDATE survivor_entry
          SET status = 'eliminated',
              eliminated_week_start = COALESCE(eliminated_week_start, (
                SELECT week_start FROM survivor_pick WHERE id = $1
              )),
              updated_at = now()
          WHERE id = $2
        `,
        [pickId, row.entry_id]
      );
    }

    return { id: pickId, status };
  });
};

const normalizeMlbTeamName = (team: string) =>
  team
    .toLowerCase()
    .replace(/^(oakland|the)\s+/, "")
    .replace(/\bathletics\b/, "athletics")
    .replace(/[^a-z0-9]+/g, "");

const providerEventBase = (providerEventId: string | null | undefined) =>
  providerEventId?.split(":")[0]?.split("|")[0] ?? null;

const footballTeamAliases: Record<string, string> = {
  "miami fl": "miami florida",
  "miami florida hurricanes": "miami florida",
  "miami oh": "miami ohio",
  "miami oh redhawks": "miami ohio",
  "massachusetts": "umass",
  "massachusetts minutemen": "umass",
  "umass minutemen": "umass",
  "u albany": "albany",
  "ualbany": "albany",
  "albany great danes": "albany",
  "buffalo bulls": "buffalo",
  "rutgers scarlet knights": "rutgers",
  "wake forest demon deacons": "wake forest",
  "delaware fighting blue hens": "delaware",
  "delaware fightin blue hens": "delaware",
  "colorado buffaloes": "colorado",
  "georgia tech yellow jackets": "georgia tech",
  "minnesota golden gophers": "minnesota",
  "west virginia mountaineers": "west virginia",
  "wv mountaineers": "west virginia",
  "connecticut": "uconn",
  "uconn huskies": "uconn",
  "usc trojans": "usc",
  "pittsburgh panthers": "pittsburgh",
  "cincinnati bearcats": "cincinnati",
  "houston cougars": "houston"
};

const normalizeFootballTeamKey = (team: string) => {
  const normalized = team
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bst\.?\b/g, "state")
    .replace(/\bu\s+/g, "u")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return footballTeamAliases[normalized] ?? normalized;
};

const footballEventKey = (row: {
  sport: string;
  startsAt: Date;
  awayTeam: string;
  homeTeam: string;
}) => {
  const roundedStart = new Date(row.startsAt);
  roundedStart.setUTCMinutes(Math.floor(roundedStart.getUTCMinutes() / 5) * 5, 0, 0);
  return [
    row.sport,
    roundedStart.toISOString(),
    normalizeFootballTeamKey(row.awayTeam),
    normalizeFootballTeamKey(row.homeTeam)
  ].join(":");
};

const gameEventKey = (row: {
  providerEventId: string | null;
  sport: string;
  startsAt: Date;
  awayTeam: string;
  homeTeam: string;
  marketKey?: string;
}) => row.sport === "NFL" || row.sport === "NCAAF"
  ? footballEventKey(row)
  : providerEventBase(row.providerEventId)
    ?? `${row.sport}:${row.startsAt.toISOString()}:${row.awayTeam}:${row.homeTeam}`;

const findMlbPitcherFallback = (
  game: { startsAt: string; awayTeam: string; homeTeam: string },
  fallbacks: MlbProbablePitcherFallback[]
) => {
  const away = normalizeMlbTeamName(game.awayTeam);
  const home = normalizeMlbTeamName(game.homeTeam);
  const startsAt = new Date(game.startsAt).getTime();
  const sameTeams = fallbacks
    .filter((candidate) =>
      normalizeMlbTeamName(candidate.awayTeam) === away
      && normalizeMlbTeamName(candidate.homeTeam) === home
    )
    .map((candidate) => ({
      candidate,
      delta: Math.abs(new Date(candidate.startsAt).getTime() - startsAt)
    }))
    .sort((left, right) => left.delta - right.delta);

  return sameTeams[0]?.delta <= 12 * 60 * 60 * 1000 ? sameTeams[0].candidate : null;
};

const createVerificationToken = async (userId: string, email: string) => {
  const tokenSecret = randomBytes(32).toString("base64url");
  const tokenHash = await hashPassword(tokenSecret);
  await transaction(async (client) => {
    await client.query(
      "UPDATE email_verification_code SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
      [userId]
    );
    await client.query(
      `
        INSERT INTO email_verification_code (id, user_id, email, code_hash, expires_at)
        VALUES ($1, $2, $3, $4, now() + interval '24 hours')
      `,
      [randomUUID(), userId, email, tokenHash]
    );
  });
  return `${userId}.${tokenSecret}`;
};

const createEmailChangeRecoveryToken = async (userId: string, oldEmail: string, newEmail: string) => {
  const tokenSecret = randomBytes(32).toString("base64url");
  const tokenHash = await hashPassword(tokenSecret);
  await transaction(async (client) => {
    await client.query(
      "UPDATE email_change_recovery SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
      [userId]
    );
    await client.query(
      `
        INSERT INTO email_change_recovery (id, user_id, old_email, new_email, token_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')
      `,
      [randomUUID(), userId, oldEmail, newEmail, tokenHash]
    );
  });
  return `${userId}.${tokenSecret}`;
};

const consumeEmailChangeRecoveryTokens = async (userId: string) => {
  await query(
    "UPDATE email_change_recovery SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
    [userId]
  );
};

const welcomeText = (verifyUrl: string) => [
  "Hey there!",
  "",
  "Welcome to StakeWars! 🎉",
  "",
  "You're officially part of the competition.",
  "",
  "Every week, you'll battle other players—and Chine, our autonomous AI picking games daily—for leaderboard bragging rights and real rewards.",
  "",
  "Before you can claim prizes, we need to verify that this email address belongs to you.",
  "",
  "Click the link below to verify your email:",
  "",
  verifyUrl,
  "",
  "---",
  "",
  "Why verify?",
  "",
  "Verifying your email helps us:",
  "",
  "* Secure your account",
  "* Send important account notifications",
  "* Confirm your eligibility for cash prizes and other rewards",
  "",
  "Unverified accounts can still browse the site, but you must verify your email before you're eligible to receive prizes.",
  "",
  "---",
  "",
  "Ready to compete?",
  "",
  "Once you're verified, you'll be able to:",
  "",
  "🏆 Climb the weekly leaderboard",
  "🤖 Try to Beat Chine, our autonomous AI competitor",
  "💵 Compete for cash prizes and special rewards",
  "🎟️ Win exclusive giveaways and event prizes",
  "",
  "The StakeWars are heating up—we're excited to have you with us!",
  "",
  "See you on the leaderboard,",
  "",
  "The StakeWars Team",
  "",
  "https://stakewars.ai",
  "",
  "---",
  "",
  "If you didn't create a StakeWars account, you can safely ignore this email."
].join("\n");

const welcomeHtml = (verifyUrl: string) => {
  const escapedUrl = htmlEscape(verifyUrl);
  return [
    "<div style=\"font-family:Arial,Helvetica,sans-serif;line-height:1.55;color:#171717;max-width:640px;margin:0 auto;\">",
    "<p>Hey there!</p>",
    "<p>Welcome to <strong>StakeWars</strong>! 🎉</p>",
    "<p>You're officially part of the competition.</p>",
    "<p>Every week, you'll battle other players—and <strong>Chine</strong>, our autonomous AI picking games daily—for leaderboard bragging rights and real rewards.</p>",
    "<p>Before you can claim prizes, we need to verify that this email address belongs to you.</p>",
    "<p><strong>Click the button below to verify your email:</strong></p>",
    `<p><a href="${escapedUrl}" style="display:inline-block;background:#f97316;color:#111827;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:6px;">Verify Email</a></p>`,
    "<p>Or copy and paste this link into your browser:</p>",
    `<p><a href="${escapedUrl}">${escapedUrl}</a></p>`,
    "<hr />",
    "<h3>Why verify?</h3>",
    "<p>Verifying your email helps us:</p>",
    "<ul>",
    "<li>Secure your account</li>",
    "<li>Send important account notifications</li>",
    "<li>Confirm your eligibility for cash prizes and other rewards</li>",
    "</ul>",
    "<p>Unverified accounts can still browse the site, but <strong>you must verify your email before you're eligible to receive prizes.</strong></p>",
    "<hr />",
    "<h3>Ready to compete?</h3>",
    "<p>Once you're verified, you'll be able to:</p>",
    "<p>🏆 Climb the weekly leaderboard</p>",
    "<p>🤖 Try to <strong>Beat Chine</strong>, our autonomous AI competitor</p>",
    "<p>💵 Compete for cash prizes and special rewards</p>",
    "<p>🎟️ Win exclusive giveaways and event prizes</p>",
    "<p>The StakeWars are heating up—we're excited to have you with us!</p>",
    "<p>See you on the leaderboard,</p>",
    "<p><strong>The StakeWars Team</strong></p>",
    "<p><a href=\"https://stakewars.ai\">https://stakewars.ai</a></p>",
    "<hr />",
    "<p><small>If you didn't create a StakeWars account, you can safely ignore this email.</small></p>",
    "</div>"
  ].join("");
};

const sendVerificationLinkWithToken = async (userId: string, email: string, token: string, welcome = false) => {
  const verifyUrl = `${publicAppOrigin()}/?verifyEmail=${encodeURIComponent(token)}`;
  const result = await sendMail({
    to: [{ email }],
    subject: welcome ? "Welcome to StakeWars - verify your email" : "Verify your StakeWars email",
    text: welcome ? welcomeText(verifyUrl) : [
      "Verify your StakeWars email by opening this link:",
      "",
      verifyUrl,
      "",
      "This link expires in 24 hours. If you did not request this email, you can ignore it."
    ].join("\n"),
    html: welcome ? welcomeHtml(verifyUrl) : [
      "<p>Verify your StakeWars email by clicking the button below:</p>",
      `<p><a href="${htmlEscape(verifyUrl)}" style="display:inline-block;background:#f97316;color:#111827;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:6px;">Verify Email</a></p>`,
      `<p>Or copy and paste this link into your browser:<br /><a href="${htmlEscape(verifyUrl)}">${htmlEscape(verifyUrl)}</a></p>`,
      "<p>This link expires in 24 hours. If you did not request this email, you can ignore it.</p>"
    ].join("")
  });
  console.info("Email verification link sent", {
    userId,
    email,
    accepted: result.accepted
  });
};

const sendVerificationLink = async (userId: string, email: string, welcome = false) => {
  const token = await createVerificationToken(userId, email);
  await sendVerificationLinkWithToken(userId, email, token, welcome);
};

const sendEmailChangeRecoveryNoticeWithToken = async (userId: string, oldEmail: string, newEmail: string, token: string) => {
  const recoveryUrl = `${publicAppOrigin()}/?emailRecovery=${encodeURIComponent(token)}`;
  const result = await sendMail({
    to: [{ email: oldEmail }],
    subject: "StakeWars email change requested",
    text: [
      "A request was made to change the email address on your StakeWars account.",
      "",
      `Original email: ${oldEmail}`,
      `New email: ${newEmail}`,
      "",
      "If this was you, no action is needed.",
      "",
      "If this was not you, use the recovery link below within 24 hours. You will be required to set a new password, the original email will remain verified, and the new email change will be discarded.",
      "",
      recoveryUrl,
      "",
      "If you do not use this link within 24 hours, it will expire."
    ].join("\n"),
    html: [
      "<p>A request was made to change the email address on your StakeWars account.</p>",
      `<p><strong>Original email:</strong> ${htmlEscape(oldEmail)}<br /><strong>New email:</strong> ${htmlEscape(newEmail)}</p>`,
      "<p>If this was you, no action is needed.</p>",
      "<p>If this was not you, use the recovery link below within 24 hours. You will be required to set a new password, the original email will remain verified, and the new email change will be discarded.</p>",
      `<p><a href="${htmlEscape(recoveryUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:6px;">This was not me</a></p>`,
      `<p>Or copy and paste this link into your browser:<br /><a href="${htmlEscape(recoveryUrl)}">${htmlEscape(recoveryUrl)}</a></p>`,
      "<p><small>If you do not use this link within 24 hours, it will expire.</small></p>"
    ].join("")
  });
  console.info("Email change recovery notice sent", {
    userId,
    oldEmail,
    newEmail,
    accepted: result.accepted
  });
};

const sendEmailChangeRecoveryNotice = async (userId: string, oldEmail: string, newEmail: string) => {
  const token = await createEmailChangeRecoveryToken(userId, oldEmail, newEmail);
  await sendEmailChangeRecoveryNoticeWithToken(userId, oldEmail, newEmail, token);
};

const sessionUserSelect = `
  id,
  username,
  full_name AS "fullName",
  email,
  email_verified AS "emailVerified",
  display_name AS "displayName",
  reward_balance_cents AS "rewardBalanceCents",
  payout_method AS "payoutMethod",
  payout_handle AS "payoutHandle",
  phone_last4 AS "phoneLast4",
  role
`;

const bonusOptionsFromText = (bonus: string | null) => {
  if (!bonus) {
    return [];
  }
  const trimmed = bonus.trim();
  const withoutPrefix = trimmed.replace(/^.*?\b(?:wins?|gets?|receives?)\s+(?:a\s+|an\s+)?/i, "");
  const options = withoutPrefix
    .split(/\s+or\s+|\s*\/\s*|,/i)
    .map((option) => option.trim().replace(/^(?:a|an)\s+/i, ""))
    .filter(Boolean);
  if (options.length <= 1) {
    return [trimmed];
  }
  const firstOptionParts = options[0].split(/\s+/);
  const sharedPrefix = firstOptionParts.length > 1 ? firstOptionParts.slice(0, -1).join(" ") : "";
  return options.map((option, index) => {
    if (index === 0 || !sharedPrefix || option.toLowerCase().startsWith(`${sharedPrefix.toLowerCase()} `)) {
      return option;
    }
    return `${sharedPrefix} ${option}`;
  });
};

const bonusSizeOptions = ["S", "M", "L", "XL", "2XL", "3XL"];

const bonusRequiresSize = (selection: string) =>
  /\bpolo\b/i.test(selection);

type RewardFulfillmentEmailInput = {
  playerName: string;
  username: string;
  weekStart: string;
  rewardText: string;
  bonusSelection: string;
  bonusSize: string | null;
  shippingName: string;
  shippingAddressLine1: string;
  shippingAddressLine2: string | null;
  shippingCity: string;
  shippingRegion: string;
  shippingPostalCode: string;
  shippingCountry: string;
};

const rewardFulfillmentEmailBody = (input: RewardFulfillmentEmailInput) => {
  const addressLines = [
    input.shippingName,
    input.shippingAddressLine1,
    input.shippingAddressLine2,
    `${input.shippingCity}, ${input.shippingRegion} ${input.shippingPostalCode}`,
    input.shippingCountry
  ].filter((line): line is string => Boolean(line?.trim()));
  const text = [
    "A StakeWars special reward was selected.",
    "",
    `Player: ${input.playerName} (${input.username})`,
    `Week: ${input.weekStart}`,
    `Reward: ${input.rewardText}`,
    `Selection: ${input.bonusSelection}`,
    ...(input.bonusSize ? [`Size: ${input.bonusSize}`] : []),
    "",
    "Shipping address:",
    ...addressLines
  ].join("\n");
  const html = [
    "<p>A StakeWars special reward was selected.</p>",
    "<ul>",
    `<li><strong>Player:</strong> ${htmlEscape(input.playerName)} (${htmlEscape(input.username)})</li>`,
    `<li><strong>Week:</strong> ${htmlEscape(input.weekStart)}</li>`,
    `<li><strong>Reward:</strong> ${htmlEscape(input.rewardText)}</li>`,
    `<li><strong>Selection:</strong> ${htmlEscape(input.bonusSelection)}</li>`,
    ...(input.bonusSize ? [`<li><strong>Size:</strong> ${htmlEscape(input.bonusSize)}</li>`] : []),
    "</ul>",
    "<p><strong>Shipping address:</strong><br />",
    addressLines.map((line) => htmlEscape(line)).join("<br />"),
    "</p>"
  ].join("");
  return { text, html };
};

type RewardFulfilledEmailInput = {
  playerName: string;
  rewardText: string;
  bonusSelection: string;
  bonusSize: string | null;
  message: string;
};

const rewardFulfilledEmailBody = (input: RewardFulfilledEmailInput) => {
  const rewardLines = [
    input.bonusSelection,
    input.bonusSize ? `Size: ${input.bonusSize}` : null
  ].filter((line): line is string => Boolean(line));
  const text = [
    `Hi ${input.playerName},`,
    "",
    "Your StakeWars special reward has been fulfilled.",
    "",
    `Reward: ${input.rewardText}`,
    ...rewardLines,
    "",
    input.message,
    "",
    "Thanks for playing StakeWars.",
    "https://stakewars.ai"
  ].join("\n");
  const html = [
    `<p>Hi ${htmlEscape(input.playerName)},</p>`,
    "<p>Your StakeWars special reward has been fulfilled.</p>",
    "<ul>",
    `<li><strong>Reward:</strong> ${htmlEscape(input.rewardText)}</li>`,
    ...rewardLines.map((line) => `<li>${htmlEscape(line)}</li>`),
    "</ul>",
    `<p>${htmlEscape(input.message).replace(/\n/g, "<br />")}</p>`,
    "<p>Thanks for playing StakeWars.<br /><a href=\"https://stakewars.ai\">stakewars.ai</a></p>"
  ].join("");
  return { text, html };
};

type RewardWithdrawalEmailInput = {
  displayName: string;
  username: string;
  email: string | null;
  amountCents: number;
  payoutMethod: string;
  payoutHandle: string;
  phoneLast4: string;
  requestedAt: string;
};

const rewardWithdrawalEmailBody = (input: RewardWithdrawalEmailInput) => {
  const amount = `$${(input.amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const text = [
    "A StakeWars reward withdrawal was requested.",
    "",
    `Player: ${input.displayName} (${input.username})`,
    `Email: ${input.email ?? "Not provided"}`,
    `Amount: ${amount}`,
    `Payout method: ${input.payoutMethod}`,
    `Payout handle: ${input.payoutHandle}`,
    `Phone last 4: ${input.phoneLast4}`,
    `Requested: ${input.requestedAt}`
  ].join("\n");
  const html = [
    "<p>A StakeWars reward withdrawal was requested.</p>",
    "<ul>",
    `<li><strong>Player:</strong> ${htmlEscape(input.displayName)} (${htmlEscape(input.username)})</li>`,
    `<li><strong>Email:</strong> ${htmlEscape(input.email ?? "Not provided")}</li>`,
    `<li><strong>Amount:</strong> ${htmlEscape(amount)}</li>`,
    `<li><strong>Payout method:</strong> ${htmlEscape(input.payoutMethod)}</li>`,
    `<li><strong>Payout handle:</strong> ${htmlEscape(input.payoutHandle)}</li>`,
    `<li><strong>Phone last 4:</strong> ${htmlEscape(input.phoneLast4)}</li>`,
    `<li><strong>Requested:</strong> ${htmlEscape(input.requestedAt)}</li>`,
    "</ul>"
  ].join("");
  return { text, html };
};

type RewardWithdrawalFulfilledEmailInput = {
  playerName: string;
  amountCents: number;
  payoutMethod: string;
  payoutHandle: string;
};

const rewardWithdrawalFulfilledEmailBody = (input: RewardWithdrawalFulfilledEmailInput) => {
  const amount = `$${(input.amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const text = [
    `Hi ${input.playerName},`,
    "",
    "Your StakeWars reward withdrawal has been fulfilled.",
    "",
    `Amount: ${amount}`,
    `Payout method: ${input.payoutMethod}`,
    `Payout handle: ${input.payoutHandle}`,
    "",
    "Thanks for playing StakeWars.",
    "https://stakewars.ai"
  ].join("\n");
  const html = [
    `<p>Hi ${htmlEscape(input.playerName)},</p>`,
    "<p>Your StakeWars reward withdrawal has been fulfilled.</p>",
    "<ul>",
    `<li><strong>Amount:</strong> ${htmlEscape(amount)}</li>`,
    `<li><strong>Payout method:</strong> ${htmlEscape(input.payoutMethod)}</li>`,
    `<li><strong>Payout handle:</strong> ${htmlEscape(input.payoutHandle)}</li>`,
    "</ul>",
    "<p>Thanks for playing StakeWars.<br /><a href=\"https://stakewars.ai\">stakewars.ai</a></p>"
  ].join("");
  return { text, html };
};

const verifyEmailSecret = async (userId: string, secret: string) => {
  const pending = await query<{
    id: string;
    email: string;
    codeHash: string;
    attempts: number;
  }>(
    `
      SELECT id, email, code_hash AS "codeHash", attempts
      FROM email_verification_code
      WHERE user_id = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId]
  );
  const record = pending.rows[0];
  if (!record || record.attempts >= 5) {
    return null;
  }

  const valid = await verifyPassword(secret, record.codeHash);
  if (!valid) {
    await query(
      "UPDATE email_verification_code SET attempts = attempts + 1 WHERE id = $1",
      [record.id]
    );
    return null;
  }

  const result = await transaction(async (client) => {
    await client.query(
      "UPDATE email_verification_code SET consumed_at = now() WHERE id = $1",
      [record.id]
    );
    return client.query(
      `
        UPDATE app_user
        SET email = $2,
            email_verified = true,
            email_verified_at = now()
        WHERE id = $1
        RETURNING ${sessionUserSelect}
      `,
      [userId, record.email]
    );
  });
  return result.rows[0] ?? null;
};

const verifyEmailToken = async (token: string) => {
  const [userId, tokenSecret] = token.split(".", 2);
  if (!userId || !tokenSecret || !z.string().uuid().safeParse(userId).success || tokenSecret.length < 32) {
    return null;
  }
  return verifyEmailSecret(userId, tokenSecret);
};

const recoverEmailChange = async (token: string, password: string) => {
  const [userId, tokenSecret] = token.split(".", 2);
  if (!userId || !tokenSecret || !z.string().uuid().safeParse(userId).success || tokenSecret.length < 32) {
    return null;
  }

  const pending = await query<{
    id: string;
    oldEmail: string;
    tokenHash: string;
  }>(
    `
      SELECT id, old_email AS "oldEmail", token_hash AS "tokenHash"
      FROM email_change_recovery
      WHERE user_id = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId]
  );
  const record = pending.rows[0];
  if (!record || !(await verifyPassword(tokenSecret, record.tokenHash))) {
    return null;
  }

  const passwordHash = await hashPassword(password);
  const result = await transaction(async (client) => {
    await client.query(
      "UPDATE email_change_recovery SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
      [userId]
    );
    await client.query(
      "UPDATE email_verification_code SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
      [userId]
    );
    return client.query(
      `
        UPDATE app_user
        SET email = $2,
            email_verified = true,
            email_verified_at = now(),
            password_hash = $3
        WHERE id = $1
        RETURNING ${sessionUserSelect}
      `,
      [userId, record.oldEmail, passwordHash]
    );
  });
  return result.rows[0] ?? null;
};

type LineMove = {
  oldGameLineId: string;
  newGameLineId: string;
  game: string;
  selectedTeam: string;
  marketKey: MarketKey;
  oldSpread: string;
  newSpread: string;
  oldOddsAmerican: number;
  newOddsAmerican: number;
};

class LineMoveError extends Error {
  body: {
    error: string;
    code: "LINE_MOVED";
    lineMoves: LineMove[];
  };

  constructor(lineMoves: LineMove[]) {
    super("Line changed");
    this.body = {
      error: "One or more selected lines have changed",
      code: "LINE_MOVED",
      lineMoves
    };
  }
}

class WagerValidationError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, code = "INVALID_WAGER", statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

class ReferralBoostDecisionRequiredError extends Error {
  body: {
    error: string;
    code: "REFERRAL_BOOST_DECISION_REQUIRED";
    availableBoosts: number;
    maxUsableBoosts: number;
    boostAmountCents: number;
  };

  constructor(availableBoosts: number, maxUsableBoosts: number) {
    super("Referral boost decision required");
    this.body = {
      error: "Referral boost decision required before first weekly wager",
      code: "REFERRAL_BOOST_DECISION_REQUIRED",
      availableBoosts,
      maxUsableBoosts,
      boostAmountCents: 100_000
    };
  }
}

const wagerMarketLabel = (marketKey: MarketKey) => {
  if (marketKey === "h2h") return "moneyline";
  if (marketKey === "totals") return "total";
  return "spread/run line";
};

const unavailableLineMessage = (line: WagerLineRow) =>
  `${line.away_team} @ ${line.home_team} ${line.favorite_team} ${wagerMarketLabel(line.market_key)} is no longer available`;

const sameGameKey = (line: Pick<WagerLineRow, "sport" | "away_team" | "home_team" | "starts_at">) =>
  `${line.sport}:${line.away_team}:${line.home_team}:${line.starts_at.toISOString()}`;

const createQualifiedReferralBoost = async (client: import("pg").PoolClient, referredUserId: string) => {
  await client.query(
    `
      INSERT INTO referral_bankroll_boost (id, referrer_user_id, referred_user_id)
      SELECT $1, referred.referred_by_user_id, referred.id
      FROM app_user referred
      WHERE referred.id = $2
        AND referred.referred_by_user_id IS NOT NULL
      ON CONFLICT (referred_user_id) DO NOTHING
    `,
    [randomUUID(), referredUserId]
  );
};

const applyReferralBoostDecision = async (
  client: import("pg").PoolClient,
  userId: string,
  weeklyEntryId: string,
  weekStart: string,
  decision: "use" | "waive" | undefined,
  requestedCount: number | undefined
) => {
  const activity = await client.query<{ wagers: string }>(
    "SELECT count(*)::text AS wagers FROM wager WHERE weekly_entry_id = $1",
    [weeklyEntryId]
  );
  const weeklyWagers = Number(activity.rows[0]?.wagers ?? 0);
  if (weeklyWagers > 0) {
    if (decision === "use") {
      throw new Error("Referral boosts must be used before your first wager of the week");
    }
    return { appliedBoosts: 0 };
  }

  const waiver = await client.query<{ id: string }>(
    "SELECT id FROM referral_boost_weekly_waiver WHERE user_id = $1 AND week_starts_on = $2::date LIMIT 1",
    [userId, weekStart]
  );
  if (waiver.rowCount) {
    if (decision === "use") {
      throw new Error("Referral boosts were already waived for this week");
    }
    return { appliedBoosts: 0 };
  }

  const available = await client.query<{ id: string; amount_cents: number }>(
    `
      SELECT id, amount_cents
      FROM referral_bankroll_boost
      WHERE referrer_user_id = $1
        AND status = 'earned'
      ORDER BY earned_at ASC
      FOR UPDATE
    `,
    [userId]
  );
  const weeklyUsed = await client.query<{ used: string }>(
    `
      SELECT count(*)::text AS used
      FROM referral_bankroll_boost
      WHERE referrer_user_id = $1
        AND status = 'used'
        AND used_week_starts_on = $2::date
    `,
    [userId, weekStart]
  );
  const remainingWeeklySlots = Math.max(0, 2 - Number(weeklyUsed.rows[0]?.used ?? 0));
  const maxUsableBoosts = Math.min(available.rows.length, remainingWeeklySlots);
  if (maxUsableBoosts <= 0) {
    return { appliedBoosts: 0 };
  }

  if (!decision) {
    throw new ReferralBoostDecisionRequiredError(available.rows.length, maxUsableBoosts);
  }

  if (decision === "waive") {
    await client.query(
      `
        INSERT INTO referral_boost_weekly_waiver (id, user_id, week_starts_on)
        VALUES ($1, $2, $3::date)
        ON CONFLICT (user_id, week_starts_on) DO NOTHING
      `,
      [randomUUID(), userId, weekStart]
    );
    return { appliedBoosts: 0 };
  }

  const count = requestedCount ?? 1;
  if (count < 1 || count > maxUsableBoosts) {
    throw new Error(`Select 1${maxUsableBoosts > 1 ? `-${maxUsableBoosts}` : ""} referral boost${maxUsableBoosts === 1 ? "" : "s"}`);
  }
  const selected = available.rows.slice(0, count);
  const totalBoostCents = selected.reduce((sum, boost) => sum + boost.amount_cents, 0);
  await client.query(
    `
      UPDATE referral_bankroll_boost
      SET status = 'used',
          used_week_starts_on = $2::date,
          used_at = now()
      WHERE id = ANY($1::uuid[])
    `,
    [selected.map((boost) => boost.id), weekStart]
  );
  await client.query("UPDATE weekly_entry SET balance_cents = balance_cents + $1 WHERE id = $2", [
    totalBoostCents,
    weeklyEntryId
  ]);
  return { appliedBoosts: count };
};

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

const supportCategorySchema = z.enum([
  "account_email",
  "rewards_eligibility",
  "picks_scoring",
  "technical_problem",
  "other"
]);

const supportConversationSchema = z.object({
  category: supportCategorySchema,
  message: z.string().trim().min(1).max(2000).optional()
});

const supportMessageSchema = z.object({
  body: z.string().trim().min(1).max(2000)
});

const supportStatusSchema = z.object({
  status: z.enum(["open", "closed"]),
  sendTranscript: z.boolean().default(false)
});

const merchStoreClickSchema = z.object({
  source: z.string().trim().min(1).max(80).default("nav")
});

const isAdminUser = (user: Express.Request["user"]) => Boolean(
  user
  && (user.role === "admin" || config.adminUsernames.includes(user.username.toLowerCase()))
);

const isNateRakelAccount = (user: Express.Request["user"]) => Boolean(
  user && isStakeWarsOwnerUsername(user.username)
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

const requireNateRakelAccount = (
  req: Parameters<typeof requireAuth>[0],
  res: Parameters<typeof requireAuth>[1],
  next: Parameters<typeof requireAuth>[2]
) => {
  requireAuth(req, res, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    if (!isNateRakelAccount(req.user)) {
      res.status(403).json({ error: "Nate Rakel account required" });
      return;
    }
    next();
  });
};

const logAdminAction = async (
  req: Parameters<typeof requireAuth>[0],
  action: string,
  metadata: Record<string, unknown> = {}
) => {
  try {
    await query(
      `
        INSERT INTO admin_audit_log (id, user_id, action, metadata, ip_address, user_agent)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      `,
      [
        randomUUID(),
        req.user?.id ?? null,
        action,
        JSON.stringify(metadata),
        req.ip,
        req.header("user-agent") ?? null
      ]
    );
  } catch (error) {
    console.error("Admin audit log failed", error);
  }
};

const supportCategoryLabel = (category: z.infer<typeof supportCategorySchema>) => {
  switch (category) {
    case "account_email": return "Account or email issue";
    case "rewards_eligibility": return "Rewards or eligibility";
    case "picks_scoring": return "Picks or scoring";
    case "technical_problem": return "Report a technical problem";
    case "other": return "Something else";
  }
};

const notifyNateOfSupportChat = async ({
  conversationId,
  displayName,
  username,
  category
}: {
  conversationId: string;
  displayName: string | null;
  username: string;
  category: z.infer<typeof supportCategorySchema>;
}) => {
  const result = await query<{ id: string }>(
    "SELECT id FROM app_user WHERE lower(username) = 'nathanielrakel@gmail.com' LIMIT 1"
  );
  const nateId = result.rows[0]?.id;
  if (!nateId) return;
  await sendPushToUsers([nateId], {
    title: "Live support chat opened",
    body: `${displayName || username} opened: ${supportCategoryLabel(category)}`,
    url: `/?page=admin&adminTab=support&conversation=${conversationId}`,
    tag: `support-chat:${conversationId}`,
    renotify: true,
    urgency: "high"
  });
};

const sendSupportTranscript = async (conversationId: string) => {
  const conversation = await query<{
    category: z.infer<typeof supportCategorySchema>;
    username: string;
    displayName: string | null;
    email: string | null;
    emailVerified: boolean;
  }>(
    `
      SELECT
        c.category,
        u.username,
        u.display_name AS "displayName",
        u.email,
        u.email_verified AS "emailVerified"
      FROM support_conversation c
      JOIN app_user u ON u.id = c.user_id
      WHERE c.id = $1
    `,
    [conversationId]
  );
  const target = conversation.rows[0];
  if (!target?.email || !target.emailVerified) {
    throw new Error("Conversation owner does not have a verified email address.");
  }
  const messages = await query<{
    senderRole: "user" | "admin";
    body: string;
    createdAt: string;
  }>(
    `
      SELECT sender_role AS "senderRole", body, created_at AS "createdAt"
      FROM support_message
      WHERE conversation_id = $1
      ORDER BY created_at ASC
    `,
    [conversationId]
  );
  const lines = [
    "StakeWars support chat transcript",
    "",
    `Topic: ${supportCategoryLabel(target.category)}`,
    `User: ${target.displayName || target.username}`,
    "",
    ...messages.rows.flatMap((message) => [
      `[${new Date(message.createdAt).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT] ${message.senderRole === "admin" ? "StakeWars Support" : target.displayName || target.username}:`,
      message.body,
      ""
    ])
  ];
  const htmlLines = messages.rows.map((message) => [
    `<p><strong>${message.senderRole === "admin" ? "StakeWars Support" : htmlEscape(target.displayName || target.username)}</strong>`,
    `<br /><small>${htmlEscape(new Date(message.createdAt).toLocaleString("en-US", { timeZone: "America/Chicago" }))} CT</small>`,
    `<br />${htmlEscape(message.body).replace(/\n/g, "<br />")}</p>`
  ].join(""));
  await sendMail({
    to: [{ email: target.email, name: target.displayName ?? undefined }],
    subject: "StakeWars support chat transcript",
    text: lines.join("\n"),
    html: [
      "<h2>StakeWars support chat transcript</h2>",
      `<p><strong>Topic:</strong> ${htmlEscape(supportCategoryLabel(target.category))}</p>`,
      ...htmlLines
    ].join("")
  });
};

export const registerRoutes = (router: Router) => {
  if (!config.towerEnabled) {
    router.use(["/tower", "/admin/tower"], (_req, res) => {
      res.status(404).json({ error: "Tower is not available." });
    });
  }

  router.get("/qr/:slug", async (req, res, next) => {
    try {
      const slug = qrCampaignSlugSchema.parse(req.params.slug);
      const origin = publicAppOrigin();
      const destinationUrl = `${origin}/?campaign=${encodeURIComponent(slug)}`;
      await query(
        `
          INSERT INTO qr_campaign_scan (
            id, campaign_slug, local_date, scanner_key, ip_address,
            user_agent, referrer, destination_url
          )
          VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
        `,
        [
          randomUUID(),
          slug,
          centralDate(),
          hashValue(`${req.ip}|${req.header("user-agent") ?? ""}`),
          req.ip,
          req.header("user-agent") ?? null,
          req.header("referer") ?? null,
          destinationUrl
        ]
      );
      res.redirect(302, destinationUrl);
    } catch (error) {
      next(error);
    }
  });

  router.get("/merch/store", async (_req, res, next) => {
    try {
      const item = merchNavItemForUser("public", config.merchStoreUrl);
      if (!item) {
        res.status(404).json({ error: "Merch store is not available." });
        return;
      }
      res.json({ url: item.url, label: item.label });
    } catch (error) {
      next(error);
    }
  });

  router.post("/merch/click", optionalAuth, async (req, res, next) => {
    try {
      const input = merchStoreClickSchema.parse(req.body);
      const item = merchNavItemForUser(req.user?.username ?? "public", config.merchStoreUrl);
      if (!item) {
        res.status(404).json({ error: "Merch store is not available." });
        return;
      }
      await query(
        `
          INSERT INTO merch_store_click (id, user_id, destination_url, source, ip_address, user_agent)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          randomUUID(),
          req.user?.id ?? null,
          item.url,
          input.source,
          req.ip,
          req.header("user-agent") ?? null
        ]
      );
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/register", async (req, res, next) => {
    try {
      const input = registerSchema.parse(req.body);
      const passwordHash = await hashPassword(input.password);
      const referralCode = await createUniqueReferralCode();
      const referrer = input.referralCode
        ? await query<{ id: string }>(
          "SELECT id FROM app_user WHERE referral_code = lower($1) LIMIT 1",
          [input.referralCode]
        )
        : null;
      const result = await query<{
        id: string;
        username: string;
        fullName: string | null;
        email: string | null;
        emailVerified: boolean;
        displayName: string | null;
        rewardBalanceCents: number;
        payoutMethod: "none";
        payoutHandle: string | null;
        phoneLast4: string | null;
        role: "player";
      }>(
        `
          INSERT INTO app_user (id, username, email, email_verified, password_hash, display_name, referral_code, referred_by_user_id)
          VALUES ($1, $2, $3, false, $4, $5, $6, $7)
          RETURNING ${sessionUserSelect}
        `,
        [randomUUID(), input.username, input.email, passwordHash, input.displayName, referralCode, referrer?.rows[0]?.id ?? null]
      );
      let emailVerificationSent = true;
      try {
        await sendVerificationLink(result.rows[0].id, input.email, true);
      } catch (error) {
        emailVerificationSent = false;
        console.error("Registration verification email failed; allowing unverified account login", {
          userId: result.rows[0].id,
          email: input.email,
          error
        });
      }
      const sessionUser = result.rows[0];
      res.status(201).json({
        token: signToken(sessionUser),
        user: sessionUser,
        emailVerificationSent,
        verificationRequired: !sessionUser.emailVerified
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const constraint = (error as { constraint?: string }).constraint;
        res.status(409).json({
          error: constraint === "app_user_display_name_unique_lower_idx"
            ? "Display name is already taken"
            : constraint === "app_user_email_unique_lower_idx"
              ? "Email is already registered"
            : "Username is already taken"
        });
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
        emailVerified: boolean;
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
            email_verified AS "emailVerified",
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
        emailVerified: user.emailVerified,
        displayName: user.displayName,
        rewardBalanceCents: user.rewardBalanceCents,
        payoutMethod: user.payoutMethod,
        payoutHandle: user.payoutHandle,
        phoneLast4: user.phoneLast4,
        role: user.role
      };
      let emailVerificationSent = false;
      if (!user.emailVerified && user.email) {
        try {
          await sendVerificationLink(user.id, user.email);
          emailVerificationSent = true;
        } catch (error) {
          console.error("Login verification email failed; allowing unverified account login", {
            userId: user.id,
            email: user.email,
            error
          });
        }
      }
      res.json({
        token: signToken(sessionUser),
        user: sessionUser,
        emailVerificationSent,
        verificationRequired: !sessionUser.emailVerified && Boolean(sessionUser.email)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/verify-email-link", async (req, res, next) => {
    try {
      const token = typeof req.query.token === "string" ? req.query.token : "";
      const user = await verifyEmailToken(token);
      const redirectUrl = new URL(publicAppOrigin());
      if (!user) {
        redirectUrl.searchParams.set("emailVerified", "failed");
        res.redirect(302, redirectUrl.toString());
        return;
      }
      redirectUrl.searchParams.set("emailVerified", "success");
      redirectUrl.searchParams.set("authToken", signToken(user));
      res.redirect(302, redirectUrl.toString());
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/verify-email-link", async (req, res, next) => {
    try {
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      const user = await verifyEmailToken(token);
      if (!user) {
        res.status(400).json({ error: "Invalid or expired verification link" });
        return;
      }
      res.json({ token: signToken(user), user });
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/recover-email-change", async (req, res, next) => {
    try {
      const input = emailChangeRecoverySchema.parse(req.body);
      const user = await recoverEmailChange(input.token, input.password);
      if (!user) {
        res.status(400).json({ error: "Invalid or expired recovery link" });
        return;
      }
      res.json({ token: signToken(user), user });
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/resend-verification", async (req, res, next) => {
    try {
      const input = resendVerificationSchema.parse(req.body);
      const result = await query<{ id: string; email: string | null; emailVerified: boolean }>(
        `
          SELECT id, email, email_verified AS "emailVerified"
          FROM app_user
          WHERE id = $1
        `,
        [input.userId]
      );
      const user = result.rows[0];
      if (!user || !user.email) {
        res.status(404).json({ error: "Verification account not found" });
        return;
      }
      if (user.emailVerified) {
        res.json({ alreadyVerified: true });
        return;
      }
      await sendVerificationLink(user.id, user.email);
      res.json({ sent: true, email: user.email });
    } catch (error) {
      next(error);
    }
  });

  router.get("/nfl-confidence", requireNateRakelAccount, async (req, res, next) => {
    try {
      const pool = await getActiveNflConfidencePool();
      if (!pool) {
        res.status(404).json({ error: "No active NFL Confidence pool is available." });
        return;
      }
      const displayPool = await nflConfidencePoolWithDynamicPrize(pool);
      let week = await currentNflConfidenceWeek(pool);
      await ensureNflConfidenceWeekGames(pool, week);

      const gamesResult = await query<{
        id: string;
        week: number;
        startsAt: Date;
        awayTeam: string;
        homeTeam: string;
        awayScore: number | null;
        homeScore: number | null;
        status: "scheduled" | "in_progress" | "final" | "void";
      }>(
        `
          SELECT
            id,
            week,
            starts_at AS "startsAt",
            away_team AS "awayTeam",
            home_team AS "homeTeam",
            away_score AS "awayScore",
            home_score AS "homeScore",
            status
          FROM nfl_confidence_game
          WHERE pool_id = $1 AND week = $2
          ORDER BY starts_at ASC, away_team ASC
        `,
        [pool.id, week]
      );
      if (gamesResult.rows.length === 0 && week !== 1) {
        week = 1;
        await ensureNflConfidenceWeekGames(pool, week);
      }

      const games = gamesResult.rows.length ? gamesResult.rows : (await query<typeof gamesResult.rows[number]>(
        `
          SELECT
            id,
            week,
            starts_at AS "startsAt",
            away_team AS "awayTeam",
            home_team AS "homeTeam",
            away_score AS "awayScore",
            home_score AS "homeScore",
            status
          FROM nfl_confidence_game
          WHERE pool_id = $1 AND week = $2
          ORDER BY starts_at ASC, away_team ASC
        `,
        [pool.id, week]
      )).rows;

      const entryResult = await query<{ id: string; status: "active" | "inactive" }>(
        `
          SELECT id, status
          FROM nfl_confidence_entry
          WHERE pool_id = $1 AND user_id = $2
          LIMIT 1
        `,
        [pool.id, req.user!.id]
      );
      const entry = entryResult.rows[0] ?? null;
      const firstGame = games[0] ?? null;
      const firstSundayGame = games.find((game) => {
        const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short" });
        return formatter.format(game.startsAt) === "Sun";
      }) ?? null;

      if (entry && firstGame && firstGame.startsAt.getTime() <= Date.now()) {
        const selectedCount = await query<{ count: string }>(
          `
            SELECT count(*)::text AS count
            FROM nfl_confidence_pick
            WHERE entry_id = $1
              AND week = $2
              AND selected_team IS NOT NULL
          `,
          [entry.id, week]
        );

        const firstPick = await query(
          "SELECT 1 FROM nfl_confidence_pick WHERE entry_id = $1 AND game_id = $2 LIMIT 1",
          [entry.id, firstGame.id]
        );
        if (!firstPick.rowCount) {
          await query(
            `
              INSERT INTO nfl_confidence_pick (
                id, pool_id, entry_id, user_id, game_id, season, week,
                selected_team, confidence_points, status, points_awarded, locked_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 5, 'lost', 0, now())
              ON CONFLICT (entry_id, game_id) DO NOTHING
            `,
            [randomUUID(), pool.id, entry.id, req.user!.id, firstGame.id, pool.season, week]
          );
        }

        if (firstSundayGame && firstSundayGame.startsAt.getTime() <= Date.now() && Number(selectedCount.rows[0]?.count ?? 0) === 0) {
          for (const game of games) {
            await query(
              `
                INSERT INTO nfl_confidence_pick (
                  id, pool_id, entry_id, user_id, game_id, season, week,
                  selected_team, confidence_points, status, points_awarded, locked_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, 'void', 0, now())
                ON CONFLICT (entry_id, game_id) DO NOTHING
              `,
              [randomUUID(), pool.id, entry.id, req.user!.id, game.id, pool.season, week]
            );
          }
        }
      }

      const picks = entry ? (await query<{
        id: string;
        gameId: string;
        selectedTeam: string | null;
        confidencePoints: number | null;
        status: "pending" | "won" | "lost" | "void" | "no_pick";
        pointsAwarded: number;
      }>(
        `
          SELECT
            id,
            game_id AS "gameId",
            selected_team AS "selectedTeam",
            confidence_points AS "confidencePoints",
            status,
            points_awarded AS "pointsAwarded"
          FROM nfl_confidence_pick
          WHERE entry_id = $1 AND week = $2
          ORDER BY confidence_points NULLS LAST, created_at ASC
        `,
        [entry.id, week]
      )).rows : [];

      const weeklyStandings = await query<{
        userId: string;
        displayName: string | null;
        username: string;
        weekPoints: number;
        seasonPoints: number;
        submittedPicks: number;
        possibleWeekPoints: number;
      }>(
        `
          WITH season_points AS (
            SELECT entry_id, COALESCE(sum(points_awarded), 0)::int AS points
            FROM nfl_confidence_pick
            WHERE pool_id = $1
            GROUP BY entry_id
          ),
          week_points AS (
            SELECT entry_id,
                   COALESCE(sum(points_awarded), 0)::int AS points,
                   count(*) FILTER (WHERE selected_team IS NOT NULL)::int AS submitted,
                   COALESCE(sum(confidence_points) FILTER (WHERE selected_team IS NOT NULL), 0)::int AS possible
            FROM nfl_confidence_pick
            WHERE pool_id = $1 AND week = $2
            GROUP BY entry_id
          )
          SELECT
            u.id AS "userId",
            u.display_name AS "displayName",
            u.username,
            COALESCE(wp.points, 0)::int AS "weekPoints",
            COALESCE(sp.points, 0)::int AS "seasonPoints",
            COALESCE(wp.submitted, 0)::int AS "submittedPicks",
            COALESCE(wp.possible, 0)::int AS "possibleWeekPoints"
          FROM nfl_confidence_entry e
          JOIN app_user u ON u.id = e.user_id
          LEFT JOIN season_points sp ON sp.entry_id = e.id
          LEFT JOIN week_points wp ON wp.entry_id = e.id
          WHERE e.pool_id = $1
          ORDER BY COALESCE(wp.points, 0) DESC, COALESCE(sp.points, 0) DESC, lower(COALESCE(NULLIF(u.display_name, ''), u.username))
        `,
        [pool.id, week]
      );

      const seasonStandings = [...weeklyStandings.rows]
        .sort((left, right) => right.seasonPoints - left.seasonPoints || right.weekPoints - left.weekPoints || (left.displayName || left.username).localeCompare(right.displayName || right.username));

      res.json({
        pool: displayPool,
        entry,
        currentWeek: week,
        games: games.map((game) => ({
          id: game.id,
          week: game.week,
          startsAt: game.startsAt.toISOString(),
          awayTeam: game.awayTeam,
          homeTeam: game.homeTeam,
          status: game.status,
          awayScore: game.awayScore,
          homeScore: game.homeScore
        })),
        picks,
        unavailableConfidencePoints: picks.some((pick) => pick.confidencePoints === 5 && pick.selectedTeam === null) ? [5] : [],
        missedThursdayPick: picks.some((pick) => pick.confidencePoints === 5 && pick.selectedTeam === null && pick.status === "lost"),
        sundayLocked: Boolean(firstSundayGame && firstSundayGame.startsAt.getTime() <= Date.now() && !picks.some((pick) => pick.selectedTeam)),
        firstGameStartsAt: firstGame?.startsAt.toISOString() ?? null,
        firstSundayGameStartsAt: firstSundayGame?.startsAt.toISOString() ?? null,
        weeklyStandings: weeklyStandings.rows.map((row) => ({
          userId: row.userId,
          displayName: row.displayName || row.username,
          weekPoints: row.weekPoints,
          seasonPoints: row.seasonPoints,
          submittedPicks: row.submittedPicks,
          possibleWeekPoints: row.possibleWeekPoints
        })),
        seasonStandings: seasonStandings.map((row) => ({
          userId: row.userId,
          displayName: row.displayName || row.username,
          weekPoints: row.weekPoints,
          seasonPoints: row.seasonPoints,
          submittedPicks: row.submittedPicks,
          possibleWeekPoints: row.possibleWeekPoints
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/nfl-confidence/entry", requireNateRakelAccount, async (req, res, next) => {
    try {
      const pool = await getActiveNflConfidencePool();
      if (!pool) {
        res.status(404).json({ error: "No active NFL Confidence pool is available." });
        return;
      }
      await query(
        `
          INSERT INTO nfl_confidence_entry (id, pool_id, user_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (pool_id, user_id) DO NOTHING
        `,
        [randomUUID(), pool.id, req.user!.id]
      );
      res.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.put("/nfl-confidence/picks", requireNateRakelAccount, async (req, res, next) => {
    try {
      const input = nflConfidenceSubmitSchema.parse(req.body);
      const pool = await getActiveNflConfidencePool();
      if (!pool) {
        res.status(404).json({ error: "No active NFL Confidence pool is available." });
        return;
      }
      await ensureNflConfidenceWeekGames(pool, input.week);
      const saved = await transaction(async (client) => {
        const entryResult = await client.query<{ id: string; status: "active" | "inactive" }>(
          "SELECT id, status FROM nfl_confidence_entry WHERE pool_id = $1 AND user_id = $2 FOR UPDATE",
          [pool.id, req.user!.id]
        );
        const entry = entryResult.rows[0];
        if (!entry) throw new WagerValidationError("Join NFL Confidence before making picks.");
        if (entry.status !== "active") throw new WagerValidationError("Your NFL Confidence entry is inactive.");

        const gamesResult = await client.query<{
          id: string;
          starts_at: Date;
          away_team: string;
          home_team: string;
        }>(
          `
            SELECT id, starts_at, away_team, home_team
            FROM nfl_confidence_game
            WHERE pool_id = $1 AND week = $2
            ORDER BY starts_at ASC
            FOR SHARE
          `,
          [pool.id, input.week]
        );
        const games = gamesResult.rows;
        if (!games.length) throw new WagerValidationError("No NFL Confidence games are available for this week.");

        const firstGame = games[0];
        const firstSundayGame = games.find((game) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short" }).format(game.starts_at) === "Sun");
        const existingSelected = await client.query<{ count: string }>(
          `
            SELECT count(*)::text AS count
            FROM nfl_confidence_pick
            WHERE entry_id = $1
              AND week = $2
              AND selected_team IS NOT NULL
          `,
          [entry.id, input.week]
        );
        if (firstSundayGame && firstSundayGame.starts_at.getTime() <= Date.now() && Number(existingSelected.rows[0]?.count ?? 0) === 0) {
          throw new WagerValidationError("The first Sunday kickoff has passed. This week is locked with no points awarded.");
        }

        const pickMap = new Map(input.picks.map((pick) => [pick.gameId, pick]));
        const missedFirstGame = firstGame.starts_at.getTime() <= Date.now() && !pickMap.has(firstGame.id);
        const expectedGames = missedFirstGame ? games.filter((game) => game.id !== firstGame.id) : games;
        if (input.picks.length !== expectedGames.length) {
          throw new WagerValidationError("Pick a winner for every available NFL Confidence game.");
        }

        const confidenceValues = input.picks.map((pick) => pick.confidencePoints);
        if (new Set(confidenceValues).size !== confidenceValues.length) {
          throw new WagerValidationError("Each confidence value can only be used once.");
        }
        const unavailable = missedFirstGame ? new Set([5]) : new Set<number>();
        if (confidenceValues.some((value) => unavailable.has(value))) {
          throw new WagerValidationError("Confidence value 5 is unavailable because the Thursday pick was missed.");
        }

        for (const game of expectedGames) {
          const pick = pickMap.get(game.id);
          if (!pick) throw new WagerValidationError("Pick a winner for every available NFL Confidence game.");
          if (game.starts_at.getTime() <= Date.now()) {
            throw new WagerValidationError(`${game.away_team} @ ${game.home_team} has already started.`);
          }
          if (pick.selectedTeam !== game.away_team && pick.selectedTeam !== game.home_team) {
            throw new WagerValidationError("Selected team is not in the selected game.");
          }
        }

        if (missedFirstGame) {
          await client.query(
            `
              INSERT INTO nfl_confidence_pick (
                id, pool_id, entry_id, user_id, game_id, season, week,
                selected_team, confidence_points, status, points_awarded, locked_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 5, 'lost', 0, now())
              ON CONFLICT (entry_id, game_id) DO NOTHING
            `,
            [randomUUID(), pool.id, entry.id, req.user!.id, firstGame.id, pool.season, input.week]
          );
        }

        await client.query(
          `
            DELETE FROM nfl_confidence_pick
            WHERE entry_id = $1
              AND week = $2
              AND locked_at IS NULL
          `,
          [entry.id, input.week]
        );

        for (const pick of input.picks) {
          const game = games.find((candidate) => candidate.id === pick.gameId);
          if (!game) continue;
          await client.query(
            `
              INSERT INTO nfl_confidence_pick (
                id, pool_id, entry_id, user_id, game_id, season, week,
                selected_team, confidence_points, status, points_awarded
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 0)
            `,
            [randomUUID(), pool.id, entry.id, req.user!.id, pick.gameId, pool.season, input.week, pick.selectedTeam, pick.confidencePoints]
          );
        }
        return { ok: true };
      });
      res.json(saved);
    } catch (error) {
      if (error instanceof WagerValidationError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    }
  });

  router.post("/nfl-confidence/settle", requireNateRakelAccount, async (req, res, next) => {
    try {
      const input = nflConfidenceSettleSchema.parse(req.body ?? {});
      const pool = await getActiveNflConfidencePool();
      if (!pool) {
        res.status(404).json({ error: "No active NFL Confidence pool is available." });
        return;
      }
      const week = input.week ?? await currentNflConfidenceWeek(pool);
      const scoreboard = await fetchEspnNflWeek(pool.season, week);
      const events = scoreboard.events ?? [];
      const completedEvents = events.filter((event) => event.competitions?.[0]?.status?.type?.completed);

      const settled = await transaction(async (client) => {
        for (const event of events) {
          const competition = event.competitions?.[0];
          const competitors = competition?.competitors ?? [];
          const away = competitors.find((competitor) => competitor.homeAway === "away");
          const home = competitors.find((competitor) => competitor.homeAway === "home");
          if (!away || !home) continue;
          const status = competition?.status?.type?.completed
            ? "final"
            : competition?.status?.type?.state === "in"
              ? "in_progress"
              : "scheduled";
          await client.query(
            `
              UPDATE nfl_confidence_game
              SET away_score = $5,
                  home_score = $6,
                  status = $7,
                  updated_at = now()
              WHERE pool_id = $1
                AND season = $2
                AND week = $3
                AND provider_event_id = $4
            `,
            [
              pool.id,
              pool.season,
              week,
              event.id,
              away.score == null ? null : Number(away.score),
              home.score == null ? null : Number(home.score),
              status
            ]
          );
        }

        let updated = 0;
        const finalGames = await client.query<{
          id: string;
          awayTeam: string;
          homeTeam: string;
          awayScore: number | null;
          homeScore: number | null;
        }>(
          `
            SELECT
              id,
              away_team AS "awayTeam",
              home_team AS "homeTeam",
              away_score AS "awayScore",
              home_score AS "homeScore"
            FROM nfl_confidence_game
            WHERE pool_id = $1
              AND week = $2
              AND status = 'final'
          `,
          [pool.id, week]
        );
        for (const game of finalGames.rows) {
          if (game.awayScore == null || game.homeScore == null) continue;
          const winner = game.awayScore > game.homeScore
            ? game.awayTeam
            : game.homeScore > game.awayScore
              ? game.homeTeam
              : null;
          const result = await client.query(
            `
              UPDATE nfl_confidence_pick
              SET status = CASE
                    WHEN selected_team IS NULL THEN status
                    WHEN selected_team = $2 THEN 'won'
                    ELSE 'lost'
                  END,
                  points_awarded = CASE
                    WHEN selected_team = $2 THEN COALESCE(confidence_points, 0)
                    ELSE 0
                  END,
                  locked_at = COALESCE(locked_at, now()),
                  updated_at = now()
              WHERE pool_id = $1
                AND game_id = $3
                AND status = 'pending'
            `,
            [pool.id, winner, game.id]
          );
          updated += result.rowCount ?? 0;
        }
        return updated;
      });

      await logAdminAction(req, "nfl_confidence.settle", { week, completedEvents: completedEvents.length, settled });
      res.json({ week, completedEvents: completedEvents.length, settled });
    } catch (error) {
      next(error);
    }
  });

  router.get("/survivor", requireAuth, async (req, res, next) => {
    try {
      const pool = await getActiveSurvivorPool();
      if (!pool) {
        res.status(404).json({ error: "No active Survivor pool is available." });
        return;
      }
      const displayPool = await survivorPoolWithDynamicPrize(pool);
      const weekStart = currentSurvivorWeekStart(pool);
      const weekEnd = addDays(weekStart, 7);

      const entryResult = await query<{
        id: string;
        status: "active" | "eliminated" | "winner";
        eliminatedWeekStart: string | null;
      }>(
        `
          SELECT id, status, eliminated_week_start::text AS "eliminatedWeekStart"
          FROM survivor_entry
          WHERE pool_id = $1 AND user_id = $2
          LIMIT 1
        `,
        [pool.id, req.user!.id]
      );
      const entry = entryResult.rows[0] ?? null;

      const usedTeamsResult = entry
        ? await query<{ selectedTeam: string }>(
          `
            SELECT selected_team AS "selectedTeam"
            FROM survivor_pick
            WHERE entry_id = $1 AND status <> 'void'
            ORDER BY week_start ASC
          `,
          [entry.id]
        )
        : { rows: [] as Array<{ selectedTeam: string }> };

      const currentPickResult = entry
        ? await query<{
          id: string;
          weekStart: string;
          selectedTeam: string;
          awayTeam: string;
          homeTeam: string;
          startsAt: Date;
          status: "pending" | "won" | "lost" | "tie" | "no_pick" | "void";
        }>(
          `
            SELECT id, week_start::text AS "weekStart", selected_team AS "selectedTeam",
                   away_team AS "awayTeam", home_team AS "homeTeam", starts_at AS "startsAt", status
            FROM survivor_pick
            WHERE entry_id = $1 AND week_start = $2::date
            LIMIT 1
          `,
          [entry.id, weekStart]
        )
        : { rows: [] as Array<{
          id: string;
          weekStart: string;
          selectedTeam: string;
          awayTeam: string;
          homeTeam: string;
          startsAt: Date;
          status: "pending" | "won" | "lost" | "tie" | "no_pick" | "void";
        }> };

      const lineResult = await query<{
        id: string;
        startsAt: Date;
        awayTeam: string;
        homeTeam: string;
        favoriteTeam: string;
      }>(
        `
          SELECT DISTINCT ON (
            away_team,
            home_team,
            favorite_team
          )
            id,
            starts_at AS "startsAt",
            away_team AS "awayTeam",
            home_team AS "homeTeam",
            favorite_team AS "favoriteTeam"
          FROM game_line
          WHERE sport = 'NFL'
            AND market_key = 'h2h'
            AND is_active = true
            AND away_team = ANY($3::text[])
            AND home_team = ANY($3::text[])
            AND (starts_at AT TIME ZONE 'America/Chicago')::date >= $1::date
            AND (starts_at AT TIME ZONE 'America/Chicago')::date < $2::date
          ORDER BY
            away_team,
            home_team,
            favorite_team,
            fetched_at DESC
        `,
        [weekStart, weekEnd, nflTeamNames]
      );
      const games = new Map<string, {
        eventKey: string;
        startsAt: string;
        awayTeam: string;
        homeTeam: string;
        awayLineId: string | null;
        homeLineId: string | null;
      }>();
      for (const line of lineResult.rows) {
        const eventKey = `NFL:${line.awayTeam}:${line.homeTeam}`;
        const game = games.get(eventKey) ?? {
          eventKey,
          startsAt: line.startsAt.toISOString(),
          awayTeam: line.awayTeam,
          homeTeam: line.homeTeam,
          awayLineId: null,
          homeLineId: null
        };
        if (line.favoriteTeam === line.awayTeam) game.awayLineId = line.id;
        if (line.favoriteTeam === line.homeTeam) game.homeLineId = line.id;
        games.set(eventKey, game);
      }

      const standingsResult = await query<{
        userId: string;
        displayName: string | null;
        username: string;
        status: "active" | "eliminated" | "winner";
        eliminatedWeekStart: string | null;
        picksMade: number;
        pickId: string | null;
        pickWeekStart: string | null;
        selectedTeam: string | null;
        awayTeam: string | null;
        homeTeam: string | null;
        startsAt: Date | null;
        pickStatus: "pending" | "won" | "lost" | "tie" | "no_pick" | "void" | null;
      }>(
        `
          SELECT
            u.id AS "userId",
            u.display_name AS "displayName",
            u.username,
            e.status,
            e.eliminated_week_start::text AS "eliminatedWeekStart",
            count(p_all.id)::int AS "picksMade",
            p.id AS "pickId",
            p.week_start::text AS "pickWeekStart",
            p.selected_team AS "selectedTeam",
            p.away_team AS "awayTeam",
            p.home_team AS "homeTeam",
            p.starts_at AS "startsAt",
            p.status AS "pickStatus"
          FROM survivor_entry e
          JOIN app_user u ON u.id = e.user_id
          LEFT JOIN survivor_pick p_all ON p_all.entry_id = e.id AND p_all.status <> 'void'
          LEFT JOIN survivor_pick p ON p.entry_id = e.id AND p.week_start = $2::date
          WHERE e.pool_id = $1
          GROUP BY u.id, u.display_name, u.username, e.status, e.eliminated_week_start,
                   p.id, p.week_start, p.selected_team, p.away_team, p.home_team, p.starts_at, p.status
          ORDER BY
            CASE e.status WHEN 'active' THEN 1 WHEN 'winner' THEN 2 ELSE 3 END,
            count(p_all.id) DESC,
            lower(COALESCE(NULLIF(u.display_name, ''), u.username))
        `,
        [pool.id, weekStart]
      );

      const currentPick = currentPickResult.rows[0] ?? null;
      res.json({
        pool: displayPool,
        currentWeekStart: weekStart,
        entry: entry ? {
          ...entry,
          usedTeams: usedTeamsResult.rows.map((row) => row.selectedTeam),
          currentPick: currentPick ? {
            id: currentPick.id,
            weekStart: currentPick.weekStart,
            selectedTeam: currentPick.selectedTeam,
            awayTeam: currentPick.awayTeam,
            homeTeam: currentPick.homeTeam,
            startsAt: currentPick.startsAt.toISOString(),
            status: currentPick.status,
            locked: currentPick.startsAt.getTime() <= Date.now(),
            visible: true,
            displayTeam: currentPick.selectedTeam
          } : null
        } : null,
        games: [...games.values()].sort((left, right) => left.startsAt.localeCompare(right.startsAt)),
        standings: standingsResult.rows.map((row) => ({
          userId: row.userId,
          displayName: row.displayName || row.username,
          status: row.status,
          eliminatedWeekStart: row.eliminatedWeekStart,
          picksMade: row.picksMade,
          currentPick: row.pickId && row.startsAt && row.selectedTeam && row.awayTeam && row.homeTeam && row.pickWeekStart ? {
            id: row.pickId,
            weekStart: row.pickWeekStart,
            selectedTeam: row.selectedTeam,
            awayTeam: row.awayTeam,
            homeTeam: row.homeTeam,
            startsAt: row.startsAt.toISOString(),
            status: row.pickStatus ?? "pending",
            locked: row.startsAt.getTime() <= Date.now(),
            visible: row.startsAt.getTime() <= Date.now() || row.userId === req.user!.id,
            displayTeam: survivorVisiblePickTeam(row.startsAt, row.selectedTeam, row.userId === req.user!.id)
          } : null
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/survivor/entry", requireAuth, async (req, res, next) => {
    try {
      if (!req.user!.emailVerified) {
        res.status(403).json({ error: "Verify your email address before joining Survivor." });
        return;
      }
      const pool = await getActiveSurvivorPool();
      if (!pool) {
        res.status(404).json({ error: "No active Survivor pool is available." });
        return;
      }
      await query(
        `
          INSERT INTO survivor_entry (id, pool_id, user_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (pool_id, user_id) DO NOTHING
        `,
        [randomUUID(), pool.id, req.user!.id]
      );
      res.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/survivor/picks", requireAuth, async (req, res, next) => {
    try {
      if (!req.user!.emailVerified) {
        res.status(403).json({ error: "Verify your email address before making a Survivor pick." });
        return;
      }
      const input = survivorPickSchema.parse(req.body);
      const pool = await getActiveSurvivorPool();
      if (!pool) {
        res.status(404).json({ error: "No active Survivor pool is available." });
        return;
      }
      const weekStart = currentSurvivorWeekStart(pool);
      const result = await transaction(async (client) => {
        const entryResult = await client.query<{ id: string; status: "active" | "eliminated" | "winner" }>(
          "SELECT id, status FROM survivor_entry WHERE pool_id = $1 AND user_id = $2 FOR UPDATE",
          [pool.id, req.user!.id]
        );
        const entry = entryResult.rows[0];
        if (!entry) throw new WagerValidationError("Join Survivor before making a pick.");
        if (entry.status !== "active") throw new WagerValidationError("You have been eliminated from this Survivor pool.");

        const lineResult = await client.query<{
          id: string;
          starts_at: Date;
          away_team: string;
          home_team: string;
          favorite_team: string;
          is_active: boolean;
        }>(
          `
            SELECT id, starts_at, away_team, home_team, favorite_team, is_active
            FROM game_line
            WHERE id = $1
              AND sport = 'NFL'
              AND market_key = 'h2h'
            FOR SHARE
          `,
          [input.gameLineId]
        );
        const line = lineResult.rows[0];
        if (
          !line ||
          !line.is_active ||
          line.favorite_team !== input.selectedTeam ||
          !isNflMatchup(line.away_team, line.home_team)
        ) {
          throw new WagerValidationError("Selected Survivor team is not available.");
        }
        if (line.starts_at.getTime() <= Date.now()) {
          throw new WagerValidationError("This Survivor game has already started.");
        }
        if (!isInContestWeek(line.starts_at, weekStart)) {
          throw new WagerValidationError("Survivor picks must be for the current contest week.");
        }

        const existingPick = await client.query<{ id: string; starts_at: Date; selected_team: string }>(
          "SELECT id, starts_at, selected_team FROM survivor_pick WHERE entry_id = $1 AND week_start = $2::date FOR UPDATE",
          [entry.id, weekStart]
        );
        const existing = existingPick.rows[0];
        if (existing && existing.starts_at.getTime() <= Date.now()) {
          throw new WagerValidationError("Your Survivor pick is locked because that game has started.");
        }

        const reused = await client.query(
          `
            SELECT 1
            FROM survivor_pick
            WHERE entry_id = $1
              AND selected_team = $2
              AND week_start <> $3::date
              AND status <> 'void'
            LIMIT 1
          `,
          [entry.id, input.selectedTeam, weekStart]
        );
        if (reused.rowCount) {
          throw new WagerValidationError("You have already used that team in this Survivor pool.");
        }

        const pickId = existing?.id ?? randomUUID();
        const saved = await client.query<{ id: string }>(
          `
            INSERT INTO survivor_pick (
              id, pool_id, entry_id, user_id, week_start, game_line_id, selected_team,
              away_team, home_team, starts_at
            )
            VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10)
            ON CONFLICT (entry_id, week_start) DO UPDATE
            SET game_line_id = EXCLUDED.game_line_id,
                selected_team = EXCLUDED.selected_team,
                away_team = EXCLUDED.away_team,
                home_team = EXCLUDED.home_team,
                starts_at = EXCLUDED.starts_at,
                status = 'pending',
                locked_at = NULL,
                settled_at = NULL,
                updated_at = now()
            RETURNING id
          `,
          [pickId, pool.id, entry.id, req.user!.id, weekStart, line.id, input.selectedTeam, line.away_team, line.home_team, line.starts_at]
        );
        return saved.rows[0];
      });
      res.status(201).json({ pick: result });
    } catch (error) {
      if (error instanceof WagerValidationError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    }
  });

  router.get("/admin/survivor", requireNateRakelAccount, async (req, res, next) => {
    try {
      const pool = await getActiveSurvivorPool();
      if (!pool) {
        res.status(404).json({ error: "No active Survivor pool is available." });
        return;
      }
      const displayPool = await survivorPoolWithDynamicPrize(pool);
      const weekStart = currentSurvivorWeekStart(pool);
      const standingsResult = await query<{
        entryId: string;
        userId: string;
        displayName: string | null;
        username: string;
        status: "active" | "eliminated" | "winner";
        eliminatedWeekStart: string | null;
        picksMade: number;
        pickId: string | null;
        pickWeekStart: string | null;
        selectedTeam: string | null;
        awayTeam: string | null;
        homeTeam: string | null;
        startsAt: Date | null;
        pickStatus: "pending" | "won" | "lost" | "tie" | "no_pick" | "void" | null;
      }>(
        `
          SELECT
            e.id AS "entryId",
            u.id AS "userId",
            u.display_name AS "displayName",
            u.username,
            e.status,
            e.eliminated_week_start::text AS "eliminatedWeekStart",
            count(p_all.id)::int AS "picksMade",
            p.id AS "pickId",
            p.week_start::text AS "pickWeekStart",
            p.selected_team AS "selectedTeam",
            p.away_team AS "awayTeam",
            p.home_team AS "homeTeam",
            p.starts_at AS "startsAt",
            p.status AS "pickStatus"
          FROM survivor_entry e
          JOIN app_user u ON u.id = e.user_id
          LEFT JOIN survivor_pick p_all ON p_all.entry_id = e.id AND p_all.status <> 'void'
          LEFT JOIN survivor_pick p ON p.entry_id = e.id AND p.week_start = $2::date
          WHERE e.pool_id = $1
          GROUP BY e.id, u.id, u.display_name, u.username, e.status, e.eliminated_week_start,
                   p.id, p.week_start, p.selected_team, p.away_team, p.home_team, p.starts_at, p.status
          ORDER BY
            CASE e.status WHEN 'active' THEN 1 WHEN 'winner' THEN 2 ELSE 3 END,
            count(p_all.id) DESC,
            lower(COALESCE(NULLIF(u.display_name, ''), u.username))
        `,
        [pool.id, weekStart]
      );
      await logAdminAction(req, "admin.survivor.view", { rowCount: standingsResult.rowCount });
      res.json({
        pool: displayPool,
        currentWeekStart: weekStart,
        standings: standingsResult.rows.map((row) => ({
          entryId: row.entryId,
          userId: row.userId,
          displayName: row.displayName || row.username,
          status: row.status,
          eliminatedWeekStart: row.eliminatedWeekStart,
          picksMade: row.picksMade,
          currentPick: row.pickId && row.startsAt && row.selectedTeam && row.awayTeam && row.homeTeam && row.pickWeekStart ? {
            id: row.pickId,
            weekStart: row.pickWeekStart,
            selectedTeam: row.selectedTeam,
            awayTeam: row.awayTeam,
            homeTeam: row.homeTeam,
            startsAt: row.startsAt.toISOString(),
            status: row.pickStatus ?? "pending",
            locked: row.startsAt.getTime() <= Date.now(),
            visible: true,
            displayTeam: row.selectedTeam,
            ownerName: row.displayName || row.username
          } : null
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/survivor/picks/:id", requireNateRakelAccount, async (req, res, next) => {
    try {
      const pickId = String(req.params.id);
      const input = survivorAdminPickSchema.parse(req.body);
      const result = await settleSurvivorPickById(pickId, input.status, req.user!.id, input.note);
      if (!result) {
        res.status(404).json({ error: "Survivor pick not found." });
        return;
      }
      await logAdminAction(req, "admin.survivor_pick.override", { pickId, status: input.status });
      res.json({ pick: result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/survivor/settle", requireNateRakelAccount, async (req, res, next) => {
    try {
      const pool = await getActiveSurvivorPool();
      if (!pool) {
        res.status(404).json({ error: "No active Survivor pool is available." });
        return;
      }
      const weekStart = currentSurvivorWeekStart(pool);
      const weekEnd = addDays(weekStart, 7);
      const pendingResult = await query<{
        id: string;
        selectedTeam: string;
        awayTeam: string;
        homeTeam: string;
        startsAt: Date;
        awayScore: number | null;
        homeScore: number | null;
      }>(
        `
          SELECT
            p.id,
            p.selected_team AS "selectedTeam",
            p.away_team AS "awayTeam",
            p.home_team AS "homeTeam",
            p.starts_at AS "startsAt",
            gr.away_score AS "awayScore",
            gr.home_score AS "homeScore"
          FROM survivor_pick p
          LEFT JOIN LATERAL (
            SELECT *
            FROM game_result candidate
            WHERE candidate.sport = 'NFL'
              AND candidate.away_team = p.away_team
              AND candidate.home_team = p.home_team
              AND abs(extract(epoch from coalesce(candidate.starts_at, candidate.starts_on::timestamptz) - p.starts_at)) <= 43200
            ORDER BY abs(extract(epoch from coalesce(candidate.starts_at, candidate.starts_on::timestamptz) - p.starts_at)) ASC,
                     candidate.fetched_at DESC
            LIMIT 1
          ) gr ON true
          WHERE p.pool_id = $1
            AND p.week_start = $2::date
            AND p.status = 'pending'
            AND p.starts_at <= now()
          ORDER BY p.starts_at ASC
        `,
        [pool.id, weekStart]
      );

      let settled = 0;
      for (const pick of pendingResult.rows) {
        if (pick.awayScore == null || pick.homeScore == null) continue;
        const status = survivorPickStatusForResult(pick.selectedTeam, {
          away_team: pick.awayTeam,
          home_team: pick.homeTeam,
          away_score: pick.awayScore,
          home_score: pick.homeScore
        });
        await settleSurvivorPickById(pick.id, status);
        settled += 1;
      }

      const firstKickoffResult = await query(
        `
          SELECT 1
          FROM game_line
          WHERE sport = 'NFL'
            AND market_key = 'h2h'
            AND away_team = ANY($3::text[])
            AND home_team = ANY($3::text[])
            AND (starts_at AT TIME ZONE 'America/Chicago')::date >= $1::date
            AND (starts_at AT TIME ZONE 'America/Chicago')::date < $2::date
            AND starts_at <= now()
          LIMIT 1
        `,
        [weekStart, weekEnd, nflTeamNames]
      );
      let missed = 0;
      if (firstKickoffResult.rowCount) {
        const missedResult = await query(
          `
            UPDATE survivor_entry e
            SET status = 'eliminated',
                eliminated_week_start = $2::date,
                updated_at = now()
            WHERE e.pool_id = $1
              AND e.status = 'active'
              AND NOT EXISTS (
                SELECT 1
                FROM survivor_pick p
                WHERE p.entry_id = e.id
                  AND p.week_start = $2::date
              )
          `,
          [pool.id, weekStart]
        );
        missed = missedResult.rowCount ?? 0;
      }

      await logAdminAction(req, "admin.survivor.settle", { settled, missed });
      res.json({ settled, missed });
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

  router.get("/me/rewards", requireAuth, async (req, res, next) => {
    try {
      const result = await query<{
        id: string;
        weekStart: string;
        rank: number;
        sharePercent: number;
        rewardCents: number;
        firstPlaceBonus: string | null;
        bonusSelection: string | null;
        bonusSize: string | null;
        shippingName: string | null;
        shippingAddressLine1: string | null;
        shippingAddressLine2: string | null;
        shippingCity: string | null;
        shippingRegion: string | null;
        shippingPostalCode: string | null;
        shippingCountry: string | null;
        bonusFulfillmentSubmittedAt: string | null;
        bonusFulfilledAt: string | null;
        bonusFulfillmentMessage: string | null;
      }>(
        `
          SELECT
            id,
            week_starts_on::text AS "weekStart",
            rank,
            share_percent AS "sharePercent",
            reward_cents AS "rewardCents",
            first_place_bonus AS "firstPlaceBonus",
            bonus_selection AS "bonusSelection",
            bonus_size AS "bonusSize",
            shipping_name AS "shippingName",
            shipping_address_line1 AS "shippingAddressLine1",
            shipping_address_line2 AS "shippingAddressLine2",
            shipping_city AS "shippingCity",
            shipping_region AS "shippingRegion",
            shipping_postal_code AS "shippingPostalCode",
            shipping_country AS "shippingCountry",
            bonus_fulfillment_submitted_at AS "bonusFulfillmentSubmittedAt",
            bonus_fulfilled_at AS "bonusFulfilledAt",
            bonus_fulfillment_message AS "bonusFulfillmentMessage"
          FROM weekly_reward_award
          WHERE user_id = $1
          ORDER BY week_starts_on DESC, rank ASC
        `,
        [req.user!.id]
      );
      res.json({
        rewards: result.rows.map((award) => ({
          ...award,
          bonusOptions: bonusOptionsFromText(award.firstPlaceBonus)
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/me/rewards/:id/bonus-fulfillment", requireAuth, async (req, res, next) => {
    try {
      const rewardId = z.uuid().parse(req.params.id);
      const input = bonusFulfillmentSchema.parse(req.body);
      const existing = await query<{
        firstPlaceBonus: string | null;
        weekStart: string;
        username: string;
        playerName: string;
        bonusFulfilledAt: string | null;
      }>(
        `
          SELECT
            a.first_place_bonus AS "firstPlaceBonus",
            a.week_starts_on::text AS "weekStart",
            a.bonus_fulfilled_at AS "bonusFulfilledAt",
            u.username,
            COALESCE(NULLIF(u.display_name, ''), NULLIF(u.full_name, ''), u.username) AS "playerName"
          FROM weekly_reward_award a
          JOIN app_user u ON u.id = a.user_id
          WHERE a.id = $1 AND a.user_id = $2
        `,
        [rewardId, req.user!.id]
      );
      const award = existing.rows[0];
      if (!award) {
        res.status(404).json({ error: "Reward not found" });
        return;
      }
      if (award.bonusFulfilledAt) {
        res.status(400).json({ error: "This reward has already been fulfilled." });
        return;
      }
      const options = bonusOptionsFromText(award.firstPlaceBonus);
      if (options.length === 0) {
        res.status(400).json({ error: "This reward does not have a selectable bonus item." });
        return;
      }
      if (!options.some((option) => option.toLowerCase() === input.bonusSelection.toLowerCase())) {
        res.status(400).json({ error: "Select one of the available reward options." });
        return;
      }
      const selectedOption = options.find((option) => option.toLowerCase() === input.bonusSelection.toLowerCase()) ?? input.bonusSelection;
      const normalizedSize = input.bonusSize?.trim().toUpperCase() || null;
      if (bonusRequiresSize(selectedOption) && !normalizedSize) {
        res.status(400).json({ error: "Select a size for the polo." });
        return;
      }
      if (normalizedSize && !bonusSizeOptions.includes(normalizedSize)) {
        res.status(400).json({ error: "Select one of the available sizes." });
        return;
      }

      const result = await query<{
        id: string;
        weekStart: string;
        rank: number;
        sharePercent: number;
        rewardCents: number;
        firstPlaceBonus: string | null;
        bonusSelection: string | null;
        bonusSize: string | null;
        shippingName: string | null;
        shippingAddressLine1: string | null;
        shippingAddressLine2: string | null;
        shippingCity: string | null;
        shippingRegion: string | null;
        shippingPostalCode: string | null;
        shippingCountry: string | null;
        bonusFulfillmentSubmittedAt: string | null;
        bonusFulfilledAt: string | null;
        bonusFulfillmentMessage: string | null;
      }>(
        `
          UPDATE weekly_reward_award
          SET bonus_selection = $3,
              bonus_size = $4,
              shipping_name = $5,
              shipping_address_line1 = $6,
              shipping_address_line2 = $7,
              shipping_city = $8,
              shipping_region = $9,
              shipping_postal_code = $10,
              shipping_country = $11,
              bonus_fulfillment_submitted_at = now()
          WHERE id = $1 AND user_id = $2
          RETURNING
            id,
            week_starts_on::text AS "weekStart",
            rank,
            share_percent AS "sharePercent",
            reward_cents AS "rewardCents",
            first_place_bonus AS "firstPlaceBonus",
            bonus_selection AS "bonusSelection",
            bonus_size AS "bonusSize",
            shipping_name AS "shippingName",
            shipping_address_line1 AS "shippingAddressLine1",
            shipping_address_line2 AS "shippingAddressLine2",
            shipping_city AS "shippingCity",
            shipping_region AS "shippingRegion",
            shipping_postal_code AS "shippingPostalCode",
            shipping_country AS "shippingCountry",
            bonus_fulfillment_submitted_at AS "bonusFulfillmentSubmittedAt",
            bonus_fulfilled_at AS "bonusFulfilledAt",
            bonus_fulfillment_message AS "bonusFulfillmentMessage"
        `,
        [
          rewardId,
          req.user!.id,
          selectedOption,
          bonusRequiresSize(selectedOption) ? normalizedSize : null,
          input.shippingName,
          input.shippingAddressLine1,
          input.shippingAddressLine2?.trim() || null,
          input.shippingCity,
          input.shippingRegion,
          input.shippingPostalCode,
          input.shippingCountry
        ]
      );
      const updated = result.rows[0];
      try {
        const emailBody = rewardFulfillmentEmailBody({
          playerName: award.playerName,
          username: award.username,
          weekStart: award.weekStart,
          rewardText: award.firstPlaceBonus ?? selectedOption,
          bonusSelection: selectedOption,
          bonusSize: bonusRequiresSize(selectedOption) ? normalizedSize : null,
          shippingName: input.shippingName,
          shippingAddressLine1: input.shippingAddressLine1,
          shippingAddressLine2: input.shippingAddressLine2?.trim() || null,
          shippingCity: input.shippingCity,
          shippingRegion: input.shippingRegion,
          shippingPostalCode: input.shippingPostalCode,
          shippingCountry: input.shippingCountry
        });
        await sendMail({
          to: [{ email: "nathanielrakel@gmail.com", name: "Nate Rakel" }],
          subject: "StakeWars special reward selected",
          text: emailBody.text,
          html: emailBody.html
        });
      } catch (mailError) {
        console.error("Reward fulfillment notification email failed", mailError);
      }
      res.json({
        reward: {
          ...updated,
          bonusOptions: options
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me/referral", requireAuth, async (req, res, next) => {
    try {
      const result = await query<{
        referralCode: string;
        referredCount: string;
        qualifiedReferralCount: string;
        availableBoosts: string;
      }>(
        `
          SELECT
            referral_code AS "referralCode",
            (
              SELECT count(*)::text
              FROM app_user referred
              WHERE referred.referred_by_user_id = app_user.id
            ) AS "referredCount"
            ,
            (
              SELECT count(*)::text
              FROM referral_bankroll_boost boost
              WHERE boost.referrer_user_id = app_user.id
            ) AS "qualifiedReferralCount",
            (
              SELECT count(*)::text
              FROM referral_bankroll_boost boost
              WHERE boost.referrer_user_id = app_user.id
                AND boost.status = 'earned'
            ) AS "availableBoosts"
          FROM app_user
          WHERE id = $1
        `,
        [req.user!.id]
      );
      const row = result.rows[0];
      if (!row) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const origin = config.referralPublicOrigin.replace(/\/+$/, "");
      res.json({
        referralCode: row.referralCode,
        referralUrl: `${origin}/?ref=${encodeURIComponent(row.referralCode)}`,
        referredCount: Number(row.referredCount),
        qualifiedReferralCount: Number(row.qualifiedReferralCount),
        availableBoosts: Number(row.availableBoosts),
        boostAmountCents: 100_000,
        maxBoostsPerWeek: 2
      });
    } catch (error) {
      next(error);
    }
  });

  if (config.towerEnabled) {
    router.get("/tower/config", requireAuth, async (_req, res, next) => {
      try {
        const configVersion = await getActiveTowerConfig();
        res.json(configVersion);
      } catch (error) {
        next(error);
      }
    });

    router.get("/tower/state", requireAuth, async (req, res, next) => {
      try {
        res.json(await getTowerState(req.user!.id));
      } catch (error) {
        next(error);
      }
    });

    router.get("/tower/history", requireAuth, async (req, res, next) => {
      try {
        res.json({ history: await getRecentTowerHands(req.user!.id) });
      } catch (error) {
        next(error);
      }
    });

    router.post("/tower/hands", requireAuth, async (req, res, next) => {
      try {
        const input = towerStartHandSchema.parse(req.body);
        const result = await startTowerHandForUser({
          userId: req.user!.id,
          valueWagerCents: input.valueWagerCents,
          heightWagerCents: input.heightWagerCents
        });
        res.status(201).json(result);
      } catch (error) {
        if (error instanceof TowerError) {
          res.status(error.statusCode).json({ error: error.message });
          return;
        }
        next(error);
      }
    });

    router.post("/tower/hands/:id/build", requireAuth, async (req, res, next) => {
      try {
        const input = towerActionSchema.parse(req.body);
        res.json(await buildTowerHandForUser({
          userId: req.user!.id,
          handId: String(req.params.id),
          actionVersion: input.actionVersion
        }));
      } catch (error) {
        if (error instanceof TowerError) {
          res.status(error.statusCode).json({ error: error.message });
          return;
        }
        next(error);
      }
    });

    router.post("/tower/hands/:id/double", requireAuth, async (req, res, next) => {
      try {
        const input = towerDoubleSchema.parse(req.body);
        res.json(await doubleTowerHandForUser({
          userId: req.user!.id,
          handId: String(req.params.id),
          actionVersion: input.actionVersion,
          doubleValue: input.doubleValue,
          doubleHeight: input.doubleHeight
        }));
      } catch (error) {
        if (error instanceof TowerError) {
          res.status(error.statusCode).json({ error: error.message });
          return;
        }
        next(error);
      }
    });

    router.post("/tower/hands/:id/cap", requireAuth, async (req, res, next) => {
      try {
        const input = towerActionSchema.parse(req.body);
        res.json(await capTowerHandForUser({
          userId: req.user!.id,
          handId: String(req.params.id),
          actionVersion: input.actionVersion
        }));
      } catch (error) {
        if (error instanceof TowerError) {
          res.status(error.statusCode).json({ error: error.message });
          return;
        }
        next(error);
      }
    });

    router.post("/admin/tower/simulate", requireNateRakelAccount, async (req, res, next) => {
      try {
        const input = towerSimulateSchema.parse(req.body);
        const result = await simulateTowerHandsForUser({
          userId: req.user!.id,
          valueWagerCents: input.valueWagerCents,
          heightWagerCents: input.heightWagerCents,
          hands: input.hands
        });
        res.json(result);
      } catch (error) {
        if (error instanceof TowerError) {
          res.status(error.statusCode).json({ error: error.message });
          return;
        }
        next(error);
      }
    });

    router.get("/admin/tower/analytics", requireNateRakelAccount, async (_req, res, next) => {
      try {
        res.json({ analytics: await getTowerAnalytics() });
      } catch (error) {
        next(error);
      }
    });
  }

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

  router.post("/support/conversations", requireAuth, async (req, res, next) => {
    try {
      if (!req.user!.emailVerified) {
        res.status(403).json({ error: "Verify your email address before starting a support chat." });
        return;
      }
      const input = supportConversationSchema.parse(req.body);
      const conversationId = randomUUID();
      const messageBody = input.message?.trim()
        || `Support topic selected: ${supportCategoryLabel(input.category)}`;
      const result = await transaction(async (client) => {
        await client.query(
          `
            INSERT INTO support_conversation (id, user_id, category)
            VALUES ($1, $2, $3)
          `,
          [conversationId, req.user!.id, input.category]
        );
        await client.query(
          `
            INSERT INTO support_message (id, conversation_id, sender_user_id, sender_role, body)
            VALUES ($1, $2, $3, 'user', $4)
          `,
          [randomUUID(), conversationId, req.user!.id, messageBody]
        );
        return client.query<{
          id: string;
          category: z.infer<typeof supportCategorySchema>;
          status: "open" | "closed";
          createdAt: string;
          updatedAt: string;
        }>(
          `
            SELECT
              id,
              category,
              status,
              created_at AS "createdAt",
              updated_at AS "updatedAt"
            FROM support_conversation
            WHERE id = $1
          `,
          [conversationId]
        );
      });
      await notifyNateOfSupportChat({
        conversationId,
        displayName: req.user!.displayName,
        username: req.user!.username,
        category: input.category
      }).catch((error) => console.error("Support chat push failed", error));
      res.status(201).json({ conversation: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get("/support/conversations", requireAuth, async (req, res, next) => {
    try {
      const result = await query(
        `
          SELECT
            c.id,
            c.category,
            c.status,
            c.created_at AS "createdAt",
            c.updated_at AS "updatedAt",
            (
              SELECT body
              FROM support_message sm
              WHERE sm.conversation_id = c.id
              ORDER BY sm.created_at DESC
              LIMIT 1
            ) AS "lastMessage"
          FROM support_conversation c
          WHERE c.user_id = $1
          ORDER BY c.updated_at DESC
          LIMIT 20
        `,
        [req.user!.id]
      );
      res.json({ conversations: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/support/conversations/:id", requireAuth, async (req, res, next) => {
    try {
      const conversation = await query(
        `
          SELECT id, category, status, created_at AS "createdAt", updated_at AS "updatedAt"
          FROM support_conversation
          WHERE id = $1 AND user_id = $2
        `,
        [req.params.id, req.user!.id]
      );
      if (!conversation.rows[0]) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      const messages = await query(
        `
          SELECT id, sender_role AS "senderRole", body, created_at AS "createdAt"
          FROM support_message
          WHERE conversation_id = $1
          ORDER BY created_at ASC
        `,
        [req.params.id]
      );
      res.json({ conversation: conversation.rows[0], messages: messages.rows });
    } catch (error) {
      next(error);
    }
  });

  router.post("/support/conversations/:id/messages", requireAuth, async (req, res, next) => {
    try {
      if (!req.user!.emailVerified) {
        res.status(403).json({ error: "Verify your email address before using support chat." });
        return;
      }
      const input = supportMessageSchema.parse(req.body);
      const conversation = await query(
        "SELECT id FROM support_conversation WHERE id = $1 AND user_id = $2 AND status = 'open'",
        [req.params.id, req.user!.id]
      );
      if (!conversation.rows[0]) {
        res.status(404).json({ error: "Open conversation not found" });
        return;
      }
      const result = await transaction(async (client) => {
        const message = await client.query(
          `
            INSERT INTO support_message (id, conversation_id, sender_user_id, sender_role, body)
            VALUES ($1, $2, $3, 'user', $4)
            RETURNING id, sender_role AS "senderRole", body, created_at AS "createdAt"
          `,
          [randomUUID(), req.params.id, req.user!.id, input.body]
        );
        await client.query("UPDATE support_conversation SET updated_at = now() WHERE id = $1", [req.params.id]);
        return message;
      });
      res.status(201).json({ message: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/support/conversations", requireNateRakelAccount, async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" && req.query.status === "closed" ? "closed" : "open";
      const result = await query(
        `
          SELECT
            c.id,
            c.category,
            c.status,
            c.created_at AS "createdAt",
            c.updated_at AS "updatedAt",
            c.closed_at AS "closedAt",
            u.username,
            u.display_name AS "displayName",
            u.email,
            (
              SELECT body
              FROM support_message sm
              WHERE sm.conversation_id = c.id
              ORDER BY sm.created_at DESC
              LIMIT 1
            ) AS "lastMessage"
          FROM support_conversation c
          JOIN app_user u ON u.id = c.user_id
          WHERE c.status = $1
          ORDER BY c.updated_at DESC
          LIMIT 100
        `,
        [status]
      );
      await logAdminAction(req, "admin.support_conversations.view", { status, rowCount: result.rowCount });
      res.json({ conversations: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/support/conversations/:id", requireNateRakelAccount, async (req, res, next) => {
    try {
      const conversation = await query(
        `
          SELECT
            c.id,
            c.category,
            c.status,
            c.created_at AS "createdAt",
            c.updated_at AS "updatedAt",
            c.closed_at AS "closedAt",
            u.username,
            u.display_name AS "displayName",
            u.email
          FROM support_conversation c
          JOIN app_user u ON u.id = c.user_id
          WHERE c.id = $1
        `,
        [req.params.id]
      );
      if (!conversation.rows[0]) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      const messages = await query(
        `
          SELECT id, sender_role AS "senderRole", body, created_at AS "createdAt"
          FROM support_message
          WHERE conversation_id = $1
          ORDER BY created_at ASC
        `,
        [req.params.id]
      );
      await logAdminAction(req, "admin.support_conversation.view", { conversationId: req.params.id });
      res.json({ conversation: conversation.rows[0], messages: messages.rows });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/support/conversations/:id/messages", requireNateRakelAccount, async (req, res, next) => {
    try {
      const input = supportMessageSchema.parse(req.body);
      const conversation = await query(
        "SELECT id FROM support_conversation WHERE id = $1 AND status = 'open'",
        [req.params.id]
      );
      if (!conversation.rows[0]) {
        res.status(404).json({ error: "Open conversation not found" });
        return;
      }
      const result = await transaction(async (client) => {
        const message = await client.query(
          `
            INSERT INTO support_message (id, conversation_id, sender_user_id, sender_role, body)
            VALUES ($1, $2, $3, 'admin', $4)
            RETURNING id, sender_role AS "senderRole", body, created_at AS "createdAt"
          `,
          [randomUUID(), req.params.id, req.user!.id, input.body]
        );
        await client.query("UPDATE support_conversation SET updated_at = now() WHERE id = $1", [req.params.id]);
        return message;
      });
      await logAdminAction(req, "admin.support_message.create", { conversationId: req.params.id });
      res.status(201).json({ message: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/support/conversations/:id", requireNateRakelAccount, async (req, res, next) => {
    try {
      const input = supportStatusSchema.parse(req.body);
      const conversationId = String(req.params.id);
      const result = await query(
        `
          UPDATE support_conversation
          SET status = $2,
              closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END,
              updated_at = now()
          WHERE id = $1
          RETURNING id, category, status, created_at AS "createdAt", updated_at AS "updatedAt", closed_at AS "closedAt"
        `,
        [conversationId, input.status]
      );
      if (!result.rows[0]) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      let transcriptSent = false;
      if (input.status === "closed" && input.sendTranscript) {
        await sendSupportTranscript(conversationId);
        transcriptSent = true;
      }
      await logAdminAction(req, "admin.support_conversation.status", { conversationId, status: input.status });
      res.json({ conversation: result.rows[0], transcriptSent });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/user-display-map", requireNateRakelAccount, async (req, res, next) => {
    try {
      const result = await query<{
        id: string;
        username: string;
        email: string | null;
        displayName: string | null;
        leaderboardDisplayName: string | null;
        leaderboardRank: number | null;
        fullName: string | null;
        role: "player" | "admin" | "system";
        createdAt: string;
      }>(
        `
          WITH current_week AS (
            SELECT (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date AS week_start
          ),
          wager_profit AS (
            SELECT
              w.weekly_entry_id,
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
          ranked AS (
            SELECT
              u.id,
              (row_number() OVER (
                ORDER BY e.starting_bankroll_cents + COALESCE(wp.settled_profit_cents, 0) DESC, COALESCE(wp.settled_profit_cents, 0) DESC
              ))::int AS rank
            FROM weekly_entry e
            JOIN app_user u ON u.id = e.user_id
            LEFT JOIN wager_profit wp ON wp.weekly_entry_id = e.id
            JOIN current_week cw ON cw.week_start = e.week_starts_on
            WHERE u.role = 'player'
          )
          SELECT
            u.id,
            u.username,
            u.email,
            u.display_name AS "displayName",
            CASE
              WHEN r.rank IS NULL THEN NULL
              ELSE COALESCE(NULLIF(u.display_name, ''), 'Player ' || r.rank::text)
            END AS "leaderboardDisplayName",
            r.rank AS "leaderboardRank",
            u.full_name AS "fullName",
            u.role,
            u.created_at AS "createdAt"
          FROM app_user u
          LEFT JOIN ranked r ON r.id = u.id
          WHERE u.role <> 'system'
          ORDER BY r.rank ASC NULLS LAST, lower(COALESCE(NULLIF(u.display_name, ''), u.username)), lower(u.username)
        `
      );
      await logAdminAction(req, "admin.user_display_map.view", { rowCount: result.rowCount });
      res.json({ users: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/visitors", requireNateRakelAccount, async (req, res, next) => {
    try {
      const metrics = await getVisitorMetrics();
      await logAdminAction(req, "admin.visitors.view", {
        generatedAt: metrics.generatedAt,
        lastUpdatedAt: metrics.lastUpdatedAt
      });
      res.json(metrics);
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/eligibility", requireNateRakelAccount, async (req, res, next) => {
    try {
      const requestedWeekStart = typeof req.query.weekStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.weekStart)
        ? req.query.weekStart
        : null;
      const weeks = await query<{ weekStart: string; isCurrent: boolean }>(
        `
          WITH current_week AS (
            SELECT (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date AS week_start
          )
          SELECT
            week_start::text AS "weekStart",
            week_start = (SELECT week_start FROM current_week) AS "isCurrent"
          FROM (
            SELECT week_starts_on AS week_start FROM weekly_entry
            UNION
            SELECT week_starts_on AS week_start FROM weekly_prize
            UNION
            SELECT week_start FROM current_week
          ) weeks
          ORDER BY week_start DESC
        `
      );
      const currentWeek = weeks.rows.find((week) => week.isCurrent);
      const selectedWeekStart = requestedWeekStart ?? currentWeek?.weekStart ?? weeks.rows[0]?.weekStart ?? centralDate();
      const result = await query(
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
          rows AS (
            SELECT
              u.id AS user_id,
              u.username,
              u.display_name,
              u.role,
              u.email_verified,
              e.id IS NOT NULL AS has_weekly_entry,
              COALESCE(wa.weekly_wagers, 0)::int AS weekly_wagers,
              COALESCE(wa.weekly_stake_cents, 0)::int AS weekly_stake_cents,
              (COALESCE(e.starting_bankroll_cents, $3::int) * 1.5)::int AS required_stake_cents,
              COALESCE(e.starting_bankroll_cents, $3::int)
                + (
                  SELECT COALESCE(sum(boost.amount_cents), 0)::int
                  FROM referral_bankroll_boost boost
                  WHERE boost.referrer_user_id = u.id
                    AND boost.status = 'used'
                    AND boost.used_week_starts_on = (SELECT week_start FROM selected_week)
                )
                + COALESCE(e.settled_profit_cents, 0) AS leaderboard_cents,
              COALESCE(e.settled_profit_cents, 0)::int AS settled_profit_cents,
              (
                SELECT count(*)::int
                FROM referral_bankroll_boost boost
                WHERE boost.referrer_user_id = u.id
                  AND boost.status = 'used'
                  AND boost.used_week_starts_on = (SELECT week_start FROM selected_week)
              ) AS referral_boosts_used
            FROM app_user u
            CROSS JOIN selected_week sw
            LEFT JOIN weekly_entry e ON e.user_id = u.id AND e.week_starts_on = sw.week_start
            LEFT JOIN wager_activity wa ON wa.weekly_entry_id = e.id
            WHERE u.role IN ('player', 'system')
          )
          SELECT
            user_id AS "userId",
            COALESCE(NULLIF(display_name, ''), CASE WHEN role = 'system' THEN 'StakeWars Chine' ELSE username END) AS "displayName",
            username,
            role,
            (row_number() OVER (ORDER BY leaderboard_cents DESC, settled_profit_cents DESC))::int AS rank,
            leaderboard_cents AS "balanceCents",
            settled_profit_cents AS "settledProfitCents",
            email_verified AS "emailVerified",
            weekly_wagers AS "weeklyWagers",
            weekly_stake_cents AS "weeklyStakeCents",
            required_stake_cents AS "requiredStakeCents",
            referral_boosts_used AS "referralBoostsUsed",
            has_weekly_entry AS "hasWeeklyEntry",
            CASE
              WHEN role = 'system' THEN false
              WHEN (SELECT leaderboard_cents FROM ai) IS NULL THEN false
              ELSE leaderboard_cents > (SELECT leaderboard_cents FROM ai)
            END AS "beatAi",
            CASE
              WHEN role = 'system' THEN false
              WHEN email_verified
                AND weekly_wagers >= 10
                AND weekly_stake_cents >= required_stake_cents
                AND (SELECT leaderboard_cents FROM ai) IS NOT NULL
                AND leaderboard_cents > (SELECT leaderboard_cents FROM ai)
              THEN true
              ELSE false
            END AS eligible
          FROM rows
          ORDER BY leaderboard_cents DESC, settled_profit_cents DESC
        `,
        [config.aiUsername, selectedWeekStart, config.weeklyBankrollCents]
      );
      await logAdminAction(req, "admin.eligibility.view", { weekStart: selectedWeekStart, rowCount: result.rowCount });
      res.json({ weekStart: selectedWeekStart, weeks: weeks.rows, rows: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/chine-model-audit", requireNateRakelAccount, async (req, res, next) => {
    try {
      const since = optionalDateParam.parse(typeof req.query.since === "string" ? req.query.since : undefined) ?? null;
      const through = optionalDateParam.parse(typeof req.query.through === "string" ? req.query.through : undefined) ?? null;
      const audit = await getChineModelAudit({ since, through });
      await logAdminAction(req, "admin.chine_model_audit.view", {
        since,
        through,
        settledPicks: audit.summary[0]?.picks ?? 0
      });
      res.json(audit);
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/podcast", requireNateRakelAccount, async (req, res, next) => {
    try {
      const date = optionalDateParam.parse(typeof req.query.date === "string" ? req.query.date : undefined) ?? centralDate();
      const result = await query<PodcastPickRow>(
        `
          SELECT
            p.id,
            p.selected_team AS "selectedTeam",
            p.published_for::text AS "publishedFor",
            p.score,
            p.confidence,
            p.reasons,
            p.features,
            p.explanation,
            p.locked_at AS "lockedAt",
            p.wager_id AS "wagerId",
            p.model_version AS "modelVersion",
            p.locked_odds_american AS "lockedOddsAmerican",
            p.locked_spread::text AS "lockedSpread",
            p.locked_line_captured_at AS "lockedLineCapturedAt",
            p.closing_odds_american AS "closingOddsAmerican",
            p.closing_spread::text AS "closingSpread",
            p.closing_captured_at AS "closingCapturedAt",
            w.status::text AS "wagerStatus",
            w.stake_cents AS "stakeCents",
            w.potential_payout_cents AS "potentialReturnCents",
            gl.sport,
            gl.league,
            gl.starts_at AS "startsAt",
            gl.home_team AS "homeTeam",
            gl.away_team AS "awayTeam",
            gl.spread::text AS spread,
            gl.odds_american AS "oddsAmerican",
            gl.market_key AS "marketKey"
          FROM ai_pick p
          JOIN game_line gl ON gl.id = p.game_line_id
          LEFT JOIN wager w ON w.id = p.wager_id
          WHERE p.published_for = $1::date
          ORDER BY p.confidence DESC NULLS LAST, p.score DESC NULLS LAST, gl.starts_at ASC
        `,
        [date]
      );
      const body = buildPodcastMarkdown(date, result.rows);
      await logAdminAction(req, "admin.podcast.download", { date, picks: result.rowCount });
      res.setHeader("content-type", "text/markdown; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="stakewars-chine-podcast-${date}.md"`);
      res.send(body);
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/prizes", requireNateRakelAccount, async (req, res, next) => {
    try {
      const current = currentWeekStart();
      const next = new Date(`${current}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 7);
      const nextWeek = next.toISOString().slice(0, 10);
      const result = await query<{
        weekStart: string;
        cashPrizeCents: number;
        firstPlaceBonus: string | null;
        updatedAt: string;
      }>(
        `
          SELECT
            week_starts_on::text AS "weekStart",
            cash_prize_cents AS "cashPrizeCents",
            first_place_bonus AS "firstPlaceBonus",
            updated_at AS "updatedAt"
          FROM weekly_prize
          WHERE week_starts_on >= ($1::date - interval '4 weeks')
          ORDER BY week_starts_on DESC
          LIMIT 12
        `,
        [current]
      );
      await logAdminAction(req, "admin.prizes.view", { rowCount: result.rowCount });
      res.json({ currentWeekStart: current, nextWeekStart: nextWeek, prizes: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/rewards", requireNateRakelAccount, async (req, res, next) => {
    try {
      const result = await query<{
        id: string;
        weekStart: string;
        userId: string;
        username: string;
        displayName: string | null;
        rank: number;
        sharePercent: number;
        rewardCents: number;
        firstPlaceBonus: string | null;
        bonusSelection: string | null;
        bonusSize: string | null;
        shippingName: string | null;
        shippingAddressLine1: string | null;
        shippingAddressLine2: string | null;
        shippingCity: string | null;
        shippingRegion: string | null;
        shippingPostalCode: string | null;
        shippingCountry: string | null;
        bonusFulfillmentSubmittedAt: string | null;
        bonusFulfilledAt: string | null;
        bonusFulfillmentMessage: string | null;
      }>(
        `
          SELECT
            a.id,
            a.week_starts_on::text AS "weekStart",
            u.id AS "userId",
            u.username,
            COALESCE(NULLIF(u.display_name, ''), NULLIF(u.full_name, ''), u.username) AS "displayName",
            a.rank,
            a.share_percent AS "sharePercent",
            a.reward_cents AS "rewardCents",
            a.first_place_bonus AS "firstPlaceBonus",
            a.bonus_selection AS "bonusSelection",
            a.bonus_size AS "bonusSize",
            a.shipping_name AS "shippingName",
            a.shipping_address_line1 AS "shippingAddressLine1",
            a.shipping_address_line2 AS "shippingAddressLine2",
            a.shipping_city AS "shippingCity",
            a.shipping_region AS "shippingRegion",
            a.shipping_postal_code AS "shippingPostalCode",
            a.shipping_country AS "shippingCountry",
            a.bonus_fulfillment_submitted_at AS "bonusFulfillmentSubmittedAt",
            a.bonus_fulfilled_at AS "bonusFulfilledAt",
            a.bonus_fulfillment_message AS "bonusFulfillmentMessage"
          FROM weekly_reward_award a
          JOIN app_user u ON u.id = a.user_id
          WHERE a.first_place_bonus IS NOT NULL
          ORDER BY a.week_starts_on DESC, a.rank ASC
          LIMIT 100
        `
      );
      await logAdminAction(req, "admin.rewards.view", { rowCount: result.rowCount });
      res.json({
        rewards: result.rows.map((award) => ({
          ...award,
          bonusOptions: bonusOptionsFromText(award.firstPlaceBonus)
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/reward-withdrawals", requireNateRakelAccount, async (req, res, next) => {
    try {
      const result = await query<{
        id: string;
        userId: string;
        username: string;
        displayName: string | null;
        email: string | null;
        rewardBalanceCents: number;
        amountCents: number;
        payoutMethod: "paypal" | "venmo";
        payoutHandle: string;
        phoneLast4: string;
        status: "pending" | "completed" | "canceled";
        requestedAt: string;
        completedAt: string | null;
      }>(
        `
          SELECT
            r.id,
            u.id AS "userId",
            u.username,
            COALESCE(NULLIF(u.display_name, ''), NULLIF(u.full_name, ''), u.username) AS "displayName",
            u.email,
            u.reward_balance_cents AS "rewardBalanceCents",
            r.amount_cents AS "amountCents",
            r.payout_method AS "payoutMethod",
            r.payout_handle AS "payoutHandle",
            r.phone_last4 AS "phoneLast4",
            r.status,
            r.requested_at AS "requestedAt",
            r.completed_at AS "completedAt"
          FROM reward_withdrawal_request r
          JOIN app_user u ON u.id = r.user_id
          WHERE r.status = 'pending'
             OR r.requested_at >= now() - interval '30 days'
          ORDER BY
            CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END,
            r.requested_at DESC
          LIMIT 100
        `
      );
      await logAdminAction(req, "admin.reward_withdrawals.view", { rowCount: result.rowCount });
      res.json({ withdrawals: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/reward-withdrawals/:id/fulfill", requireNateRakelAccount, async (req, res, next) => {
    try {
      const withdrawalId = z.uuid().parse(req.params.id);
      const completed = await transaction(async (client) => {
        const result = await client.query<{
          id: string;
          userId: string;
          username: string;
          displayName: string | null;
          email: string | null;
          rewardBalanceCents: number;
          amountCents: number;
          payoutMethod: "paypal" | "venmo";
          payoutHandle: string;
          phoneLast4: string;
          status: "pending" | "completed" | "canceled";
          requestedAt: string;
          completedAt: string | null;
        }>(
          `
            SELECT
              r.id,
              u.id AS "userId",
              u.username,
              COALESCE(NULLIF(u.display_name, ''), NULLIF(u.full_name, ''), u.username) AS "displayName",
              u.email,
              u.reward_balance_cents AS "rewardBalanceCents",
              r.amount_cents AS "amountCents",
              r.payout_method AS "payoutMethod",
              r.payout_handle AS "payoutHandle",
              r.phone_last4 AS "phoneLast4",
              r.status,
              r.requested_at AS "requestedAt",
              r.completed_at AS "completedAt"
            FROM reward_withdrawal_request r
            JOIN app_user u ON u.id = r.user_id
            WHERE r.id = $1
            FOR UPDATE OF r, u
          `,
          [withdrawalId]
        );
        const withdrawal = result.rows[0];
        if (!withdrawal) {
          throw new WagerValidationError("Withdrawal request not found.", "WITHDRAWAL_NOT_FOUND", 404);
        }
        if (withdrawal.status !== "pending") {
          throw new WagerValidationError("This withdrawal is no longer pending.", "WITHDRAWAL_NOT_PENDING");
        }
        if (withdrawal.rewardBalanceCents < withdrawal.amountCents) {
          throw new WagerValidationError("User reward balance is lower than the pending withdrawal amount.", "WITHDRAWAL_BALANCE_CHANGED");
        }

        await client.query(
          "UPDATE app_user SET reward_balance_cents = reward_balance_cents - $2 WHERE id = $1",
          [withdrawal.userId, withdrawal.amountCents]
        );
        const updatedResult = await client.query<typeof withdrawal>(
          `
            UPDATE reward_withdrawal_request
            SET status = 'completed',
                completed_at = now()
            WHERE id = $1
            RETURNING
              id,
              $2::uuid AS "userId",
              $3::text AS username,
              $4::text AS "displayName",
              $5::text AS email,
              ($6::integer - amount_cents) AS "rewardBalanceCents",
              amount_cents AS "amountCents",
              payout_method AS "payoutMethod",
              payout_handle AS "payoutHandle",
              phone_last4 AS "phoneLast4",
              status,
              requested_at AS "requestedAt",
              completed_at AS "completedAt"
          `,
          [
            withdrawal.id,
            withdrawal.userId,
            withdrawal.username,
            withdrawal.displayName,
            withdrawal.email,
            withdrawal.rewardBalanceCents
          ]
        );
        return updatedResult.rows[0];
      });

      if (completed.email) {
        const emailBody = rewardWithdrawalFulfilledEmailBody({
          playerName: completed.displayName ?? completed.username,
          amountCents: completed.amountCents,
          payoutMethod: completed.payoutMethod,
          payoutHandle: completed.payoutHandle
        });
        await sendMail({
          to: [{ email: completed.email, name: completed.displayName ?? undefined }],
          subject: "Your StakeWars withdrawal has been fulfilled",
          text: emailBody.text,
          html: emailBody.html
        });
      }
      await logAdminAction(req, "admin.reward_withdrawal.fulfill", {
        withdrawalId,
        userId: completed.userId,
        amountCents: completed.amountCents
      });
      res.json({ withdrawal: completed });
    } catch (error) {
      if (error instanceof WagerValidationError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    }
  });

  router.post("/admin/rewards/:id/fulfill", requireNateRakelAccount, async (req, res, next) => {
    try {
      const rewardId = z.uuid().parse(req.params.id);
      const input = bonusFulfillmentCompleteSchema.parse(req.body);
      const existing = await query<{
        id: string;
        weekStart: string;
        userId: string;
        username: string;
        email: string | null;
        displayName: string | null;
        rank: number;
        sharePercent: number;
        rewardCents: number;
        firstPlaceBonus: string | null;
        bonusSelection: string | null;
        bonusSize: string | null;
        shippingName: string | null;
        shippingAddressLine1: string | null;
        shippingAddressLine2: string | null;
        shippingCity: string | null;
        shippingRegion: string | null;
        shippingPostalCode: string | null;
        shippingCountry: string | null;
        bonusFulfillmentSubmittedAt: string | null;
        bonusFulfilledAt: string | null;
        bonusFulfillmentMessage: string | null;
      }>(
        `
          SELECT
            a.id,
            a.week_starts_on::text AS "weekStart",
            u.id AS "userId",
            u.username,
            u.email,
            COALESCE(NULLIF(u.display_name, ''), NULLIF(u.full_name, ''), u.username) AS "displayName",
            a.rank,
            a.share_percent AS "sharePercent",
            a.reward_cents AS "rewardCents",
            a.first_place_bonus AS "firstPlaceBonus",
            a.bonus_selection AS "bonusSelection",
            a.bonus_size AS "bonusSize",
            a.shipping_name AS "shippingName",
            a.shipping_address_line1 AS "shippingAddressLine1",
            a.shipping_address_line2 AS "shippingAddressLine2",
            a.shipping_city AS "shippingCity",
            a.shipping_region AS "shippingRegion",
            a.shipping_postal_code AS "shippingPostalCode",
            a.shipping_country AS "shippingCountry",
            a.bonus_fulfillment_submitted_at AS "bonusFulfillmentSubmittedAt",
            a.bonus_fulfilled_at AS "bonusFulfilledAt",
            a.bonus_fulfillment_message AS "bonusFulfillmentMessage"
          FROM weekly_reward_award a
          JOIN app_user u ON u.id = a.user_id
          WHERE a.id = $1
        `,
        [rewardId]
      );
      const award = existing.rows[0];
      if (!award) {
        res.status(404).json({ error: "Reward not found" });
        return;
      }
      if (award.bonusFulfilledAt) {
        res.status(400).json({ error: "This reward has already been marked fulfilled." });
        return;
      }
      if (!award.email) {
        res.status(400).json({ error: "Winner does not have an email address." });
        return;
      }
      if (!award.bonusSelection || !award.shippingName || !award.shippingAddressLine1 || !award.shippingCity || !award.shippingRegion || !award.shippingPostalCode || !award.shippingCountry) {
        res.status(400).json({ error: "Winner must submit reward selection and shipping details before fulfillment." });
        return;
      }

      const emailBody = rewardFulfilledEmailBody({
        playerName: award.displayName ?? award.username,
        rewardText: award.firstPlaceBonus ?? award.bonusSelection ?? "StakeWars reward",
        bonusSelection: award.bonusSelection,
        bonusSize: award.bonusSize,
        message: input.message
      });
      await sendMail({
        to: [{ email: award.email, name: award.displayName ?? undefined }],
        subject: "Your StakeWars reward has been fulfilled",
        text: emailBody.text,
        html: emailBody.html
      });

      const updatedResult = await query<typeof award>(
        `
          UPDATE weekly_reward_award
          SET bonus_fulfilled_at = now(),
              bonus_fulfillment_message = $2
          WHERE id = $1
          RETURNING
            id,
            week_starts_on::text AS "weekStart",
            user_id AS "userId",
            $3::text AS username,
            $4::text AS email,
            $5::text AS "displayName",
            rank,
            share_percent AS "sharePercent",
            reward_cents AS "rewardCents",
            first_place_bonus AS "firstPlaceBonus",
            bonus_selection AS "bonusSelection",
            bonus_size AS "bonusSize",
            shipping_name AS "shippingName",
            shipping_address_line1 AS "shippingAddressLine1",
            shipping_address_line2 AS "shippingAddressLine2",
            shipping_city AS "shippingCity",
            shipping_region AS "shippingRegion",
            shipping_postal_code AS "shippingPostalCode",
            shipping_country AS "shippingCountry",
            bonus_fulfillment_submitted_at AS "bonusFulfillmentSubmittedAt",
            bonus_fulfilled_at AS "bonusFulfilledAt",
            bonus_fulfillment_message AS "bonusFulfillmentMessage"
        `,
        [rewardId, input.message, award.username, award.email, award.displayName]
      );
      const updated = updatedResult.rows[0];
      await logAdminAction(req, "admin.reward.fulfill", { rewardId, userId: award.userId });
      res.json({
        reward: {
          ...updated,
          bonusOptions: bonusOptionsFromText(updated.firstPlaceBonus)
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/admin/prizes", requireNateRakelAccount, async (req, res, next) => {
    try {
      const input = weeklyPrizeSchema.parse(req.body);
      const week = new Date(`${input.weekStart}T00:00:00Z`);
      if (Number.isNaN(week.getTime()) || week.getUTCDay() !== 1) {
        res.status(400).json({ error: "Week start must be a Monday" });
        return;
      }
      const result = await query<{
        weekStart: string;
        cashPrizeCents: number;
        firstPlaceBonus: string | null;
        updatedAt: string;
      }>(
        `
          INSERT INTO weekly_prize (week_starts_on, cash_prize_cents, first_place_bonus)
          VALUES ($1::date, $2, NULLIF($3, ''))
          ON CONFLICT (week_starts_on) DO UPDATE
          SET cash_prize_cents = EXCLUDED.cash_prize_cents,
              first_place_bonus = EXCLUDED.first_place_bonus,
              updated_at = now()
          RETURNING
            week_starts_on::text AS "weekStart",
            cash_prize_cents AS "cashPrizeCents",
            first_place_bonus AS "firstPlaceBonus",
            updated_at AS "updatedAt"
        `,
        [input.weekStart, input.cashPrizeCents, input.firstPlaceBonus?.trim() ?? null]
      );
      await logAdminAction(req, "admin.prizes.update", {
        weekStart: input.weekStart,
        cashPrizeCents: input.cashPrizeCents,
        hasFirstPlaceBonus: Boolean(input.firstPlaceBonus?.trim())
      });
      res.json({ prize: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/me/profile", requireAuth, async (req, res, next) => {
    try {
      const input = profileSchema.parse(req.body);
      const existing = await query<{ email: string | null; emailVerified: boolean; lastEmailChangeAt: string | null }>(
        "SELECT email, email_verified AS \"emailVerified\", last_email_change_at AS \"lastEmailChangeAt\" FROM app_user WHERE id = $1",
        [req.user!.id]
      );
      const current = existing.rows[0];
      const emailChanged = (current?.email ?? "").trim().toLowerCase() !== (input.email ?? "").trim().toLowerCase();
      if (emailChanged && current?.email) {
        const lastEmailChangeAt = current.lastEmailChangeAt ? new Date(current.lastEmailChangeAt) : null;
        const nextAllowedAt = lastEmailChangeAt ? new Date(lastEmailChangeAt.getTime() + 24 * 60 * 60 * 1000) : null;
        if (nextAllowedAt && nextAllowedAt.getTime() > Date.now()) {
          res.status(429).json({
            error: `Email can only be changed once every 24 hours. Try again after ${nextAllowedAt.toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" })} CT.`,
            retryAt: nextAllowedAt.toISOString()
          });
          return;
        }
      }
      if (current?.emailVerified && emailChanged && !input.allowEmailChange) {
        res.status(409).json({ error: "Verified email is locked. Use Change Email before saving a new address." });
        return;
      }
      const shouldPrepareEmailChange = Boolean(
        current?.emailVerified
        && emailChanged
        && current.email
        && input.email
      );
      if (shouldPrepareEmailChange) {
        await query(
          "UPDATE email_verification_code SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
          [req.user!.id]
        );
        await consumeEmailChangeRecoveryTokens(req.user!.id);
        const newEmailVerificationToken = await createVerificationToken(req.user!.id, input.email!);
        const recoveryToken = await createEmailChangeRecoveryToken(req.user!.id, current!.email!, input.email!);
        try {
          await sendVerificationLinkWithToken(req.user!.id, input.email!, newEmailVerificationToken);
          await sendEmailChangeRecoveryNoticeWithToken(req.user!.id, current!.email!, input.email!, recoveryToken);
        } catch (deliveryError) {
          await query(
            "UPDATE email_verification_code SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
            [req.user!.id]
          );
          await consumeEmailChangeRecoveryTokens(req.user!.id);
          console.error("Email change delivery failed", deliveryError);
          res.status(400).json({ error: "Could not send the verification email. Your email was not changed." });
          return;
        }
      }
      const result = await query<{
        id: string;
        username: string;
        fullName: string | null;
        email: string | null;
        emailVerified: boolean;
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
              email_verified = CASE
                WHEN coalesce(lower(trim(email)), '') = coalesce(lower(trim($3::text)), '') THEN email_verified
                ELSE false
              END,
              email_verified_at = CASE
                WHEN coalesce(lower(trim(email)), '') = coalesce(lower(trim($3::text)), '') THEN email_verified_at
                ELSE NULL
              END,
              last_email_change_at = CASE
                WHEN coalesce(trim(email), '') <> ''
                 AND coalesce(lower(trim(email)), '') <> coalesce(lower(trim($3::text)), '') THEN now()
                ELSE last_email_change_at
              END,
              display_name = $4,
              payout_method = $5,
              payout_handle = $6,
              phone_last4 = $7
          WHERE id = $1
          RETURNING ${sessionUserSelect}
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
      if (!shouldPrepareEmailChange && emailChanged && user.email && !user.emailVerified) {
        await sendVerificationLink(user.id, user.email);
      }
      res.json({ token: signToken(user), user });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const constraint = (error as { constraint?: string }).constraint;
        res.status(409).json({
          error: constraint === "app_user_display_name_unique_lower_idx"
            ? "Display name is already taken"
            : "Profile value is already taken"
        });
        return;
      }
      next(error);
    }
  });

  router.get("/me/reward-withdrawals", requireAuth, async (req, res, next) => {
    try {
      const result = await query<{
        id: string;
        amountCents: number;
        payoutMethod: "paypal" | "venmo";
        payoutHandle: string;
        phoneLast4: string;
        status: "pending" | "completed" | "canceled";
        requestedAt: string;
        completedAt: string | null;
      }>(
        `
          SELECT
            id,
            amount_cents AS "amountCents",
            payout_method AS "payoutMethod",
            payout_handle AS "payoutHandle",
            phone_last4 AS "phoneLast4",
            status,
            requested_at AS "requestedAt",
            completed_at AS "completedAt"
          FROM reward_withdrawal_request
          WHERE user_id = $1
          ORDER BY requested_at DESC
          LIMIT 10
        `,
        [req.user!.id]
      );
      res.json({
        withdrawals: result.rows,
        pendingWithdrawal: result.rows.find((withdrawal) => withdrawal.status === "pending") ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/me/reward-withdrawals", requireAuth, async (req, res, next) => {
    try {
      const withdrawal = await transaction(async (client) => {
        const existingPending = await client.query<{ id: string }>(
          "SELECT id FROM reward_withdrawal_request WHERE user_id = $1 AND status = 'pending' LIMIT 1",
          [req.user!.id]
        );
        if ((existingPending.rowCount ?? 0) > 0) {
          throw new WagerValidationError("You already have a pending withdrawal request.", "WITHDRAWAL_PENDING");
        }

        const userResult = await client.query<{
          id: string;
          username: string;
          displayName: string | null;
          email: string | null;
          emailVerified: boolean;
          rewardBalanceCents: number;
          payoutMethod: "none" | "paypal" | "venmo";
          payoutHandle: string | null;
          phoneLast4: string | null;
          role: "player" | "admin" | "system";
        }>(
          `
            SELECT
              id,
              username,
              COALESCE(NULLIF(display_name, ''), NULLIF(full_name, ''), username) AS "displayName",
              email,
              email_verified AS "emailVerified",
              reward_balance_cents AS "rewardBalanceCents",
              payout_method AS "payoutMethod",
              payout_handle AS "payoutHandle",
              phone_last4 AS "phoneLast4",
              role
            FROM app_user
            WHERE id = $1
            FOR UPDATE
          `,
          [req.user!.id]
        );
        const user = userResult.rows[0];
        if (!user) {
          throw new WagerValidationError("User not found.", "USER_NOT_FOUND", 404);
        }
        if (!user.emailVerified) {
          throw new WagerValidationError("Verify your email before requesting a withdrawal.", "EMAIL_NOT_VERIFIED");
        }
        if (user.rewardBalanceCents < 2000) {
          throw new WagerValidationError("Withdrawal requires at least $20.00 in rewards.", "WITHDRAWAL_MINIMUM_NOT_MET");
        }
        if (user.payoutMethod === "none" || !user.payoutHandle || !user.phoneLast4) {
          throw new WagerValidationError("Complete payout method, payout handle, and phone last 4 before requesting a withdrawal.", "PAYOUT_DETAILS_REQUIRED");
        }

        const requestResult = await client.query<{
          id: string;
          amountCents: number;
          payoutMethod: "paypal" | "venmo";
          payoutHandle: string;
          phoneLast4: string;
          status: "pending" | "completed" | "canceled";
          requestedAt: string;
          completedAt: string | null;
        }>(
          `
            INSERT INTO reward_withdrawal_request (
              id,
              user_id,
              amount_cents,
              payout_method,
              payout_handle,
              phone_last4
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING
              id,
              amount_cents AS "amountCents",
              payout_method AS "payoutMethod",
              payout_handle AS "payoutHandle",
              phone_last4 AS "phoneLast4",
              status,
              requested_at AS "requestedAt",
              completed_at AS "completedAt"
          `,
          [randomUUID(), user.id, user.rewardBalanceCents, user.payoutMethod, user.payoutHandle, user.phoneLast4]
        );

        return {
          request: requestResult.rows[0],
          user
        };
      });

      const email = rewardWithdrawalEmailBody({
        displayName: withdrawal.user.displayName ?? withdrawal.user.username,
        username: withdrawal.user.username,
        email: withdrawal.user.email,
        amountCents: withdrawal.request.amountCents,
        payoutMethod: withdrawal.request.payoutMethod,
        payoutHandle: withdrawal.request.payoutHandle,
        phoneLast4: withdrawal.request.phoneLast4,
        requestedAt: new Date(withdrawal.request.requestedAt).toLocaleString("en-US", { timeZone: "America/Chicago" })
      });
      try {
        await sendMail({
          to: [{ email: "support@stakewars.ai", name: "StakeWars Support" }],
          subject: "StakeWars reward withdrawal requested",
          text: email.text,
          html: email.html
        });
      } catch (mailError) {
        console.error("Reward withdrawal notification email failed", mailError);
      }

      const refreshed = await query<{
        id: string;
        username: string;
        fullName: string | null;
        email: string | null;
        emailVerified: boolean;
        displayName: string | null;
        rewardBalanceCents: number;
        payoutMethod: "none" | "paypal" | "venmo";
        payoutHandle: string | null;
        phoneLast4: string | null;
        role: "player" | "admin" | "system";
      }>(
        `SELECT ${sessionUserSelect} FROM app_user WHERE id = $1`,
        [req.user!.id]
      );
      const user = refreshed.rows[0];
      res.json({ request: withdrawal.request, user, token: signToken(user) });
    } catch (error) {
      if (error instanceof WagerValidationError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    }
  });

  router.post("/me/email-verification/send", requireAuth, async (req, res, next) => {
    try {
      const result = await query<{ email: string | null; emailVerified: boolean }>(
        "SELECT email, email_verified AS \"emailVerified\" FROM app_user WHERE id = $1",
        [req.user!.id]
      );
      const user = result.rows[0];
      if (!user?.email) {
        res.status(400).json({ error: "Add an email address before requesting a verification link" });
        return;
      }
      if (user.emailVerified) {
        res.json({ alreadyVerified: true });
        return;
      }
      await sendVerificationLink(req.user!.id, user.email);
      res.json({ sent: true, email: user.email });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/reddit/status", requireNateRakelAccount, async (req, res, next) => {
    try {
      const locks = await getTodayRedditLockStatus();
      res.json({
        configured: true,
        mode: "manual",
        connected: false,
        redditUsername: null,
        connectedAt: null,
        scopes: [],
        defaultSubreddits: config.redditDefaultSubreddits,
        locks
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/reddit/preview", requireNateRakelAccount, async (req, res, next) => {
    try {
      const input = redditPreviewSchema.parse(req.body);
      const preview = input.postType === "parlay"
        ? await buildRedditParlayPreview(input.subreddit)
        : input.postType === "all"
          ? await buildRedditAllPicksPreview(input.subreddit)
          : await buildRedditPreview(input.subreddit);
      await logAdminAction(req, "admin.reddit.preview", {
        subreddit: preview.subreddit,
        postType: input.postType,
        titleLength: preview.title.length,
        bodyLength: preview.body.length
      });
      res.json({ preview });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/reddit/lock", requireNateRakelAccount, async (req, res, next) => {
    try {
      const input = redditLockSchema.parse(req.body);
      const result = await lockRedditPostTracking({
        userId: req.user!.id,
        postType: input.postType,
        title: input.title,
        body: input.body
      });
      await logAdminAction(req, "admin.reddit.lock", {
        postType: input.postType,
        trackingId: result.id,
        titleLength: input.title.length,
        bodyLength: input.body.length
      });
      res.json(result);
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
          WITH active_lines AS (
            SELECT *
            FROM (
              SELECT
                gl.*,
                row_number() OVER (
                  PARTITION BY gl.sport
                  ORDER BY gl.starts_at ASC, gl.provider_event_id ASC NULLS LAST, gl.market_key ASC, gl.id ASC
                ) AS sport_row_number
              FROM game_line gl
              WHERE gl.is_active = true
                AND gl.starts_at > now()
                AND gl.sport <> 'WORLDCUP'
            ) ranked
            WHERE sport_row_number <= 240
          )
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
          FROM active_lines gl
          LEFT JOIN LATERAL (
            SELECT *
            FROM mlb_game_context candidate
            WHERE candidate.starts_on = (gl.starts_at AT TIME ZONE 'UTC')::date
              AND regexp_replace(lower(candidate.away_team), '^(oakland|the)\\s+', '') = regexp_replace(lower(gl.away_team), '^(oakland|the)\\s+', '')
              AND regexp_replace(lower(candidate.home_team), '^(oakland|the)\\s+', '') = regexp_replace(lower(gl.home_team), '^(oakland|the)\\s+', '')
              AND abs(extract(epoch from candidate.starts_at - gl.starts_at)) <= 10800
            ORDER BY abs(extract(epoch from candidate.starts_at - gl.starts_at)) ASC
            LIMIT 1
          ) mgc ON true
          ORDER BY gl.starts_at ASC
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
        const eventKey = gameEventKey(row);
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
      const needsMlbPitcherFallback = result.rows.some((row) =>
        row.sport === "MLB" && (!row.awayProbablePitcherName || !row.homeProbablePitcherName)
      );
      const mlbDates = result.rows
        .filter((row) => row.sport === "MLB")
        .map((row) => yyyyMmDd(row.startsAt));
      const mlbPitcherFallbacks = needsMlbPitcherFallback && mlbDates.length
        ? await fetchMlbProbablePitcherFallbacks(
          addDays(mlbDates.sort()[0], -1),
          addDays(mlbDates.sort()[mlbDates.length - 1], 1)
        ).catch((error) => {
          console.error("MLB probable pitcher fallback failed", error);
          return [] as MlbProbablePitcherFallback[];
        })
        : [];

      for (const market of markets) {
        const sourceRow = result.rows.find((row) => {
          const rowEventKey = gameEventKey(row);
          return rowEventKey === market.eventKey;
        });
        const fallback = market.sport === "MLB"
          ? findMlbPitcherFallback(market, mlbPitcherFallbacks)
          : null;
        const game = gameMap.get(market.eventKey) ?? {
          eventKey: market.eventKey,
          sport: market.sport,
          league: market.league,
          startsAt: market.startsAt,
          homeTeam: market.homeTeam,
          awayTeam: market.awayTeam,
          awayProbablePitcher: sourceRow ? {
            id: sourceRow.awayProbablePitcherId ?? fallback?.awayProbablePitcher?.id ?? null,
            name: sourceRow.awayProbablePitcherName || fallback?.awayProbablePitcher?.name || null,
            wins: sourceRow.awayPitcherWins === null ? null : Number(sourceRow.awayPitcherWins),
            losses: sourceRow.awayPitcherLosses === null ? null : Number(sourceRow.awayPitcherLosses),
            era: sourceRow.awayPitcherEra === null ? null : Number(sourceRow.awayPitcherEra)
          } : fallback?.awayProbablePitcher ? {
            id: fallback.awayProbablePitcher.id,
            name: fallback.awayProbablePitcher.name,
            wins: null,
            losses: null,
            era: null
          } : null,
          homeProbablePitcher: sourceRow ? {
            id: sourceRow.homeProbablePitcherId ?? fallback?.homeProbablePitcher?.id ?? null,
            name: sourceRow.homeProbablePitcherName || fallback?.homeProbablePitcher?.name || null,
            wins: sourceRow.homePitcherWins === null ? null : Number(sourceRow.homePitcherWins),
            losses: sourceRow.homePitcherLosses === null ? null : Number(sourceRow.homePitcherLosses),
            era: sourceRow.homePitcherEra === null ? null : Number(sourceRow.homePitcherEra)
          } : fallback?.homeProbablePitcher ? {
            id: fallback.homeProbablePitcher.id,
            name: fallback.homeProbablePitcher.name,
            wins: null,
            losses: null,
            era: null
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

  router.get("/leaderboard", optionalAuth, async (req, res, next) => {
    try {
      const requestedWeekStart = typeof req.query.weekStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.weekStart)
        ? req.query.weekStart
        : null;
      const weeks = await query(
        `
          WITH current_week AS (
            SELECT (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date AS week_start
          )
          SELECT
            week_start::text AS "weekStart",
            week_start = (SELECT week_start FROM current_week) AS "isCurrent"
          FROM (
            SELECT week_starts_on AS week_start FROM weekly_entry
            UNION
            SELECT week_starts_on AS week_start FROM weekly_prize
            UNION
            SELECT week_start FROM current_week
          ) weeks
          ORDER BY week_start DESC
        `
      );
      const result = await query(
        `
          WITH current_week AS (
            SELECT (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date AS week_start
          ),
          selected_week AS (
            SELECT COALESCE($2::date, (SELECT week_start FROM current_week)) AS week_start
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
            SELECT e.starting_bankroll_cents
              + CASE
                WHEN sw.week_start = (SELECT week_start FROM current_week)
                THEN e.settled_profit_cents
                ELSE e.settled_profit_cents
              END AS leaderboard_cents
            FROM weekly_entry e
            JOIN app_user u ON u.id = e.user_id
            LEFT JOIN wager_activity wa ON wa.weekly_entry_id = e.id
            JOIN selected_week sw ON sw.week_start = e.week_starts_on
            WHERE u.username = $1
            LIMIT 1
          ),
          ranked AS (
            SELECT
              u.display_name,
              u.id AS user_id,
              u.role,
              u.email_verified,
              coalesce(wa.weekly_wagers, 0) AS weekly_wagers,
              coalesce(wa.weekly_stake_cents, 0) AS weekly_stake_cents,
              (e.starting_bankroll_cents * 1.5)::int AS required_stake_cents,
              e.starting_bankroll_cents
                + (
                  SELECT COALESCE(sum(boost.amount_cents), 0)::int
                  FROM referral_bankroll_boost boost
                  WHERE boost.referrer_user_id = u.id
                    AND boost.status = 'used'
                    AND boost.used_week_starts_on = e.week_starts_on
                )
                + CASE
                  WHEN sw.week_start = (SELECT week_start FROM current_week)
                  THEN e.settled_profit_cents
                  ELSE e.settled_profit_cents
                END AS leaderboard_cents,
              CASE
                WHEN sw.week_start = (SELECT week_start FROM current_week)
                THEN e.settled_profit_cents
                ELSE e.settled_profit_cents
              END AS settled_profit_cents,
              (
                SELECT count(*)::int
                FROM referral_bankroll_boost boost
                WHERE boost.referrer_user_id = u.id
                  AND boost.status = 'used'
                  AND boost.used_week_starts_on = e.week_starts_on
              ) AS referral_boosts_used
            FROM weekly_entry e
            JOIN app_user u ON u.id = e.user_id
            LEFT JOIN wager_activity wa ON wa.weekly_entry_id = e.id
            JOIN selected_week sw ON sw.week_start = e.week_starts_on
            WHERE u.role IN ('player', 'system')
          )
          SELECT
            (row_number() OVER (ORDER BY leaderboard_cents DESC, settled_profit_cents DESC))::int AS rank,
            CASE
              WHEN role = 'system' THEN COALESCE(NULLIF(display_name, ''), 'StakeWars Chine')
              ELSE COALESCE(NULLIF(display_name, ''), 'Player ' || (row_number() OVER (ORDER BY leaderboard_cents DESC, settled_profit_cents DESC))::text)
            END AS "displayName",
            leaderboard_cents AS "balanceCents",
            settled_profit_cents AS "settledProfitCents",
            role,
            coalesce(user_id = $3::uuid, false) AS "isCurrentUser",
            CASE WHEN user_id = $3::uuid THEN weekly_wagers ELSE NULL END AS "weeklyWagers",
            CASE WHEN user_id = $3::uuid THEN weekly_stake_cents ELSE NULL END AS "weeklyStakeCents",
            CASE WHEN user_id = $3::uuid THEN required_stake_cents ELSE NULL END AS "requiredStakeCents",
            referral_boosts_used AS "referralBoostsUsed",
            CASE WHEN user_id = $3::uuid THEN email_verified ELSE NULL END AS "emailVerified",
            CASE
              WHEN role = 'system' THEN false
              WHEN (SELECT leaderboard_cents FROM ai) IS NULL THEN false
              ELSE leaderboard_cents > (SELECT leaderboard_cents FROM ai)
            END AS "beatAi",
            CASE
              WHEN role = 'system' THEN false
              WHEN email_verified
                AND weekly_wagers >= 10
                AND weekly_stake_cents >= required_stake_cents
                AND (SELECT leaderboard_cents FROM ai) IS NOT NULL
                AND leaderboard_cents > (SELECT leaderboard_cents FROM ai)
              THEN true
              ELSE false
            END AS eligible
          FROM ranked
          ORDER BY leaderboard_cents DESC, settled_profit_cents DESC
          LIMIT 100
        `,
        [config.aiUsername, requestedWeekStart, req.user?.id ?? null]
      );
      const registeredPlayers = await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app_user WHERE role = 'player'"
      );
      const currentWeek = weeks.rows.find((week) => week.isCurrent) as { weekStart: string; isCurrent: boolean } | undefined;
      const selectedWeekStart = requestedWeekStart ?? currentWeek?.weekStart ?? null;
      const prize = selectedWeekStart
        ? await query<{ cashPrizeCents: number; firstPlaceBonus: string | null }>(
          `
            SELECT
              cash_prize_cents AS "cashPrizeCents",
              first_place_bonus AS "firstPlaceBonus"
            FROM weekly_prize
            WHERE week_starts_on = $1::date
          `,
          [selectedWeekStart]
        )
        : { rows: [] as Array<{ cashPrizeCents: number; firstPlaceBonus: string | null }> };
      const weeklyPrize = prize.rows[0] ?? { cashPrizeCents: 0, firstPlaceBonus: null };
      const nflConfidencePool = await getActiveNflConfidencePool();
      const nflConfidenceLeaderboard = nflConfidencePool
        ? await (async () => {
          const week = await currentNflConfidenceWeek(nflConfidencePool);
          await ensureNflConfidenceWeekGames(nflConfidencePool, week);
          const standings = await query<{
            userId: string;
            displayName: string | null;
            username: string;
            weekPoints: number;
            seasonPoints: number;
            submittedPicks: number;
            possibleWeekPoints: number;
          }>(
            `
              WITH season_points AS (
                SELECT entry_id, COALESCE(sum(points_awarded), 0)::int AS points
                FROM nfl_confidence_pick
                WHERE pool_id = $1
                GROUP BY entry_id
              ),
              week_points AS (
                SELECT entry_id,
                       COALESCE(sum(points_awarded), 0)::int AS points,
                       count(*) FILTER (WHERE selected_team IS NOT NULL)::int AS submitted,
                       COALESCE(sum(confidence_points) FILTER (WHERE selected_team IS NOT NULL), 0)::int AS possible
                FROM nfl_confidence_pick
                WHERE pool_id = $1 AND week = $2
                GROUP BY entry_id
              )
              SELECT
                u.id AS "userId",
                u.display_name AS "displayName",
                u.username,
                COALESCE(wp.points, 0)::int AS "weekPoints",
                COALESCE(sp.points, 0)::int AS "seasonPoints",
                COALESCE(wp.submitted, 0)::int AS "submittedPicks",
                COALESCE(wp.possible, 0)::int AS "possibleWeekPoints"
              FROM nfl_confidence_entry e
              JOIN app_user u ON u.id = e.user_id
              LEFT JOIN season_points sp ON sp.entry_id = e.id
              LEFT JOIN week_points wp ON wp.entry_id = e.id
              WHERE e.pool_id = $1
                AND e.status = 'active'
              ORDER BY COALESCE(wp.points, 0) DESC, COALESCE(sp.points, 0) DESC, lower(COALESCE(NULLIF(u.display_name, ''), u.username))
              LIMIT 100
            `,
            [nflConfidencePool.id, week]
          );
          const weeklyStandings = standings.rows.map((row) => ({
            userId: row.userId,
            displayName: row.displayName || row.username,
            weekPoints: row.weekPoints,
            seasonPoints: row.seasonPoints,
            submittedPicks: row.submittedPicks,
            possibleWeekPoints: row.possibleWeekPoints
          }));
          const seasonStandings = [...weeklyStandings]
            .sort((left, right) => right.seasonPoints - left.seasonPoints || right.weekPoints - left.weekPoints || left.displayName.localeCompare(right.displayName));
          return {
            pool: await nflConfidencePoolWithDynamicPrize(nflConfidencePool),
            currentWeek: week,
            weeklyStandings,
            seasonStandings
          };
        })()
        : null;
      const survivorPool = await getActiveSurvivorPool();
      const survivorLeaderboard = survivorPool
        ? await (async () => {
          const weekStart = currentSurvivorWeekStart(survivorPool);
          const standings = await query<{
            userId: string;
            displayName: string | null;
            username: string;
            status: "active" | "eliminated" | "winner";
            eliminatedWeekStart: string | null;
            picksMade: number;
            pickId: string | null;
            pickWeekStart: string | null;
            selectedTeam: string | null;
            awayTeam: string | null;
            homeTeam: string | null;
            startsAt: Date | null;
            pickStatus: "pending" | "won" | "lost" | "tie" | "no_pick" | "void" | null;
          }>(
            `
              SELECT
                u.id AS "userId",
                u.display_name AS "displayName",
                u.username,
                e.status,
                e.eliminated_week_start::text AS "eliminatedWeekStart",
                count(p_all.id)::int AS "picksMade",
                p.id AS "pickId",
                p.week_start::text AS "pickWeekStart",
                p.selected_team AS "selectedTeam",
                p.away_team AS "awayTeam",
                p.home_team AS "homeTeam",
                p.starts_at AS "startsAt",
                p.status AS "pickStatus"
              FROM survivor_entry e
              JOIN app_user u ON u.id = e.user_id
              LEFT JOIN survivor_pick p_all ON p_all.entry_id = e.id AND p_all.status <> 'void'
              LEFT JOIN survivor_pick p ON p.entry_id = e.id AND p.week_start = $2::date
              WHERE e.pool_id = $1
              GROUP BY u.id, u.display_name, u.username, e.status, e.eliminated_week_start,
                       p.id, p.week_start, p.selected_team, p.away_team, p.home_team, p.starts_at, p.status
              ORDER BY
                CASE e.status WHEN 'active' THEN 1 WHEN 'winner' THEN 2 ELSE 3 END,
                count(p_all.id) DESC,
                lower(COALESCE(NULLIF(u.display_name, ''), u.username))
              LIMIT 100
            `,
            [survivorPool.id, weekStart]
          );
          return {
            pool: await survivorPoolWithDynamicPrize(survivorPool),
            currentWeekStart: weekStart,
            standings: standings.rows.map((row) => ({
              userId: row.userId,
              displayName: row.displayName || row.username,
              status: row.status,
              eliminatedWeekStart: row.eliminatedWeekStart,
              picksMade: row.picksMade,
              currentPick: row.pickId && row.startsAt && row.selectedTeam && row.awayTeam && row.homeTeam && row.pickWeekStart ? {
                id: row.pickId,
                weekStart: row.pickWeekStart,
                selectedTeam: row.selectedTeam,
                awayTeam: row.awayTeam,
                homeTeam: row.homeTeam,
                startsAt: row.startsAt.toISOString(),
                status: row.pickStatus ?? "pending",
                locked: row.startsAt.getTime() <= Date.now(),
                visible: row.startsAt.getTime() <= Date.now() || row.userId === req.user?.id,
                displayTeam: survivorVisiblePickTeam(row.startsAt, row.selectedTeam, row.userId === req.user?.id)
              } : null
            }))
          };
        })()
        : null;
      res.json({
        leaderboard: result.rows,
        weeks: weeks.rows,
        weekStart: selectedWeekStart,
        isCurrentWeek: requestedWeekStart ? requestedWeekStart === currentWeek?.weekStart : true,
        registeredPlayers: Number(registeredPlayers.rows[0]?.count ?? 0),
        weeklyPrizeCents: weeklyPrize.cashPrizeCents,
        weeklyPrize,
        nflConfidenceLeaderboard,
        survivorLeaderboard
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/ai-picks", async (_req, res, next) => {
    try {
      const result = await query<DailyAiPick>(
        `
          WITH ranked AS (
            SELECT DISTINCT ON (
              p.published_for,
              COALESCE(split_part(split_part(l.provider_event_id, ':', 1), '|', 1), l.sport::text || ':' || l.away_team || ':' || l.home_team || ':' || l.starts_at::text),
              l.market_key,
              p.selected_team
            )
              p.id,
              p.selected_team AS "selectedTeam",
              p.published_for AS "publishedFor",
              p.score,
              p.confidence,
              p.reasons,
              p.features,
              p.explanation,
              p.locked_at AS "lockedAt",
              p.wager_id AS "wagerId",
              w.status AS "wagerStatus",
              wl.status AS "legStatus",
              COALESCE(wl.status, w.status) AS "resultStatus",
              w.stake_cents AS "stakeCents",
              w.potential_payout_cents AS "potentialReturnCents",
              CASE
                WHEN COALESCE(wl.status, w.status) = 'won' THEN w.potential_payout_cents - w.stake_cents
                WHEN COALESCE(wl.status, w.status) = 'lost' THEN -w.stake_cents
                WHEN COALESCE(wl.status, w.status) IN ('push', 'void') THEN 0
                ELSE NULL
              END AS "resultValueCents",
              l.sport,
              l.league,
              l.starts_at AS "startsAt",
              l.home_team AS "homeTeam",
              l.away_team AS "awayTeam",
              l.spread,
              l.odds_american AS "oddsAmerican",
              l.market_key AS "marketKey"
            FROM ai_pick p
            JOIN game_line l ON l.id = p.game_line_id
            LEFT JOIN wager w ON w.id = p.wager_id
            LEFT JOIN wager_leg wl ON wl.wager_id = w.id
              AND wl.game_line_id = p.game_line_id
              AND wl.selected_team = p.selected_team
            WHERE p.published_for = (now() AT TIME ZONE 'America/Chicago')::date
              AND p.confidence >= $1
              AND (p.locked_at IS NULL OR p.wager_id IS NOT NULL)
              AND (
                p.locked_at IS NOT NULL
                OR NOT EXISTS (
                  SELECT 1
                  FROM ai_daily_bankroll adb
                  JOIN app_user au ON au.id = adb.user_id
                  WHERE au.username = $2
                    AND au.role = 'system'
                    AND adb.bankroll_date = (now() AT TIME ZONE 'America/Chicago')::date
                    AND adb.straight_wager_stake_cents IS NOT NULL
                    AND floor(adb.starting_balance_cents * (
                      CASE
                        WHEN adb.starting_balance_cents > $3::integer THEN LEAST($4::numeric, $5::numeric)
                        ELSE $5::numeric
                      END
                    )) - (
                      SELECT COALESCE(sum(w2.stake_cents), 0)
                      FROM wager w2
                      WHERE w2.user_id = au.id
                        AND w2.kind = 'straight'
                        AND (w2.placed_at AT TIME ZONE 'America/Chicago')::date = adb.bankroll_date
                    ) < adb.straight_wager_stake_cents
                )
              )
            ORDER BY
              p.published_for,
              COALESCE(split_part(split_part(l.provider_event_id, ':', 1), '|', 1), l.sport::text || ':' || l.away_team || ':' || l.home_team || ':' || l.starts_at::text),
              l.market_key,
              p.selected_team,
              (p.wager_id IS NOT NULL) DESC,
              p.locked_at DESC NULLS LAST,
              p.confidence DESC NULLS LAST,
              p.score DESC NULLS LAST
          )
          SELECT *
          FROM ranked
          ORDER BY "lockedAt" DESC NULLS LAST, confidence DESC NULLS LAST, score DESC NULLS LAST, "startsAt" ASC
        `,
        [
          dailyAiWagerMinConfidence,
          config.aiUsername,
          dailyAiReducedStraightBankrollThresholdCents,
          dailyAiHighBankrollStraightBankrollFraction,
          dailyAiStraightBankrollFraction
        ]
      );
      const chineParlay = (await query<DailyChineParlay>(
        `
          SELECT
            w.id,
            w.kind::text AS kind,
            (w.placed_at AT TIME ZONE 'America/Chicago')::date::text AS "pickDate",
            (w.stake_cents / 10000.0)::numeric(8,2)::text AS units,
            w.stake_cents AS "stakeCents",
            w.potential_payout_cents AS "potentialReturnCents",
            (w.potential_payout_cents / 10000.0)::numeric(8,2)::text AS "potentialReturnUnits",
            w.status::text AS status,
            CASE
              WHEN w.status = 'won' THEN w.potential_payout_cents - w.stake_cents
              WHEN w.status = 'lost' THEN -w.stake_cents
              WHEN w.status IN ('push', 'void') THEN 0
              ELSE NULL
            END AS "profitCents",
            ((w.potential_payout_cents - w.stake_cents) / 10000.0)::numeric(8,2)::text AS "profitUnits",
            COALESCE(
              json_agg(
                json_build_object(
                  'id', wl.id,
                  'selectedTeam', wl.selected_team,
                  'legIndex', leg_rows.leg_index,
                  'status', wl.status,
                  'decimalOdds', (CASE WHEN wl.odds_american > 0 THEN 1 + wl.odds_american / 100.0 ELSE 1 + 100.0 / abs(wl.odds_american) END)::numeric(8,3)::text,
                  'oddsAmerican', wl.odds_american,
                  'sport', gl.sport,
                  'league', gl.league,
                  'startsAt', gl.starts_at,
                  'homeTeam', gl.home_team,
                  'awayTeam', gl.away_team,
                  'spread', wl.spread::text,
                  'marketKey', gl.market_key
                )
                ORDER BY leg_rows.leg_index ASC
              ) FILTER (WHERE wl.id IS NOT NULL),
              '[]'::json
            ) AS legs
          FROM wager w
          JOIN app_user u ON u.id = w.user_id
          JOIN LATERAL (
            SELECT
              wl_inner.id,
              row_number() OVER (ORDER BY gl_inner.starts_at ASC, wl_inner.id ASC) AS leg_index
            FROM wager_leg wl_inner
            JOIN game_line gl_inner ON gl_inner.id = wl_inner.game_line_id
            WHERE wl_inner.wager_id = w.id
          ) leg_rows ON true
          JOIN wager_leg wl ON wl.id = leg_rows.id
          JOIN game_line gl ON gl.id = wl.game_line_id
          WHERE u.username = $1
            AND w.kind IN ('parlay', 'round_robin')
            AND (w.placed_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date
          GROUP BY w.id
          HAVING count(wl.id) >= 2
          ORDER BY w.placed_at DESC
          LIMIT 1
        `,
        [config.aiUsername]
      )).rows[0] ?? null;

      let dailyParlay = chineParlay;
      if (!dailyParlay) {
        const bankroll = await query<{ startingBalanceCents: number }>(
          `
            SELECT adb.starting_balance_cents AS "startingBalanceCents"
            FROM ai_daily_bankroll adb
            JOIN app_user u ON u.id = adb.user_id
            WHERE u.username = $1
              AND u.role = 'system'
              AND adb.bankroll_date = (now() AT TIME ZONE 'America/Chicago')::date
            LIMIT 1
          `,
          [config.aiUsername]
        );
        const startingBalanceCents = Number(bankroll.rows[0]?.startingBalanceCents ?? 0);
        const projectedStakeCents = Math.max(0, Math.floor(startingBalanceCents * dailyAiParlayBankrollFraction));
        const parlayPicks: typeof result.rows = [];
        const seenGames = new Set<string>();
        const seenTeams = new Set<string>();
        for (const pick of [...result.rows].sort((left, right) => {
          const confidence = Number(right.confidence ?? 0) - Number(left.confidence ?? 0);
          if (confidence !== 0) return confidence;
          const score = Number(right.score ?? 0) - Number(left.score ?? 0);
          if (score !== 0) return score;
          return new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime();
        })) {
          const gameKey = `${pick.sport}:${pick.awayTeam}:${pick.homeTeam}:${new Date(pick.startsAt).toISOString()}`;
          const teamKey = String(pick.selectedTeam).toLowerCase();
          if (seenGames.has(gameKey) || seenTeams.has(teamKey)) continue;
          seenGames.add(gameKey);
          seenTeams.add(teamKey);
          parlayPicks.push(pick);
          if (parlayPicks.length >= 2) break;
        }

        if (parlayPicks.length === 2) {
          const potentialReturnCents = estimatePayoutCents(projectedStakeCents, parlayPicks.map((pick) => Number(pick.oddsAmerican)));
          dailyParlay = {
            id: "projected-daily-chine-parlay",
            kind: "parlay",
            projected: true,
            pickDate: new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }),
            units: (projectedStakeCents / 10000).toFixed(2),
            stakeCents: projectedStakeCents,
            potentialReturnCents,
            potentialReturnUnits: (potentialReturnCents / 10000).toFixed(2),
            status: "pending",
            profitCents: 0,
            profitUnits: "0.00",
            legs: parlayPicks.map((pick, index) => ({
              id: pick.id,
              selectedTeam: pick.selectedTeam,
              legIndex: index + 1,
              status: "pending",
              decimalOdds: (Number(pick.oddsAmerican) > 0 ? 1 + Number(pick.oddsAmerican) / 100 : 1 + 100 / Math.abs(Number(pick.oddsAmerican))).toFixed(3),
              oddsAmerican: Number(pick.oddsAmerican),
              sport: pick.sport,
              league: pick.league,
              startsAt: pick.startsAt,
              homeTeam: pick.homeTeam,
              awayTeam: pick.awayTeam,
              spread: pick.spread,
              marketKey: pick.marketKey
            }))
          };
        }
      }

      res.json({ picks: result.rows, parlay: dailyParlay });
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

  router.get("/live/:sport", async (req, res, next) => {
    try {
      const sport = req.params.sport.toUpperCase();
      if (sport !== "WORLDCUP" && sport !== "EPL" && sport !== "NCAAF") {
        res.status(404).json({ error: "Live scoreboard is not available for this sport" });
        return;
      }
      const games = await getLiveStates(sport);
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
        roundRobinStakePerWayCents: number | null;
        roundRobinMinLegs: number | null;
        roundRobinMaxLegs: number | null;
        placedAt: Date;
        legId: string;
        selectedTeam: string;
        spread: string;
        oddsAmerican: number;
        legStatus: "pending" | "won" | "lost" | "push" | "void";
        marketKey: "spreads" | "h2h";
        sport: SportKey;
        startsAt: Date;
        awayTeam: string;
        homeTeam: string;
        liveAwayScore: number | null;
        liveHomeScore: number | null;
        livePeriod: string | null;
        liveGameStatus: string | null;
        liveInPlay: boolean | null;
      }>(
        `
          SELECT
            w.id AS "wagerId",
            w.kind,
            w.stake_cents AS "stakeCents",
            w.potential_payout_cents AS "potentialPayoutCents",
            w.round_robin_stake_per_way_cents AS "roundRobinStakePerWayCents",
            w.round_robin_min_legs AS "roundRobinMinLegs",
            w.round_robin_max_legs AS "roundRobinMaxLegs",
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
            gl.home_team AS "homeTeam",
            lgs.away_score AS "liveAwayScore",
            lgs.home_score AS "liveHomeScore",
            lgs.period AS "livePeriod",
            lgs.game_status AS "liveGameStatus",
            lgs.in_play AS "liveInPlay"
          FROM wager w
          JOIN wager_leg wl ON wl.wager_id = w.id
          JOIN game_line gl ON gl.id = wl.game_line_id
          LEFT JOIN LATERAL (
            SELECT *
            FROM live_game_state candidate
            WHERE candidate.sport = gl.sport
              AND (
                candidate.event_key = split_part(gl.provider_event_id, ':', 1)
                OR (
                  candidate.away_team = gl.away_team
                  AND candidate.home_team = gl.home_team
                  AND abs(extract(epoch from candidate.starts_at - gl.starts_at)) <= 10800
                )
              )
            ORDER BY
              CASE candidate.provider
                WHEN 'mlb-stats-api' THEN 1
                WHEN 'espn-scoreboard' THEN 2
                WHEN 'parlay-live' THEN 3
                ELSE 4
              END,
              abs(extract(epoch from candidate.starts_at - gl.starts_at)) ASC,
              candidate.fetched_at DESC
            LIMIT 1
          ) lgs ON true
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
        roundRobinStakePerWayCents: number | null;
        roundRobinMinLegs: number | null;
        roundRobinMaxLegs: number | null;
        placedAt: string;
        legs: Array<{
          id: string;
          selectedTeam: string;
          spread: string;
          oddsAmerican: number;
          status: "pending" | "won" | "lost" | "push" | "void";
          marketKey: "spreads" | "h2h";
          sport: SportKey;
          startsAt: string;
          awayTeam: string;
          homeTeam: string;
          liveAwayScore: number | null;
          liveHomeScore: number | null;
          livePeriod: string | null;
          liveGameStatus: string | null;
          liveInPlay: boolean;
        }>;
      }>();

      for (const row of result.rows) {
        const wager = wagers.get(row.wagerId) ?? {
          id: row.wagerId,
          kind: row.kind,
          stakeCents: row.stakeCents,
          potentialPayoutCents: row.potentialPayoutCents,
          roundRobinStakePerWayCents: row.roundRobinStakePerWayCents,
          roundRobinMinLegs: row.roundRobinMinLegs,
          roundRobinMaxLegs: row.roundRobinMaxLegs,
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
          homeTeam: row.homeTeam,
          liveAwayScore: row.liveAwayScore,
          liveHomeScore: row.liveHomeScore,
          livePeriod: row.livePeriod,
          liveGameStatus: row.liveGameStatus,
          liveInPlay: Boolean(row.liveInPlay)
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
            SELECT id, 'ai'::text AS owner, COALESCE(NULLIF(display_name, ''), 'StakeWars Chine') AS display_name
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
        const weekStart = currentWeekStart();
        await applyReferralBoostDecision(
          client,
          req.user!.id,
          entry.id,
          weekStart,
          input.referralBoostDecision,
          input.referralBoostCount
        );
        const balanceResult = await client.query<{ balance_cents: number }>(
          "SELECT balance_cents FROM weekly_entry WHERE id = $1 FOR UPDATE",
          [entry.id]
        );
        const availableBalanceCents = balanceResult.rows[0]?.balance_cents ?? entry.balance_cents;
        const ways = input.kind === "round_robin" ? roundRobinWays(input.legs.length, input.roundRobinMaxLegs, 2) : null;
        const totalStakeCents = input.kind === "round_robin" ? input.stakeCents * (ways ?? 0) : input.stakeCents;
        if (!ways && input.kind === "round_robin") {
          throw new WagerValidationError("Select a valid round robin size");
        }
        if (availableBalanceCents < totalStakeCents) {
          throw new WagerValidationError("Insufficient bankroll", "INSUFFICIENT_BANKROLL");
        }

        const lineResult = await client.query<WagerLineRow>(
          "SELECT id, sport, starts_at, home_team, away_team, favorite_team, spread, odds_american, market_key, is_active FROM game_line WHERE id = ANY($1::uuid[]) FOR SHARE",
          [input.legs.map((leg) => leg.gameLineId)]
        );

        if (lineResult.rowCount !== input.legs.length) {
          throw new WagerValidationError("One or more selected lines are unavailable", "LINE_UNAVAILABLE");
        }

        const requestedLines = new Map(lineResult.rows.map((line) => [line.id, line]));
        const selectedLines: WagerLineRow[] = [];
        const lineMoves: LineMove[] = [];

        for (const leg of input.legs) {
          const requestedLine = requestedLines.get(leg.gameLineId);
          if (!requestedLine) {
            throw new WagerValidationError("One or more selected lines are unavailable", "LINE_UNAVAILABLE");
          }
          if (leg.selectedTeam !== requestedLine.favorite_team) {
            throw new WagerValidationError("Selected outcome is not available", "OUTCOME_UNAVAILABLE");
          }
          let currentLine = requestedLine;
          if (!requestedLine.is_active) {
            const replacementResult = await client.query<WagerLineRow>(
              `
                SELECT id, sport, starts_at, home_team, away_team, favorite_team, spread, odds_american, market_key, is_active
                FROM game_line
                WHERE is_active = true
                  AND starts_at > now()
                  AND sport = $1
                  AND away_team = $2
                  AND home_team = $3
                  AND market_key = $4
                  AND favorite_team = $5
                  AND starts_at BETWEEN $6::timestamptz - interval '3 hours' AND $6::timestamptz + interval '3 hours'
                ORDER BY abs(extract(epoch from starts_at - $6::timestamptz)) ASC, fetched_at DESC
                LIMIT 1
                FOR SHARE
              `,
              [
                requestedLine.sport,
                requestedLine.away_team,
                requestedLine.home_team,
                requestedLine.market_key,
                requestedLine.favorite_team,
                requestedLine.starts_at
              ]
            );
            if (replacementResult.rowCount !== 1) {
              throw new WagerValidationError(unavailableLineMessage(requestedLine), "LINE_UNAVAILABLE");
            }
            currentLine = replacementResult.rows[0];
          }
          if (currentLine.starts_at.getTime() <= Date.now()) {
            throw new WagerValidationError(`${currentLine.away_team} @ ${currentLine.home_team} has already started`, "GAME_STARTED");
          }
          if (!isInContestWeek(currentLine.starts_at, weekStart)) {
            throw new WagerValidationError(
              `${currentLine.away_team} @ ${currentLine.home_team} is outside the current contest week. Weekly bankroll can only be used on games scheduled for this contest week.`,
              "OUTSIDE_CONTEST_WEEK"
            );
          }

          const expectedSpread = leg.expectedSpread ?? requestedLine.spread;
          const expectedOddsAmerican = leg.expectedOddsAmerican ?? requestedLine.odds_american;
          if (currentLine.id !== leg.gameLineId || currentLine.spread !== expectedSpread || currentLine.odds_american !== expectedOddsAmerican) {
            lineMoves.push({
              oldGameLineId: leg.gameLineId,
              newGameLineId: currentLine.id,
              game: `${currentLine.away_team} @ ${currentLine.home_team}`,
              selectedTeam: leg.selectedTeam,
              marketKey: currentLine.market_key,
              oldSpread: expectedSpread,
              newSpread: currentLine.spread,
              oldOddsAmerican: expectedOddsAmerican,
              newOddsAmerican: currentLine.odds_american
            });
          }
          selectedLines.push(currentLine);
        }

        if (lineMoves.length > 0 && !input.acceptLineMoves) {
          throw new LineMoveError(lineMoves);
        }

        const lines = new Map(input.legs.map((leg, index) => [leg.gameLineId, selectedLines[index]]));
        const sameGameSelections = new Map<string, { teamMarkets: number; totals: number }>();
        for (const line of selectedLines) {
          const key = sameGameKey(line);
          const summary = sameGameSelections.get(key) ?? { teamMarkets: 0, totals: 0 };
          if (line.market_key === "totals") {
            summary.totals += 1;
          } else {
            summary.teamMarkets += 1;
          }
          if (summary.teamMarkets > 1 || summary.totals > 1) {
            throw new WagerValidationError("Only one team pick and one over/under are allowed for the same game", "SAME_GAME_CONFLICT");
          }
          sameGameSelections.set(key, summary);
        }
        const odds = input.legs.map((leg) => {
          const line = lines.get(leg.gameLineId)!;
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
            [randomUUID(), wagerResult.rows[0].id, line.id, leg.selectedTeam, line.spread, line.odds_american]
          );
        }

        await client.query("UPDATE weekly_entry SET balance_cents = balance_cents - $1 WHERE id = $2", [
          totalStakeCents,
          entry.id
        ]);
        await createQualifiedReferralBoost(client, req.user!.id);

        return { id: wagerResult.rows[0].id, potentialPayoutCents: potentialPayout, roundRobinWays: ways };
      });

      res.status(201).json({ wager });
    } catch (error) {
      if (error instanceof LineMoveError) {
        res.status(409).json(error.body);
        return;
      }
      if (error instanceof ReferralBoostDecisionRequiredError) {
        res.status(409).json(error.body);
        return;
      }
      if (error instanceof WagerValidationError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      if ((error as Error).message === "Insufficient bankroll") {
        res.status(400).json({ error: "Insufficient bankroll" });
        return;
      }
      if ((error as Error).message.includes("unavailable") || (error as Error).message.includes("no longer available") || (error as Error).message.includes("already started") || (error as Error).message.includes("Selected outcome") || (error as Error).message.includes("conflict") || (error as Error).message.includes("Only one team pick") || (error as Error).message.includes("round robin") || (error as Error).message.includes("Referral boosts") || (error as Error).message.includes("referral boost")) {
        res.status(400).json({ error: (error as Error).message });
        return;
      }
      next(error);
    }
  });
};
