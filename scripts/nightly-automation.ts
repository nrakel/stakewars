import { pool } from "../src/server/db.js";
import { backfillParlayMlbHistory, dateRange } from "../src/server/historicalBackfill.js";
import { refreshMlbGameContext } from "../src/server/mlbContext.js";
import { settleMlbStraightWagers } from "../src/server/settlement.js";
import { evaluateMlbCandidateSnapshots } from "../src/server/snapshotEvaluation.js";
import { buildMlbTrainingExamples } from "../src/server/training.js";

type CoverageResponse = {
  by_sport?: Array<{
    sport_key: string;
    last_d?: string;
  }>;
};

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

const addDays = (date: string, days: number) => {
  const copy = new Date(`${date}T00:00:00Z`);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
};

const minDate = (left: string, right: string) => left <= right ? left : right;

const fetchMlbCoverageEnd = async () => {
  const response = await fetch("https://parlay-api.com/v1/historical/coverage");
  if (!response.ok) {
    throw new Error(`Parlay historical coverage failed with ${response.status}`);
  }

  const body = (await response.json()) as CoverageResponse;
  const mlb = body.by_sport?.find((sport) => sport.sport_key === "baseball_mlb");
  if (!mlb?.last_d) {
    throw new Error("Parlay historical coverage did not include baseball_mlb.last_d");
  }

  return mlb.last_d;
};

const latestStoredParlayDate = async () => {
  const result = await pool.query<{ last_date: string | null }>(
    `
      SELECT max(target_date)::text AS last_date
      FROM parlay_historical_fetch
      WHERE sport = 'MLB'
        AND endpoint = 'closing-odds'
        AND status_code = 200
        AND row_count > 0
    `
  );
  return result.rows[0]?.last_date ?? null;
};

const run = async () => {
  const todayCentral = centralDate();
  const yesterdayCentral = addDays(todayCentral, -1);
  const maxBackfillDays = Number(process.env.STAKEWARS_NIGHTLY_MAX_BACKFILL_DAYS ?? 3);

  console.log(JSON.stringify({
    step: "start",
    todayCentral,
    yesterdayCentral,
    maxBackfillDays
  }));

  const coverageEnd = await fetchMlbCoverageEnd();
  const storedEnd = await latestStoredParlayDate();

  if (!storedEnd) {
    const startDate = addDays(coverageEnd, -Math.max(maxBackfillDays - 1, 0));
    const backfill = await backfillParlayMlbHistory({ startDate, endDate: coverageEnd });
    console.log(JSON.stringify({ step: "historical-backfill", coverageEnd, storedEnd, ...backfill }));
  } else if (storedEnd < coverageEnd) {
    const startDate = addDays(storedEnd, 1);
    const endDate = minDate(addDays(startDate, Math.max(maxBackfillDays - 1, 0)), coverageEnd);
    const backfill = await backfillParlayMlbHistory({ startDate, endDate });
    console.log(JSON.stringify({ step: "historical-backfill", coverageEnd, storedEnd, ...backfill }));
  } else {
    console.log(JSON.stringify({ step: "historical-backfill", coverageEnd, storedEnd, skipped: "already current" }));
  }

  const settlement = await settleMlbStraightWagers(yesterdayCentral, yesterdayCentral);
  console.log(JSON.stringify({ step: "settlement", ...settlement }));

  const contextEnd = addDays(todayCentral, 2);
  const mlbContext = await refreshMlbGameContext({ startDate: todayCentral, endDate: contextEnd });
  console.log(JSON.stringify({ step: "mlb-context", ...mlbContext }));

  const training = await buildMlbTrainingExamples(yesterdayCentral, yesterdayCentral);
  console.log(JSON.stringify({ step: "training", ...training }));

  const snapshotEvaluation = await evaluateMlbCandidateSnapshots(yesterdayCentral, yesterdayCentral);
  console.log(JSON.stringify({ step: "snapshot-evaluation", ...snapshotEvaluation }));

  console.log(JSON.stringify({ step: "ai-picks", skipped: "handled by first-pitch daily AI bot timer" }));
};

try {
  await run();
} finally {
  await pool.end();
}
