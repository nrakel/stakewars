import { generateAiPicks, snapshotAiCandidates } from "../src/server/ai.js";
import { config } from "../src/server/config.js";
import { pool } from "../src/server/db.js";
import { refreshMlbGameContext } from "../src/server/mlbContext.js";
import { refreshOdds } from "../src/server/odds.js";

type ParlayUsage = {
  credits_used: number;
  credits_remaining: number;
  credits_total: number;
  period_end: string;
};

type MlbScheduleResponse = {
  dates?: Array<{
    games?: Array<{
      gameDate: string;
    }>;
  }>;
};

const centralParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
};

const centralDate = (date = new Date()) => {
  const parts = centralParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const centralMinuteOfDay = (date = new Date()) => {
  const parts = centralParts(date);
  return Number(parts.hour) * 60 + Number(parts.minute);
};

const addDays = (date: string, days: number) => {
  const copy = new Date(`${date}T00:00:00Z`);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
};

const fetchUsage = async () => {
  if (!config.parlayApiKey) {
    throw new Error("PARLAY_API_KEY is not configured");
  }

  const base = config.parlayApiBaseUrl.replace(/\/$/, "");
  const response = await fetch(`${base}/usage`, {
    headers: { "X-API-Key": config.parlayApiKey }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Parlay usage failed with ${response.status}: ${body.slice(0, 200)}`);
  }
  return (await response.json()) as ParlayUsage;
};

const fetchMlbStartsForCentralDate = async (targetDate: string) => {
  const url = new URL("https://statsapi.mlb.com/api/v1/schedule");
  url.searchParams.set("sportId", "1");
  url.searchParams.set("startDate", targetDate);
  url.searchParams.set("endDate", targetDate);

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MLB schedule failed with ${response.status}: ${body.slice(0, 200)}`);
  }

  const body = (await response.json()) as MlbScheduleResponse;
  return (body.dates ?? [])
    .flatMap((date) => date.games ?? [])
    .map((game) => new Date(game.gameDate))
    .filter((date) => Number.isFinite(date.getTime()) && centralDate(date) === targetDate)
    .sort((left, right) => left.getTime() - right.getTime());
};

const creditsUsedToday = async (targetDate: string) => {
  const result = await pool.query<{ credits: string | null }>(
    `
      SELECT COALESCE(sum(credits_delta), 0)::text AS credits
      FROM parlay_usage_log
      WHERE (created_at AT TIME ZONE 'America/Chicago')::date = $1::date
    `,
    [targetDate]
  );
  return Number(result.rows[0]?.credits ?? 0);
};

const logUsage = async (
  before: ParlayUsage,
  after: ParlayUsage,
  metadata: Record<string, unknown>
) => {
  await pool.query(
    `
      INSERT INTO parlay_usage_log (
        job_name, credits_before, credits_after, credits_delta, credits_remaining, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      "refresh-mlb-odds",
      before.credits_used,
      after.credits_used,
      Math.max(after.credits_used - before.credits_used, 0),
      after.credits_remaining,
      JSON.stringify(metadata)
    ]
  );
};

const run = async () => {
  const todayCentral = centralDate();
  const minimumRemaining = Number(process.env.STAKEWARS_PARLAY_MIN_REMAINING_CREDITS ?? 100_000);
  const dailyCap = Number(process.env.STAKEWARS_PARLAY_DAILY_CREDIT_CAP ?? 30_000);
  const starts = await fetchMlbStartsForCentralDate(todayCentral);

  if (!starts.length) {
    return { status: "skipped", reason: "no MLB games today", todayCentral };
  }

  if (centralMinuteOfDay() < 8 * 60) {
    return { status: "skipped", reason: "before 8 AM CT", todayCentral };
  }

  const lastStart = starts.at(-1)!;
  if (Date.now() > lastStart.getTime()) {
    return {
      status: "skipped",
      reason: "after last MLB start",
      todayCentral,
      lastStart: lastStart.toISOString()
    };
  }

  const before = await fetchUsage();
  const usedToday = await creditsUsedToday(todayCentral);
  if (before.credits_remaining <= minimumRemaining) {
    return {
      status: "skipped",
      reason: "minimum remaining credit guard",
      todayCentral,
      creditsRemaining: before.credits_remaining,
      minimumRemaining
    };
  }
  if (usedToday >= dailyCap) {
    return {
      status: "skipped",
      reason: "daily credit cap",
      todayCentral,
      usedToday,
      dailyCap
    };
  }

  const odds = await refreshOdds({ sports: ["MLB"] });
  let mlbContext: unknown;
  try {
    mlbContext = await refreshMlbGameContext({ startDate: todayCentral, endDate: addDays(todayCentral, 1) });
  } catch (error) {
    mlbContext = { error: error instanceof Error ? error.message : "MLB context refresh failed" };
    console.error("MLB context refresh failed", error);
  }
  const snapshot = await snapshotAiCandidates({ sport: "MLB", source: "odds-refresh" });
  const picks = await generateAiPicks({
    sport: "MLB",
    maxPicks: 5,
    placeWagers: true,
    marketKey: "h2h",
    sortBy: "confidence",
    uniqueGames: true
  });
  const after = await fetchUsage();
  await logUsage(before, after, {
    todayCentral,
    firstStart: starts[0].toISOString(),
    lastStart: lastStart.toISOString(),
    usedTodayBeforeRun: usedToday,
    odds,
    snapshot: {
      inserted: typeof snapshot === "object" && snapshot && "inserted" in snapshot ? snapshot.inserted : null
    },
    picks: {
      locked: picks.locked,
      projected: picks.projected,
      published: picks.published.length
    },
    mlbContext
  });

  return {
    status: "refreshed",
    todayCentral,
    firstStart: starts[0].toISOString(),
    lastStart: lastStart.toISOString(),
    creditsBefore: before.credits_used,
    creditsAfter: after.credits_used,
    creditsDelta: Math.max(after.credits_used - before.credits_used, 0),
    creditsRemaining: after.credits_remaining,
    odds,
    picks: {
      locked: picks.locked,
      projected: picks.projected,
      published: picks.published.length
    }
  };
};

try {
  console.log(JSON.stringify(await run(), null, 2));
} finally {
  await pool.end();
}
