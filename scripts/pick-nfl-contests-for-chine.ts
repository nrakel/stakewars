import { randomUUID } from "node:crypto";
import { currentWeekStart, nflSeasonWeek } from "../src/server/betting.js";
import { config } from "../src/server/config.js";
import { pool, transaction } from "../src/server/db.js";

type ContestLine = {
  id: string;
  startsAt: Date;
  awayTeam: string;
  homeTeam: string;
  selectedTeam: string;
  oddsAmerican: number;
};

type ConfidenceGame = {
  id: string;
  week: number;
  startsAt: Date;
  awayTeam: string;
  homeTeam: string;
};

type ScoredTeam = {
  gameId?: string;
  lineId?: string;
  awayTeam: string;
  homeTeam: string;
  selectedTeam: string;
  startsAt: Date;
  winProbability: number;
  confidenceScore: number;
  oddsAmerican: number | null;
};

const nflTeamNames = [
  "Arizona Cardinals",
  "Atlanta Falcons",
  "Baltimore Ravens",
  "Buffalo Bills",
  "Carolina Panthers",
  "Chicago Bears",
  "Cincinnati Bengals",
  "Cleveland Browns",
  "Dallas Cowboys",
  "Denver Broncos",
  "Detroit Lions",
  "Green Bay Packers",
  "Houston Texans",
  "Indianapolis Colts",
  "Jacksonville Jaguars",
  "Kansas City Chiefs",
  "Las Vegas Raiders",
  "Los Angeles Chargers",
  "Los Angeles Rams",
  "Miami Dolphins",
  "Minnesota Vikings",
  "New England Patriots",
  "New Orleans Saints",
  "New York Giants",
  "New York Jets",
  "Philadelphia Eagles",
  "Pittsburgh Steelers",
  "San Francisco 49ers",
  "Seattle Seahawks",
  "Tampa Bay Buccaneers",
  "Tennessee Titans",
  "Washington Commanders"
];

const nflTeamNameSet = new Set(nflTeamNames);

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

const isInContestWeek = (startsAt: Date, weekStart: string) => {
  const startsOn = centralDate(startsAt);
  return startsOn >= weekStart && startsOn < addDays(weekStart, 7);
};

const impliedProbability = (american: number) =>
  american > 0 ? 100 / (american + 100) : Math.abs(american) / (Math.abs(american) + 100);

const gameKey = (awayTeam: string, homeTeam: string) => `${awayTeam} @ ${homeTeam}`;

const scoreGame = (
  game: Pick<ConfidenceGame, "id" | "startsAt" | "awayTeam" | "homeTeam">,
  linesByGame: Map<string, ContestLine[]>
): ScoredTeam | null => {
  const lines = linesByGame.get(gameKey(game.awayTeam, game.homeTeam)) ?? [];
  const awayLine = lines.find((line) => line.selectedTeam === game.awayTeam);
  const homeLine = lines.find((line) => line.selectedTeam === game.homeTeam);

  if (!awayLine && !homeLine) {
    return null;
  }

  const rawAway = awayLine ? impliedProbability(awayLine.oddsAmerican) : 0.5;
  const rawHome = homeLine ? impliedProbability(homeLine.oddsAmerican) : 0.5;
  const total = rawAway + rawHome;
  const noVigAway = total > 0 ? rawAway / total : rawAway;
  const noVigHome = total > 0 ? rawHome / total : rawHome;

  const awayRested = game.awayTeam !== "Los Angeles Rams" && game.awayTeam !== "San Francisco 49ers";
  const homeRested = game.homeTeam !== "Los Angeles Rams" && game.homeTeam !== "San Francisco 49ers";
  const awayAdjustment = awayRested ? 0 : -0.015;
  const homeAdjustment = 0.018 + (homeRested ? 0 : -0.015);

  const awayProbability = Math.max(0.01, Math.min(0.99, noVigAway + awayAdjustment));
  const homeProbability = Math.max(0.01, Math.min(0.99, noVigHome + homeAdjustment));
  const selectedTeam = homeProbability >= awayProbability ? game.homeTeam : game.awayTeam;
  const selectedLine = selectedTeam === game.homeTeam ? homeLine : awayLine;
  const winProbability = selectedTeam === game.homeTeam ? homeProbability : awayProbability;
  const confidenceScore = Math.round(winProbability * 1000) / 10;

  return {
    gameId: game.id,
    lineId: selectedLine?.id,
    awayTeam: game.awayTeam,
    homeTeam: game.homeTeam,
    selectedTeam,
    startsAt: game.startsAt,
    winProbability,
    confidenceScore,
    oddsAmerican: selectedLine?.oddsAmerican ?? null
  };
};

const fetchCurrentNflLines = async (weekStart: string) => {
  const weekEnd = addDays(weekStart, 8);
  const result = await pool.query<ContestLine>(
    `
      SELECT DISTINCT ON (away_team, home_team, favorite_team)
        id,
        starts_at AS "startsAt",
        away_team AS "awayTeam",
        home_team AS "homeTeam",
        favorite_team AS "selectedTeam",
        odds_american AS "oddsAmerican"
      FROM game_line
      WHERE sport = 'NFL'
        AND market_key = 'h2h'
        AND is_active = true
        AND away_team = ANY($3::text[])
        AND home_team = ANY($3::text[])
        AND (starts_at AT TIME ZONE 'America/Chicago')::date >= $1::date
        AND (starts_at AT TIME ZONE 'America/Chicago')::date < $2::date
      ORDER BY away_team, home_team, favorite_team, fetched_at DESC
    `,
    [weekStart, weekEnd, nflTeamNames]
  );

  const linesByGame = new Map<string, ContestLine[]>();
  for (const line of result.rows) {
    if (!nflTeamNameSet.has(line.awayTeam) || !nflTeamNameSet.has(line.homeTeam)) continue;
    linesByGame.set(gameKey(line.awayTeam, line.homeTeam), [...(linesByGame.get(gameKey(line.awayTeam, line.homeTeam)) ?? []), line]);
  }
  return linesByGame;
};

const confidencePointValues = (gameCount: number, unavailable: number[]) => {
  const blocked = new Set(unavailable);
  return Array.from({ length: gameCount }, (_, index) => gameCount - index).filter((value) => !blocked.has(value));
};

const pickChineSurvivor = async (userId: string, linesByGame: Map<string, ContestLine[]>, weekStart: string) => {
  const poolRow = await pool.query<{ id: string; startsOn: string }>(
    "SELECT id, starts_on::text AS \"startsOn\" FROM survivor_pool WHERE status = 'active' ORDER BY starts_on DESC LIMIT 1"
  );
  const survivorPool = poolRow.rows[0];
  if (!survivorPool) return { skipped: "no active Survivor pool" };

  const activeWeekStart = currentWeekStart() < survivorPool.startsOn ? survivorPool.startsOn : currentWeekStart();
  const result = await transaction(async (client) => {
    const entryResult = await client.query<{ id: string; status: string }>(
      `
        INSERT INTO survivor_entry (id, pool_id, user_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (pool_id, user_id) DO UPDATE SET updated_at = now()
        RETURNING id, status
      `,
      [randomUUID(), survivorPool.id, userId]
    );
    const entry = entryResult.rows[0];
    if (!entry || entry.status !== "active") return { skipped: "Chine Survivor entry is not active" };

    const existingPick = await client.query<{ id: string; startsAt: Date; selectedTeam: string }>(
      "SELECT id, starts_at AS \"startsAt\", selected_team AS \"selectedTeam\" FROM survivor_pick WHERE entry_id = $1 AND week_start = $2::date FOR UPDATE",
      [entry.id, activeWeekStart]
    );
    const existing = existingPick.rows[0];
    if (existing?.startsAt && existing.startsAt.getTime() <= Date.now()) {
      return { selectedTeam: existing.selectedTeam, skipped: "existing Survivor pick is locked" };
    }

    const used = await client.query<{ selectedTeam: string }>(
      "SELECT selected_team AS \"selectedTeam\" FROM survivor_pick WHERE entry_id = $1 AND week_start <> $2::date AND status <> 'void'",
      [entry.id, activeWeekStart]
    );
    const usedTeams = new Set(used.rows.map((row) => row.selectedTeam));
    const candidates = [...linesByGame.values()]
      .map((lines) => {
        const first = lines[0];
        if (!first || !isInContestWeek(first.startsAt, activeWeekStart) || first.startsAt.getTime() <= Date.now()) return null;
        return scoreGame({ id: "", startsAt: first.startsAt, awayTeam: first.awayTeam, homeTeam: first.homeTeam }, linesByGame);
      })
      .filter((candidate): candidate is ScoredTeam => Boolean(candidate?.lineId && !usedTeams.has(candidate.selectedTeam)))
      .sort((left, right) => right.winProbability - left.winProbability || left.startsAt.getTime() - right.startsAt.getTime());

    const pick = candidates[0];
    if (!pick?.lineId) return { skipped: "no available Survivor candidate" };

    const pickId = existing?.id ?? randomUUID();
    await client.query(
      `
        INSERT INTO survivor_pick (
          id, pool_id, entry_id, user_id, week_start, game_line_id, selected_team,
          away_team, home_team, starts_at
        )
        VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10)
        ON CONFLICT (entry_id, week_start) DO UPDATE
        SET game_line_id = EXCLUDED.game_line_id,
            selected_team = EXCLUDED.selected_team,
            away_team = EXCLUDED.away_team,
            home_team = EXCLUDED.home_team,
            starts_at = EXCLUDED.starts_at,
            status = 'pending',
            locked_at = NULL,
            settled_at = NULL,
            updated_at = now()
      `,
      [pickId, survivorPool.id, entry.id, userId, activeWeekStart, pick.lineId, pick.selectedTeam, pick.awayTeam, pick.homeTeam, pick.startsAt]
    );

    return {
      selectedTeam: pick.selectedTeam,
      matchup: gameKey(pick.awayTeam, pick.homeTeam),
      startsAt: pick.startsAt.toISOString(),
      confidenceScore: pick.confidenceScore,
      oddsAmerican: pick.oddsAmerican
    };
  });

  return { weekStart, activeWeekStart, ...result };
};

const pickChineConfidence = async (userId: string, linesByGame: Map<string, ContestLine[]>) => {
  const poolRow = await pool.query<{ id: string; season: number; startsOn: string }>(
    "SELECT id, season, starts_on::text AS \"startsOn\" FROM nfl_confidence_pool WHERE status = 'active' ORDER BY starts_on DESC LIMIT 1"
  );
  const confidencePool = poolRow.rows[0];
  if (!confidencePool) return { skipped: "no active NFL Confidence pool" };

  const week = nflSeasonWeek(confidencePool.startsOn);
  const games = await pool.query<ConfidenceGame>(
    `
      SELECT id, week, starts_at AS "startsAt", away_team AS "awayTeam", home_team AS "homeTeam"
      FROM nfl_confidence_game
      WHERE pool_id = $1 AND week = $2
      ORDER BY starts_at ASC, away_team ASC
    `,
    [confidencePool.id, week]
  );
  if (!games.rowCount) return { skipped: "no NFL Confidence games available", week };

  const result = await transaction(async (client) => {
    const entryResult = await client.query<{ id: string; status: string }>(
      `
        INSERT INTO nfl_confidence_entry (id, pool_id, user_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (pool_id, user_id) DO UPDATE SET updated_at = now()
        RETURNING id, status
      `,
      [randomUUID(), confidencePool.id, userId]
    );
    const entry = entryResult.rows[0];
    if (!entry || entry.status !== "active") return { skipped: "Chine NFL Confidence entry is not active" };

    const firstGame = games.rows[0];
    const missedFirstGame = Boolean(firstGame && firstGame.startsAt.getTime() <= Date.now());
    if (missedFirstGame && firstGame) {
      await client.query(
        `
          INSERT INTO nfl_confidence_pick (
            id, pool_id, entry_id, user_id, game_id, season, week,
            selected_team, confidence_points, status, points_awarded, locked_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 5, 'lost', 0, now())
          ON CONFLICT (entry_id, game_id) DO NOTHING
        `,
        [randomUUID(), confidencePool.id, entry.id, userId, firstGame.id, confidencePool.season, week]
      );
    }

    const openGames = games.rows.filter((game) => game.startsAt.getTime() > Date.now());
    const scored = openGames
      .map((game) => scoreGame(game, linesByGame))
      .filter((candidate): candidate is ScoredTeam => Boolean(candidate))
      .sort((left, right) => right.winProbability - left.winProbability || left.startsAt.getTime() - right.startsAt.getTime());

    const unavailable = missedFirstGame ? [5] : [];
    const points = confidencePointValues(games.rows.length, unavailable).slice(0, scored.length);
    if (scored.length !== openGames.length) {
      return {
        skipped: `expected ${openGames.length} open Confidence games but scored ${scored.length}`,
        week,
        scored: scored.map((pick) => pick.selectedTeam)
      };
    }

    await client.query(
      `
        DELETE FROM nfl_confidence_pick pick
        USING nfl_confidence_game game
        WHERE pick.game_id = game.id
          AND pick.entry_id = $1
          AND pick.week = $2
          AND pick.locked_at IS NULL
          AND game.starts_at > now()
      `,
      [entry.id, week]
    );

    for (const [index, pick] of scored.entries()) {
      await client.query(
        `
          INSERT INTO nfl_confidence_pick (
            id, pool_id, entry_id, user_id, game_id, season, week,
            selected_team, confidence_points, status, points_awarded
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 0)
          ON CONFLICT (entry_id, game_id) DO UPDATE
          SET selected_team = EXCLUDED.selected_team,
              confidence_points = EXCLUDED.confidence_points,
              status = 'pending',
              points_awarded = 0,
              updated_at = now()
        `,
        [randomUUID(), confidencePool.id, entry.id, userId, pick.gameId, confidencePool.season, week, pick.selectedTeam, points[index]]
      );
    }

    return {
      week,
      picks: scored.map((pick, index) => ({
        selectedTeam: pick.selectedTeam,
        matchup: gameKey(pick.awayTeam, pick.homeTeam),
        confidencePoints: points[index],
        confidenceScore: pick.confidenceScore,
        oddsAmerican: pick.oddsAmerican,
        startsAt: pick.startsAt.toISOString()
      }))
    };
  });

  return result;
};

try {
  const user = await pool.query<{ id: string }>(
    "SELECT id FROM app_user WHERE username = $1 AND role = 'system' LIMIT 1",
    [config.aiUsername]
  );
  const chine = user.rows[0];
  if (!chine) {
    throw new Error(`System user ${config.aiUsername} not found`);
  }

  const weekStart = currentWeekStart();
  const linesByGame = await fetchCurrentNflLines(weekStart);
  const survivor = await pickChineSurvivor(chine.id, linesByGame, weekStart);
  const confidence = await pickChineConfidence(chine.id, linesByGame);

  console.log(JSON.stringify({ survivor, confidence }, null, 2));
} finally {
  await pool.end();
}
