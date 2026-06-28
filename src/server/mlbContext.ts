import { randomUUID } from "node:crypto";
import type pg from "pg";
import { transaction } from "./db.js";

type MlbTeamRef = {
  id: number;
  name: string;
};

type MlbPersonRef = {
  id: number;
  fullName: string;
  batSide?: {
    code?: string;
    description?: string;
  };
  pitchHand?: {
    code?: string;
    description?: string;
  };
};

type MlbLineupPlayer = MlbPersonRef & {
  primaryPosition?: {
    code?: string;
    name?: string;
    type?: string;
    abbreviation?: string;
  };
};

type MlbScheduleGame = {
  gamePk: number;
  gameDate: string;
  lineups?: {
    awayPlayers?: MlbLineupPlayer[];
    homePlayers?: MlbLineupPlayer[];
  };
  teams: {
    away: {
      team: MlbTeamRef;
      probablePitcher?: MlbPersonRef;
    };
    home: {
      team: MlbTeamRef;
      probablePitcher?: MlbPersonRef;
    };
  };
};

type MlbScheduleResponse = {
  dates?: Array<{
    games: MlbScheduleGame[];
  }>;
};

type MlbStatsResponse = {
  stats?: Array<{
    splits?: Array<{
      date?: string;
      isHome?: boolean;
      stat?: Record<string, unknown>;
      opponent?: MlbTeamRef;
      team?: MlbTeamRef;
      split?: {
        code?: string;
        description?: string;
      };
      game?: {
        gamePk?: number;
      };
    }>;
  }>;
};

type MlbRosterResponse = {
  roster?: Array<{
    person?: MlbPersonRef;
    position?: {
      code?: string;
      name?: string;
      type?: string;
      abbreviation?: string;
    };
  }>;
};

type MlbTransaction = {
  id: number;
  person?: MlbPersonRef;
  fromTeam?: MlbTeamRef;
  toTeam?: MlbTeamRef;
  date?: string;
  effectiveDate?: string;
  typeCode?: string;
  typeDesc?: string;
  description?: string;
};

type MlbTransactionsResponse = {
  transactions?: MlbTransaction[];
};

type MlbBoxscoreTeam = {
  team: MlbTeamRef;
  pitchers?: number[];
  players?: Record<string, {
    person?: MlbPersonRef;
    stats?: {
      pitching?: Record<string, unknown>;
    };
  }>;
};

type MlbBoxscoreResponse = {
  teams?: {
    away?: MlbBoxscoreTeam;
    home?: MlbBoxscoreTeam;
  };
};

type PitcherStatsSummary = {
  pitcherId: number;
  pitcherName: string;
  pitchHand: string | null;
  season: {
    era: number | null;
    whip: number | null;
    inningsPitched: number | null;
    strikeoutsPer9: number | null;
    walksPer9: number | null;
    homeRunsPer9: number | null;
    strikeoutWalkRatio: number | null;
    gamesStarted: number | null;
    pitchesPerInning: number | null;
    wins: number | null;
    losses: number | null;
    adjustedEraExcludingWorstOlderStart: number | null;
    excludedWorstOlderStartDate: string | null;
    excludedWorstOlderStartEarnedRuns: number | null;
  } | null;
  recent: {
    starts: number;
    inningsPitched: number;
    earnedRuns: number;
    strikeouts: number;
    walks: number;
    pitches: number;
    era: number | null;
    strikeoutWalkRatio: number | null;
  };
};

type BullpenSummary = {
  gamesChecked: number;
  relieverAppearances: number;
  pitchesLast1: number;
  pitchesLast3: number;
  outsLast3: number;
  inningsLast3: number;
  earnedRunsLast3: number;
  whipEventsLast3: number;
  strikeoutsLast3: number;
  walksLast3: number;
  eraLast3: number | null;
  whipLast3: number | null;
};

type HitterSplitSummary = {
  hittersChecked: number;
  hittersWithSplitStats: number;
  opponentPitchHand: string | null;
  leftBatters: number;
  rightBatters: number;
  switchBatters: number;
  oppositeHandBatters: number;
  sameHandBatters: number;
  averageOpsVsPitchHand: number | null;
  averageObpVsPitchHand: number | null;
  averageSlgVsPitchHand: number | null;
  totalPlateAppearancesVsPitchHand: number;
};

type InjurySummary = {
  activeIlPlayers: number;
  activeIlPitchers: number;
  recentInjuryTransactions: number;
  players: Array<{
    playerId: number;
    playerName: string;
    date: string | null;
    description: string;
  }>;
};

type InjurySnapshot = Map<number, InjurySummary>;

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
    return null;
  }
  const normalized = value.trim();
  if (!normalized || normalized.includes("--") || normalized.includes("---")) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
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

const rate = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator : null;

const fetchJson = async <T>(url: URL | string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`MLB Stats API request failed with ${response.status}: ${url.toString()}`);
  }
  return (await response.json()) as T;
};

const personCache = new Map<number, Promise<MlbPersonRef | null>>();

const fetchPerson = async (personId: number) => {
  if (!personCache.has(personId)) {
    personCache.set(personId, fetchJson<{ people?: MlbPersonRef[] }>(`https://statsapi.mlb.com/api/v1/people/${personId}`)
      .then((body) => body.people?.[0] ?? null));
  }
  return personCache.get(personId)!;
};

const fetchSchedule = async (startDate: string, endDate: string) => {
  const url = new URL("https://statsapi.mlb.com/api/v1/schedule");
  url.searchParams.set("sportId", "1");
  url.searchParams.set("hydrate", "lineups,probablePitcher,team");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);

  const body = await fetchJson<MlbScheduleResponse>(url);
  return (body.dates ?? []).flatMap((date) => date.games);
};

const fetchPitcherStats = async (pitcher: MlbPersonRef | undefined, season: number): Promise<PitcherStatsSummary | null> => {
  if (!pitcher) {
    return null;
  }

  const seasonUrl = new URL(`https://statsapi.mlb.com/api/v1/people/${pitcher.id}/stats`);
  seasonUrl.searchParams.set("stats", "season");
  seasonUrl.searchParams.set("group", "pitching");
  seasonUrl.searchParams.set("season", String(season));

  const gameLogUrl = new URL(`https://statsapi.mlb.com/api/v1/people/${pitcher.id}/stats`);
  gameLogUrl.searchParams.set("stats", "gameLog");
  gameLogUrl.searchParams.set("group", "pitching");
  gameLogUrl.searchParams.set("season", String(season));

  const [personBody, seasonBody, gameLogBody] = await Promise.all([
    fetchPerson(pitcher.id),
    fetchJson<MlbStatsResponse>(seasonUrl),
    fetchJson<MlbStatsResponse>(gameLogUrl)
  ]);

  const seasonStat = seasonBody.stats?.[0]?.splits?.[0]?.stat ?? null;
  const starts = [...(gameLogBody.stats?.[0]?.splits ?? [])]
    .filter((split) => parseNumber(split.stat?.gamesStarted) === 1)
    .sort((left, right) => (left.date ?? "").localeCompare(right.date ?? ""));
  const recentStarts = starts.slice(-3);
  const olderStarts = starts.slice(0, -3);
  const worstOlderStart = starts.length >= 8 && olderStarts.length
    ? olderStarts.reduce((worst, split) => {
      const earnedRuns = parseNumber(split.stat?.earnedRuns) ?? 0;
      const worstEarnedRuns = parseNumber(worst.stat?.earnedRuns) ?? 0;
      return earnedRuns > worstEarnedRuns ? split : worst;
    }, olderStarts[0])
    : null;
  const adjustedSeason = worstOlderStart
    ? starts.reduce((summary, split) => {
      if (split === worstOlderStart) {
        return summary;
      }
      summary.outs += inningsToOuts(split.stat?.inningsPitched);
      summary.earnedRuns += parseNumber(split.stat?.earnedRuns) ?? 0;
      return summary;
    }, { outs: 0, earnedRuns: 0 })
    : null;
  const recent = recentStarts.reduce((summary, split) => {
    const stat = split.stat ?? {};
    summary.starts += 1;
    summary.outs += inningsToOuts(stat.inningsPitched);
    summary.earnedRuns += parseNumber(stat.earnedRuns) ?? 0;
    summary.strikeouts += parseNumber(stat.strikeOuts) ?? 0;
    summary.walks += parseNumber(stat.baseOnBalls) ?? 0;
    summary.pitches += parseNumber(stat.numberOfPitches) ?? 0;
    return summary;
  }, { starts: 0, outs: 0, earnedRuns: 0, strikeouts: 0, walks: 0, pitches: 0 });

  return {
    pitcherId: pitcher.id,
    pitcherName: pitcher.fullName,
    pitchHand: personBody?.pitchHand?.code ?? pitcher.pitchHand?.code ?? null,
    season: seasonStat ? {
      era: parseNumber(seasonStat.era),
      whip: parseNumber(seasonStat.whip),
      inningsPitched: parseNumber(seasonStat.inningsPitched),
      strikeoutsPer9: parseNumber(seasonStat.strikeoutsPer9Inn),
      walksPer9: parseNumber(seasonStat.walksPer9Inn),
      homeRunsPer9: parseNumber(seasonStat.homeRunsPer9),
      strikeoutWalkRatio: parseNumber(seasonStat.strikeoutWalkRatio),
      gamesStarted: parseNumber(seasonStat.gamesStarted),
      pitchesPerInning: parseNumber(seasonStat.pitchesPerInning),
      wins: parseNumber(seasonStat.wins),
      losses: parseNumber(seasonStat.losses),
      adjustedEraExcludingWorstOlderStart: adjustedSeason && adjustedSeason.outs > 0
        ? Number((adjustedSeason.earnedRuns * 27 / adjustedSeason.outs).toFixed(2))
        : null,
      excludedWorstOlderStartDate: worstOlderStart?.date ?? null,
      excludedWorstOlderStartEarnedRuns: worstOlderStart ? parseNumber(worstOlderStart.stat?.earnedRuns) : null
    } : null,
    recent: {
      starts: recent.starts,
      inningsPitched: outsToInnings(recent.outs),
      earnedRuns: recent.earnedRuns,
      strikeouts: recent.strikeouts,
      walks: recent.walks,
      pitches: recent.pitches,
      era: recent.outs > 0 ? Number((recent.earnedRuns * 27 / recent.outs).toFixed(2)) : null,
      strikeoutWalkRatio: rate(recent.strikeouts, recent.walks)
    }
  };
};

const boxscoreCache = new Map<number, Promise<MlbBoxscoreResponse>>();
const rosterCache = new Map<string, Promise<MlbRosterResponse>>();
const hitterSplitCache = new Map<string, Promise<MlbStatsResponse>>();
const hitterSeasonCache = new Map<string, Promise<MlbStatsResponse>>();

const fetchBoxscore = async (gamePk: number) => {
  if (!boxscoreCache.has(gamePk)) {
    boxscoreCache.set(gamePk, fetchJson<MlbBoxscoreResponse>(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`));
  }
  return boxscoreCache.get(gamePk)!;
};

const fetchRoster = async (teamId: number, season: number) => {
  const key = `${teamId}:${season}`;
  if (!rosterCache.has(key)) {
    const url = new URL(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster`);
    url.searchParams.set("rosterType", "active");
    url.searchParams.set("season", String(season));
    url.searchParams.set("hydrate", "person");
    rosterCache.set(key, fetchJson<MlbRosterResponse>(url));
  }
  return rosterCache.get(key)!;
};

const fetchHitterSplits = async (playerId: number, season: number) => {
  const key = `${playerId}:${season}`;
  if (!hitterSplitCache.has(key)) {
    const url = new URL(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats`);
    url.searchParams.set("stats", "statSplits");
    url.searchParams.set("group", "hitting");
    url.searchParams.set("season", String(season));
    url.searchParams.set("sitCodes", "vl,vr");
    hitterSplitCache.set(key, fetchJson<MlbStatsResponse>(url));
  }
  return hitterSplitCache.get(key)!;
};

const fetchHitterSeason = async (playerId: number, season: number) => {
  const key = `${playerId}:${season}`;
  if (!hitterSeasonCache.has(key)) {
    const url = new URL(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats`);
    url.searchParams.set("stats", "season");
    url.searchParams.set("group", "hitting");
    url.searchParams.set("season", String(season));
    hitterSeasonCache.set(key, fetchJson<MlbStatsResponse>(url));
  }
  return hitterSeasonCache.get(key)!;
};

const splitCodeForPitchHand = (pitchHand: string | null | undefined) => {
  if (pitchHand === "L") return "vl";
  if (pitchHand === "R") return "vr";
  return null;
};

const isOppositeHanded = (batSide: string | null | undefined, pitchHand: string | null | undefined) => {
  if (!batSide || !pitchHand || batSide === "S") {
    return false;
  }
  return batSide !== pitchHand;
};

const isSameHanded = (batSide: string | null | undefined, pitchHand: string | null | undefined) => {
  if (!batSide || !pitchHand || batSide === "S") {
    return false;
  }
  return batSide === pitchHand;
};

const summarizeHitterSplits = async (
  teamId: number,
  season: number,
  opponentPitchHand: string | null | undefined
): Promise<HitterSplitSummary> => {
  const splitCode = splitCodeForPitchHand(opponentPitchHand);
  const roster = await fetchRoster(teamId, season);
  const hitters = (roster.roster ?? []).filter((entry) => entry.position?.type !== "Pitcher" && entry.person?.id);
  const summary: HitterSplitSummary = {
    hittersChecked: hitters.length,
    hittersWithSplitStats: 0,
    opponentPitchHand: opponentPitchHand ?? null,
    leftBatters: 0,
    rightBatters: 0,
    switchBatters: 0,
    oppositeHandBatters: 0,
    sameHandBatters: 0,
    averageOpsVsPitchHand: null,
    averageObpVsPitchHand: null,
    averageSlgVsPitchHand: null,
    totalPlateAppearancesVsPitchHand: 0
  };
  let weightedOps = 0;
  let weightedObp = 0;
  let weightedSlg = 0;

  for (const hitter of hitters) {
    const person = hitter.person!;
    const batSide = person.batSide?.code ?? null;
    if (batSide === "L") summary.leftBatters += 1;
    if (batSide === "R") summary.rightBatters += 1;
    if (batSide === "S") summary.switchBatters += 1;
    if (isOppositeHanded(batSide, opponentPitchHand)) summary.oppositeHandBatters += 1;
    if (isSameHanded(batSide, opponentPitchHand)) summary.sameHandBatters += 1;

    if (!splitCode) {
      continue;
    }

    const splits = await fetchHitterSplits(person.id, season);
    const split = splits.stats?.[0]?.splits?.find((candidate) => candidate.split?.code === splitCode);
    const plateAppearances = parseNumber(split?.stat?.plateAppearances) ?? 0;
    const ops = parseNumber(split?.stat?.ops);
    const obp = parseNumber(split?.stat?.obp);
    const slg = parseNumber(split?.stat?.slg);
    if (plateAppearances <= 0 || ops === null || obp === null || slg === null) {
      continue;
    }

    summary.hittersWithSplitStats += 1;
    summary.totalPlateAppearancesVsPitchHand += plateAppearances;
    weightedOps += ops * plateAppearances;
    weightedObp += obp * plateAppearances;
    weightedSlg += slg * plateAppearances;
  }

  if (summary.totalPlateAppearancesVsPitchHand > 0) {
    summary.averageOpsVsPitchHand = Number((weightedOps / summary.totalPlateAppearancesVsPitchHand).toFixed(3));
    summary.averageObpVsPitchHand = Number((weightedObp / summary.totalPlateAppearancesVsPitchHand).toFixed(3));
    summary.averageSlgVsPitchHand = Number((weightedSlg / summary.totalPlateAppearancesVsPitchHand).toFixed(3));
  }

  return summary;
};

const summarizeLineup = async (players: MlbLineupPlayer[] | undefined, season: number) => {
  if (!players?.length) {
    return {
      confirmed: false,
      players: []
    };
  }

  const enriched = await Promise.all(players.map(async (player, index) => {
    const [person, seasonStats] = await Promise.all([
      fetchPerson(player.id),
      fetchHitterSeason(player.id, season)
    ]);
    const stat = seasonStats.stats?.[0]?.splits?.[0]?.stat ?? {};
    return {
      order: index + 1,
      playerId: player.id,
      name: player.fullName,
      position: player.primaryPosition?.abbreviation ?? null,
      batSide: person?.batSide?.code ?? player.batSide?.code ?? null,
      avg: typeof stat.avg === "string" ? stat.avg : null,
      homeRuns: parseNumber(stat.homeRuns),
      rbi: parseNumber(stat.rbi)
    };
  }));

  return {
    confirmed: enriched.length >= 9,
    players: enriched
  };
};

const fetchTeamRecentGames = async (teamId: number, startsOn: string, lookbackDays: number) => {
  const startDate = addDays(startsOn, -lookbackDays);
  const endDate = addDays(startsOn, -1);
  if (endDate < startDate) {
    return [];
  }

  const url = new URL("https://statsapi.mlb.com/api/v1/schedule");
  url.searchParams.set("sportId", "1");
  url.searchParams.set("teamId", String(teamId));
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);

  const body = await fetchJson<MlbScheduleResponse>(url);
  return (body.dates ?? []).flatMap((date) => date.games);
};

const summarizeBullpen = async (teamId: number, startsOn: string): Promise<BullpenSummary> => {
  const games = await fetchTeamRecentGames(teamId, startsOn, 3);
  const summary: BullpenSummary = {
    gamesChecked: games.length,
    relieverAppearances: 0,
    pitchesLast1: 0,
    pitchesLast3: 0,
    outsLast3: 0,
    inningsLast3: 0,
    earnedRunsLast3: 0,
    whipEventsLast3: 0,
    strikeoutsLast3: 0,
    walksLast3: 0,
    eraLast3: null,
    whipLast3: null
  };

  for (const game of games) {
    const boxscore = await fetchBoxscore(game.gamePk);
    const side = boxscore.teams?.away?.team.id === teamId ? boxscore.teams.away : boxscore.teams?.home;
    if (!side?.pitchers?.length || !side.players) {
      continue;
    }

    const gameDate = yyyyMmDd(new Date(game.gameDate));
    for (const pitcherId of side.pitchers.slice(1)) {
      const pitching = side.players[`ID${pitcherId}`]?.stats?.pitching ?? {};
      const pitches = parseNumber(pitching.numberOfPitches) ?? parseNumber(pitching.pitchesThrown) ?? 0;
      const outs = inningsToOuts(pitching.inningsPitched);
      const walks = parseNumber(pitching.baseOnBalls) ?? 0;
      const hits = parseNumber(pitching.hits) ?? 0;

      summary.relieverAppearances += 1;
      summary.pitchesLast3 += pitches;
      summary.outsLast3 += outs;
      summary.earnedRunsLast3 += parseNumber(pitching.earnedRuns) ?? 0;
      summary.whipEventsLast3 += walks + hits;
      summary.strikeoutsLast3 += parseNumber(pitching.strikeOuts) ?? 0;
      summary.walksLast3 += walks;
      if (gameDate === addDays(startsOn, -1)) {
        summary.pitchesLast1 += pitches;
      }
    }
  }

  summary.inningsLast3 = outsToInnings(summary.outsLast3);
  summary.eraLast3 = summary.outsLast3 > 0 ? Number((summary.earnedRunsLast3 * 27 / summary.outsLast3).toFixed(2)) : null;
  summary.whipLast3 = summary.outsLast3 > 0 ? Number((summary.whipEventsLast3 / (summary.outsLast3 / 3)).toFixed(2)) : null;
  return summary;
};

const fetchInjurySnapshot = async (targetDate: string): Promise<InjurySnapshot> => {
  const seasonStart = `${seasonForDate(targetDate)}-01-01`;
  const url = new URL("https://statsapi.mlb.com/api/v1/transactions");
  url.searchParams.set("sportId", "1");
  url.searchParams.set("startDate", seasonStart);
  url.searchParams.set("endDate", targetDate);

  const body = await fetchJson<MlbTransactionsResponse>(url);
  const latestByPlayer = new Map<number, MlbTransaction>();

  for (const tx of body.transactions ?? []) {
    const description = tx.description?.toLowerCase() ?? "";
    if (!tx.person?.id || !description.includes("injured list")) {
      continue;
    }
    const previous = latestByPlayer.get(tx.person.id);
    const txDate = tx.effectiveDate ?? tx.date ?? "";
    const previousDate = previous?.effectiveDate ?? previous?.date ?? "";
    if (!previous || txDate >= previousDate) {
      latestByPlayer.set(tx.person.id, tx);
    }
  }

  const snapshot: InjurySnapshot = new Map();
  for (const tx of latestByPlayer.values()) {
    const description = tx.description ?? "";
    const lower = description.toLowerCase();
    if (lower.includes("activated") || lower.includes("reinstated")) {
      continue;
    }
    if (!lower.includes("placed") && !lower.includes("transferred")) {
      continue;
    }

    const teamId = tx.toTeam?.id ?? tx.fromTeam?.id;
    if (!teamId || !tx.person) {
      continue;
    }

    const summary = snapshot.get(teamId) ?? {
      activeIlPlayers: 0,
      activeIlPitchers: 0,
      recentInjuryTransactions: 0,
      players: []
    };
    summary.activeIlPlayers += 1;
    if (/\b[lr]hp\b/i.test(description)) {
      summary.activeIlPitchers += 1;
    }
    summary.players.push({
      playerId: tx.person.id,
      playerName: tx.person.fullName,
      date: tx.effectiveDate ?? tx.date ?? null,
      description
    });
    snapshot.set(teamId, summary);
  }

  return snapshot;
};

const upsertContext = async (
  client: pg.PoolClient,
  game: MlbScheduleGame,
  startsOn: string,
  awayPitcherStats: PitcherStatsSummary | null,
  homePitcherStats: PitcherStatsSummary | null,
  awayBullpen: BullpenSummary,
  homeBullpen: BullpenSummary,
  awayHitterSplits: HitterSplitSummary,
  homeHitterSplits: HitterSplitSummary,
  awayInjuries: InjurySummary,
  homeInjuries: InjurySummary
) => {
  const context = {
    probablePitcherKnown: Boolean(game.teams.away.probablePitcher && game.teams.home.probablePitcher),
    bullpenDataKnown: awayBullpen.gamesChecked > 0 || homeBullpen.gamesChecked > 0,
    injuryDataKnown: true,
    awayPitchHand: awayPitcherStats?.pitchHand ?? null,
    homePitchHand: homePitcherStats?.pitchHand ?? null,
    awayHitterSplits,
    homeHitterSplits,
    awayLineup: await summarizeLineup(game.lineups?.awayPlayers, seasonForDate(startsOn)),
    homeLineup: await summarizeLineup(game.lineups?.homePlayers, seasonForDate(startsOn))
  };

  await client.query(
    `
      INSERT INTO mlb_game_context (
        id, provider_game_id, starts_on, starts_at, away_team, home_team,
        away_team_id, home_team_id,
        away_probable_pitcher_id, away_probable_pitcher_name,
        home_probable_pitcher_id, home_probable_pitcher_name,
        away_pitcher_stats, home_pitcher_stats,
        away_bullpen, home_bullpen,
        away_injuries, home_injuries,
        context, fetched_at, updated_at
      )
      VALUES (
        $1, $2, $3::date, $4, $5, $6,
        $7, $8,
        $9, $10,
        $11, $12,
        $13::jsonb, $14::jsonb,
        $15::jsonb, $16::jsonb,
        $17::jsonb, $18::jsonb,
        $19::jsonb, now(), now()
      )
      ON CONFLICT (provider_game_id) DO UPDATE SET
        starts_on = EXCLUDED.starts_on,
        starts_at = EXCLUDED.starts_at,
        away_team = EXCLUDED.away_team,
        home_team = EXCLUDED.home_team,
        away_team_id = EXCLUDED.away_team_id,
        home_team_id = EXCLUDED.home_team_id,
        away_probable_pitcher_id = EXCLUDED.away_probable_pitcher_id,
        away_probable_pitcher_name = EXCLUDED.away_probable_pitcher_name,
        home_probable_pitcher_id = EXCLUDED.home_probable_pitcher_id,
        home_probable_pitcher_name = EXCLUDED.home_probable_pitcher_name,
        away_pitcher_stats = EXCLUDED.away_pitcher_stats,
        home_pitcher_stats = EXCLUDED.home_pitcher_stats,
        away_bullpen = EXCLUDED.away_bullpen,
        home_bullpen = EXCLUDED.home_bullpen,
        away_injuries = EXCLUDED.away_injuries,
        home_injuries = EXCLUDED.home_injuries,
        context = EXCLUDED.context,
        fetched_at = EXCLUDED.fetched_at,
        updated_at = EXCLUDED.updated_at
    `,
    [
      randomUUID(),
      String(game.gamePk),
      startsOn,
      game.gameDate,
      game.teams.away.team.name,
      game.teams.home.team.name,
      game.teams.away.team.id,
      game.teams.home.team.id,
      game.teams.away.probablePitcher?.id ?? null,
      game.teams.away.probablePitcher?.fullName ?? null,
      game.teams.home.probablePitcher?.id ?? null,
      game.teams.home.probablePitcher?.fullName ?? null,
      JSON.stringify(awayPitcherStats ?? {}),
      JSON.stringify(homePitcherStats ?? {}),
      JSON.stringify(awayBullpen),
      JSON.stringify(homeBullpen),
      JSON.stringify(awayInjuries),
      JSON.stringify(homeInjuries),
      JSON.stringify(context)
    ]
  );
};

const emptyInjuries = (): InjurySummary => ({
  activeIlPlayers: 0,
  activeIlPitchers: 0,
  recentInjuryTransactions: 0,
  players: []
});

export const refreshMlbGameContext = async ({ startDate, endDate }: { startDate: string; endDate: string }) => {
  const games = await fetchSchedule(startDate, endDate);
  const injurySnapshots = new Map<string, Promise<InjurySnapshot>>();

  return transaction(async (client) => {
    let upserted = 0;
    let probablePitchers = 0;

    for (const game of games) {
      const startsOn = yyyyMmDd(new Date(game.gameDate));
      const season = seasonForDate(startsOn);
      if (!injurySnapshots.has(startsOn)) {
        injurySnapshots.set(startsOn, fetchInjurySnapshot(startsOn));
      }

      const [awayPitcherStats, homePitcherStats, awayBullpen, homeBullpen, injuries] = await Promise.all([
        fetchPitcherStats(game.teams.away.probablePitcher, season),
        fetchPitcherStats(game.teams.home.probablePitcher, season),
        summarizeBullpen(game.teams.away.team.id, startsOn),
        summarizeBullpen(game.teams.home.team.id, startsOn),
        injurySnapshots.get(startsOn)!
      ]);
      const [awayHitterSplits, homeHitterSplits] = await Promise.all([
        summarizeHitterSplits(game.teams.away.team.id, season, homePitcherStats?.pitchHand),
        summarizeHitterSplits(game.teams.home.team.id, season, awayPitcherStats?.pitchHand)
      ]);

      probablePitchers += Number(Boolean(game.teams.away.probablePitcher)) + Number(Boolean(game.teams.home.probablePitcher));
      await upsertContext(
        client,
        game,
        startsOn,
        awayPitcherStats,
        homePitcherStats,
        awayBullpen,
        homeBullpen,
        awayHitterSplits,
        homeHitterSplits,
        injuries.get(game.teams.away.team.id) ?? emptyInjuries(),
        injuries.get(game.teams.home.team.id) ?? emptyInjuries()
      );
      upserted += 1;
    }

    return {
      startDate,
      endDate,
      games: games.length,
      upserted,
      probablePitchers
    };
  });
};
