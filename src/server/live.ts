import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { sendLiveGameNotifications, type LiveStateChange } from "./liveNotifications.js";
import type { SportKey } from "../shared/types.js";

type LiveSport = "MLB" | "WORLDCUP";

type ParlayLiveMatch = {
  match_id?: string | number;
  id?: string | number;
  sport_key?: string;
  commence_time?: string;
  start_time?: string;
  home_team?: string;
  away_team?: string;
  home?: string;
  away?: string;
  team_or_player_a?: string;
  team_or_player_b?: string;
  score_a?: number | string;
  score_b?: number | string;
  in_play?: boolean;
  last_event_at_ms?: number | string;
  occurred_at_ms?: number | string;
  captured_at_ms?: number | string;
  teams?: {
    home?: string;
    away?: string;
  };
  score?: {
    home?: number | string;
    away?: number | string;
    home_score?: number | string;
    away_score?: number | string;
  };
  scores?: {
    home?: number | string;
    away?: number | string;
    home_score?: number | string;
    away_score?: number | string;
  };
  state?: {
    period?: string | number;
    inning?: string | number;
    half?: string;
    status?: string;
    game_status?: string;
    description?: string;
    batter?: string | { name?: string };
    pitcher?: string | { name?: string };
    players?: {
      onFirst?: unknown;
      onSecond?: unknown;
      onThird?: unknown;
    };
  };
  status?: string;
  game_status?: string;
  description?: string;
};

type ParlayLiveEvent = {
  id: string;
  canonical_event_id?: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Array<{
    key: string;
    title: string;
    last_update?: string;
    last_update_ms?: number;
    stale_seconds?: number;
    markets?: Array<{
      key: string;
      outcomes?: Array<{ name: string; price: number | null; point?: number }>;
    }>;
  }>;
};

type MlbScheduleGame = {
  gamePk: number;
  gameDate?: string;
  status?: {
    abstractGameState?: string;
    detailedState?: string;
  };
  teams?: {
    away?: { team?: { name?: string }; score?: number };
    home?: { team?: { name?: string }; score?: number };
  };
  linescore?: {
    currentInningOrdinal?: string;
    inningHalf?: string;
    balls?: number;
    strikes?: number;
    outs?: number;
    teams?: {
      away?: { runs?: number };
      home?: { runs?: number };
    };
    offense?: {
      batter?: { id?: number; fullName?: string };
      pitcher?: { id?: number; fullName?: string };
      first?: { id?: number; fullName?: string };
      second?: { id?: number; fullName?: string };
      third?: { id?: number; fullName?: string };
    };
    defense?: {
      pitcher?: { id?: number; fullName?: string };
    };
  };
};

type MlbLiveFeed = {
  liveData?: {
    boxscore?: {
      teams?: {
        away?: { players?: Record<string, { stats?: { batting?: Record<string, unknown>; pitching?: Record<string, unknown> } }> };
        home?: { players?: Record<string, { stats?: { batting?: Record<string, unknown>; pitching?: Record<string, unknown> } }> };
      };
    };
    linescore?: MlbScheduleGame["linescore"];
    plays?: {
      currentPlay?: {
        result?: {
          description?: string;
        };
        count?: {
          balls?: number;
          strikes?: number;
          outs?: number;
        };
        matchup?: {
          batter?: { id?: number; fullName?: string };
          pitcher?: { id?: number; fullName?: string };
        };
      };
      allPlays?: Array<{
        result?: {
          description?: string;
        };
        about?: {
          isScoringPlay?: boolean;
        };
      }>;
    };
  };
};

export type LiveGameState = {
  matchId: string;
  sport: SportKey;
  eventKey: string | null;
  startsAt: string | null;
  awayTeam: string;
  homeTeam: string;
  awayScore: number | null;
  homeScore: number | null;
  period: string | null;
  gameStatus: string | null;
  description: string | null;
  lastPlay: string | null;
  batter: string | null;
  pitcher: string | null;
  balls: number | null;
  strikes: number | null;
  outs: number | null;
  pitcherPitches: number | null;
  batterHits: number | null;
  batterAtBats: number | null;
  inPlay: boolean;
  lastEventAt: string | null;
  bases: Record<string, unknown>;
  fetchedAt: string;
};

const liveSports: Record<LiveSport, string> = {
  MLB: "baseball_mlb",
  WORLDCUP: "soccer_fifa_world_cup"
};

const normalizeTeam = (team: string) =>
  team
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|fc|club)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const firstString = (...values: Array<unknown>) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return null;
};

const numberOrNull = (...values: Array<unknown>) => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
};

const dateFromMs = (...values: Array<unknown>) => {
  for (const value of values) {
    const ms = numberOrNull(value);
    if (ms === null) {
      continue;
    }
    const date = new Date(ms);
    if (Number.isFinite(date.getTime())) {
      return date;
    }
  }
  return null;
};

const personName = (value: unknown) => {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (value && typeof value === "object" && "name" in value && typeof value.name === "string") {
    return value.name.trim() || null;
  }
  return null;
};

const periodText = (match: ParlayLiveMatch) => {
  const inning = firstString(match.state?.inning);
  const period = firstString(match.state?.period);
  const half = firstString(match.state?.half);
  if (inning && half) {
    return `${half} ${inning}`;
  }
  return period ?? inning;
};

const eventBase = (providerEventId: string | null) => providerEventId?.split(":")[0] ?? null;

const findEventKey = async (sport: LiveSport, awayTeam: string, homeTeam: string, startsAt: Date | null) => {
  const result = await query<{ providerEventId: string | null; startsAt: Date; awayTeam: string; homeTeam: string }>(
    `
      SELECT DISTINCT ON (COALESCE(split_part(provider_event_id, ':', 1), id::text))
        provider_event_id AS "providerEventId",
        starts_at AS "startsAt",
        away_team AS "awayTeam",
        home_team AS "homeTeam"
      FROM game_line
      WHERE sport = $1
        AND (starts_at AT TIME ZONE 'America/Chicago')::date BETWEEN
          ((now() AT TIME ZONE 'America/Chicago')::date - INTERVAL '1 day')
          AND ((now() AT TIME ZONE 'America/Chicago')::date + INTERVAL '1 day')
      ORDER BY COALESCE(split_part(provider_event_id, ':', 1), id::text), starts_at ASC
    `,
    [sport]
  );

  const away = normalizeTeam(awayTeam);
  const home = normalizeTeam(homeTeam);
  const candidates = result.rows.filter((row) =>
    normalizeTeam(row.awayTeam) === away && normalizeTeam(row.homeTeam) === home
  );
  if (!candidates.length) {
    return null;
  }

  const selected = startsAt
    ? candidates.sort((left, right) =>
      Math.abs(left.startsAt.getTime() - startsAt.getTime()) - Math.abs(right.startsAt.getTime() - startsAt.getTime())
    )[0]
    : candidates[0];

  return eventBase(selected.providerEventId)
    ?? `${sport}:${selected.startsAt.toISOString()}:${selected.awayTeam}:${selected.homeTeam}`;
};

type NormalizedLiveMatch = {
  matchId: string;
  provider: string;
  sport: LiveSport;
  eventKey: string | null;
  startsAt: Date | null;
  awayTeam: string;
  homeTeam: string;
  awayScore: number | null;
  homeScore: number | null;
  period: string | null;
  gameStatus: string | null;
  description: string | null;
  lastPlay: string | null;
  batter: string | null;
  pitcher: string | null;
  balls: number | null;
  strikes: number | null;
  outs: number | null;
  pitcherPitches: number | null;
  batterHits: number | null;
  batterAtBats: number | null;
  inPlay: boolean;
  lastEventAt: Date | null;
  bases: Record<string, unknown>;
  payload: unknown;
};

const normalizeMatch = async (sport: LiveSport, match: ParlayLiveMatch): Promise<NormalizedLiveMatch | null> => {
  const matchId = firstString(match.match_id, match.id);
  const awayTeam = firstString(match.away_team, match.away, match.teams?.away, match.team_or_player_a);
  const homeTeam = firstString(match.home_team, match.home, match.teams?.home, match.team_or_player_b);
  if (!matchId || !awayTeam || !homeTeam) {
    return null;
  }

  const startsAtText = firstString(match.commence_time, match.start_time);
  const startsAt = startsAtText ? new Date(startsAtText) : null;
  const safeStartsAt = startsAt && Number.isFinite(startsAt.getTime()) ? startsAt : null;

  return {
    matchId,
    provider: "parlay-api",
    sport,
    eventKey: await findEventKey(sport, awayTeam, homeTeam, safeStartsAt),
    startsAt: safeStartsAt,
    awayTeam,
    homeTeam,
    awayScore: numberOrNull(match.score?.away, match.score?.away_score, match.scores?.away, match.scores?.away_score, match.score_a),
    homeScore: numberOrNull(match.score?.home, match.score?.home_score, match.scores?.home, match.scores?.home_score, match.score_b),
    period: periodText(match),
    gameStatus: firstString(match.state?.status, match.state?.game_status, match.status, match.game_status),
    description: firstString(match.state?.description, match.description),
    lastPlay: firstString(match.state?.description, match.description),
    batter: personName(match.state?.batter),
    pitcher: personName(match.state?.pitcher),
    balls: null,
    strikes: null,
    outs: null,
    pitcherPitches: null,
    batterHits: null,
    batterAtBats: null,
    inPlay: match.in_play === true,
    lastEventAt: dateFromMs(match.last_event_at_ms, match.occurred_at_ms, match.captured_at_ms),
    bases: {
      onFirst: match.state?.players?.onFirst ?? null,
      onSecond: match.state?.players?.onSecond ?? null,
      onThird: match.state?.players?.onThird ?? null
    },
    payload: match
  };
};

const bestBookmakerUpdate = (event: ParlayLiveEvent) => {
  const timestamps = (event.bookmakers ?? [])
    .flatMap((bookmaker) => [
      bookmaker.last_update_ms,
      bookmaker.last_update ? new Date(bookmaker.last_update).getTime() : null
    ])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!timestamps.length) {
    return null;
  }
  return new Date(Math.max(...timestamps));
};

const preferredLiveMoneyline = (event: ParlayLiveEvent) => {
  const bookmakerOrder = ["bovada", "pinnacle", "fanduel", "draftkings", "betmgm", "caesars"];
  const books = [...(event.bookmakers ?? [])].sort((left, right) =>
    bookmakerOrder.indexOf(left.key) - bookmakerOrder.indexOf(right.key)
  );
  for (const bookmaker of books) {
    const market = bookmaker.markets?.find((item) => item.key === "h2h");
    const away = market?.outcomes?.find((outcome) => outcome.name === event.away_team && typeof outcome.price === "number");
    const home = market?.outcomes?.find((outcome) => outcome.name === event.home_team && typeof outcome.price === "number");
    if (typeof away?.price === "number" && typeof home?.price === "number") {
      return `${bookmaker.title}: ${event.away_team} ${away.price > 0 ? "+" : ""}${away.price}, ${event.home_team} ${home.price > 0 ? "+" : ""}${home.price}`;
    }
  }
  return "Live odds available";
};

const normalizeLiveEvent = async (sport: LiveSport, event: ParlayLiveEvent): Promise<NormalizedLiveMatch | null> => {
  const startsAt = new Date(event.commence_time);
  const safeStartsAt = Number.isFinite(startsAt.getTime()) ? startsAt : null;
  const lastEventAt = bestBookmakerUpdate(event);
  const eventKey = event.canonical_event_id
    ?? await findEventKey(sport, event.away_team, event.home_team, safeStartsAt)
    ?? event.id;
  return {
    matchId: event.id,
    provider: "parlay-live",
    sport,
    eventKey,
    startsAt: safeStartsAt,
    awayTeam: event.away_team,
    homeTeam: event.home_team,
    awayScore: null,
    homeScore: null,
    period: "Live",
    gameStatus: "In Play",
    description: preferredLiveMoneyline(event),
    lastPlay: preferredLiveMoneyline(event),
    batter: null,
    pitcher: null,
    balls: null,
    strikes: null,
    outs: null,
    pitcherPitches: null,
    batterHits: null,
    batterAtBats: null,
    inPlay: true,
    lastEventAt,
    bases: {},
    payload: event
  };
};


const centralDate = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const normalizeMlbGame = async (game: MlbScheduleGame): Promise<NormalizedLiveMatch | null> => {
  const awayTeam = firstString(game.teams?.away?.team?.name);
  const homeTeam = firstString(game.teams?.home?.team?.name);
  if (!awayTeam || !homeTeam) {
    return null;
  }

  const startsAt = game.gameDate ? new Date(game.gameDate) : null;
  const safeStartsAt = startsAt && Number.isFinite(startsAt.getTime()) ? startsAt : null;
  const isLive = game.status?.abstractGameState === "Live";
  const liveDetails = isLive ? await fetchMlbLiveDetails(game.gamePk) : null;
  const lastPlay = liveDetails?.lastPlay ?? null;
  const lastScoringPlay = liveDetails?.lastScoringPlay ?? null;

  return {
    matchId: `mlb:${game.gamePk}`,
    provider: "mlb-stats-api",
    sport: "MLB",
    eventKey: await findEventKey("MLB", awayTeam, homeTeam, safeStartsAt),
    startsAt: safeStartsAt,
    awayTeam,
    homeTeam,
    awayScore: numberOrNull(game.teams?.away?.score, game.linescore?.teams?.away?.runs),
    homeScore: numberOrNull(game.teams?.home?.score, game.linescore?.teams?.home?.runs),
    period: [game.linescore?.inningHalf, game.linescore?.currentInningOrdinal].filter(Boolean).join(" ") || null,
    gameStatus: game.status?.detailedState ?? null,
    description: lastScoringPlay,
    lastPlay,
    batter: liveDetails?.batter ?? game.linescore?.offense?.batter?.fullName ?? null,
    pitcher: liveDetails?.pitcher ?? game.linescore?.defense?.pitcher?.fullName ?? game.linescore?.offense?.pitcher?.fullName ?? null,
    balls: liveDetails?.balls ?? game.linescore?.balls ?? null,
    strikes: liveDetails?.strikes ?? game.linescore?.strikes ?? null,
    outs: liveDetails?.outs ?? game.linescore?.outs ?? null,
    pitcherPitches: liveDetails?.pitcherPitches ?? null,
    batterHits: liveDetails?.batterHits ?? null,
    batterAtBats: liveDetails?.batterAtBats ?? null,
    inPlay: isLive,
    lastEventAt: isLive ? new Date() : null,
    bases: {
      onFirst: game.linescore?.offense?.first?.fullName ?? null,
      onSecond: game.linescore?.offense?.second?.fullName ?? null,
      onThird: game.linescore?.offense?.third?.fullName ?? null
    },
    payload: game
  };
};

const fetchLivePoints = async (sport: LiveSport) => {
  if (!config.parlayApiKey) {
    throw new Error("PARLAY_API_KEY is not configured");
  }

  const base = config.parlayApiBaseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/sports/${liveSports[sport]}/live/points`);
  url.searchParams.set("apiKey", config.parlayApiKey);

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Parlay live ${sport} failed with ${response.status}: ${body.slice(0, 240)}`);
  }

  const body = await response.json() as { matches?: ParlayLiveMatch[] } | ParlayLiveMatch[];
  return Array.isArray(body) ? body : body.matches ?? [];
};

const fetchParlayLiveEvents = async (sport: LiveSport) => {
  if (!config.parlayApiKey) {
    throw new Error("PARLAY_API_KEY is not configured");
  }

  const base = config.parlayApiBaseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/sports/${liveSports[sport]}/live`);
  url.searchParams.set("apiKey", config.parlayApiKey);
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("dateFormat", "iso");

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Parlay live odds ${sport} failed with ${response.status}: ${body.slice(0, 240)}`);
  }

  return (await response.json()) as ParlayLiveEvent[];
};

const fetchMlbStatsLive = async () => {
  const url = new URL("https://statsapi.mlb.com/api/v1/schedule");
  url.searchParams.set("sportId", "1");
  url.searchParams.set("date", centralDate());
  url.searchParams.set("hydrate", "linescore,team,probablePitcher");

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MLB Stats live failed with ${response.status}: ${body.slice(0, 240)}`);
  }

  const body = await response.json() as { dates?: Array<{ games?: MlbScheduleGame[] }> };
  return (body.dates ?? []).flatMap((date) => date.games ?? []);
};

const playerStats = (body: MlbLiveFeed, playerId: number | undefined, group: "batting" | "pitching") => {
  if (!playerId) {
    return null;
  }
  const key = `ID${playerId}`;
  return body.liveData?.boxscore?.teams?.away?.players?.[key]?.stats?.[group]
    ?? body.liveData?.boxscore?.teams?.home?.players?.[key]?.stats?.[group]
    ?? null;
};

const fetchMlbLiveDetails = async (gamePk: number) => {
  const response = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
  if (!response.ok) {
    return null;
  }
  const body = await response.json() as MlbLiveFeed;
  const currentPlay = body.liveData?.plays?.currentPlay;
  const lastScoringPlay = [...(body.liveData?.plays?.allPlays ?? [])]
    .reverse()
    .find((play) => play.about?.isScoringPlay && play.result?.description?.trim());
  const lastCompletedPlay = [...(body.liveData?.plays?.allPlays ?? [])]
    .reverse()
    .find((play) => play.result?.description?.trim());
  const batterId = currentPlay?.matchup?.batter?.id ?? body.liveData?.linescore?.offense?.batter?.id;
  const pitcherId = currentPlay?.matchup?.pitcher?.id ?? body.liveData?.linescore?.defense?.pitcher?.id;
  const batting = playerStats(body, batterId, "batting");
  const pitching = playerStats(body, pitcherId, "pitching");
  return {
    lastScoringPlay: lastScoringPlay?.result?.description?.trim() ?? null,
    lastPlay: currentPlay?.result?.description?.trim() ?? lastCompletedPlay?.result?.description?.trim() ?? null,
    batter: currentPlay?.matchup?.batter?.fullName ?? body.liveData?.linescore?.offense?.batter?.fullName ?? null,
    pitcher: currentPlay?.matchup?.pitcher?.fullName ?? body.liveData?.linescore?.defense?.pitcher?.fullName ?? null,
    balls: currentPlay?.count?.balls ?? body.liveData?.linescore?.balls ?? null,
    strikes: currentPlay?.count?.strikes ?? body.liveData?.linescore?.strikes ?? null,
    outs: currentPlay?.count?.outs ?? body.liveData?.linescore?.outs ?? null,
    pitcherPitches: numberOrNull(pitching?.numberOfPitches, pitching?.pitchesThrown),
    batterHits: numberOrNull(batting?.hits),
    batterAtBats: numberOrNull(batting?.atBats)
  };
};

const upsertLiveMatches = async (matches: NormalizedLiveMatch[]) => {
  return transaction(async (client) => {
    const changes: LiveStateChange[] = [];
    for (const match of matches) {
      const previous = await client.query<{
        matchId: string;
        provider: string;
        sport: SportKey;
        eventKey: string | null;
        startsAt: Date | null;
        awayTeam: string;
        homeTeam: string;
        awayScore: number | null;
        homeScore: number | null;
        gameStatus: string | null;
        description: string | null;
        lastPlay: string | null;
        batter: string | null;
        pitcher: string | null;
        balls: number | null;
        strikes: number | null;
        outs: number | null;
        pitcherPitches: number | null;
        batterHits: number | null;
        batterAtBats: number | null;
        inPlay: boolean;
      }>(
        `
          SELECT
            match_id AS "matchId",
            provider,
            sport,
            event_key AS "eventKey",
            starts_at AS "startsAt",
            away_team AS "awayTeam",
            home_team AS "homeTeam",
            away_score AS "awayScore",
            home_score AS "homeScore",
            game_status AS "gameStatus",
            description,
            last_play AS "lastPlay",
            batter,
            pitcher,
            balls,
            strikes,
            outs,
            pitcher_pitches AS "pitcherPitches",
            batter_hits AS "batterHits",
            batter_at_bats AS "batterAtBats",
            in_play AS "inPlay"
          FROM live_game_state
          WHERE match_id = $1
          FOR UPDATE
        `,
        [match.matchId]
      );
      await client.query(
        `
          INSERT INTO live_game_state (
            match_id, provider, sport, event_key, starts_at, away_team, home_team, away_score,
            home_score, period, game_status, description, last_play, batter, pitcher, balls, strikes, outs,
            pitcher_pitches, batter_hits, batter_at_bats, in_play, last_event_at, bases, payload, fetched_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
            $17, $18, $19, $20, $21, $22, $23, $24, $25, now(), now()
          )
          ON CONFLICT (match_id) DO UPDATE SET
            provider = EXCLUDED.provider,
            sport = EXCLUDED.sport,
            event_key = EXCLUDED.event_key,
            starts_at = EXCLUDED.starts_at,
            away_team = EXCLUDED.away_team,
            home_team = EXCLUDED.home_team,
            away_score = EXCLUDED.away_score,
            home_score = EXCLUDED.home_score,
            period = EXCLUDED.period,
            game_status = EXCLUDED.game_status,
            description = EXCLUDED.description,
            last_play = EXCLUDED.last_play,
            batter = EXCLUDED.batter,
            pitcher = EXCLUDED.pitcher,
            balls = EXCLUDED.balls,
            strikes = EXCLUDED.strikes,
            outs = EXCLUDED.outs,
            pitcher_pitches = EXCLUDED.pitcher_pitches,
            batter_hits = EXCLUDED.batter_hits,
            batter_at_bats = EXCLUDED.batter_at_bats,
            in_play = EXCLUDED.in_play,
            last_event_at = EXCLUDED.last_event_at,
            bases = EXCLUDED.bases,
            payload = EXCLUDED.payload,
            fetched_at = now(),
            updated_at = now()
        `,
        [
          match.matchId,
          match.provider,
          match.sport,
          match.eventKey,
          match.startsAt,
          match.awayTeam,
          match.homeTeam,
          match.awayScore,
          match.homeScore,
          match.period,
          match.gameStatus,
          match.description,
          match.lastPlay,
          match.batter,
          match.pitcher,
          match.balls,
          match.strikes,
          match.outs,
          match.pitcherPitches,
          match.batterHits,
          match.batterAtBats,
          match.inPlay,
          match.lastEventAt,
          JSON.stringify(match.bases),
          JSON.stringify(match.payload)
        ]
      );
      changes.push({
        previous: previous.rows[0] ?? null,
        current: {
          matchId: match.matchId,
          provider: match.provider,
          sport: match.sport,
          eventKey: match.eventKey,
          startsAt: match.startsAt,
          awayTeam: match.awayTeam,
          homeTeam: match.homeTeam,
          awayScore: match.awayScore,
          homeScore: match.homeScore,
          gameStatus: match.gameStatus,
          description: match.description,
          lastPlay: match.lastPlay,
          batter: match.batter,
          pitcher: match.pitcher,
          balls: match.balls,
          strikes: match.strikes,
          outs: match.outs,
          pitcherPitches: match.pitcherPitches,
          batterHits: match.batterHits,
          batterAtBats: match.batterAtBats,
          inPlay: match.inPlay
        }
      });
    }
    return changes;
  });
};

const refreshLiveSport = async (sport: LiveSport) => {
  const matches = await fetchLivePoints(sport);
  const liveEvents = await fetchParlayLiveEvents(sport);
  const parlayNormalized = (await Promise.all(matches.map((match) => normalizeMatch(sport, match))))
    .filter((match): match is NonNullable<typeof match> => Boolean(match));
  const liveEventNormalized = (await Promise.all(liveEvents.map((event) => normalizeLiveEvent(sport, event))))
    .filter((match): match is NonNullable<typeof match> => Boolean(match));
  const mlbGames = sport === "MLB" ? await fetchMlbStatsLive() : [];
  const mlbNormalized = sport === "MLB"
    ? (await Promise.all(mlbGames.map((game) => normalizeMlbGame(game))))
      .filter((match): match is NonNullable<typeof match> => Boolean(match))
    : [];
  const normalized = [...parlayNormalized, ...liveEventNormalized, ...mlbNormalized];

  const changes = await upsertLiveMatches(normalized);
  const notifications = await sendLiveGameNotifications(changes);

  const recent = normalized.filter((match) =>
    match.inPlay
    && match.lastEventAt
    && match.lastEventAt.getTime() > Date.now() - 20 * 60 * 1000
  ).length;

  return {
    sport,
    parlayFetched: matches.length,
    parlayLiveFetched: liveEvents.length,
    mlbFetched: mlbGames.length,
    imported: normalized.length,
    recent,
    notifications: notifications.length
  };
};

export const refreshLiveSports = async (sports: LiveSport[] = ["MLB", "WORLDCUP"]) => {
  const results = [];
  for (const sport of sports) {
    results.push(await refreshLiveSport(sport));
  }
  return {
    sports: results,
    parlayFetched: results.reduce((sum, result) => sum + result.parlayFetched, 0),
    parlayLiveFetched: results.reduce((sum, result) => sum + result.parlayLiveFetched, 0),
    mlbFetched: results.reduce((sum, result) => sum + result.mlbFetched, 0),
    imported: results.reduce((sum, result) => sum + result.imported, 0),
    recent: results.reduce((sum, result) => sum + result.recent, 0),
    notifications: results.reduce((sum, result) => sum + result.notifications, 0)
  };
};

export const refreshLiveMlb = async () => refreshLiveSports(["MLB"]);

export const getLiveStates = async (sport: SportKey) => {
  const result = await query<{
    matchId: string;
    sport: SportKey;
    eventKey: string | null;
    startsAt: Date | null;
    awayTeam: string;
    homeTeam: string;
    awayScore: number | null;
    homeScore: number | null;
    period: string | null;
    gameStatus: string | null;
    description: string | null;
    lastPlay: string | null;
    batter: string | null;
    pitcher: string | null;
    balls: number | null;
    strikes: number | null;
    outs: number | null;
    pitcherPitches: number | null;
    batterHits: number | null;
    batterAtBats: number | null;
    inPlay: boolean;
    lastEventAt: Date | null;
    bases: Record<string, unknown>;
    fetchedAt: Date;
  }>(
    `
      WITH ranked AS (
        SELECT
          *,
          row_number() OVER (
            PARTITION BY COALESCE(event_key, match_id)
            ORDER BY
              CASE provider
                WHEN 'mlb-stats-api' THEN 1
                WHEN 'parlay-live' THEN 2
                ELSE 3
              END,
              fetched_at DESC
          ) AS row_rank
        FROM live_game_state
        WHERE sport = $1
          AND ($1 <> 'MLB' OR provider = 'mlb-stats-api')
          AND in_play = true
          AND (
            last_event_at > now() - INTERVAL '20 minutes'
            OR fetched_at > now() - INTERVAL '20 minutes'
          )
      )
      SELECT
        match_id AS "matchId",
        sport,
        event_key AS "eventKey",
        starts_at AS "startsAt",
        away_team AS "awayTeam",
        home_team AS "homeTeam",
        away_score AS "awayScore",
        home_score AS "homeScore",
        period,
        game_status AS "gameStatus",
        description,
        last_play AS "lastPlay",
        batter,
        pitcher,
        balls,
        strikes,
        outs,
        pitcher_pitches AS "pitcherPitches",
        batter_hits AS "batterHits",
        batter_at_bats AS "batterAtBats",
        in_play AS "inPlay",
        last_event_at AS "lastEventAt",
        bases,
        fetched_at AS "fetchedAt"
      FROM ranked
      WHERE row_rank = 1
      ORDER BY COALESCE(starts_at, fetched_at) ASC, away_team ASC
      LIMIT 40
    `
    ,
    [sport]
  );

  return result.rows.map((row) => ({
    ...row,
    startsAt: row.startsAt?.toISOString() ?? null,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    fetchedAt: row.fetchedAt.toISOString()
  })) satisfies LiveGameState[];
};

export const getLiveMlbStates = async () => getLiveStates("MLB");
