import { randomUUID } from "node:crypto";
import { estimatePayoutCents } from "./betting.js";
import { transaction } from "./db.js";
import {
  fetchMlbFinals,
  finalGameKey,
  outcomeForSelection,
  profitCentsForOutcome
} from "./settlement.js";
import {
  resultMapByUnambiguousGame,
  upsertMlbResults
} from "./training.js";

type SnapshotCandidate = {
  snapshot_id: string;
  sport: "MLB";
  market_key: "h2h" | "spreads";
  selected_team: string;
  away_team: string;
  home_team: string;
  starts_at: Date;
  starts_on: string;
  captured_at: Date;
  odds_american: number;
  spread: string;
  implied_probability: string;
  fair_probability: string;
  edge: string;
  model_score: string;
  confidence: string;
  features: unknown;
};

const yyyyMmDd = (date: Date) => date.toISOString().slice(0, 10);

const normalizeJson = (value: unknown) => {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
};

export const evaluateMlbCandidateSnapshots = async (
  startDate = yyyyMmDd(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
  endDate = yyyyMmDd(new Date())
) => {
  const finals = await fetchMlbFinals(startDate, endDate);
  const storedResults = await upsertMlbResults(finals);
  const resultMap = resultMapByUnambiguousGame(storedResults);

  return transaction(async (client) => {
    const snapshots = await client.query<SnapshotCandidate>(
      `
        SELECT
          s.id AS snapshot_id,
          s.sport,
          s.market_key,
          s.selected_team,
          s.away_team,
          s.home_team,
          s.starts_at,
          (s.starts_at AT TIME ZONE 'UTC')::date::text AS starts_on,
          s.captured_at,
          s.odds_american,
          s.spread,
          s.implied_probability,
          s.fair_probability,
          s.edge,
          s.score AS model_score,
          s.confidence,
          s.features
        FROM ai_candidate_snapshot s
        WHERE s.sport = 'MLB'
          AND (s.starts_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
        ORDER BY s.starts_at ASC, s.captured_at ASC, s.score DESC
      `,
      [startDate, endDate]
    );

    let inserted = 0;
    let updated = 0;
    const unmatched: Array<{ snapshotId: string; awayTeam: string; homeTeam: string; startsOn: string; reason: string }> = [];

    for (const snapshot of snapshots.rows) {
      const game = resultMap.get(finalGameKey({
        startsOn: snapshot.starts_on,
        awayTeam: snapshot.away_team,
        homeTeam: snapshot.home_team
      }));

      if (!game) {
        unmatched.push({
          snapshotId: snapshot.snapshot_id,
          awayTeam: snapshot.away_team,
          homeTeam: snapshot.home_team,
          startsOn: snapshot.starts_on,
          reason: "no unambiguous result match"
        });
        continue;
      }

      const outcome = outcomeForSelection({
        selectedTeam: snapshot.selected_team,
        awayTeam: snapshot.away_team,
        homeTeam: snapshot.home_team,
        marketKey: snapshot.market_key,
        spread: Number(snapshot.spread),
        game
      });
      const profit = profitCentsForOutcome({
        outcome,
        stakeCents: 10000,
        potentialPayoutCents: estimatePayoutCents(10000, [snapshot.odds_american])
      });

      const write = await client.query<{ inserted: boolean }>(
        `
          INSERT INTO ai_snapshot_evaluation (
            id, snapshot_id, result_id, sport, market_key, selected_team,
            away_team, home_team, starts_at, captured_at, odds_american, spread,
            implied_probability, fair_probability, edge, model_score, confidence,
            features, outcome, profit_cents_per_100
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12,
            $13, $14, $15, $16, $17,
            $18::jsonb, $19, $20
          )
          ON CONFLICT (snapshot_id)
          DO UPDATE SET
            result_id = EXCLUDED.result_id,
            outcome = EXCLUDED.outcome,
            profit_cents_per_100 = EXCLUDED.profit_cents_per_100,
            features = EXCLUDED.features
          RETURNING (xmax = 0) AS inserted
        `,
        [
          randomUUID(),
          snapshot.snapshot_id,
          game.id,
          snapshot.sport,
          snapshot.market_key,
          snapshot.selected_team,
          snapshot.away_team,
          snapshot.home_team,
          snapshot.starts_at,
          snapshot.captured_at,
          snapshot.odds_american,
          snapshot.spread,
          snapshot.implied_probability,
          snapshot.fair_probability,
          snapshot.edge,
          snapshot.model_score,
          snapshot.confidence,
          normalizeJson(snapshot.features),
          outcome,
          profit
        ]
      );

      if (write.rows[0]?.inserted) {
        inserted += 1;
      } else {
        updated += 1;
      }
    }

    const summary = await client.query<{
      market_key: string;
      rows: number;
      wins: number;
      losses: number;
      pushes: number;
      profit_cents: number;
    }>(
      `
        SELECT
          market_key,
          count(*)::int AS rows,
          count(*) FILTER (WHERE outcome = 'won')::int AS wins,
          count(*) FILTER (WHERE outcome = 'lost')::int AS losses,
          count(*) FILTER (WHERE outcome = 'push')::int AS pushes,
          coalesce(sum(profit_cents_per_100), 0)::int AS profit_cents
        FROM ai_snapshot_evaluation
        WHERE (starts_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
        GROUP BY market_key
        ORDER BY market_key
      `,
      [startDate, endDate]
    );

    return {
      dateRange: { startDate, endDate },
      finalsFetched: finals.length,
      snapshotsChecked: snapshots.rowCount,
      evaluationsInserted: inserted,
      evaluationsUpdated: updated,
      unmatched,
      summary: summary.rows.map((row) => ({
        ...row,
        roi: row.rows ? row.profit_cents / (row.rows * 10000) : 0
      }))
    };
  });
};
