import { randomUUID } from "node:crypto";
import { estimatePayoutCents } from "./betting.js";
import type pg from "pg";
import { transaction } from "./db.js";
import {
  fetchMlbFinals,
  finalGameKey,
  outcomeForSelection,
  profitCentsForOutcome,
  type FinalGame
} from "./settlement.js";

type StoredResult = FinalGame & {
  id: string;
};

type TrainingCandidate = {
  candidate_id: string;
  run_id: string;
  game_line_id: string;
  sport: "MLB";
  market_key: "h2h" | "spreads";
  selected_team: string;
  away_team: string;
  home_team: string;
  starts_at: Date;
  starts_on: string;
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

const finalMetadata = (game: FinalGame) => JSON.stringify(game.metadata ?? {});

export const upsertMlbResult = async (
  client: pg.PoolClient,
  game: FinalGame,
  source = "mlb-stats-api"
) => {
  if (game.providerGameId) {
    const existingProvider = await client.query<{ id: string }>(
      "SELECT id FROM game_result WHERE source = $1 AND provider_game_id = $2 LIMIT 1",
      [source, game.providerGameId]
    );
    if (!existingProvider.rowCount) {
      const upgraded = await client.query<{ id: string }>(
        `
          UPDATE game_result
          SET provider_game_id = $1,
              starts_at = $2,
              away_score = $3,
              home_score = $4,
              game_number = $5,
              result_metadata = $6,
              fetched_at = now()
          WHERE id = (
            SELECT id
            FROM game_result
            WHERE sport = 'MLB'
              AND source = $7
              AND provider_game_id IS NULL
              AND starts_on = $8
              AND away_team = $9
              AND home_team = $10
            LIMIT 1
          )
          RETURNING id
        `,
        [
          game.providerGameId,
          game.startsAt ?? null,
          game.awayScore,
          game.homeScore,
          game.gameNumber ?? null,
          finalMetadata(game),
          source,
          game.startsOn,
          game.awayTeam,
          game.homeTeam
        ]
      );

      if (upgraded.rowCount) {
        return upgraded.rows[0].id;
      }
    }

    const result = await client.query<{ id: string }>(
      `
        INSERT INTO game_result (
          id, sport, provider_game_id, starts_at, starts_on, away_team, home_team,
          away_score, home_score, game_number, result_metadata, source, fetched_at
        )
        VALUES ($1, 'MLB', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
        ON CONFLICT (source, provider_game_id) WHERE provider_game_id IS NOT NULL
        DO UPDATE SET
          starts_at = EXCLUDED.starts_at,
          starts_on = EXCLUDED.starts_on,
          away_team = EXCLUDED.away_team,
          home_team = EXCLUDED.home_team,
          away_score = EXCLUDED.away_score,
          home_score = EXCLUDED.home_score,
          game_number = EXCLUDED.game_number,
          result_metadata = EXCLUDED.result_metadata,
          fetched_at = now()
        RETURNING id
      `,
      [
        randomUUID(),
        game.providerGameId,
        game.startsAt ?? null,
        game.startsOn,
        game.awayTeam,
        game.homeTeam,
        game.awayScore,
        game.homeScore,
        game.gameNumber ?? null,
        finalMetadata(game),
        source
      ]
    );

    return result.rows[0].id;
  }

  const result = await client.query<{ id: string }>(
    `
      INSERT INTO game_result (
        id, sport, starts_at, starts_on, away_team, home_team, away_score, home_score,
        game_number, result_metadata, source, fetched_at
      )
      VALUES ($1, 'MLB', $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (sport, starts_on, away_team, home_team, source)
      WHERE provider_game_id IS NULL
      DO UPDATE SET
        starts_at = EXCLUDED.starts_at,
        away_score = EXCLUDED.away_score,
        home_score = EXCLUDED.home_score,
        game_number = EXCLUDED.game_number,
        result_metadata = EXCLUDED.result_metadata,
        fetched_at = now()
      RETURNING id
    `,
    [
      randomUUID(),
      game.startsAt ?? null,
      game.startsOn,
      game.awayTeam,
      game.homeTeam,
      game.awayScore,
      game.homeScore,
      game.gameNumber ?? null,
      finalMetadata(game),
      source
    ]
  );

  return result.rows[0].id;
};

export const upsertMlbResults = async (finals: FinalGame[]) => {
  return transaction(async (client) => {
    const stored: StoredResult[] = [];

    for (const game of finals) {
      const id = await upsertMlbResult(client, game);
      stored.push({ ...game, id });
    }

    return stored;
  });
};

export const resultMapByUnambiguousGame = (results: StoredResult[]) => {
  const grouped = new Map<string, StoredResult[]>();
  for (const result of results) {
    const key = finalGameKey(result);
    grouped.set(key, [...(grouped.get(key) ?? []), result]);
  }

  const map = new Map<string, StoredResult>();
  for (const [key, group] of grouped.entries()) {
    if (group.length === 1) {
      map.set(key, group[0]);
    }
  }
  return map;
};

export const buildMlbTrainingExamples = async (
  startDate = yyyyMmDd(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
  endDate = yyyyMmDd(new Date())
) => {
  const finals = await fetchMlbFinals(startDate, endDate);
  const storedResults = await upsertMlbResults(finals);
  const resultMap = resultMapByUnambiguousGame(storedResults);

  return transaction(async (client) => {
    const candidates = await client.query<TrainingCandidate>(
      `
        SELECT
          c.id AS candidate_id,
          c.run_id,
          c.game_line_id,
          gl.sport,
          gl.market_key,
          c.selected_team,
          gl.away_team,
          gl.home_team,
          gl.starts_at,
          (gl.starts_at AT TIME ZONE 'UTC')::date::text AS starts_on,
          gl.odds_american,
          gl.spread,
          c.implied_probability,
          c.fair_probability,
          c.edge,
          c.score AS model_score,
          c.confidence,
          c.features
        FROM ai_pick_candidate c
        JOIN game_line gl ON gl.id = c.game_line_id
        WHERE gl.sport = 'MLB'
          AND (gl.starts_at AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
        ORDER BY gl.starts_at ASC, c.score DESC
      `,
      [startDate, endDate]
    );

    let inserted = 0;
    let updated = 0;
    const unmatched: Array<{ candidateId: string; awayTeam: string; homeTeam: string; startsOn: string; reason: string }> = [];

    for (const candidate of candidates.rows) {
      const game = resultMap.get(finalGameKey({
        startsOn: candidate.starts_on,
        awayTeam: candidate.away_team,
        homeTeam: candidate.home_team
      }));

      if (!game) {
        unmatched.push({
          candidateId: candidate.candidate_id,
          awayTeam: candidate.away_team,
          homeTeam: candidate.home_team,
          startsOn: candidate.starts_on,
          reason: "no unambiguous result match"
        });
        continue;
      }

      const outcome = outcomeForSelection({
        selectedTeam: candidate.selected_team,
        awayTeam: candidate.away_team,
        homeTeam: candidate.home_team,
        marketKey: candidate.market_key,
        spread: Number(candidate.spread),
        game
      });
      const profit = profitCentsForOutcome({
        outcome,
        stakeCents: 10000,
        potentialPayoutCents: estimatePayoutCents(10000, [candidate.odds_american])
      });

      const write = await client.query<{ inserted: boolean }>(
        `
          INSERT INTO ai_training_example (
            id, candidate_id, run_id, game_line_id, sport, market_key, selected_team,
            away_team, home_team, starts_at, odds_american, spread, implied_probability,
            fair_probability, edge, model_score, confidence, features, result_id,
            outcome, profit_cents_per_100
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19,
            $20, $21
          )
          ON CONFLICT (candidate_id)
          DO UPDATE SET
            result_id = EXCLUDED.result_id,
            outcome = EXCLUDED.outcome,
            profit_cents_per_100 = EXCLUDED.profit_cents_per_100,
            features = EXCLUDED.features
          RETURNING (xmax = 0) AS inserted
        `,
        [
          randomUUID(),
          candidate.candidate_id,
          candidate.run_id,
          candidate.game_line_id,
          candidate.sport,
          candidate.market_key,
          candidate.selected_team,
          candidate.away_team,
          candidate.home_team,
          candidate.starts_at,
          candidate.odds_american,
          candidate.spread,
          candidate.implied_probability,
          candidate.fair_probability,
          candidate.edge,
          candidate.model_score,
          candidate.confidence,
          normalizeJson(candidate.features),
          game.id,
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

    return {
      dateRange: { startDate, endDate },
      finalsFetched: finals.length,
      candidatesChecked: candidates.rowCount,
      examplesInserted: inserted,
      examplesUpdated: updated,
      unmatched
    };
  });
};
