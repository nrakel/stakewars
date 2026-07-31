import { config } from "../src/server/config.js";
import { pool } from "../src/server/db.js";
import { refreshOdds } from "../src/server/odds.js";

type ParlayUsage = {
  credits_used: number;
  credits_remaining: number;
  credits_total: number;
  period_end: string;
};

type ParlayEvent = {
  commence_time: string;
};

const centralParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    weekday: "short",
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

const centralWeekday = (date = new Date()) => centralParts(date).weekday;

const addDays = (date: string, days: number) => {
  const copy = new Date(`${date}T00:00:00Z`);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
};

const nflPollingSeason = (date = new Date()) => {
  const parts = centralParts(date);
  const monthDay = Number(parts.month) * 100 + Number(parts.day);
  return monthDay >= 801 || monthDay <= 110;
};

const holidayDates = () => new Set(
  (process.env.STAKEWARS_NFL_HOLIDAY_DATES ?? "")
    .split(",")
    .map((date) => date.trim())
    .filter(Boolean)
);

const cadenceForNow = (date = new Date()) => {
  const today = centralDate(date);
  const minute = centralMinuteOfDay(date);
  const hour = Math.floor(minute / 60);
  const weekday = centralWeekday(date);
  const holiday = holidayDates().has(today);

  if (!nflPollingSeason(date)) {
    return null;
  }

  if (weekday === "Sun") {
    return minute >= 6 * 60 && hour <= 23 && minute % 5 === 0
      ? { cadence: "sunday_5_minute", intervalMinutes: 5 }
      : null;
  }

  if (weekday === "Mon" || weekday === "Thu" || holiday) {
    if (hour >= 8 && hour < 12 && minute % 60 === 0) {
      return { cadence: holiday ? "holiday_hourly_until_noon" : "weekday_game_day_hourly_until_noon", intervalMinutes: 60 };
    }
    if (hour >= 12 && hour <= 23 && minute % 10 === 0) {
      return { cadence: holiday ? "holiday_10_minute_after_noon" : "weekday_game_day_10_minute_after_noon", intervalMinutes: 10 };
    }
    return null;
  }

  if (["Tue", "Wed", "Fri", "Sat"].includes(weekday)) {
    return hour >= 8 && hour <= 19 && minute % 60 === 0
      ? { cadence: "off_day_hourly", intervalMinutes: 60 }
      : null;
  }

  return null;
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

const fetchNflStartsForCentralDate = async (targetDate: string) => {
  if (!config.parlayApiKey) {
    throw new Error("PARLAY_API_KEY is not configured");
  }

  const base = config.parlayApiBaseUrl.replace(/\/$/, "");
  const from = new Date(`${targetDate}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${addDays(targetDate, 2)}T00:00:00Z`);
  const url = new URL(`${base}/sports/americanfootball_nfl/events`);
  url.searchParams.set("commenceTimeFrom", from.toISOString());
  url.searchParams.set("commenceTimeTo", to.toISOString());
  url.searchParams.set("dateFormat", "iso");

  const response = await fetch(url, {
    headers: { "X-API-Key": config.parlayApiKey }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Parlay API events americanfootball_nfl failed with ${response.status}: ${body.slice(0, 200)}`);
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
      "refresh-nfl-odds",
      before.credits_used,
      after.credits_used,
      Math.max(after.credits_used - before.credits_used, 0),
      after.credits_remaining,
      JSON.stringify(metadata)
    ]
  );
};

const run = async () => {
  const now = new Date();
  const todayCentral = centralDate(now);
  const cadence = cadenceForNow(now);
  if (!cadence) {
    return { status: "skipped", reason: "outside NFL polling cadence", todayCentral };
  }

  const sameDayStarts = await fetchNflStartsForCentralDate(todayCentral);
  const lastStart = sameDayStarts.at(-1);
  if (lastStart && now.getTime() > lastStart.getTime()) {
    return {
      status: "skipped",
      reason: "after last same-day NFL start",
      todayCentral,
      lastStart: lastStart.toISOString(),
      cadence
    };
  }

  const before = await fetchUsage();
  const minimumRemaining = Number(process.env.STAKEWARS_PARLAY_MIN_REMAINING_CREDITS ?? 100_000);
  const dailyCap = Number(process.env.STAKEWARS_NFL_PARLAY_DAILY_CREDIT_CAP ?? process.env.STAKEWARS_PARLAY_DAILY_CREDIT_CAP ?? 30_000);
  const usedToday = await creditsUsedToday(todayCentral);
  if (before.credits_remaining <= minimumRemaining) {
    return {
      status: "skipped",
      reason: "minimum remaining credit guard",
      todayCentral,
      creditsRemaining: before.credits_remaining,
      minimumRemaining,
      cadence
    };
  }
  if (usedToday >= dailyCap) {
    return {
      status: "skipped",
      reason: "daily credit cap",
      todayCentral,
      usedToday,
      dailyCap,
      cadence
    };
  }

  const odds = await refreshOdds({ sports: ["NFL"], ignoreUpcomingWindow: true });
  const after = await fetchUsage();
  await logUsage(before, after, {
    todayCentral,
    cadence,
    sameDayStarts: sameDayStarts.map((date) => date.toISOString()),
    usedTodayBeforeRun: usedToday,
    odds
  });

  return {
    status: "refreshed",
    todayCentral,
    cadence,
    sameDayStarts: sameDayStarts.map((date) => date.toISOString()),
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
