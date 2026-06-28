import { estimatePayoutCents } from "./betting.js";
import { query } from "./db.js";
import { scoreLine, type CandidateLine, type MlbHeuristicContext, type ScoredCandidate } from "./ai.js";
import {
  finalGameKey,
  outcomeForSelection,
  profitCentsForOutcome,
  type FinalGame
} from "./settlement.js";

type HistoricalLineRow = {
  id: string;
  provider_event_id: string | null;
  source_endpoint: string;
  bookmaker_key: string;
  sport: "MLB";
  starts_at: Date;
  starts_on: string;
  home_team: string;
  away_team: string;
  selected_team: string;
  spread: string;
  odds_american: number;
  market_key: "h2h" | "spreads";
};

type ResultRow = {
  id: string;
  provider_game_id: string | null;
  starts_on: string;
  starts_at: Date | null;
  away_team: string;
  home_team: string;
  away_score: number;
  home_score: number;
};

type EvaluatedPick = ScoredCandidate & {
  starts_on: string;
  source_endpoint: string;
  bookmaker_key: string;
  teamForm: TeamFormSnapshot | null;
  resultId: string;
  outcome: "won" | "lost" | "push" | "void";
  profitCentsPer100: number;
  resultProviderGameId: string | null;
};

type EvaluationVariant = "baseline" | "favorite-form-v1" | "favorite-price-v1";

type EvaluationCandidate = ScoredCandidate & {
  starts_on: string;
  source_endpoint: string;
  bookmaker_key: string;
  teamForm: TeamFormSnapshot | null;
  variantScore: number;
};

type Summary = {
  group: string;
  picks: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  winRate: number;
  profitCents: number;
  roi: number;
  averageConfidence: number;
  averageScore: number;
};

type TeamGame = {
  startsOn: string;
  team: string;
  opponent: string;
  isHome: boolean;
  runsFor: number;
  runsAgainst: number;
  won: boolean;
};

type TeamForm = {
  games: number;
  wins: number;
  losses: number;
  runsFor: number;
  runsAgainst: number;
};

type TeamFormSnapshot = {
  selectedLast7: TeamForm;
  opponentLast7: TeamForm;
  selectedLast14: TeamForm;
  opponentLast14: TeamForm;
  winPctDiff7: number | null;
  runDiffPerGameDiff7: number | null;
  winPctDiff14: number | null;
  runDiffPerGameDiff14: number | null;
  selectedRestDays: number | null;
  opponentRestDays: number | null;
  restDaysDiff: number | null;
  selectedVenueChanged: boolean | null;
  opponentVenueChanged: boolean | null;
};

const emptyForm = (): TeamForm => ({
  games: 0,
  wins: 0,
  losses: 0,
  runsFor: 0,
  runsAgainst: 0
});

const formForGames = (games: TeamGame[], limit: number): TeamForm => {
  return games.slice(-limit).reduce((form, game) => ({
    games: form.games + 1,
    wins: form.wins + (game.won ? 1 : 0),
    losses: form.losses + (game.won ? 0 : 1),
    runsFor: form.runsFor + game.runsFor,
    runsAgainst: form.runsAgainst + game.runsAgainst
  }), emptyForm());
};

const winPct = (form: TeamForm) => form.games ? form.wins / form.games : null;
const runDiffPerGame = (form: TeamForm) => form.games ? (form.runsFor - form.runsAgainst) / form.games : null;
const diffOrNull = (left: number | null, right: number | null) => left === null || right === null ? null : left - right;
const daysBetween = (start: string, end: string) => {
  return Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86_400_000);
};

const contextFromTeamForm = (teamForm: TeamFormSnapshot | null): MlbHeuristicContext | null => {
  if (!teamForm) {
    return null;
  }

  return {
    winPctDiff7: teamForm.winPctDiff7,
    runDiffPerGameDiff7: teamForm.runDiffPerGameDiff7,
    winPctDiff14: teamForm.winPctDiff14,
    runDiffPerGameDiff14: teamForm.runDiffPerGameDiff14,
    selectedRunsForPerGame7: teamForm.selectedLast7.games ? teamForm.selectedLast7.runsFor / teamForm.selectedLast7.games : null,
    opponentRunsForPerGame7: teamForm.opponentLast7.games ? teamForm.opponentLast7.runsFor / teamForm.opponentLast7.games : null,
    runsForPerGameDiff7: diffOrNull(
      teamForm.selectedLast7.games ? teamForm.selectedLast7.runsFor / teamForm.selectedLast7.games : null,
      teamForm.opponentLast7.games ? teamForm.opponentLast7.runsFor / teamForm.opponentLast7.games : null
    ),
    selectedRunsForPerGame14: teamForm.selectedLast14.games ? teamForm.selectedLast14.runsFor / teamForm.selectedLast14.games : null,
    opponentRunsForPerGame14: teamForm.opponentLast14.games ? teamForm.opponentLast14.runsFor / teamForm.opponentLast14.games : null,
    runsForPerGameDiff14: diffOrNull(
      teamForm.selectedLast14.games ? teamForm.selectedLast14.runsFor / teamForm.selectedLast14.games : null,
      teamForm.opponentLast14.games ? teamForm.opponentLast14.runsFor / teamForm.opponentLast14.games : null
    ),
    selectedRunsAgainstPerGame7: teamForm.selectedLast7.games ? teamForm.selectedLast7.runsAgainst / teamForm.selectedLast7.games : null,
    opponentRunsAgainstPerGame7: teamForm.opponentLast7.games ? teamForm.opponentLast7.runsAgainst / teamForm.opponentLast7.games : null,
    runsAgainstPerGameDiff7: diffOrNull(
      teamForm.selectedLast7.games ? teamForm.selectedLast7.runsAgainst / teamForm.selectedLast7.games : null,
      teamForm.opponentLast7.games ? teamForm.opponentLast7.runsAgainst / teamForm.opponentLast7.games : null
    ),
    selectedRunsAgainstPerGame14: teamForm.selectedLast14.games ? teamForm.selectedLast14.runsAgainst / teamForm.selectedLast14.games : null,
    opponentRunsAgainstPerGame14: teamForm.opponentLast14.games ? teamForm.opponentLast14.runsAgainst / teamForm.opponentLast14.games : null,
    runsAgainstPerGameDiff14: diffOrNull(
      teamForm.selectedLast14.games ? teamForm.selectedLast14.runsAgainst / teamForm.selectedLast14.games : null,
      teamForm.opponentLast14.games ? teamForm.opponentLast14.runsAgainst / teamForm.opponentLast14.games : null
    ),
    selectedHitterOpsVsPitchHand: null,
    opponentHitterOpsVsPitchHand: null,
    hitterOpsVsPitchHandDiff: null,
    selectedHitterObpVsPitchHand: null,
    opponentHitterObpVsPitchHand: null,
    hitterObpVsPitchHandDiff: null,
    selectedHitterSlgVsPitchHand: null,
    opponentHitterSlgVsPitchHand: null,
    hitterSlgVsPitchHandDiff: null,
    selectedOppositeHandBatters: null,
    opponentOppositeHandBatters: null,
    oppositeHandBattersDiff: null,
    selectedLineupConfirmed: null,
    opponentLineupConfirmed: null,
    selectedLineupAvg: null,
    opponentLineupAvg: null,
    lineupAvgDiff: null,
    selectedLineupHomeRuns: null,
    opponentLineupHomeRuns: null,
    lineupHomeRunsDiff: null,
    selectedLineupRbi: null,
    opponentLineupRbi: null,
    lineupRbiDiff: null,
    selectedVenueWinPct: null,
    opponentVenueWinPct: null,
    venueWinPctDiff: null,
    selectedVenueRunDiffPerGame: null,
    opponentVenueRunDiffPerGame: null,
    venueRunDiffPerGameDiff: null,
    selectedRestDays: teamForm.selectedRestDays,
    opponentRestDays: teamForm.opponentRestDays,
    restDaysDiff: teamForm.restDaysDiff,
    selectedVenueChanged: teamForm.selectedVenueChanged,
    opponentVenueChanged: teamForm.opponentVenueChanged,
    probablePitcherKnown: false,
    bullpenDataKnown: false,
    injuryDataKnown: false,
    selectedStarterEra: null,
    opponentStarterEra: null,
    starterEraDiff: null,
    selectedStarterAdjustedEra: null,
    opponentStarterAdjustedEra: null,
    starterAdjustedEraDiff: null,
    selectedStarterWhip: null,
    opponentStarterWhip: null,
    starterWhipDiff: null,
    selectedStarterHomeRunsPer9: null,
    opponentStarterHomeRunsPer9: null,
    starterHomeRunsPer9Diff: null,
    selectedStarterStrikeoutsPer9: null,
    opponentStarterStrikeoutsPer9: null,
    starterStrikeoutsPer9Diff: null,
    selectedStarterWalksPer9: null,
    opponentStarterWalksPer9: null,
    starterWalksPer9Diff: null,
    selectedStarterKbb: null,
    opponentStarterKbb: null,
    starterKbbDiff: null,
    selectedStarterRecentEra: null,
    opponentStarterRecentEra: null,
    starterRecentEraDiff: null,
    selectedStarterRecentKbb: null,
    opponentStarterRecentKbb: null,
    starterRecentKbbDiff: null,
    selectedStarterRecentPitches: null,
    opponentStarterRecentPitches: null,
    starterRecentPitchesDiff: null,
    selectedBullpenPitchesLast3: null,
    opponentBullpenPitchesLast3: null,
    bullpenPitchesLast3Diff: null,
    selectedBullpenPitchesLast1: null,
    opponentBullpenPitchesLast1: null,
    bullpenPitchesLast1Diff: null,
    selectedBullpenEraLast3: null,
    opponentBullpenEraLast3: null,
    bullpenEraLast3Diff: null,
    selectedBullpenWhipLast3: null,
    opponentBullpenWhipLast3: null,
    bullpenWhipLast3Diff: null,
    selectedBullpenKbbLast3: null,
    opponentBullpenKbbLast3: null,
    bullpenKbbLast3Diff: null,
    selectedActiveIlPlayers: null,
    opponentActiveIlPlayers: null,
    activeIlPlayersDiff: null,
    selectedActiveIlPitchers: null,
    opponentActiveIlPitchers: null,
    activeIlPitchersDiff: null,
    openingOddsAmerican: null,
    previousOddsAmerican: null,
    lineMovementAmerican: null,
    lineMovementImplied: null,
    lineSnapshotCount: null
  };
};

const buildTeamFormSnapshots = (results: ResultRow[]) => {
  const sorted = [...results].sort((a, b) =>
    a.starts_on.localeCompare(b.starts_on)
    || (a.starts_at?.getTime() ?? 0) - (b.starts_at?.getTime() ?? 0)
    || a.id.localeCompare(b.id)
  );
  const history = new Map<string, TeamGame[]>();
  const snapshots = new Map<string, TeamFormSnapshot>();

  for (const result of sorted) {
    const key = finalGameKey({
      startsOn: result.starts_on,
      awayTeam: result.away_team,
      homeTeam: result.home_team
    });
    const awayHistory = history.get(result.away_team) ?? [];
    const homeHistory = history.get(result.home_team) ?? [];

    const awayLast7 = formForGames(awayHistory, 7);
    const homeLast7 = formForGames(homeHistory, 7);
    const awayLast14 = formForGames(awayHistory, 14);
    const homeLast14 = formForGames(homeHistory, 14);
    const awayLast = awayHistory.at(-1);
    const homeLast = homeHistory.at(-1);
    const awayRestDays = awayLast ? Math.max(0, daysBetween(awayLast.startsOn, result.starts_on) - 1) : null;
    const homeRestDays = homeLast ? Math.max(0, daysBetween(homeLast.startsOn, result.starts_on) - 1) : null;

    snapshots.set(`${key}:${result.away_team}`, {
      selectedLast7: awayLast7,
      opponentLast7: homeLast7,
      selectedLast14: awayLast14,
      opponentLast14: homeLast14,
      winPctDiff7: diffOrNull(winPct(awayLast7), winPct(homeLast7)),
      runDiffPerGameDiff7: diffOrNull(runDiffPerGame(awayLast7), runDiffPerGame(homeLast7)),
      winPctDiff14: diffOrNull(winPct(awayLast14), winPct(homeLast14)),
      runDiffPerGameDiff14: diffOrNull(runDiffPerGame(awayLast14), runDiffPerGame(homeLast14)),
      selectedRestDays: awayRestDays,
      opponentRestDays: homeRestDays,
      restDaysDiff: diffOrNull(awayRestDays, homeRestDays),
      selectedVenueChanged: awayLast ? awayLast.isHome !== false : null,
      opponentVenueChanged: homeLast ? homeLast.isHome !== true : null
    });
    snapshots.set(`${key}:${result.home_team}`, {
      selectedLast7: homeLast7,
      opponentLast7: awayLast7,
      selectedLast14: homeLast14,
      opponentLast14: awayLast14,
      winPctDiff7: diffOrNull(winPct(homeLast7), winPct(awayLast7)),
      runDiffPerGameDiff7: diffOrNull(runDiffPerGame(homeLast7), runDiffPerGame(awayLast7)),
      winPctDiff14: diffOrNull(winPct(homeLast14), winPct(awayLast14)),
      runDiffPerGameDiff14: diffOrNull(runDiffPerGame(homeLast14), runDiffPerGame(awayLast14)),
      selectedRestDays: homeRestDays,
      opponentRestDays: awayRestDays,
      restDaysDiff: diffOrNull(homeRestDays, awayRestDays),
      selectedVenueChanged: homeLast ? homeLast.isHome !== true : null,
      opponentVenueChanged: awayLast ? awayLast.isHome !== false : null
    });

    history.set(result.away_team, [...awayHistory, {
      startsOn: result.starts_on,
      team: result.away_team,
      opponent: result.home_team,
      isHome: false,
      runsFor: result.away_score,
      runsAgainst: result.home_score,
      won: result.away_score > result.home_score
    }]);
    history.set(result.home_team, [...homeHistory, {
      startsOn: result.starts_on,
      team: result.home_team,
      opponent: result.away_team,
      isHome: true,
      runsFor: result.home_score,
      runsAgainst: result.away_score,
      won: result.home_score > result.away_score
    }]);
  }

  return snapshots;
};

const confidenceBucket = (confidence: number) => {
  if (confidence >= 0.62) return "0.62+";
  if (confidence >= 0.56) return "0.56-0.62";
  if (confidence >= 0.5) return "0.50-0.56";
  return "<0.50";
};

const sideBucket = (pick: EvaluatedPick) => pick.selected_team === pick.home_team ? "home" : "away";
const priceBucket = (pick: EvaluatedPick) => pick.odds_american < 0 ? "favorite" : "underdog";
const diffBucket = (value: number | null) => {
  if (value === null) return "unknown";
  if (value >= 0.15) return "strong-positive";
  if (value > 0) return "slight-positive";
  if (value <= -0.15) return "strong-negative";
  return "slight-negative";
};
const runDiffBucket = (value: number | null) => {
  if (value === null) return "unknown";
  if (value >= 1) return "strong-positive";
  if (value > 0) return "slight-positive";
  if (value <= -1) return "strong-negative";
  return "slight-negative";
};

const eventKey = (line: HistoricalLineRow | CandidateLine) => {
  return `${line.sport}:${line.starts_at.toISOString()}:${line.away_team}:${line.home_team}:${line.market_key}`;
};

const variantScore = (pick: ScoredCandidate, teamForm: TeamFormSnapshot | null, variant: EvaluationVariant) => {
  if (variant === "baseline") {
    return pick.score;
  }

  let score = pick.score;
  if (pick.market_key === "h2h" && pick.odds_american < 0) {
    score += 1.6;
  }
  if (pick.market_key === "h2h" && pick.odds_american > 0) {
    score -= 1.4;
  }
  if (variant === "favorite-price-v1") {
    return score;
  }
  if ((teamForm?.winPctDiff7 ?? 0) >= 0.15) {
    score += 0.8;
  }
  if ((teamForm?.runDiffPerGameDiff14 ?? 0) >= 1) {
    score += 0.7;
  }
  if ((teamForm?.runDiffPerGameDiff7 ?? 0) <= -1) {
    score -= 0.8;
  }
  if ((teamForm?.runDiffPerGameDiff14 ?? 0) <= -1) {
    score -= 0.5;
  }
  return score;
};

const resultMapByUnambiguousGame = (results: ResultRow[]) => {
  const grouped = new Map<string, ResultRow[]>();
  for (const result of results) {
    const key = finalGameKey({
      startsOn: result.starts_on,
      awayTeam: result.away_team,
      homeTeam: result.home_team
    });
    grouped.set(key, [...(grouped.get(key) ?? []), result]);
  }

  const map = new Map<string, ResultRow>();
  for (const [key, group] of grouped.entries()) {
    if (group.length === 1) {
      map.set(key, group[0]);
    }
  }
  return map;
};

const summarize = (group: string, picks: EvaluatedPick[]): Summary => {
  const wins = picks.filter((pick) => pick.outcome === "won").length;
  const losses = picks.filter((pick) => pick.outcome === "lost").length;
  const pushes = picks.filter((pick) => pick.outcome === "push").length;
  const voids = picks.filter((pick) => pick.outcome === "void").length;
  const decided = wins + losses;
  const profitCents = picks.reduce((sum, pick) => sum + pick.profitCentsPer100, 0);
  const stakedCents = picks.length * 10000;

  return {
    group,
    picks: picks.length,
    wins,
    losses,
    pushes,
    voids,
    winRate: decided ? wins / decided : 0,
    profitCents,
    roi: stakedCents ? profitCents / stakedCents : 0,
    averageConfidence: picks.length ? picks.reduce((sum, pick) => sum + pick.confidence, 0) / picks.length : 0,
    averageScore: picks.length ? picks.reduce((sum, pick) => sum + pick.score, 0) / picks.length : 0
  };
};

const groupedSummaries = (picks: EvaluatedPick[]) => {
  const groups: Record<string, (pick: EvaluatedPick) => string> = {
    market: (pick) => pick.market_key,
    source: (pick) => pick.source_endpoint,
    bookmaker: (pick) => pick.bookmaker_key,
    side: sideBucket,
    price: priceBucket,
    confidence: (pick) => confidenceBucket(pick.confidence),
    formWinPct7: (pick) => diffBucket(pick.teamForm?.winPctDiff7 ?? null),
    formRunDiff7: (pick) => runDiffBucket(pick.teamForm?.runDiffPerGameDiff7 ?? null),
    formWinPct14: (pick) => diffBucket(pick.teamForm?.winPctDiff14 ?? null),
    formRunDiff14: (pick) => runDiffBucket(pick.teamForm?.runDiffPerGameDiff14 ?? null)
  };

  return Object.entries(groups).flatMap(([groupName, keyFor]) => {
    const grouped = new Map<string, EvaluatedPick[]>();
    for (const pick of picks) {
      const key = `${groupName}:${keyFor(pick)}`;
      grouped.set(key, [...(grouped.get(key) ?? []), pick]);
    }
    return [...grouped.entries()].map(([group, groupPicks]) => summarize(group, groupPicks));
  });
};

export const evaluateHistoricalAi = async ({
  startDate,
  endDate,
  sourceEndpoint = "closing-odds",
  bookmaker,
  market = "h2h",
  picksPerDay = 3,
  variant = "baseline"
}: {
  startDate: string;
  endDate: string;
  sourceEndpoint?: string;
  bookmaker?: string;
  market?: "h2h" | "spreads";
  picksPerDay?: number;
  variant?: EvaluationVariant;
}) => {
  const lines = await query<HistoricalLineRow>(
    `
      SELECT
        id,
        provider_event_id,
        source_endpoint,
        bookmaker_key,
        sport,
        starts_at,
        starts_on::text,
        home_team,
        away_team,
        selected_team,
        spread,
        odds_american,
        market_key
      FROM historical_game_line
      WHERE sport = 'MLB'
        AND starts_on BETWEEN $1::date AND $2::date
        AND source_endpoint = $3
        AND market_key = $4
        AND ($5::text IS NULL OR bookmaker_key = $5)
      ORDER BY starts_on ASC, bookmaker_key ASC, home_team ASC, selected_team ASC
    `,
    [startDate, endDate, sourceEndpoint, market, bookmaker ?? null]
  );

  const warmupStart = new Date(`${startDate}T00:00:00Z`);
  warmupStart.setUTCDate(warmupStart.getUTCDate() - 21);
  const results = await query<ResultRow>(
    `
      SELECT
        id,
        provider_game_id,
        starts_on::text,
        starts_at,
        away_team,
        home_team,
        away_score,
        home_score
      FROM game_result
      WHERE sport = 'MLB'
        AND source = 'mlb-stats-api'
        AND starts_on BETWEEN $1::date AND $2::date
    `,
    [warmupStart.toISOString().slice(0, 10), endDate]
  );

  const eventMarketCounts = new Map<string, number>();
  for (const line of lines.rows) {
    eventMarketCounts.set(eventKey(line), (eventMarketCounts.get(eventKey(line)) ?? 0) + 1);
  }
  const resultMap = resultMapByUnambiguousGame(results.rows);
  const formSnapshots = buildTeamFormSnapshots(results.rows);

  const scored = lines.rows.map((line) => scoreLine({
    id: line.id,
    provider_event_id: line.provider_event_id,
    sport: line.sport,
    starts_at: line.starts_at,
    home_team: line.home_team,
    away_team: line.away_team,
    selected_team: line.selected_team,
    spread: line.spread,
    odds_american: line.odds_american,
    market_key: line.market_key
  }, eventMarketCounts, contextFromTeamForm(formSnapshots.get(`${finalGameKey({
    startsOn: line.starts_on,
    awayTeam: line.away_team,
    homeTeam: line.home_team
  })}:${line.selected_team}`) ?? null)));
  const candidates: EvaluationCandidate[] = scored.map((pick) => {
    const line = lines.rows.find((row) => row.id === pick.id)!;
    const teamForm = formSnapshots.get(`${finalGameKey({
      startsOn: line.starts_on,
      awayTeam: pick.away_team,
      homeTeam: pick.home_team
    })}:${pick.selected_team}`) ?? null;

    return {
      ...pick,
      starts_on: line.starts_on,
      source_endpoint: line.source_endpoint,
      bookmaker_key: line.bookmaker_key,
      teamForm,
      variantScore: variantScore(pick, teamForm, variant)
    };
  });
  const byDate = new Map<string, EvaluationCandidate[]>();
  for (const pick of candidates) {
    byDate.set(pick.starts_on, [...(byDate.get(pick.starts_on) ?? []), pick]);
  }

  const evaluated: EvaluatedPick[] = [];
  const skipped = {
    noResult: 0,
    duplicateGameSelection: 0
  };

  for (const [startsOn, candidates] of byDate.entries()) {
    const selected = candidates
      .sort((a, b) => b.variantScore - a.variantScore)
      .reduce<EvaluationCandidate[]>((acc, candidate) => {
        const gameKey = `${candidate.away_team}:${candidate.home_team}:${candidate.market_key}`;
        if (acc.some((pick) => `${pick.away_team}:${pick.home_team}:${pick.market_key}` === gameKey)) {
          skipped.duplicateGameSelection += 1;
          return acc;
        }
        if (acc.length >= picksPerDay) {
          return acc;
        }
        acc.push(candidate);
        return acc;
      }, []);

    for (const pick of selected) {
      const result = resultMap.get(finalGameKey({
        startsOn,
        awayTeam: pick.away_team,
        homeTeam: pick.home_team
      }));
      if (!result) {
        skipped.noResult += 1;
        continue;
      }

      const game: FinalGame = {
        providerGameId: result.provider_game_id ?? undefined,
        startsAt: result.starts_at?.toISOString(),
        startsOn: result.starts_on,
        awayTeam: result.away_team,
        homeTeam: result.home_team,
        awayScore: result.away_score,
        homeScore: result.home_score
      };
      const outcome = outcomeForSelection({
        selectedTeam: pick.selected_team,
        awayTeam: pick.away_team,
        homeTeam: pick.home_team,
        marketKey: pick.market_key,
        spread: Number(pick.spread),
        game
      });

      evaluated.push({
        ...pick,
        starts_on: startsOn,
        source_endpoint: pick.source_endpoint,
        bookmaker_key: pick.bookmaker_key,
        teamForm: pick.teamForm,
        resultId: result.id,
        resultProviderGameId: result.provider_game_id,
        outcome,
        profitCentsPer100: profitCentsForOutcome({
          outcome,
          stakeCents: 10000,
          potentialPayoutCents: estimatePayoutCents(10000, [pick.odds_american])
        })
      });
    }
  }

  const topPicks = evaluated
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on) || b.score - a.score)
    .slice(0, 25)
    .map((pick) => ({
      date: pick.starts_on,
      selectedTeam: pick.selected_team,
      matchup: `${pick.away_team} @ ${pick.home_team}`,
      bookmaker: pick.bookmaker_key,
      odds: pick.odds_american,
      confidence: Number(pick.confidence.toFixed(4)),
      score: Number(pick.score.toFixed(4)),
      outcome: pick.outcome,
      teamForm: pick.teamForm ? {
        winPctDiff7: pick.teamForm.winPctDiff7 === null ? null : Number(pick.teamForm.winPctDiff7.toFixed(4)),
        runDiffPerGameDiff7: pick.teamForm.runDiffPerGameDiff7 === null ? null : Number(pick.teamForm.runDiffPerGameDiff7.toFixed(4)),
        winPctDiff14: pick.teamForm.winPctDiff14 === null ? null : Number(pick.teamForm.winPctDiff14.toFixed(4)),
        runDiffPerGameDiff14: pick.teamForm.runDiffPerGameDiff14 === null ? null : Number(pick.teamForm.runDiffPerGameDiff14.toFixed(4))
      } : null,
      profitCentsPer100: pick.profitCentsPer100
    }));

  return {
    dateRange: { startDate, endDate },
    filters: { sourceEndpoint, bookmaker: bookmaker ?? null, market, picksPerDay, variant },
    linesChecked: lines.rowCount,
    resultsChecked: results.rowCount,
    evaluatedPicks: evaluated.length,
    skipped,
    overall: summarize("overall", evaluated),
    groups: groupedSummaries(evaluated).sort((a, b) => b.picks - a.picks || b.roi - a.roi),
    topPicks
  };
};
