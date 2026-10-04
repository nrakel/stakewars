import { pool, transaction } from "../src/server/db.js";
import { settleNcaafWagers, settleNflWagers } from "../src/server/settlement.js";

type EspnNflScoreboardResponse = {
  events?: Array<{
    id: string;
    competitions?: Array<{
      status?: {
        type?: {
          completed?: boolean;
          state?: string;
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
    date?: string;
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
    throw new Error(`ESPN NFL scoreboard failed with ${response.status}`);
  }
  return (await response.json()) as EspnNflScoreboardResponse;
};

const settleNflConfidencePicks = async () => {
  const activePools = await pool.query<{ id: string; season: number; week: number }>(
    `
      SELECT DISTINCT p.id, p.season, g.week
      FROM nfl_confidence_pool p
      JOIN nfl_confidence_game g ON g.pool_id = p.id
      JOIN nfl_confidence_pick pick ON pick.game_id = g.id
      WHERE p.status = 'active'
        AND pick.status = 'pending'
        AND g.starts_at <= now()
      ORDER BY p.season, g.week
    `
  );

  let completedEvents = 0;
  let updatedGames = 0;
  let settledPicks = 0;

  for (const poolRow of activePools.rows) {
    const scoreboard = await fetchEspnNflWeek(poolRow.season, poolRow.week);
    const events = scoreboard.events ?? [];
    completedEvents += events.filter((event) => event.competitions?.[0]?.status?.type?.completed).length;

    const result = await transaction(async (client) => {
      let games = 0;
      let picks = 0;

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

        const gameResult = await client.query(
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
            poolRow.id,
            poolRow.season,
            poolRow.week,
            event.id,
            away.score == null ? null : Number(away.score),
            home.score == null ? null : Number(home.score),
            status
          ]
        );
        games += gameResult.rowCount ?? 0;
      }

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
        [poolRow.id, poolRow.week]
      );

      for (const game of finalGames.rows) {
        if (game.awayScore == null || game.homeScore == null) continue;
        const winner = game.awayScore > game.homeScore
          ? game.awayTeam
          : game.homeScore > game.awayScore
            ? game.homeTeam
            : null;
        const pickResult = await client.query(
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
          [poolRow.id, winner, game.id]
        );
        picks += pickResult.rowCount ?? 0;
      }

      return { games, picks };
    });

    updatedGames += result.games;
    settledPicks += result.picks;
  }

  return { checkedPools: activePools.rowCount, completedEvents, updatedGames, settledPicks };
};

const settleSurvivorPicks = async () => {
  const pendingWeeks = await pool.query<{ season: number; week: number }>(
    `
      SELECT DISTINCT sp.season, g.week
      FROM survivor_pool sp
      JOIN survivor_pick pick ON pick.pool_id = sp.id
      JOIN nfl_confidence_game g ON g.season = sp.season
        AND g.away_team = pick.away_team
        AND g.home_team = pick.home_team
        AND abs(extract(epoch from g.starts_at - pick.starts_at)) <= 43200
      WHERE sp.status = 'active'
        AND pick.status = 'pending'
        AND pick.starts_at <= now()
      ORDER BY sp.season, g.week
    `
  );

  let completedEvents = 0;
  let settledPicks = 0;
  let eliminatedEntries = 0;

  for (const pendingWeek of pendingWeeks.rows) {
    const scoreboard = await fetchEspnNflWeek(pendingWeek.season, pendingWeek.week);
    for (const event of scoreboard.events ?? []) {
      const competition = event.competitions?.[0];
      if (!competition?.status?.type?.completed) continue;
      const competitors = competition.competitors ?? [];
      const away = competitors.find((competitor) => competitor.homeAway === "away");
      const home = competitors.find((competitor) => competitor.homeAway === "home");
      const awayTeam = away?.team?.displayName ?? away?.team?.name ?? away?.team?.shortDisplayName;
      const homeTeam = home?.team?.displayName ?? home?.team?.name ?? home?.team?.shortDisplayName;
      const startsAt = event.date ? new Date(event.date) : null;
      const awayScore = away?.score == null ? null : Number(away.score);
      const homeScore = home?.score == null ? null : Number(home.score);
      if (!awayTeam || !homeTeam || !startsAt || Number.isNaN(startsAt.getTime()) || awayScore == null || homeScore == null) {
        continue;
      }

      completedEvents += 1;
      const winner = awayScore > homeScore ? awayTeam : homeScore > awayScore ? homeTeam : null;
      const result = await transaction(async (client) => {
        const updated = await client.query<{ entryId: string; status: "won" | "lost" | "tie"; weekStart: string }>(
          `
            UPDATE survivor_pick pick
            SET status = CASE
                  WHEN $5::text IS NULL THEN 'tie'
                  WHEN pick.selected_team = $5 THEN 'won'
                  ELSE 'lost'
                END,
                locked_at = COALESCE(locked_at, now()),
                settled_at = now(),
                updated_at = now()
            FROM survivor_pool sp
            WHERE pick.pool_id = sp.id
              AND sp.status = 'active'
              AND sp.season = $1
              AND pick.status = 'pending'
              AND pick.away_team = $2
              AND pick.home_team = $3
              AND abs(extract(epoch from pick.starts_at - $4::timestamptz)) <= 43200
            RETURNING pick.entry_id AS "entryId", pick.status, pick.week_start::text AS "weekStart"
          `,
          [pendingWeek.season, awayTeam, homeTeam, startsAt, winner]
        );

        const eliminated = updated.rows.filter((row) => row.status === "lost" || row.status === "tie");
        if (eliminated.length) {
          const eliminatedResult = await client.query(
            `
              UPDATE survivor_entry entry
              SET status = 'eliminated',
                  eliminated_week_start = COALESCE(entry.eliminated_week_start, updates.week_start::date),
                  updated_at = now()
              FROM (
                SELECT unnest($1::uuid[]) AS entry_id, $2::date AS week_start
              ) updates
              WHERE entry.id = updates.entry_id
                AND entry.status = 'active'
            `,
            [eliminated.map((row) => row.entryId), eliminated[0].weekStart]
          );
          return { settled: updated.rowCount ?? 0, eliminated: eliminatedResult.rowCount ?? 0 };
        }

        return { settled: updated.rowCount ?? 0, eliminated: 0 };
      });

      settledPicks += result.settled;
      eliminatedEntries += result.eliminated;
    }
  }

  return { checkedWeeks: pendingWeeks.rowCount, completedEvents, settledPicks, eliminatedEntries };
};

try {
  const pending = await pool.query<{ sport: "NFL" | "NCAAF"; gameDate: string; pendingStartedLegs: string }>(
    `
      SELECT
        gl.sport,
        (gl.starts_at AT TIME ZONE 'America/Chicago')::date::text AS "gameDate",
        count(*)::text AS "pendingStartedLegs"
      FROM wager w
      JOIN wager_leg wl ON wl.wager_id = w.id
      JOIN game_line gl ON gl.id = wl.game_line_id
      WHERE (w.status = 'pending' OR wl.status = 'pending')
        AND wl.status = 'pending'
        AND gl.sport IN ('NFL', 'NCAAF')
        AND gl.starts_at <= now()
        AND gl.starts_at >= now() - interval '10 days'
      GROUP BY gl.sport, (gl.starts_at AT TIME ZONE 'America/Chicago')::date
      ORDER BY gl.sport, (gl.starts_at AT TIME ZONE 'America/Chicago')::date
    `
  );
  const pendingStartedLegs = pending.rows.reduce((sum, row) => sum + Number(row.pendingStartedLegs), 0);
  const confidence = await settleNflConfidencePicks();
  const survivor = await settleSurvivorPicks();

  if (pendingStartedLegs <= 0) {
    console.log(JSON.stringify({ skipped: "no started pending football legs", pendingStartedLegs, confidence, survivor }));
  } else {
    const results: Record<string, unknown> = {};
    const nflDates = pending.rows.filter((row) => row.sport === "NFL").map((row) => row.gameDate);
    const ncaafDates = pending.rows.filter((row) => row.sport === "NCAAF").map((row) => row.gameDate);
    if (nflDates.length > 0) {
      results.nfl = [];
      for (const gameDate of nflDates) {
        (results.nfl as unknown[]).push(await settleNflWagers(gameDate, gameDate));
      }
    }
    if (ncaafDates.length > 0) {
      results.ncaaf = [];
      for (const gameDate of ncaafDates) {
        (results.ncaaf as unknown[]).push(await settleNcaafWagers(gameDate, gameDate));
      }
    }
    console.log(JSON.stringify({ pendingStartedLegs, pendingDates: pending.rows, confidence, survivor, ...results }, null, 2));
  }
} finally {
  await pool.end();
}
