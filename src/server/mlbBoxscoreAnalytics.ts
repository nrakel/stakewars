import { randomUUID } from "node:crypto";
import type pg from "pg";
import { transaction } from "./db.js";

type TeamRef = {
  id: number;
  name: string;
};

type ScheduleGame = {
  gamePk: number;
  gameDate: string;
  officialDate?: string;
  status?: {
    abstractGameState?: string;
    detailedState?: string;
    statusCode?: string;
  };
  teams: {
    away: {
      team: TeamRef;
      score?: number;
    };
    home: {
      team: TeamRef;
      score?: number;
    };
  };
};

type ScheduleResponse = {
  dates?: Array<{
    games?: ScheduleGame[];
  }>;
};

type BoxscoreTeam = {
  team: TeamRef;
  pitchers?: number[];
  players?: Record<string, {
    person?: {
      id: number;
      fullName: string;
    };
    stats?: {
      pitching?: Record<string, unknown>;
    };
  }>;
};

type BoxscoreResponse = {
  teams?: {
    away?: BoxscoreTeam;
    home?: BoxscoreTeam;
  };
};

type PitcherLine = {
  providerGameId: string;
  startsOn: string;
  startsAt: string;
  season: number;
  teamId: number;
  teamName: string;
  opponentTeamId: number;
  opponentTeamName: string;
  isHome: boolean;
  playerId: number;
  playerName: string;
  isStarter: boolean;
  outs: number;
  inningsPitched: number;
  earnedRuns: number;
  runs: number;
  hits: number;
  walks: number;
  intentionalWalks: number;
  hitBatsmen: number;
  strikeouts: number;
  homeRuns: number;
  battersFaced: number;
  pitches: number;
  groundOuts: number;
  airOuts: number;
  flyOuts: number;
  popOuts: number;
  lineOuts: number;
  inheritedRunners: number;
  inheritedRunnersScored: number;
  payload: Record<string, unknown>;
};

const yyyyMmDd = (date: Date) => date.toISOString().slice(0, 10);

const addDays = (date: string, days: number) => {
  const copy = new Date(`${date}T00:00:00Z`);
  copy.setUTCDate(copy.getUTCDate() + days);
  return yyyyMmDd(copy);
};

const seasonForDate = (date: string) => Number(date.slice(0, 4));

const parseNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return 0;
  }
  const normalized = value.trim();
  if (!normalized || normalized.includes("--") || normalized.includes("---")) {
    return 0;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
};

const inningsToOuts = (value: unknown) => {
  if (typeof value === "number") {
    return Math.round(value * 3);
  }
  if (typeof value !== "string") {
    return 0;
  }
  const [inningsRaw, partialRaw = "0"] = value.split(".");
  const innings = Number(inningsRaw);
  const partial = Number(partialRaw);
  if (!Number.isFinite(innings) || !Number.isFinite(partial)) {
    return 0;
  }
  return innings * 3 + partial;
};

const outsToInnings = (outs: number) => Number((Math.floor(outs / 3) + (outs % 3) / 10).toFixed(1));

const fetchJson = async <T>(url: URL | string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`MLB Stats API request failed with ${response.status}: ${url.toString()}`);
  }
  return (await response.json()) as T;
};

const isCompletedGame = (game: ScheduleGame) => {
  const detailed = game.status?.detailedState?.toLowerCase() ?? "";
  return game.status?.abstractGameState === "Final"
    || detailed.includes("final")
    || detailed.includes("completed");
};

const fetchSchedule = async (startDate: string, endDate: string) => {
  const url = new URL("https://statsapi.mlb.com/api/v1/schedule");
  url.searchParams.set("sportId", "1");
  url.searchParams.set("hydrate", "team,linescore");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);

  const body = await fetchJson<ScheduleResponse>(url);
  return (body.dates ?? [])
    .flatMap((date) => date.games ?? [])
    .filter((game) => isCompletedGame(game));
};

const fetchBoxscore = (gamePk: number) =>
  fetchJson<BoxscoreResponse>(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`);

const normalizePitcherLine = ({
  game,
  side,
  opponent,
  isHome,
  pitcherId,
  pitcherIndex
}: {
  game: ScheduleGame;
  side: BoxscoreTeam;
  opponent: BoxscoreTeam;
  isHome: boolean;
  pitcherId: number;
  pitcherIndex: number;
}): PitcherLine | null => {
  const player = side.players?.[`ID${pitcherId}`];
  const pitching = player?.stats?.pitching ?? {};
  const outs = parseNumber(pitching.outs) || inningsToOuts(pitching.inningsPitched);
  const playerName = player?.person?.fullName;
  if (!playerName || outs <= 0) {
    return null;
  }

  const startsOn = yyyyMmDd(new Date(game.gameDate));
  return {
    providerGameId: String(game.gamePk),
    startsOn,
    startsAt: game.gameDate,
    season: seasonForDate(startsOn),
    teamId: side.team.id,
    teamName: side.team.name,
    opponentTeamId: opponent.team.id,
    opponentTeamName: opponent.team.name,
    isHome,
    playerId: pitcherId,
    playerName,
    isStarter: pitcherIndex === 0,
    outs,
    inningsPitched: outsToInnings(outs),
    earnedRuns: parseNumber(pitching.earnedRuns),
    runs: parseNumber(pitching.runs),
    hits: parseNumber(pitching.hits),
    walks: parseNumber(pitching.baseOnBalls),
    intentionalWalks: parseNumber(pitching.intentionalWalks),
    hitBatsmen: parseNumber(pitching.hitBatsmen),
    strikeouts: parseNumber(pitching.strikeOuts),
    homeRuns: parseNumber(pitching.homeRuns),
    battersFaced: parseNumber(pitching.battersFaced),
    pitches: parseNumber(pitching.numberOfPitches) || parseNumber(pitching.pitchesThrown),
    groundOuts: parseNumber(pitching.groundOuts),
    airOuts: parseNumber(pitching.airOuts),
    flyOuts: parseNumber(pitching.flyOuts),
    popOuts: parseNumber(pitching.popOuts),
    lineOuts: parseNumber(pitching.lineOuts),
    inheritedRunners: parseNumber(pitching.inheritedRunners),
    inheritedRunnersScored: parseNumber(pitching.inheritedRunnersScored),
    payload: pitching
  };
};

const pitcherLinesForGame = (game: ScheduleGame, boxscore: BoxscoreResponse) => {
  const away = boxscore.teams?.away;
  const home = boxscore.teams?.home;
  if (!away || !home) {
    return [];
  }

  const awayLines = (away.pitchers ?? [])
    .map((pitcherId, index) => normalizePitcherLine({
      game,
      side: away,
      opponent: home,
      isHome: false,
      pitcherId,
      pitcherIndex: index
    }))
    .filter((line): line is PitcherLine => Boolean(line));
  const homeLines = (home.pitchers ?? [])
    .map((pitcherId, index) => normalizePitcherLine({
      game,
      side: home,
      opponent: away,
      isHome: true,
      pitcherId,
      pitcherIndex: index
    }))
    .filter((line): line is PitcherLine => Boolean(line));
  return [...awayLines, ...homeLines];
};

const upsertBoxscoreGame = async (client: pg.PoolClient, game: ScheduleGame, boxscore: BoxscoreResponse) => {
  const startsOn = yyyyMmDd(new Date(game.gameDate));
  await client.query(
    `
      INSERT INTO mlb_boxscore_game (
        provider_game_id, starts_on, starts_at, season,
        away_team_id, away_team, home_team_id, home_team,
        away_score, home_score, status, payload, fetched_at, updated_at
      )
      VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now(), now())
      ON CONFLICT (provider_game_id) DO UPDATE SET
        starts_on = EXCLUDED.starts_on,
        starts_at = EXCLUDED.starts_at,
        season = EXCLUDED.season,
        away_team_id = EXCLUDED.away_team_id,
        away_team = EXCLUDED.away_team,
        home_team_id = EXCLUDED.home_team_id,
        home_team = EXCLUDED.home_team,
        away_score = EXCLUDED.away_score,
        home_score = EXCLUDED.home_score,
        status = EXCLUDED.status,
        payload = EXCLUDED.payload,
        fetched_at = now(),
        updated_at = now()
    `,
    [
      String(game.gamePk),
      startsOn,
      game.gameDate,
      seasonForDate(startsOn),
      game.teams.away.team.id,
      game.teams.away.team.name,
      game.teams.home.team.id,
      game.teams.home.team.name,
      typeof game.teams.away.score === "number" ? game.teams.away.score : null,
      typeof game.teams.home.score === "number" ? game.teams.home.score : null,
      game.status?.detailedState ?? null,
      JSON.stringify({ boxscoreTeams: boxscore.teams })
    ]
  );
};

const upsertPitcherLine = async (client: pg.PoolClient, line: PitcherLine) => {
  await client.query(
    `
      INSERT INTO mlb_boxscore_pitcher (
        id, provider_game_id, starts_on, starts_at, season,
        team_id, team_name, opponent_team_id, opponent_team_name, is_home,
        player_id, player_name, is_starter, outs, innings_pitched,
        earned_runs, runs, hits, walks, intentional_walks, hit_batsmen,
        strikeouts, home_runs, batters_faced, pitches, ground_outs,
        air_outs, fly_outs, pop_outs, line_outs,
        inherited_runners, inherited_runners_scored, payload, updated_at
      )
      VALUES (
        $1, $2, $3::date, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21,
        $22, $23, $24, $25, $26,
        $27, $28, $29, $30,
        $31, $32, $33::jsonb, now()
      )
      ON CONFLICT (provider_game_id, team_id, player_id) DO UPDATE SET
        starts_on = EXCLUDED.starts_on,
        starts_at = EXCLUDED.starts_at,
        season = EXCLUDED.season,
        team_name = EXCLUDED.team_name,
        opponent_team_id = EXCLUDED.opponent_team_id,
        opponent_team_name = EXCLUDED.opponent_team_name,
        is_home = EXCLUDED.is_home,
        player_name = EXCLUDED.player_name,
        is_starter = EXCLUDED.is_starter,
        outs = EXCLUDED.outs,
        innings_pitched = EXCLUDED.innings_pitched,
        earned_runs = EXCLUDED.earned_runs,
        runs = EXCLUDED.runs,
        hits = EXCLUDED.hits,
        walks = EXCLUDED.walks,
        intentional_walks = EXCLUDED.intentional_walks,
        hit_batsmen = EXCLUDED.hit_batsmen,
        strikeouts = EXCLUDED.strikeouts,
        home_runs = EXCLUDED.home_runs,
        batters_faced = EXCLUDED.batters_faced,
        pitches = EXCLUDED.pitches,
        ground_outs = EXCLUDED.ground_outs,
        air_outs = EXCLUDED.air_outs,
        fly_outs = EXCLUDED.fly_outs,
        pop_outs = EXCLUDED.pop_outs,
        line_outs = EXCLUDED.line_outs,
        inherited_runners = EXCLUDED.inherited_runners,
        inherited_runners_scored = EXCLUDED.inherited_runners_scored,
        payload = EXCLUDED.payload,
        updated_at = now()
    `,
    [
      randomUUID(),
      line.providerGameId,
      line.startsOn,
      line.startsAt,
      line.season,
      line.teamId,
      line.teamName,
      line.opponentTeamId,
      line.opponentTeamName,
      line.isHome,
      line.playerId,
      line.playerName,
      line.isStarter,
      line.outs,
      line.inningsPitched,
      line.earnedRuns,
      line.runs,
      line.hits,
      line.walks,
      line.intentionalWalks,
      line.hitBatsmen,
      line.strikeouts,
      line.homeRuns,
      line.battersFaced,
      line.pitches,
      line.groundOuts,
      line.airOuts,
      line.flyOuts,
      line.popOuts,
      line.lineOuts,
      line.inheritedRunners,
      line.inheritedRunnersScored,
      JSON.stringify(line.payload)
    ]
  );
};

const recomputePitcherRollingMetrics = async (client: pg.PoolClient, asOfDate: string, windowDays: number) => {
  const startDate = addDays(asOfDate, -windowDays);
  const result = await client.query(
    `
      WITH league AS (
        SELECT
          sum(earned_runs)::numeric AS er,
          sum(outs)::numeric AS outs,
          sum(home_runs)::numeric AS hr,
          sum(walks - intentional_walks + hit_batsmen)::numeric AS bb_hbp,
          sum(strikeouts)::numeric AS k,
          sum(GREATEST(air_outs + home_runs, fly_outs + pop_outs + line_outs + home_runs))::numeric AS fly_proxy
        FROM mlb_boxscore_pitcher
        WHERE starts_on >= $2::date
          AND starts_on < $1::date
          AND outs > 0
      ),
      constants AS (
        SELECT
          CASE WHEN outs > 0 THEN (er * 27 / outs) - ((13 * hr + 3 * bb_hbp - 2 * k) / (outs / 3)) ELSE 3.1 END AS fip_constant,
          CASE WHEN fly_proxy > 0 THEN hr / fly_proxy ELSE 0.12 END AS league_hr_per_fly_proxy
        FROM league
      ),
      pitcher AS (
        SELECT
          player_id,
          max(player_name) AS player_name,
          (array_agg(team_id ORDER BY starts_on DESC, starts_at DESC))[1] AS team_id,
          (array_agg(team_name ORDER BY starts_on DESC, starts_at DESC))[1] AS team_name,
          CASE WHEN is_starter THEN 'starter' ELSE 'reliever' END AS role,
          count(*)::integer AS games,
          count(*) FILTER (WHERE is_starter)::integer AS starts,
          count(*) FILTER (WHERE NOT is_starter)::integer AS relief_appearances,
          sum(outs)::integer AS outs,
          sum(earned_runs)::integer AS earned_runs,
          sum(home_runs)::integer AS home_runs,
          sum(walks)::integer AS walks,
          sum(intentional_walks)::integer AS intentional_walks,
          sum(hit_batsmen)::integer AS hit_batsmen,
          sum(strikeouts)::integer AS strikeouts,
          sum(batters_faced)::integer AS batters_faced,
          sum(pitches)::integer AS pitches,
          sum(ground_outs)::integer AS ground_outs,
          sum(air_outs)::integer AS air_outs,
          sum(GREATEST(air_outs + home_runs, fly_outs + pop_outs + line_outs + home_runs))::integer AS fly_ball_proxy
        FROM mlb_boxscore_pitcher
        WHERE starts_on >= $2::date
          AND starts_on < $1::date
          AND outs > 0
        GROUP BY player_id, is_starter
      ),
      calculated AS (
        SELECT
          p.*,
          c.fip_constant,
          c.league_hr_per_fly_proxy,
          (p.fly_ball_proxy * c.league_hr_per_fly_proxy)::numeric AS expected_home_runs
        FROM pitcher p
        CROSS JOIN constants c
      )
      INSERT INTO mlb_pitcher_rolling_metric (
        id, as_of_date, player_id, player_name, team_id, team_name, role, window_days,
        games, starts, relief_appearances, outs, innings_pitched,
        earned_runs, home_runs, expected_home_runs, walks, intentional_walks,
        hit_batsmen, strikeouts, batters_faced, pitches, ground_outs,
        air_outs, fly_ball_proxy, era, fip, xfip_like, sw_fip, sw_xfip, sw_siera, k_pct, bb_pct,
        k_minus_bb_pct, hr_per_9, pitches_per_inning, updated_at
      )
      SELECT
        md5($1::text || ':' || player_id::text || ':' || role || ':' || $3::text)::uuid,
        $1::date, player_id, player_name, team_id, team_name, role, $3::int,
        games, starts, relief_appearances, outs, (floor(outs / 3) + mod(outs, 3) / 10.0)::numeric(7,1),
        earned_runs, home_runs, expected_home_runs, walks, intentional_walks,
        hit_batsmen, strikeouts, batters_faced, pitches, ground_outs,
        air_outs, fly_ball_proxy,
        CASE WHEN outs > 0 THEN (earned_runs * 27.0 / outs)::numeric(7,3) END,
        CASE WHEN outs > 0 THEN (((13 * home_runs + 3 * (walks - intentional_walks + hit_batsmen) - 2 * strikeouts) / (outs / 3.0)) + fip_constant)::numeric(7,3) END,
        CASE WHEN outs > 0 THEN (((13 * expected_home_runs + 3 * (walks - intentional_walks + hit_batsmen) - 2 * strikeouts) / (outs / 3.0)) + fip_constant)::numeric(7,3) END,
        CASE WHEN outs > 0 THEN (((13 * home_runs + 3 * (walks - intentional_walks + hit_batsmen) - 2 * strikeouts) / (outs / 3.0)) + fip_constant)::numeric(7,3) END,
        CASE WHEN outs > 0 THEN (((13 * expected_home_runs + 3 * (walks - intentional_walks + hit_batsmen) - 2 * strikeouts) / (outs / 3.0)) + fip_constant)::numeric(7,3) END,
        CASE WHEN batters_faced > 0 THEN GREATEST(1.5, LEAST(7.5,
          4.6
          - 3.2 * (strikeouts::numeric / batters_faced)
          + 4.0 * ((walks - intentional_walks + hit_batsmen)::numeric / batters_faced)
          - 0.8 * COALESCE(ground_outs::numeric / NULLIF(ground_outs + fly_ball_proxy, 0), 0)
          + 1.2 * COALESCE(home_runs::numeric / NULLIF(fly_ball_proxy, 0), 0)
          + 0.25 * ((pitches / NULLIF(outs / 3.0, 0)) - 16.5) / 2.5
        ))::numeric(7,3) END,
        CASE WHEN batters_faced > 0 THEN (strikeouts::numeric / batters_faced)::numeric(7,5) END,
        CASE WHEN batters_faced > 0 THEN ((walks - intentional_walks + hit_batsmen)::numeric / batters_faced)::numeric(7,5) END,
        CASE WHEN batters_faced > 0 THEN ((strikeouts - (walks - intentional_walks + hit_batsmen))::numeric / batters_faced)::numeric(7,5) END,
        CASE WHEN outs > 0 THEN (home_runs * 27.0 / outs)::numeric(7,3) END,
        CASE WHEN outs > 0 THEN (pitches / (outs / 3.0))::numeric(7,3) END,
        now()
      FROM calculated
      WHERE outs > 0
      ON CONFLICT (as_of_date, player_id, role, window_days) DO UPDATE SET
        player_name = EXCLUDED.player_name,
        team_id = EXCLUDED.team_id,
        team_name = EXCLUDED.team_name,
        games = EXCLUDED.games,
        starts = EXCLUDED.starts,
        relief_appearances = EXCLUDED.relief_appearances,
        outs = EXCLUDED.outs,
        innings_pitched = EXCLUDED.innings_pitched,
        earned_runs = EXCLUDED.earned_runs,
        home_runs = EXCLUDED.home_runs,
        expected_home_runs = EXCLUDED.expected_home_runs,
        walks = EXCLUDED.walks,
        intentional_walks = EXCLUDED.intentional_walks,
        hit_batsmen = EXCLUDED.hit_batsmen,
        strikeouts = EXCLUDED.strikeouts,
        batters_faced = EXCLUDED.batters_faced,
        pitches = EXCLUDED.pitches,
        ground_outs = EXCLUDED.ground_outs,
        air_outs = EXCLUDED.air_outs,
        fly_ball_proxy = EXCLUDED.fly_ball_proxy,
        era = EXCLUDED.era,
        fip = EXCLUDED.fip,
        xfip_like = EXCLUDED.xfip_like,
        sw_fip = EXCLUDED.sw_fip,
        sw_xfip = EXCLUDED.sw_xfip,
        sw_siera = EXCLUDED.sw_siera,
        k_pct = EXCLUDED.k_pct,
        bb_pct = EXCLUDED.bb_pct,
        k_minus_bb_pct = EXCLUDED.k_minus_bb_pct,
        hr_per_9 = EXCLUDED.hr_per_9,
        pitches_per_inning = EXCLUDED.pitches_per_inning,
        updated_at = now()
    `,
    [asOfDate, startDate, windowDays]
  );
  return result.rowCount ?? 0;
};

const recomputeBullpenRollingMetrics = async (client: pg.PoolClient, asOfDate: string, windowDays: number) => {
  const startDate = addDays(asOfDate, -windowDays);
  const result = await client.query(
    `
      WITH league AS (
        SELECT
          sum(earned_runs)::numeric AS er,
          sum(outs)::numeric AS outs,
          sum(home_runs)::numeric AS hr,
          sum(walks - intentional_walks + hit_batsmen)::numeric AS bb_hbp,
          sum(strikeouts)::numeric AS k,
          sum(GREATEST(air_outs + home_runs, fly_outs + pop_outs + line_outs + home_runs))::numeric AS fly_proxy
        FROM mlb_boxscore_pitcher
        WHERE starts_on >= $2::date
          AND starts_on < $1::date
          AND outs > 0
      ),
      constants AS (
        SELECT
          CASE WHEN outs > 0 THEN (er * 27 / outs) - ((13 * hr + 3 * bb_hbp - 2 * k) / (outs / 3)) ELSE 3.1 END AS fip_constant,
          CASE WHEN fly_proxy > 0 THEN hr / fly_proxy ELSE 0.12 END AS league_hr_per_fly_proxy
        FROM league
      ),
      bullpen AS (
        SELECT
          team_id,
          max(team_name) AS team_name,
          count(DISTINCT provider_game_id)::integer AS games,
          count(*)::integer AS reliever_appearances,
          sum(outs)::integer AS outs,
          sum(earned_runs)::integer AS earned_runs,
          sum(home_runs)::integer AS home_runs,
          sum(walks)::integer AS walks,
          sum(intentional_walks)::integer AS intentional_walks,
          sum(hit_batsmen)::integer AS hit_batsmen,
          sum(strikeouts)::integer AS strikeouts,
          sum(batters_faced)::integer AS batters_faced,
          sum(pitches)::integer AS pitches,
          sum(ground_outs)::integer AS ground_outs,
          sum(air_outs)::integer AS air_outs,
          sum(GREATEST(air_outs + home_runs, fly_outs + pop_outs + line_outs + home_runs))::integer AS fly_ball_proxy
        FROM mlb_boxscore_pitcher
        WHERE starts_on >= $2::date
          AND starts_on < $1::date
          AND outs > 0
          AND is_starter = false
        GROUP BY team_id
      ),
      calculated AS (
        SELECT
          b.*,
          c.fip_constant,
          c.league_hr_per_fly_proxy,
          (b.fly_ball_proxy * c.league_hr_per_fly_proxy)::numeric AS expected_home_runs
        FROM bullpen b
        CROSS JOIN constants c
      )
      INSERT INTO mlb_team_bullpen_rolling_metric (
        id, as_of_date, team_id, team_name, window_days,
        games, reliever_appearances, outs, innings_pitched,
        earned_runs, home_runs, expected_home_runs, walks, intentional_walks,
        hit_batsmen, strikeouts, batters_faced, pitches, ground_outs,
        air_outs, fly_ball_proxy, era, fip, xfip_like, sw_fip, sw_xfip, sw_siera, k_pct, bb_pct,
        k_minus_bb_pct, hr_per_9, pitches_per_inning, updated_at
      )
      SELECT
        md5($1::text || ':' || team_id::text || ':bullpen:' || $3::text)::uuid,
        $1::date, team_id, team_name, $3::int,
        games, reliever_appearances, outs, (floor(outs / 3) + mod(outs, 3) / 10.0)::numeric(7,1),
        earned_runs, home_runs, expected_home_runs, walks, intentional_walks,
        hit_batsmen, strikeouts, batters_faced, pitches, ground_outs,
        air_outs, fly_ball_proxy,
        CASE WHEN outs > 0 THEN (earned_runs * 27.0 / outs)::numeric(7,3) END,
        CASE WHEN outs > 0 THEN (((13 * home_runs + 3 * (walks - intentional_walks + hit_batsmen) - 2 * strikeouts) / (outs / 3.0)) + fip_constant)::numeric(7,3) END,
        CASE WHEN outs > 0 THEN (((13 * expected_home_runs + 3 * (walks - intentional_walks + hit_batsmen) - 2 * strikeouts) / (outs / 3.0)) + fip_constant)::numeric(7,3) END,
        CASE WHEN outs > 0 THEN (((13 * home_runs + 3 * (walks - intentional_walks + hit_batsmen) - 2 * strikeouts) / (outs / 3.0)) + fip_constant)::numeric(7,3) END,
        CASE WHEN outs > 0 THEN (((13 * expected_home_runs + 3 * (walks - intentional_walks + hit_batsmen) - 2 * strikeouts) / (outs / 3.0)) + fip_constant)::numeric(7,3) END,
        CASE WHEN batters_faced > 0 THEN GREATEST(1.5, LEAST(7.5,
          4.6
          - 3.2 * (strikeouts::numeric / batters_faced)
          + 4.0 * ((walks - intentional_walks + hit_batsmen)::numeric / batters_faced)
          - 0.8 * COALESCE(ground_outs::numeric / NULLIF(ground_outs + fly_ball_proxy, 0), 0)
          + 1.2 * COALESCE(home_runs::numeric / NULLIF(fly_ball_proxy, 0), 0)
          + 0.25 * ((pitches / NULLIF(outs / 3.0, 0)) - 16.5) / 2.5
        ))::numeric(7,3) END,
        CASE WHEN batters_faced > 0 THEN (strikeouts::numeric / batters_faced)::numeric(7,5) END,
        CASE WHEN batters_faced > 0 THEN ((walks - intentional_walks + hit_batsmen)::numeric / batters_faced)::numeric(7,5) END,
        CASE WHEN batters_faced > 0 THEN ((strikeouts - (walks - intentional_walks + hit_batsmen))::numeric / batters_faced)::numeric(7,5) END,
        CASE WHEN outs > 0 THEN (home_runs * 27.0 / outs)::numeric(7,3) END,
        CASE WHEN outs > 0 THEN (pitches / (outs / 3.0))::numeric(7,3) END,
        now()
      FROM calculated
      WHERE outs > 0
      ON CONFLICT (as_of_date, team_id, window_days) DO UPDATE SET
        team_name = EXCLUDED.team_name,
        games = EXCLUDED.games,
        reliever_appearances = EXCLUDED.reliever_appearances,
        outs = EXCLUDED.outs,
        innings_pitched = EXCLUDED.innings_pitched,
        earned_runs = EXCLUDED.earned_runs,
        home_runs = EXCLUDED.home_runs,
        expected_home_runs = EXCLUDED.expected_home_runs,
        walks = EXCLUDED.walks,
        intentional_walks = EXCLUDED.intentional_walks,
        hit_batsmen = EXCLUDED.hit_batsmen,
        strikeouts = EXCLUDED.strikeouts,
        batters_faced = EXCLUDED.batters_faced,
        pitches = EXCLUDED.pitches,
        ground_outs = EXCLUDED.ground_outs,
        air_outs = EXCLUDED.air_outs,
        fly_ball_proxy = EXCLUDED.fly_ball_proxy,
        era = EXCLUDED.era,
        fip = EXCLUDED.fip,
        xfip_like = EXCLUDED.xfip_like,
        sw_fip = EXCLUDED.sw_fip,
        sw_xfip = EXCLUDED.sw_xfip,
        sw_siera = EXCLUDED.sw_siera,
        k_pct = EXCLUDED.k_pct,
        bb_pct = EXCLUDED.bb_pct,
        k_minus_bb_pct = EXCLUDED.k_minus_bb_pct,
        hr_per_9 = EXCLUDED.hr_per_9,
        pitches_per_inning = EXCLUDED.pitches_per_inning,
        updated_at = now()
    `,
    [asOfDate, startDate, windowDays]
  );
  return result.rowCount ?? 0;
};

export const refreshMlbBoxscoreAnalytics = async ({
  startDate,
  endDate,
  asOfDate = addDays(endDate, 1),
  windowDays = 30
}: {
  startDate: string;
  endDate: string;
  asOfDate?: string;
  windowDays?: number;
}) => {
  const games = await fetchSchedule(startDate, endDate);

  return transaction(async (client) => {
    let gamesUpserted = 0;
    let pitcherLinesUpserted = 0;

    for (const game of games) {
      const boxscore = await fetchBoxscore(game.gamePk);
      await upsertBoxscoreGame(client, game, boxscore);
      gamesUpserted += 1;

      const pitcherLines = pitcherLinesForGame(game, boxscore);
      for (const line of pitcherLines) {
        await upsertPitcherLine(client, line);
      }
      pitcherLinesUpserted += pitcherLines.length;
    }

    const pitcherMetricsUpserted = await recomputePitcherRollingMetrics(client, asOfDate, windowDays);
    const bullpenMetricsUpserted = await recomputeBullpenRollingMetrics(client, asOfDate, windowDays);

    return {
      startDate,
      endDate,
      asOfDate,
      windowDays,
      gamesFound: games.length,
      gamesUpserted,
      pitcherLinesUpserted,
      pitcherMetricsUpserted,
      bullpenMetricsUpserted
    };
  });
};

export const rollingMlbWindow = (asOfDate = yyyyMmDd(new Date()), windowDays = 30) => ({
  startDate: addDays(asOfDate, -windowDays),
  endDate: addDays(asOfDate, -1),
  asOfDate,
  windowDays
});
