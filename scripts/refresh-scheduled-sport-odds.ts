import { config } from "../src/server/config.js";
import { pool } from "../src/server/db.js";
import { refreshOdds } from "../src/server/odds.js";

type ScheduledSport = "NBA" | "NCAAMB" | "NHL";

type ParlayUsage = {
  credits_used: number;
  credits_remaining: number;
  credits_total: number;
  period_end: string;
};

type ParlayEvent = {
  commence_time: string;
};

const sportConfig: Record<ScheduledSport, { parlayKey: string; label: string; jobName: string; dailyCapEnv: string }> = {
  NBA: {
    parlayKey: "basketball_nba",
    label: "NBA",
    jobName: "refresh-nba-odds",
    dailyCapEnv: "STAKEWARS_NBA_PARLAY_DAILY_CREDIT_CAP"
  },
  NCAAMB: {
    parlayKey: "basketball_ncaab",
    label: "NCAAB",
    jobName: "refresh-ncaamb-odds",
    dailyCapEnv: "STAKEWARS_NCAAB_PARLAY_DAILY_CREDIT_CAP"
  },
  NHL: {
    parlayKey: "icehockey_nhl",
    label: "NHL",
    jobName: "refresh-nhl-odds",
    dailyCapEnv: "STAKEWARS_NHL_PARLAY_DAILY_CREDIT_CAP"
  }
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

const requestedSport = () => {
  const sport = (process.env.STAKEWARS_SCHEDULED_ODDS_SPORT ?? process.argv[2] ?? "").toUpperCase();
  if (sport !== "NBA" && sport !== "NCAAMB" && sport !== "NHL") {
    throw new Error("Set STAKEWARS_SCHEDULED_ODDS_SPORT to NBA, NCAAMB, or NHL");
  }
  return sport;
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

const fetchStartsForCentralDate = async (sport: ScheduledSport, targetDate: string) => {
  if (!config.parlayApiKey) {
    throw new Error("PARLAY_API_KEY is not configured");
  }

  const sportInfo = sportConfig[sport];
  const base = config.parlayApiBaseUrl.replace(/\/$/, "");
  const from = new Date(`${targetDate}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${addDays(targetDate, 2)}T00:00:00Z`);
  const url = new URL(`${base}/sports/${sportInfo.parlayKey}/events`);
  url.searchParams.set("commenceTimeFrom", from.toISOString());
  url.searchParams.set("commenceTimeTo", to.toISOString());
  url.searchParams.set("dateFormat", "iso");

  const response = await fetch(url, {
    headers: { "X-API-Key": config.parlayApiKey }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Parlay API events ${sportInfo.parlayKey} failed with ${response.status}: ${body.slice(0, 200)}`);
  }

  return ((await response.json()) as ParlayEvent[])
    .map((event) => new Date(event.commence_time))
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
  jobName: string,
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
      jobName,
      before.credits_used,
      after.credits_used,
      Math.max(after.credits_used - before.credits_used, 0),
      after.credits_remaining,
      JSON.stringify(metadata)
    ]
  );
};

const run = async () => {
  const sport = requestedSport();
  const sportInfo = sportConfig[sport];
  const todayCentral = centralDate();
  const starts = await fetchStartsForCentralDate(sport, todayCentral);

  if (!starts.length) {
    return { status: "skipped", reason: `no ${sportInfo.label} games today`, todayCentral, sport };
  }

  if (centralMinuteOfDay() < 8 * 60) {
    return { status: "skipped", reason: "before 8 AM CT", todayCentral, sport };
  }

  const lastStart = starts.at(-1)!;
  if (Date.now() > lastStart.getTime()) {
    return {
      status: "skipped",
      reason: `after last ${sportInfo.label} start`,
      todayCentral,
      sport,
      lastStart: lastStart.toISOString()
    };
  }

  const before = await fetchUsage();
  const minimumRemaining = Number(process.env.STAKEWARS_PARLAY_MIN_REMAINING_CREDITS ?? 100_000);
  const dailyCap = Number(process.env[sportInfo.dailyCapEnv] ?? process.env.STAKEWARS_PARLAY_DAILY_CREDIT_CAP ?? 30_000);
  const usedToday = await creditsUsedToday(todayCentral);
  if (before.credits_remaining <= minimumRemaining) {
    return {
      status: "skipped",
      reason: "minimum remaining credit guard",
      todayCentral,
      sport,
      creditsRemaining: before.credits_remaining,
      minimumRemaining
    };
  }
  if (usedToday >= dailyCap) {
    return {
      status: "skipped",
      reason: "daily credit cap",
      todayCentral,
      sport,
      usedToday,
      dailyCap
    };
  }

  const odds = await refreshOdds({ sports: [sport] });
  const after = await fetchUsage();
  await logUsage(sportInfo.jobName, before, after, {
    todayCentral,
    sport,
    firstStart: starts[0].toISOString(),
    lastStart: lastStart.toISOString(),
    usedTodayBeforeRun: usedToday,
    odds
  });

  return {
    status: "refreshed",
    todayCentral,
    sport,
    firstStart: starts[0].toISOString(),
    lastStart: lastStart.toISOString(),
    creditsBefore: before.credits_used,
    creditsAfter: after.credits_used,
    creditsDelta: Math.max(after.credits_used - before.credits_used, 0),
    creditsRemaining: after.credits_remaining,
    odds
  };
};

try {
  console.log(JSON.stringify(await run(), null, 2));
} finally {
  await pool.end();
}
