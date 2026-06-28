import { query } from "./db.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type EvaluatedSnapshotRow = {
  id: string;
  model_version: string;
  sport: "MLB";
  market_key: "h2h" | "spreads";
  selected_team: string;
  away_team: string;
  home_team: string;
  starts_at: Date;
  captured_at: Date;
  odds_american: number;
  spread: string;
  implied_probability: string;
  fair_probability: string;
  edge: string;
  model_score: string;
  confidence: string;
  features: Record<string, unknown>;
  outcome: "won" | "lost" | "push" | "void";
  profit_cents_per_100: number;
};

type Summary = {
  group: string;
  rows: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  winRate: number;
  profitCents: number;
  roi: number;
  averageConfidence: number;
  averageEdge: number;
  averageScore: number;
};

type ModelCoverageRow = {
  model_version: string;
  snapshots: string;
  first_captured_at: Date;
  last_captured_at: Date;
};

type DailyTopPickRow = {
  model_version: string;
  game_date: string;
  pick_rank: string;
  captured_at: Date;
  starts_at: Date;
  canonical_event_id: string;
  matchup: string;
  selected_team: string;
  odds_american: number;
  confidence: string;
  edge: string;
  model_score: string;
  outcome: "won" | "lost" | "push" | "void";
  profit_cents_per_100: number;
};

type DailyModelPerformanceRow = {
  model_version: string;
  game_date: string;
  picks: string;
  wins: string;
  losses: string;
  pushes: string;
  voids: string;
  profit_cents_per_100_each: string;
  roi: string;
  average_confidence: string;
};

type ModelPerformanceTotalRow = {
  model_version: string;
  days: string;
  picks: string;
  wins: string;
  losses: string;
  pushes: string;
  voids: string;
  profit_cents_per_100_each: string;
  roi: string;
  average_confidence: string;
};

export type DailyModelPerformanceReport = {
  dateRange: { startDate: string; endDate: string };
  generatedAt: string;
  stakeCentsPerPick: number;
  picksPerDay: number;
  coverage: Array<{
    modelVersion: string;
    snapshots: number;
    firstCapturedAt: Date;
    lastCapturedAt: Date;
  }>;
  daily: Array<{
    modelVersion: string;
    gameDate: string;
    picks: number;
    wins: number;
    losses: number;
    pushes: number;
    voids: number;
    profitCents: number;
    roi: number;
    averageConfidence: number;
  }>;
  totals: Array<{
    modelVersion: string;
    days: number;
    picks: number;
    wins: number;
    losses: number;
    pushes: number;
    voids: number;
    profitCents: number;
    roi: number;
    averageConfidence: number;
  }>;
  picks: Array<{
    modelVersion: string;
    gameDate: string;
    rank: number;
    capturedAt: Date;
    startsAt: Date;
    canonicalEventId: string;
    matchup: string;
    selectedTeam: string;
    oddsAmerican: number;
    confidence: number;
    edge: number;
    modelScore: number;
    outcome: "won" | "lost" | "push" | "void";
    profitCents: number;
  }>;
};

const asNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const confidenceBucket = (confidence: number) => {
  if (confidence >= 0.68) return "0.68+";
  if (confidence >= 0.62) return "0.62-0.68";
  if (confidence >= 0.56) return "0.56-0.62";
  if (confidence >= 0.5) return "0.50-0.56";
  return "<0.50";
};

const edgeBucket = (edge: number) => {
  if (edge >= 0.06) return "0.06+";
  if (edge >= 0.04) return "0.04-0.06";
  if (edge >= 0.02) return "0.02-0.04";
  if (edge >= 0) return "0.00-0.02";
  return "negative";
};

const signedBucket = (value: unknown, strong = 1, slight = 0) => {
  const number = asNumber(value);
  if (number === null) return "unknown";
  if (number >= strong) return "strong-positive";
  if (number > slight) return "slight-positive";
  if (number <= -strong) return "strong-negative";
  if (number < -slight) return "slight-negative";
  return "neutral";
};

const countBucket = (value: unknown) => {
  const number = asNumber(value);
  if (number === null) return "unknown";
  if (number >= 3) return "3+";
  if (number >= 1) return "1-2";
  if (number <= -3) return "-3 or less";
  if (number <= -1) return "-1 to -2";
  return "0";
};

const sideBucket = (row: EvaluatedSnapshotRow) => row.selected_team === row.home_team ? "home" : "away";
const priceBucket = (row: EvaluatedSnapshotRow) => row.odds_american < 0 ? "favorite" : "underdog";

const centsToDollars = (cents: number) => `${cents < 0 ? "-" : ""}$${Math.abs(cents / 100).toFixed(2)}`;

const percent = (value: number) => `${(value * 100).toFixed(2)}%`;

const formatDateTime = (value: Date | string) => new Date(value).toISOString();

const csvEscape = (value: unknown) => {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? formatDateTime(value) : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

const toCsv = <T extends Record<string, unknown>>(rows: T[]) => {
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
  ].join("\n");
};

const markdownTable = (headers: string[], rows: Array<Array<string | number>>) => [
  `| ${headers.join(" | ")} |`,
  `| ${headers.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${row.join(" | ")} |`)
].join("\n");

const summarize = (group: string, rows: EvaluatedSnapshotRow[]): Summary => {
  const wins = rows.filter((row) => row.outcome === "won").length;
  const losses = rows.filter((row) => row.outcome === "lost").length;
  const pushes = rows.filter((row) => row.outcome === "push").length;
  const voids = rows.filter((row) => row.outcome === "void").length;
  const decided = wins + losses;
  const profitCents = rows.reduce((sum, row) => sum + row.profit_cents_per_100, 0);
  const stakedCents = rows.length * 10000;
  const average = (key: "confidence" | "edge" | "model_score") =>
    rows.length ? rows.reduce((sum, row) => sum + Number(row[key]), 0) / rows.length : 0;

  return {
    group,
    rows: rows.length,
    wins,
    losses,
    pushes,
    voids,
    winRate: decided ? wins / decided : 0,
    profitCents,
    roi: stakedCents ? profitCents / stakedCents : 0,
    averageConfidence: average("confidence"),
    averageEdge: average("edge"),
    averageScore: average("model_score")
  };
};

const groupedSummaries = (rows: EvaluatedSnapshotRow[]) => {
  const groups: Record<string, (row: EvaluatedSnapshotRow) => string> = {
    model: (row) => row.model_version,
    market: (row) => row.market_key,
    side: sideBucket,
    price: priceBucket,
    confidence: (row) => confidenceBucket(Number(row.confidence)),
    edge: (row) => edgeBucket(Number(row.edge)),
    starterEraDiff: (row) => signedBucket(row.features?.starterEraDiff, 0.75),
    starterKbbDiff: (row) => signedBucket(row.features?.starterKbbDiff, 1),
    bullpenPitchesLast3Diff: (row) => signedBucket(row.features?.bullpenPitchesLast3Diff, 45),
    runDiff14: (row) => signedBucket(row.features?.runDiffPerGameDiff14, 1),
    winPct7: (row) => signedBucket(row.features?.winPctDiff7, 0.15),
    activeIlPitchersDiff: (row) => countBucket(row.features?.activeIlPitchersDiff)
  };

  return Object.entries(groups).flatMap(([name, keyFor]) => {
    const grouped = new Map<string, EvaluatedSnapshotRow[]>();
    for (const row of rows) {
      const key = `${name}:${keyFor(row)}`;
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return [...grouped.entries()].map(([group, groupRows]) => summarize(group, groupRows));
  });
};

export const reportAiSnapshotEvaluations = async ({
  startDate,
  endDate
}: {
  startDate: string;
  endDate: string;
}) => {
  const result = await query<EvaluatedSnapshotRow>(
    `
      SELECT
        e.id,
        s.model_version,
        e.sport,
        e.market_key,
        e.selected_team,
        e.away_team,
        e.home_team,
        e.starts_at,
        e.captured_at,
        e.odds_american,
        e.spread,
        e.implied_probability,
        e.fair_probability,
        e.edge,
        e.model_score,
        e.confidence,
        e.features,
        e.outcome,
        e.profit_cents_per_100
      FROM ai_snapshot_evaluation e
      JOIN ai_candidate_snapshot s ON s.id = e.snapshot_id
      WHERE (e.starts_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
      ORDER BY e.starts_at ASC, e.captured_at ASC, e.model_score DESC
    `,
    [startDate, endDate]
  );

  const topPositive = [...result.rows]
    .sort((a, b) => Number(b.model_score) - Number(a.model_score))
    .slice(0, 20)
    .map((row) => ({
      startsAt: row.starts_at,
      capturedAt: row.captured_at,
      matchup: `${row.away_team} @ ${row.home_team}`,
      selectedTeam: row.selected_team,
      market: row.market_key,
      odds: row.odds_american,
      spread: row.spread,
      confidence: Number(Number(row.confidence).toFixed(4)),
      edge: Number(Number(row.edge).toFixed(4)),
      score: Number(Number(row.model_score).toFixed(4)),
      outcome: row.outcome,
      profitCentsPer100: row.profit_cents_per_100
    }));

  return {
    dateRange: { startDate, endDate },
    evaluatedSnapshots: result.rowCount,
    overall: summarize("overall", result.rows),
    groups: groupedSummaries(result.rows).sort((a, b) => b.rows - a.rows || b.roi - a.roi),
    topPositive
  };
};

export const buildDailyModelPerformanceReport = async ({
  startDate,
  endDate,
  picksPerDay = 5,
  stakeCentsPerPick = 10000
}: {
  startDate: string;
  endDate: string;
  picksPerDay?: number;
  stakeCentsPerPick?: number;
}): Promise<DailyModelPerformanceReport> => {
  const coverageResult = await query<ModelCoverageRow>(
    `
      SELECT
        model_version,
        COUNT(*) AS snapshots,
        MIN(captured_at) AS first_captured_at,
        MAX(captured_at) AS last_captured_at
      FROM ai_candidate_snapshot
      WHERE (starts_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
      GROUP BY model_version
      ORDER BY model_version
    `,
    [startDate, endDate]
  );

  const pickResult = await query<DailyTopPickRow>(
    `
      WITH evaluated AS (
        SELECT
          s.model_version,
          (e.starts_at AT TIME ZONE 'UTC')::date AS game_date,
          e.captured_at,
          e.starts_at,
          COALESCE(
            NULLIF(split_part(COALESCE(s.provider_event_id, ''), ':', 1), ''),
            lower(
              concat_ws(
                '|',
                (e.starts_at AT TIME ZONE 'UTC')::date::text,
                e.away_team,
                e.home_team
              )
            )
          ) AS canonical_event_id,
          CONCAT(e.away_team, ' @ ', e.home_team) AS matchup,
          e.selected_team,
          e.odds_american,
          e.confidence,
          e.edge,
          e.model_score,
          e.outcome,
          e.profit_cents_per_100
        FROM ai_snapshot_evaluation e
        JOIN ai_candidate_snapshot s ON s.id = e.snapshot_id
        WHERE (e.starts_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
          AND e.sport = 'MLB'
          AND e.market_key = 'h2h'
      ),
      best_event_pick AS (
        SELECT *
        FROM (
          SELECT
            evaluated.*,
            ROW_NUMBER() OVER (
              PARTITION BY model_version, game_date, canonical_event_id
              ORDER BY model_score DESC, confidence DESC, edge DESC, captured_at DESC
            ) AS event_rank
          FROM evaluated
        ) ranked_events
        WHERE event_rank = 1
      ),
      ranked_daily_picks AS (
        SELECT
          best_event_pick.*,
          ROW_NUMBER() OVER (
            PARTITION BY model_version, game_date
            ORDER BY model_score DESC, confidence DESC, edge DESC, captured_at DESC
          ) AS pick_rank
        FROM best_event_pick
      )
      SELECT
        model_version,
        game_date::text,
        pick_rank,
        captured_at,
        starts_at,
        canonical_event_id,
        matchup,
        selected_team,
        odds_american,
        confidence,
        edge,
        model_score,
        outcome,
        profit_cents_per_100
      FROM ranked_daily_picks
      WHERE pick_rank <= $3
      ORDER BY game_date ASC, model_version ASC, pick_rank ASC
    `,
    [startDate, endDate, picksPerDay]
  );

  const dailyResult = await query<DailyModelPerformanceRow>(
    `
      WITH evaluated AS (
        SELECT
          s.model_version,
          (e.starts_at AT TIME ZONE 'UTC')::date AS game_date,
          e.captured_at,
          COALESCE(
            NULLIF(split_part(COALESCE(s.provider_event_id, ''), ':', 1), ''),
            lower(
              concat_ws(
                '|',
                (e.starts_at AT TIME ZONE 'UTC')::date::text,
                e.away_team,
                e.home_team
              )
            )
          ) AS canonical_event_id,
          e.confidence,
          e.edge,
          e.model_score,
          e.outcome,
          e.profit_cents_per_100
        FROM ai_snapshot_evaluation e
        JOIN ai_candidate_snapshot s ON s.id = e.snapshot_id
        WHERE (e.starts_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
          AND e.sport = 'MLB'
          AND e.market_key = 'h2h'
      ),
      best_event_pick AS (
        SELECT *
        FROM (
          SELECT
            evaluated.*,
            ROW_NUMBER() OVER (
              PARTITION BY model_version, game_date, canonical_event_id
              ORDER BY model_score DESC, confidence DESC, edge DESC, captured_at DESC
            ) AS event_rank
          FROM evaluated
        ) ranked_events
        WHERE event_rank = 1
      ),
      ranked_daily_picks AS (
        SELECT
          best_event_pick.*,
          ROW_NUMBER() OVER (
            PARTITION BY model_version, game_date
            ORDER BY model_score DESC, confidence DESC, edge DESC, captured_at DESC
          ) AS pick_rank
        FROM best_event_pick
      ),
      selected AS (
        SELECT *
        FROM ranked_daily_picks
        WHERE pick_rank <= $3
      )
      SELECT
        model_version,
        game_date::text,
        COUNT(*) AS picks,
        COUNT(*) FILTER (WHERE outcome = 'won') AS wins,
        COUNT(*) FILTER (WHERE outcome = 'lost') AS losses,
        COUNT(*) FILTER (WHERE outcome = 'push') AS pushes,
        COUNT(*) FILTER (WHERE outcome = 'void') AS voids,
        SUM(profit_cents_per_100) AS profit_cents_per_100_each,
        SUM(profit_cents_per_100)::numeric / NULLIF(COUNT(*) * $4, 0) AS roi,
        AVG(confidence) AS average_confidence
      FROM selected
      GROUP BY model_version, game_date
      ORDER BY game_date ASC, model_version ASC
    `,
    [startDate, endDate, picksPerDay, stakeCentsPerPick]
  );

  const totalsResult = await query<ModelPerformanceTotalRow>(
    `
      WITH evaluated AS (
        SELECT
          s.model_version,
          (e.starts_at AT TIME ZONE 'UTC')::date AS game_date,
          e.captured_at,
          COALESCE(
            NULLIF(split_part(COALESCE(s.provider_event_id, ''), ':', 1), ''),
            lower(
              concat_ws(
                '|',
                (e.starts_at AT TIME ZONE 'UTC')::date::text,
                e.away_team,
                e.home_team
              )
            )
          ) AS canonical_event_id,
          e.confidence,
          e.edge,
          e.model_score,
          e.outcome,
          e.profit_cents_per_100
        FROM ai_snapshot_evaluation e
        JOIN ai_candidate_snapshot s ON s.id = e.snapshot_id
        WHERE (e.starts_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
          AND e.sport = 'MLB'
          AND e.market_key = 'h2h'
      ),
      best_event_pick AS (
        SELECT *
        FROM (
          SELECT
            evaluated.*,
            ROW_NUMBER() OVER (
              PARTITION BY model_version, game_date, canonical_event_id
              ORDER BY model_score DESC, confidence DESC, edge DESC, captured_at DESC
            ) AS event_rank
          FROM evaluated
        ) ranked_events
        WHERE event_rank = 1
      ),
      ranked_daily_picks AS (
        SELECT
          best_event_pick.*,
          ROW_NUMBER() OVER (
            PARTITION BY model_version, game_date
            ORDER BY model_score DESC, confidence DESC, edge DESC, captured_at DESC
          ) AS pick_rank
        FROM best_event_pick
      ),
      selected AS (
        SELECT *
        FROM ranked_daily_picks
        WHERE pick_rank <= $3
      )
      SELECT
        model_version,
        COUNT(DISTINCT game_date) AS days,
        COUNT(*) AS picks,
        COUNT(*) FILTER (WHERE outcome = 'won') AS wins,
        COUNT(*) FILTER (WHERE outcome = 'lost') AS losses,
        COUNT(*) FILTER (WHERE outcome = 'push') AS pushes,
        COUNT(*) FILTER (WHERE outcome = 'void') AS voids,
        SUM(profit_cents_per_100) AS profit_cents_per_100_each,
        SUM(profit_cents_per_100)::numeric / NULLIF(COUNT(*) * $4, 0) AS roi,
        AVG(confidence) AS average_confidence
      FROM selected
      GROUP BY model_version
      ORDER BY model_version ASC
    `,
    [startDate, endDate, picksPerDay, stakeCentsPerPick]
  );

  return {
    dateRange: { startDate, endDate },
    generatedAt: new Date().toISOString(),
    stakeCentsPerPick,
    picksPerDay,
    coverage: coverageResult.rows.map((row) => ({
      modelVersion: row.model_version,
      snapshots: Number(row.snapshots),
      firstCapturedAt: row.first_captured_at,
      lastCapturedAt: row.last_captured_at
    })),
    daily: dailyResult.rows.map((row) => ({
      modelVersion: row.model_version,
      gameDate: row.game_date,
      picks: Number(row.picks),
      wins: Number(row.wins),
      losses: Number(row.losses),
      pushes: Number(row.pushes),
      voids: Number(row.voids),
      profitCents: Number(row.profit_cents_per_100_each),
      roi: Number(row.roi),
      averageConfidence: Number(row.average_confidence)
    })),
    totals: totalsResult.rows.map((row) => ({
      modelVersion: row.model_version,
      days: Number(row.days),
      picks: Number(row.picks),
      wins: Number(row.wins),
      losses: Number(row.losses),
      pushes: Number(row.pushes),
      voids: Number(row.voids),
      profitCents: Number(row.profit_cents_per_100_each),
      roi: Number(row.roi),
      averageConfidence: Number(row.average_confidence)
    })),
    picks: pickResult.rows.map((row) => ({
      modelVersion: row.model_version,
      gameDate: row.game_date,
      rank: Number(row.pick_rank),
      capturedAt: row.captured_at,
      startsAt: row.starts_at,
      canonicalEventId: row.canonical_event_id,
      matchup: row.matchup,
      selectedTeam: row.selected_team,
      oddsAmerican: row.odds_american,
      confidence: Number(row.confidence),
      edge: Number(row.edge),
      modelScore: Number(row.model_score),
      outcome: row.outcome,
      profitCents: row.profit_cents_per_100
    }))
  };
};

export const writeDailyModelPerformanceReport = async ({
  startDate,
  endDate,
  outputDir = "reports",
  picksPerDay = 5,
  stakeCentsPerPick = 10000
}: {
  startDate: string;
  endDate: string;
  outputDir?: string;
  picksPerDay?: number;
  stakeCentsPerPick?: number;
}) => {
  const report = await buildDailyModelPerformanceReport({
    startDate,
    endDate,
    picksPerDay,
    stakeCentsPerPick
  });
  await mkdir(outputDir, { recursive: true });

  const baseName = `daily-model-performance_${startDate}_${endDate}`;
  const markdownPath = path.join(outputDir, `${baseName}.md`);
  const dailyCsvPath = path.join(outputDir, `${baseName}_daily.csv`);
  const totalsCsvPath = path.join(outputDir, `${baseName}_totals.csv`);
  const picksCsvPath = path.join(outputDir, `${baseName}_picks.csv`);
  const jsonPath = path.join(outputDir, `${baseName}.json`);

  const markdown = [
    `# Daily Model Performance Report`,
    ``,
    `Generated: ${report.generatedAt}`,
    `Date range: ${startDate} through ${endDate}`,
    `Method: MLB moneyline only, one pick per event, top ${picksPerDay} model-score picks per model/day, ${centsToDollars(stakeCentsPerPick)} simulated stake per pick.`,
    ``,
    `## Model Coverage`,
    markdownTable(
      ["Model", "Snapshots", "First captured", "Last captured"],
      report.coverage.map((row) => [
        row.modelVersion,
        row.snapshots,
        formatDateTime(row.firstCapturedAt),
        formatDateTime(row.lastCapturedAt)
      ])
    ),
    ``,
    `## Totals`,
    markdownTable(
      ["Model", "Days", "Picks", "Record", "Push", "Void", "Profit", "ROI", "Avg Conf"],
      report.totals.map((row) => [
        row.modelVersion,
        row.days,
        row.picks,
        `${row.wins}-${row.losses}`,
        row.pushes,
        row.voids,
        centsToDollars(row.profitCents),
        percent(row.roi),
        percent(row.averageConfidence)
      ])
    ),
    ``,
    `## Daily Performance`,
    markdownTable(
      ["Date", "Model", "Picks", "Record", "Push", "Void", "Profit", "ROI", "Avg Conf"],
      report.daily.map((row) => [
        row.gameDate,
        row.modelVersion,
        row.picks,
        `${row.wins}-${row.losses}`,
        row.pushes,
        row.voids,
        centsToDollars(row.profitCents),
        percent(row.roi),
        percent(row.averageConfidence)
      ])
    ),
    ``,
    `## Notes`,
    `- Early model versions have smaller samples because they only existed briefly.`,
    `- This report evaluates stored snapshots, not hypothetical reruns of old code against today's dataset.`,
    `- Profit assumes flat ${centsToDollars(stakeCentsPerPick)} stakes and uses the stored evaluated odds/outcomes.`
  ].join("\n");

  await writeFile(markdownPath, markdown);
  await writeFile(
    dailyCsvPath,
    toCsv(report.daily.map((row) => ({
      model_version: row.modelVersion,
      game_date: row.gameDate,
      picks: row.picks,
      wins: row.wins,
      losses: row.losses,
      pushes: row.pushes,
      voids: row.voids,
      profit_dollars: (row.profitCents / 100).toFixed(2),
      roi_percent: (row.roi * 100).toFixed(2),
      average_confidence_percent: (row.averageConfidence * 100).toFixed(2)
    })))
  );
  await writeFile(
    totalsCsvPath,
    toCsv(report.totals.map((row) => ({
      model_version: row.modelVersion,
      days: row.days,
      picks: row.picks,
      wins: row.wins,
      losses: row.losses,
      pushes: row.pushes,
      voids: row.voids,
      profit_dollars: (row.profitCents / 100).toFixed(2),
      roi_percent: (row.roi * 100).toFixed(2),
      average_confidence_percent: (row.averageConfidence * 100).toFixed(2)
    })))
  );
  await writeFile(
    picksCsvPath,
    toCsv(report.picks.map((row) => ({
      model_version: row.modelVersion,
      game_date: row.gameDate,
      rank: row.rank,
      captured_at: row.capturedAt,
      starts_at: row.startsAt,
      event_id: row.canonicalEventId,
      matchup: row.matchup,
      selected_team: row.selectedTeam,
      odds_american: row.oddsAmerican,
      confidence_percent: (row.confidence * 100).toFixed(2),
      edge_percent: (row.edge * 100).toFixed(2),
      model_score: row.modelScore.toFixed(4),
      outcome: row.outcome,
      profit_dollars: (row.profitCents / 100).toFixed(2)
    })))
  );
  await writeFile(jsonPath, JSON.stringify(report, null, 2));

  return {
    report,
    files: {
      markdown: markdownPath,
      dailyCsv: dailyCsvPath,
      totalsCsv: totalsCsvPath,
      picksCsv: picksCsvPath,
      json: jsonPath
    }
  };
};
