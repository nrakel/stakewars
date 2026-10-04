import { randomUUID } from "node:crypto";
import { pool, transaction } from "../src/server/db.js";
import { fetchFootballFinals, type FinalGame } from "../src/server/settlement.js";

type FootballSport = "NFL" | "NCAAF";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));

const yyyyMmDd = (date: Date) => date.toISOString().slice(0, 10);

const addDays = (date: string, days: number) => {
  const copy = new Date(`${date}T00:00:00.000Z`);
  copy.setUTCDate(copy.getUTCDate() + days);
  return yyyyMmDd(copy);
};

const dateChunks = (startDate: string, endDate: string, chunkDays: number) => {
  const chunks: Array<{ startDate: string; endDate: string }> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const chunkEnd = addDays(cursor, chunkDays - 1);
    chunks.push({ startDate: cursor, endDate: chunkEnd > endDate ? endDate : chunkEnd });
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
};

const finalMetadata = (game: FinalGame, sport: FootballSport) =>
  JSON.stringify({ ...(game.metadata ?? {}), sport, ingestedBy: "backfill-football-results" });

const upsertFootballResult = async (sport: FootballSport, game: FinalGame) => {
  return transaction(async (client) => {
    if (game.providerGameId) {
      const result = await client.query<{ id: string }>(
        `
          INSERT INTO game_result (
            id, sport, provider_game_id, starts_at, starts_on, away_team, home_team,
            away_score, home_score, game_number, result_metadata, source, fetched_at
          )
          VALUES ($1, $2::sport_key, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'espn-scoreboard', now())
          ON CONFLICT (source, provider_game_id) WHERE provider_game_id IS NOT NULL
          DO UPDATE SET
            sport = EXCLUDED.sport,
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
          sport,
          game.providerGameId,
          game.startsAt ?? null,
          game.startsOn,
          game.awayTeam,
          game.homeTeam,
          game.awayScore,
          game.homeScore,
          game.gameNumber ?? null,
          finalMetadata(game, sport)
        ]
      );
      return result.rows[0].id;
    }

    const result = await client.query<{ id: string }>(
      `
        INSERT INTO game_result (
          id, sport, starts_at, starts_on, away_team, home_team,
          away_score, home_score, game_number, result_metadata, source, fetched_at
        )
        VALUES ($1, $2::sport_key, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'espn-scoreboard', now())
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
        sport,
        game.startsAt ?? null,
        game.startsOn,
        game.awayTeam,
        game.homeTeam,
        game.awayScore,
        game.homeScore,
        game.gameNumber ?? null,
        finalMetadata(game, sport)
      ]
    );
    return result.rows[0].id;
  });
};

const run = async () => {
  const sport = (args.get("sport") ?? "NFL") as FootballSport;
  if (sport !== "NFL" && sport !== "NCAAF") {
    throw new Error("--sport must be NFL or NCAAF");
  }

  const endDate = args.get("end") ?? yyyyMmDd(new Date());
  const startDate = args.get("start") ?? (sport === "NFL" ? "2025-09-01" : addDays(endDate, -90));
  const chunkDays = Number(args.get("chunk-days") ?? 14);

  let fetched = 0;
  let stored = 0;
  const chunks = dateChunks(startDate, endDate, chunkDays);
  for (const chunk of chunks) {
    const finals = await fetchFootballFinals(sport, chunk.startDate, chunk.endDate);
    fetched += finals.length;
    for (const final of finals) {
      await upsertFootballResult(sport, final);
      stored += 1;
    }
  }

  return { sport, startDate, endDate, chunks: chunks.length, fetched, stored };
};

try {
  console.log(JSON.stringify(await run(), null, 2));
} finally {
  await pool.end();
}
