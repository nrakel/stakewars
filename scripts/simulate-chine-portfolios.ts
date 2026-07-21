import { config as loadEnv } from "dotenv";
import { Pool } from "pg";

loadEnv();

type Outcome = "won" | "lost" | "push" | "void";

type Candidate = {
  pickDate: string;
  eventKey: string;
  modelVersion: string;
  selectedTeam: string;
  awayTeam: string;
  homeTeam: string;
  startsAt: string;
  marketKey: string;
  oddsAmerican: number;
  fairProbability: number;
  impliedProbability: number;
  edge: number;
  confidence: number;
  outcome: Outcome;
};

type SettledLeg = Pick<Candidate, "selectedTeam" | "oddsAmerican" | "outcome" | "confidence" | "edge">;

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value] as const;
  })
);

const minConfidence = Number(args.get("min-confidence") ?? 0.67);
const minEdge = Number(args.get("min-edge") ?? 0);
const minOdds = Number(args.get("min-odds") ?? -200);
const maxOdds = Number(args.get("max-odds") ?? 200);
const modelVersion = args.get("model") ?? "latest";
const marketKey = args.get("market") ?? "h2h";
const sport = args.get("sport") ?? "MLB";

const money = (units: number) => `${units >= 0 ? "+" : ""}${units.toFixed(2)}u`;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

const decimalOdds = (american: number) =>
  american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);

const singleProfit = (leg: SettledLeg, stake = 1) => {
  if (leg.outcome === "won") return stake * (decimalOdds(leg.oddsAmerican) - 1);
  if (leg.outcome === "lost") return -stake;
  return 0;
};

const parlayProfit = (legs: SettledLeg[], stake = 1) => {
  const active = legs.filter((leg) => leg.outcome !== "void");
  if (!active.length) return 0;
  if (active.some((leg) => leg.outcome === "lost")) return -stake;
  const multiplier = active
    .filter((leg) => leg.outcome === "won")
    .reduce((product, leg) => product * decimalOdds(leg.oddsAmerican), 1);
  if (multiplier === 1) return 0;
  return stake * (multiplier - 1);
};

const combinations = <T>(items: T[], size: number): T[][] => {
  const result: T[][] = [];
  const walk = (start: number, picked: T[]) => {
    if (picked.length === size) {
      result.push([...picked]);
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      picked.push(items[index]);
      walk(index + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return result;
};

const roundRobinWays = (legs: SettledLeg[], maxSize: number) => {
  const ways: SettledLeg[][] = [];
  for (let size = 2; size <= maxSize; size += 1) {
    ways.push(...combinations(legs, size));
  }
  return ways;
};

const projectedParlayEv = (legs: Candidate[], stake = 1) => {
  const winProbability = legs.reduce((product, leg) => product * leg.fairProbability, 1);
  const payoutMultiplier = legs.reduce((product, leg) => product * decimalOdds(leg.oddsAmerican), 1);
  return stake * (winProbability * payoutMultiplier - 1);
};

const projectedRoundRobinEv = (legs: Candidate[], maxSize: number, stakePerWay = 1) =>
  roundRobinWays(legs, maxSize).reduce((total, way) => total + projectedParlayEv(way as Candidate[], stakePerWay), 0);

const summarize = (name: string, dailyProfits: Array<{ date: string; profit: number; risked: number; bets: number }>) => {
  const risked = dailyProfits.reduce((sum, day) => sum + day.risked, 0);
  const profit = dailyProfits.reduce((sum, day) => sum + day.profit, 0);
  const playedDays = dailyProfits.filter((day) => day.bets > 0);
  const winningDays = playedDays.filter((day) => day.profit > 0).length;
  return {
    name,
    days: dailyProfits.length,
    playedDays: playedDays.length,
    winningDays,
    dailyWinRate: playedDays.length ? winningDays / playedDays.length : 0,
    bets: dailyProfits.reduce((sum, day) => sum + day.bets, 0),
    risked,
    profit,
    roi: risked ? profit / risked : 0
  };
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const versionResult = await pool.query<{ model_version: string }>(
    `
      SELECT model_version
      FROM ai_candidate_snapshot
      GROUP BY model_version
      ORDER BY count(*) DESC
      LIMIT 1
    `
  );
  const selectedModel = modelVersion === "latest" ? versionResult.rows[0]?.model_version : modelVersion;
  if (!selectedModel) throw new Error("No model snapshots found.");

  const rows = await pool.query<Candidate>(
    `
      WITH latest_per_side AS (
        SELECT
          (e.starts_at AT TIME ZONE 'America/Chicago')::date::text AS "pickDate",
          concat_ws('|', e.away_team, e.home_team, e.starts_at::text, e.market_key) AS "eventKey",
          s.model_version AS "modelVersion",
          e.selected_team AS "selectedTeam",
          e.away_team AS "awayTeam",
          e.home_team AS "homeTeam",
          e.starts_at::text AS "startsAt",
          e.market_key AS "marketKey",
          e.odds_american AS "oddsAmerican",
          e.fair_probability::float8 AS "fairProbability",
          e.implied_probability::float8 AS "impliedProbability",
          e.edge::float8 AS edge,
          e.confidence::float8 AS confidence,
          e.outcome::text AS outcome,
          row_number() OVER (
            PARTITION BY s.model_version, (e.starts_at AT TIME ZONE 'America/Chicago')::date, e.away_team, e.home_team, e.starts_at, e.market_key, e.selected_team
            ORDER BY e.captured_at DESC
          ) AS side_rank
        FROM ai_snapshot_evaluation e
        JOIN ai_candidate_snapshot s ON s.id = e.snapshot_id
        WHERE s.model_version = $1
          AND e.sport = $2
          AND e.market_key = $3
      ),
      best_per_event AS (
        SELECT *,
          row_number() OVER (
            PARTITION BY "modelVersion", "pickDate", "eventKey"
            ORDER BY confidence DESC, edge DESC
          ) AS event_rank
        FROM latest_per_side
        WHERE side_rank = 1
      )
      SELECT *
      FROM best_per_event
      WHERE event_rank = 1
      ORDER BY "pickDate", confidence DESC, edge DESC, "startsAt"
    `,
    [selectedModel, sport, marketKey]
  );

  const byDate = new Map<string, Candidate[]>();
  for (const row of rows.rows) {
    if (row.confidence < minConfidence || row.edge < minEdge) continue;
    if (row.oddsAmerican < minOdds || row.oddsAmerican > maxOdds) continue;
    const day = byDate.get(row.pickDate) ?? [];
    day.push(row);
    byDate.set(row.pickDate, day);
  }

  const dates = [...byDate.keys()].sort();
  const straightDaily: Array<{ date: string; profit: number; risked: number; bets: number }> = [];
  const parlay3Daily: Array<{ date: string; profit: number; risked: number; bets: number }> = [];
  const rr3Daily: Array<{ date: string; profit: number; risked: number; bets: number }> = [];
  const rr7Daily: Array<{ date: string; profit: number; risked: number; bets: number }> = [];
  const decisionDaily: Array<{ date: string; profit: number; risked: number; bets: number }> = [];

  const dailyDetails = dates.map((date) => {
    const uniqueTeams = new Set<string>();
    const picks = (byDate.get(date) ?? [])
      .sort((a, b) => b.confidence - a.confidence || b.edge - a.edge)
      .filter((pick) => {
        const key = pick.selectedTeam.toLowerCase();
        if (uniqueTeams.has(key)) return false;
        uniqueTeams.add(key);
        return true;
      });
    const straightProfit = picks.reduce((sum, pick) => sum + singleProfit(pick), 0);
    straightDaily.push({ date, profit: straightProfit, risked: picks.length, bets: picks.length });

    const top3 = picks.slice(0, 3);
    const top7 = picks.slice(0, 7);

    const parlay3Projected = top3.length === 3 ? projectedParlayEv(top3) : Number.NEGATIVE_INFINITY;
    const parlay3Profit = top3.length === 3 ? parlayProfit(top3) : 0;
    parlay3Daily.push({ date, profit: parlay3Profit, risked: top3.length === 3 ? 1 : 0, bets: top3.length === 3 ? 1 : 0 });

    const rr3Ways = top3.length === 3 ? roundRobinWays(top3, 3) : [];
    const rr3Projected = top3.length === 3 ? projectedRoundRobinEv(top3, 3) : Number.NEGATIVE_INFINITY;
    const rr3Profit = rr3Ways.reduce((sum, way) => sum + parlayProfit(way), 0);
    rr3Daily.push({ date, profit: rr3Profit, risked: rr3Ways.length, bets: rr3Ways.length });

    const rr7Ways = top7.length === 7 ? roundRobinWays(top7, 7) : [];
    const rr7Projected = top7.length === 7 ? projectedRoundRobinEv(top7, 7) : Number.NEGATIVE_INFINITY;
    const rr7Profit = rr7Ways.reduce((sum, way) => sum + parlayProfit(way), 0);
    rr7Daily.push({ date, profit: rr7Profit, risked: rr7Ways.length, bets: rr7Ways.length });

    const exoticOptions = [
      { name: "top3_parlay", projected: parlay3Projected, profit: parlay3Profit, risked: top3.length === 3 ? 1 : 0, bets: top3.length === 3 ? 1 : 0 },
      { name: "top3_round_robin", projected: rr3Projected, profit: rr3Profit, risked: rr3Ways.length, bets: rr3Ways.length },
      { name: "top7_round_robin", projected: rr7Projected, profit: rr7Profit, risked: rr7Ways.length, bets: rr7Ways.length }
    ].filter((option) => option.projected > 0 && option.risked > 0)
      .sort((a, b) => (b.projected / b.risked) - (a.projected / a.risked));

    const selected = exoticOptions[0] ?? { name: "neither", projected: 0, profit: 0, risked: 0, bets: 0 };
    decisionDaily.push({ date, profit: selected.profit, risked: selected.risked, bets: selected.bets });

    return {
      date,
      picks: picks.length,
      topPicks: picks.slice(0, 7).map((pick) => ({
        team: pick.selectedTeam,
        odds: pick.oddsAmerican,
        confidence: pct(pick.confidence),
        edge: pct(pick.edge),
        outcome: pick.outcome
      })),
      straight: money(straightProfit),
      parlay3: top3.length === 3 ? { projected: money(parlay3Projected), actual: money(parlay3Profit) } : null,
      roundRobin3: top3.length === 3 ? { ways: rr3Ways.length, projected: money(rr3Projected), actual: money(rr3Profit) } : null,
      roundRobin7: top7.length === 7 ? { ways: rr7Ways.length, projected: money(rr7Projected), actual: money(rr7Profit) } : null,
      selectedExotic: selected.name,
      selectedExoticProjected: money(selected.projected),
      selectedExoticActual: money(selected.profit)
    };
  });

  const summaries = [
    summarize("All qualifying straight singles, 1u each", straightDaily),
    summarize("Top-3 parlay, 1u", parlay3Daily),
    summarize("Top-3 round robin every way, 1u/way", rr3Daily),
    summarize("Top-7 round robin every way, 1u/way", rr7Daily),
    summarize("Projected-EV decision: best positive exotic or neither", decisionDaily)
  ];

  console.log(JSON.stringify({
    inputs: {
      modelVersion: selectedModel,
      sport,
      marketKey,
      minConfidence,
      minEdge,
      minOdds,
      maxOdds,
      candidateRows: rows.rowCount,
      simulatedDays: dates.length,
      note: "Historical candidates are deduped to latest evaluated side per event/day, then one top side per game."
    },
    summaries: summaries.map((summary) => ({
      ...summary,
      profit: money(summary.profit),
      risked: `${summary.risked.toFixed(2)}u`,
      roi: pct(summary.roi),
      dailyWinRate: pct(summary.dailyWinRate)
    })),
    dailyDetails
  }, null, 2));
} finally {
  await pool.end();
}
