import { randomUUID } from "node:crypto";
import type pg from "pg";
import { americanToDecimal, ensureWeeklyEntry, estimatePayoutCents } from "./betting.js";
import { config } from "./config.js";
import { query, transaction } from "./db.js";

export const modelVersion = "phase3-context-heuristic-v6";

export type CandidateLine = {
  id: string;
  provider_event_id: string | null;
  sport: "MLB" | "NHL" | "NFL" | "NBA" | "NCAAMB" | "NCAAF";
  starts_at: Date;
  home_team: string;
  away_team: string;
  selected_team: string;
  spread: string;
  odds_american: number;
  market_key: "h2h" | "spreads";
};

export type ScoredCandidate = CandidateLine & {
  score: number;
  confidence: number;
  impliedProbability: number;
  fairProbability: number;
  edge: number;
  features: Record<string, number | string | boolean | null>;
  reasons: string[];
};

type PublishedAiPick = {
  id: string;
  gameLineId: string;
  selectedTeam: string;
  score: number;
  confidence: number;
  edge: number;
  stakeCents: number;
  locked: boolean;
  wagerId: string | null;
  reasons: string[];
  explanation: string;
  awayTeam: string;
  homeTeam: string;
  marketKey: "h2h" | "spreads";
  spread: string;
  oddsAmerican: number;
  startsAt: string;
  features: Record<string, number | string | boolean | null>;
};

export type MlbHeuristicContext = {
  winPctDiff7: number | null;
  runDiffPerGameDiff7: number | null;
  winPctDiff14: number | null;
  runDiffPerGameDiff14: number | null;
  selectedRunsForPerGame7: number | null;
  opponentRunsForPerGame7: number | null;
  runsForPerGameDiff7: number | null;
  selectedRunsForPerGame14: number | null;
  opponentRunsForPerGame14: number | null;
  runsForPerGameDiff14: number | null;
  selectedRunsAgainstPerGame7: number | null;
  opponentRunsAgainstPerGame7: number | null;
  runsAgainstPerGameDiff7: number | null;
  selectedRunsAgainstPerGame14: number | null;
  opponentRunsAgainstPerGame14: number | null;
  runsAgainstPerGameDiff14: number | null;
  selectedHitterOpsVsPitchHand: number | null;
  opponentHitterOpsVsPitchHand: number | null;
  hitterOpsVsPitchHandDiff: number | null;
  selectedHitterObpVsPitchHand: number | null;
  opponentHitterObpVsPitchHand: number | null;
  hitterObpVsPitchHandDiff: number | null;
  selectedHitterSlgVsPitchHand: number | null;
  opponentHitterSlgVsPitchHand: number | null;
  hitterSlgVsPitchHandDiff: number | null;
  selectedOppositeHandBatters: number | null;
  opponentOppositeHandBatters: number | null;
  oppositeHandBattersDiff: number | null;
  selectedLineupConfirmed: boolean | null;
  opponentLineupConfirmed: boolean | null;
  selectedLineupAvg: number | null;
  opponentLineupAvg: number | null;
  lineupAvgDiff: number | null;
  selectedLineupHomeRuns: number | null;
  opponentLineupHomeRuns: number | null;
  lineupHomeRunsDiff: number | null;
  selectedLineupRbi: number | null;
  opponentLineupRbi: number | null;
  lineupRbiDiff: number | null;
  selectedVenueWinPct: number | null;
  opponentVenueWinPct: number | null;
  venueWinPctDiff: number | null;
  selectedVenueRunDiffPerGame: number | null;
  opponentVenueRunDiffPerGame: number | null;
  venueRunDiffPerGameDiff: number | null;
  selectedRestDays: number | null;
  opponentRestDays: number | null;
  restDaysDiff: number | null;
  selectedVenueChanged: boolean | null;
  opponentVenueChanged: boolean | null;
  probablePitcherKnown: boolean;
  bullpenDataKnown: boolean;
  injuryDataKnown: boolean;
  selectedStarterEra: number | null;
  opponentStarterEra: number | null;
  starterEraDiff: number | null;
  selectedStarterAdjustedEra: number | null;
  opponentStarterAdjustedEra: number | null;
  starterAdjustedEraDiff: number | null;
  selectedStarterWhip: number | null;
  opponentStarterWhip: number | null;
  starterWhipDiff: number | null;
  selectedStarterHomeRunsPer9: number | null;
  opponentStarterHomeRunsPer9: number | null;
  starterHomeRunsPer9Diff: number | null;
  selectedStarterStrikeoutsPer9: number | null;
  opponentStarterStrikeoutsPer9: number | null;
  starterStrikeoutsPer9Diff: number | null;
  selectedStarterWalksPer9: number | null;
  opponentStarterWalksPer9: number | null;
  starterWalksPer9Diff: number | null;
  selectedStarterKbb: number | null;
  opponentStarterKbb: number | null;
  starterKbbDiff: number | null;
  selectedStarterRecentEra: number | null;
  opponentStarterRecentEra: number | null;
  starterRecentEraDiff: number | null;
  selectedStarterRecentKbb: number | null;
  opponentStarterRecentKbb: number | null;
  starterRecentKbbDiff: number | null;
  selectedStarterRecentPitches: number | null;
  opponentStarterRecentPitches: number | null;
  starterRecentPitchesDiff: number | null;
  selectedBullpenPitchesLast3: number | null;
  opponentBullpenPitchesLast3: number | null;
  bullpenPitchesLast3Diff: number | null;
  selectedBullpenPitchesLast1: number | null;
  opponentBullpenPitchesLast1: number | null;
  bullpenPitchesLast1Diff: number | null;
  selectedBullpenEraLast3: number | null;
  opponentBullpenEraLast3: number | null;
  bullpenEraLast3Diff: number | null;
  selectedBullpenWhipLast3: number | null;
  opponentBullpenWhipLast3: number | null;
  bullpenWhipLast3Diff: number | null;
  selectedBullpenKbbLast3: number | null;
  opponentBullpenKbbLast3: number | null;
  bullpenKbbLast3Diff: number | null;
  selectedActiveIlPlayers: number | null;
  opponentActiveIlPlayers: number | null;
  activeIlPlayersDiff: number | null;
  selectedActiveIlPitchers: number | null;
  opponentActiveIlPitchers: number | null;
  activeIlPitchersDiff: number | null;
  openingOddsAmerican: number | null;
  previousOddsAmerican: number | null;
  lineMovementAmerican: number | null;
  lineMovementImplied: number | null;
  lineSnapshotCount: number | null;
};

type TeamGame = {
  startsOn: string;
  team: string;
  opponent: string;
  homeTeam: string;
  isHome: boolean;
  runsFor: number;
  runsAgainst: number;
  won: boolean;
};

type MlbStoredContext = {
  starts_at: Date;
  away_pitcher_stats: Record<string, unknown>;
  home_pitcher_stats: Record<string, unknown>;
  away_bullpen: Record<string, unknown>;
  home_bullpen: Record<string, unknown>;
  away_injuries: Record<string, unknown>;
  home_injuries: Record<string, unknown>;
  context: Record<string, unknown>;
};

type MarketMovementContext = {
  openingOddsAmerican: number | null;
  previousOddsAmerican: number | null;
  lineMovementAmerican: number | null;
  lineMovementImplied: number | null;
  lineSnapshotCount: number | null;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const impliedProbability = (american: number) => {
  if (american > 0) {
    return 100 / (american + 100);
  }
  return Math.abs(american) / (Math.abs(american) + 100);
};

const eventKey = (line: CandidateLine) => {
  return line.provider_event_id?.split(":").slice(0, 3).join(":")
    ?? `${line.sport}:${line.starts_at.toISOString()}:${line.away_team}:${line.home_team}:${line.market_key}`;
};

const dateOnly = (date: Date | string) => new Date(date).toISOString().slice(0, 10);

const storedContextExactKey = (startsAt: Date | string, awayTeam: string, homeTeam: string) =>
  `${new Date(startsAt).toISOString()}:${awayTeam}:${homeTeam}`;

const storedContextDateKey = (startsOn: string, awayTeam: string, homeTeam: string) =>
  `${startsOn}:${awayTeam}:${homeTeam}`;

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

const daysBetween = (start: string, end: string) => {
  return Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86_400_000);
};

const formForGames = (games: TeamGame[], limit: number) => {
  const selected = games.slice(-limit);
  if (!selected.length) {
    return null;
  }

  const wins = selected.filter((game) => game.won).length;
  const runsFor = selected.reduce((sum, game) => sum + game.runsFor, 0);
  const runsAgainst = selected.reduce((sum, game) => sum + game.runsAgainst, 0);
  return {
    games: selected.length,
    winPct: wins / selected.length,
    runsForPerGame: runsFor / selected.length,
    runsAgainstPerGame: runsAgainst / selected.length,
    runDiffPerGame: (runsFor - runsAgainst) / selected.length
  };
};

const diffOrNull = (left: number | null | undefined, right: number | null | undefined) =>
  left === null || left === undefined || right === null || right === undefined ? null : left - right;

const numericFeature = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const nestedNumber = (object: Record<string, unknown> | undefined, path: string[]) => {
  let cursor: unknown = object;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return numericFeature(cursor);
};

const ratioOrNull = (numerator: number | null | undefined, denominator: number | null | undefined) => {
  if (numerator === null || numerator === undefined || denominator === null || denominator === undefined) {
    return null;
  }
  if (denominator === 0) {
    return numerator > 0 ? numerator : null;
  }
  return numerator / denominator;
};

const formattedOdds = (odds: number) => odds > 0 ? `+${odds}` : String(odds);

const rounded = (value: unknown, digits = 2) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(digits));
};

const formatPct = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.round(value * 100)}%`;
};

const comparisonFact = (selectedTeam: string, opponent: string, selectedValue: unknown, opponentValue: unknown, label: string, lowerIsBetter = false) => {
  const selected = rounded(selectedValue);
  const other = rounded(opponentValue);
  if (selected === null || other === null) {
    return null;
  }
  const betterTeam = lowerIsBetter ? (selected <= other ? selectedTeam : opponent) : (selected >= other ? selectedTeam : opponent);
  return {
    fact: `${label}: ${selectedTeam} ${selected} vs ${opponent} ${other}`,
    edge: betterTeam
  };
};

const explanationBullet = (item: { fact: string; edge: string }) => {
  return `• ${item.fact}\n  Edge: ${item.edge}`;
};

const hasExplanationFact = (item: { fact: string; edge: string } | null): item is { fact: string; edge: string } => Boolean(item);

const fallbackAiExplanation = (pick: Omit<PublishedAiPick, "id" | "explanation" | "stakeCents" | "locked" | "wagerId" | "gameLineId">) => {
  const opponent = pick.selectedTeam === pick.awayTeam ? pick.homeTeam : pick.awayTeam;
  const market = pick.marketKey === "h2h" ? `moneyline ${formattedOdds(pick.oddsAmerican)}` : `run line ${pick.spread} (${formattedOdds(pick.oddsAmerican)})`;
  const matchupFacts = [
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedHitterOpsVsPitchHand, pick.features.opponentHitterOpsVsPitchHand, "Projected lineup OPS vs opposing pitcher hand"),
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedHitterObpVsPitchHand, pick.features.opponentHitterObpVsPitchHand, "Projected lineup OBP vs opposing pitcher hand"),
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedHitterSlgVsPitchHand, pick.features.opponentHitterSlgVsPitchHand, "Projected lineup SLG vs opposing pitcher hand"),
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedOppositeHandBatters, pick.features.opponentOppositeHandBatters, "Opposite-hand bats vs starter"),
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedLineupAvg, pick.features.opponentLineupAvg, "Confirmed lineup average"),
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedLineupHomeRuns, pick.features.opponentLineupHomeRuns, "Confirmed lineup home runs"),
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedLineupRbi, pick.features.opponentLineupRbi, "Confirmed lineup RBI")
  ].filter(hasExplanationFact);
  const gameStateFacts = [
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedRunsForPerGame7, pick.features.opponentRunsForPerGame7, "Recent scoring"),
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedRunsAgainstPerGame7, pick.features.opponentRunsAgainstPerGame7, "Recent run prevention", true),
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedStarterEra, pick.features.opponentStarterEra, "Starter ERA", true),
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedStarterHomeRunsPer9, pick.features.opponentStarterHomeRunsPer9, "Starter HR/9", true),
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedBullpenPitchesLast3, pick.features.opponentBullpenPitchesLast3, "Bullpen pitches last three games", true),
    comparisonFact(pick.selectedTeam, opponent, pick.features.selectedBullpenEraLast3, pick.features.opponentBullpenEraLast3, "Bullpen ERA last three games", true)
  ].filter(hasExplanationFact);
  const confidence = formatPct(pick.confidence);
  const lead = `The model prefers ${pick.selectedTeam} on the ${market}${confidence ? ` at ${confidence} confidence` : ""}.`;
  const facts = [...matchupFacts.slice(0, 1), ...gameStateFacts].slice(0, 3);
  return [lead, ...facts.map(explanationBullet)].join("\n");
};

const openAiOutputText = (body: unknown) => {
  if (!body || typeof body !== "object") {
    return null;
  }
  const direct = (body as { output_text?: unknown }).output_text;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return null;
  }
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") continue;
      const text = (contentItem as { text?: unknown }).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
  }
  return parts.join("").trim() || null;
};

const buildExplanationData = (pick: PublishedAiPick) => {
  const opponent = pick.selectedTeam === pick.awayTeam ? pick.homeTeam : pick.awayTeam;
  return {
    game: `${pick.awayTeam} at ${pick.homeTeam}`,
    startsAt: pick.startsAt,
    pick: pick.selectedTeam,
    opponent,
    market: pick.marketKey === "h2h" ? "moneyline" : "runline",
    line: pick.marketKey === "h2h" ? formattedOdds(pick.oddsAmerican) : `${pick.spread} (${formattedOdds(pick.oddsAmerican)})`,
    confidence: rounded(pick.confidence, 4),
    modelEdge: rounded(pick.edge, 4),
    reasons: pick.reasons,
    features: pick.features
  };
};

const generateOpenAiExplanation = async (pick: PublishedAiPick) => {
  if (!config.openAiApiKey) {
    return pick.explanation;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openAiApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.openAiModel,
        max_output_tokens: 180,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: [
                  "You write concise sports model explanations for a free entertainment contest.",
                  "Use only the supplied data. Do not invent player names, injuries, pitch counts, innings, odds, or statistics.",
                  "Explain why the model prefers the pick, not why it is guaranteed to win.",
                  "When hitter split or confirmed lineup data is available, include at least one lineup strength or batter-vs-pitcher-handedness detail.",
                  "Use this format after the opening sentence: bullet fact on one line, then 'Edge: Team' on the next line. Mention specific stats when they are available.",
                  "Do not include markdown tables, betting advice disclaimers, or phrases like 'lock' or 'sure thing'."
                ].join(" ")
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `With these considerations, generate an explanation as to why this is the model's preferred pick in today's game:\n${JSON.stringify(buildExplanationData(pick), null, 2)}`
              }
            ]
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return pick.explanation;
    }

    const text = openAiOutputText(await response.json());
    return text && text.length <= 1200 ? text : pick.explanation;
  } catch {
    return pick.explanation;
  } finally {
    clearTimeout(timeout);
  }
};

const enrichPublishedExplanations = async (published: PublishedAiPick[]) => {
  if (!config.openAiApiKey || published.length === 0) {
    return published;
  }

  const enriched: PublishedAiPick[] = [];
  for (const pick of published) {
    const explanation = await generateOpenAiExplanation(pick);
    if (explanation !== pick.explanation) {
      await query("UPDATE ai_pick SET explanation = $1 WHERE id = $2", [explanation, pick.id]);
    }
    enriched.push({ ...pick, explanation });
  }
  return enriched;
};

const storedSideContext = (stored: MlbStoredContext | null | undefined, side: "away" | "home") => {
  if (!stored) {
    return {
      pitcher: {},
      bullpen: {},
      injuries: {}
    } as {
      pitcher: Record<string, unknown>;
      bullpen: Record<string, unknown>;
      injuries: Record<string, unknown>;
    };
  }

  return side === "away"
    ? { pitcher: stored.away_pitcher_stats ?? {}, bullpen: stored.away_bullpen ?? {}, injuries: stored.away_injuries ?? {} }
    : { pitcher: stored.home_pitcher_stats ?? {}, bullpen: stored.home_bullpen ?? {}, injuries: stored.home_injuries ?? {} };
};

const storedHitterSplits = (stored: MlbStoredContext | null | undefined, side: "away" | "home") => {
  const key = side === "away" ? "awayHitterSplits" : "homeHitterSplits";
  const value = stored?.context?.[key];
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
};

const storedLineup = (stored: MlbStoredContext | null | undefined, side: "away" | "home") => {
  const key = side === "away" ? "awayLineup" : "homeLineup";
  const value = stored?.context?.[key];
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
};

const lineupSummary = (lineup: Record<string, unknown>) => {
  const players = Array.isArray(lineup.players) ? lineup.players as Array<Record<string, unknown>> : [];
  const averages = players
    .map((player) => numericFeature(player.avg))
    .filter((value): value is number => value !== null);
  return {
    confirmed: lineup.confirmed === true,
    avg: averages.length ? averages.reduce((sum, value) => sum + value, 0) / averages.length : null,
    homeRuns: players.reduce((sum, player) => sum + (numericFeature(player.homeRuns) ?? 0), 0),
    rbi: players.reduce((sum, player) => sum + (numericFeature(player.rbi) ?? 0), 0)
  };
};

const contextFromStored = (
  base: Omit<
    MlbHeuristicContext,
    | "probablePitcherKnown"
    | "bullpenDataKnown"
    | "injuryDataKnown"
    | "selectedStarterEra"
    | "opponentStarterEra"
    | "starterEraDiff"
    | "selectedStarterAdjustedEra"
    | "opponentStarterAdjustedEra"
    | "starterAdjustedEraDiff"
    | "selectedStarterWhip"
    | "opponentStarterWhip"
    | "starterWhipDiff"
    | "selectedStarterHomeRunsPer9"
    | "opponentStarterHomeRunsPer9"
    | "starterHomeRunsPer9Diff"
    | "selectedStarterStrikeoutsPer9"
    | "opponentStarterStrikeoutsPer9"
    | "starterStrikeoutsPer9Diff"
    | "selectedStarterWalksPer9"
    | "opponentStarterWalksPer9"
    | "starterWalksPer9Diff"
    | "selectedStarterKbb"
    | "opponentStarterKbb"
    | "starterKbbDiff"
    | "selectedStarterRecentEra"
    | "opponentStarterRecentEra"
    | "starterRecentEraDiff"
    | "selectedStarterRecentKbb"
    | "opponentStarterRecentKbb"
    | "starterRecentKbbDiff"
    | "selectedStarterRecentPitches"
    | "opponentStarterRecentPitches"
    | "starterRecentPitchesDiff"
    | "selectedHitterOpsVsPitchHand"
    | "opponentHitterOpsVsPitchHand"
    | "hitterOpsVsPitchHandDiff"
    | "selectedHitterObpVsPitchHand"
    | "opponentHitterObpVsPitchHand"
    | "hitterObpVsPitchHandDiff"
    | "selectedHitterSlgVsPitchHand"
    | "opponentHitterSlgVsPitchHand"
    | "hitterSlgVsPitchHandDiff"
    | "selectedOppositeHandBatters"
    | "opponentOppositeHandBatters"
    | "oppositeHandBattersDiff"
    | "selectedLineupConfirmed"
    | "opponentLineupConfirmed"
    | "selectedLineupAvg"
    | "opponentLineupAvg"
    | "lineupAvgDiff"
    | "selectedLineupHomeRuns"
    | "opponentLineupHomeRuns"
    | "lineupHomeRunsDiff"
    | "selectedLineupRbi"
    | "opponentLineupRbi"
    | "lineupRbiDiff"
    | "selectedBullpenPitchesLast3"
    | "opponentBullpenPitchesLast3"
    | "bullpenPitchesLast3Diff"
    | "selectedBullpenPitchesLast1"
    | "opponentBullpenPitchesLast1"
    | "bullpenPitchesLast1Diff"
    | "selectedBullpenEraLast3"
    | "opponentBullpenEraLast3"
    | "bullpenEraLast3Diff"
    | "selectedBullpenWhipLast3"
    | "opponentBullpenWhipLast3"
    | "bullpenWhipLast3Diff"
    | "selectedBullpenKbbLast3"
    | "opponentBullpenKbbLast3"
    | "bullpenKbbLast3Diff"
    | "selectedActiveIlPlayers"
    | "opponentActiveIlPlayers"
    | "activeIlPlayersDiff"
    | "selectedActiveIlPitchers"
    | "opponentActiveIlPitchers"
    | "activeIlPitchersDiff"
    | "openingOddsAmerican"
    | "previousOddsAmerican"
    | "lineMovementAmerican"
    | "lineMovementImplied"
    | "lineSnapshotCount"
  >,
  stored: MlbStoredContext | null | undefined,
  selectedSide: "away" | "home",
  movement: MarketMovementContext | null = null
): MlbHeuristicContext => {
  const opponentSide = selectedSide === "away" ? "home" : "away";
  const selected = storedSideContext(stored, selectedSide);
  const opponent = storedSideContext(stored, opponentSide);
  const selectedHitters = storedHitterSplits(stored, selectedSide);
  const opponentHitters = storedHitterSplits(stored, opponentSide);
  const selectedLineup = lineupSummary(storedLineup(stored, selectedSide));
  const opponentLineup = lineupSummary(storedLineup(stored, opponentSide));
  const selectedHitterOpsVsPitchHand = numericFeature(selectedHitters.averageOpsVsPitchHand);
  const opponentHitterOpsVsPitchHand = numericFeature(opponentHitters.averageOpsVsPitchHand);
  const selectedHitterObpVsPitchHand = numericFeature(selectedHitters.averageObpVsPitchHand);
  const opponentHitterObpVsPitchHand = numericFeature(opponentHitters.averageObpVsPitchHand);
  const selectedHitterSlgVsPitchHand = numericFeature(selectedHitters.averageSlgVsPitchHand);
  const opponentHitterSlgVsPitchHand = numericFeature(opponentHitters.averageSlgVsPitchHand);
  const selectedOppositeHandBatters = numericFeature(selectedHitters.oppositeHandBatters);
  const opponentOppositeHandBatters = numericFeature(opponentHitters.oppositeHandBatters);
  const selectedStarterEra = nestedNumber(selected.pitcher, ["season", "era"]);
  const opponentStarterEra = nestedNumber(opponent.pitcher, ["season", "era"]);
  const selectedStarterAdjustedEra = nestedNumber(selected.pitcher, ["season", "adjustedEraExcludingWorstOlderStart"]);
  const opponentStarterAdjustedEra = nestedNumber(opponent.pitcher, ["season", "adjustedEraExcludingWorstOlderStart"]);
  const selectedStarterWhip = nestedNumber(selected.pitcher, ["season", "whip"]);
  const opponentStarterWhip = nestedNumber(opponent.pitcher, ["season", "whip"]);
  const selectedStarterHomeRunsPer9 = nestedNumber(selected.pitcher, ["season", "homeRunsPer9"]);
  const opponentStarterHomeRunsPer9 = nestedNumber(opponent.pitcher, ["season", "homeRunsPer9"]);
  const selectedStarterStrikeoutsPer9 = nestedNumber(selected.pitcher, ["season", "strikeoutsPer9"]);
  const opponentStarterStrikeoutsPer9 = nestedNumber(opponent.pitcher, ["season", "strikeoutsPer9"]);
  const selectedStarterWalksPer9 = nestedNumber(selected.pitcher, ["season", "walksPer9"]);
  const opponentStarterWalksPer9 = nestedNumber(opponent.pitcher, ["season", "walksPer9"]);
  const selectedStarterKbb = nestedNumber(selected.pitcher, ["season", "strikeoutWalkRatio"]);
  const opponentStarterKbb = nestedNumber(opponent.pitcher, ["season", "strikeoutWalkRatio"]);
  const selectedStarterRecentEra = nestedNumber(selected.pitcher, ["recent", "era"]);
  const opponentStarterRecentEra = nestedNumber(opponent.pitcher, ["recent", "era"]);
  const selectedStarterRecentKbb = nestedNumber(selected.pitcher, ["recent", "strikeoutWalkRatio"]);
  const opponentStarterRecentKbb = nestedNumber(opponent.pitcher, ["recent", "strikeoutWalkRatio"]);
  const selectedStarterRecentPitches = nestedNumber(selected.pitcher, ["recent", "pitches"]);
  const opponentStarterRecentPitches = nestedNumber(opponent.pitcher, ["recent", "pitches"]);
  const selectedBullpenPitchesLast3 = numericFeature(selected.bullpen.pitchesLast3);
  const opponentBullpenPitchesLast3 = numericFeature(opponent.bullpen.pitchesLast3);
  const selectedBullpenPitchesLast1 = numericFeature(selected.bullpen.pitchesLast1);
  const opponentBullpenPitchesLast1 = numericFeature(opponent.bullpen.pitchesLast1);
  const selectedBullpenEraLast3 = numericFeature(selected.bullpen.eraLast3);
  const opponentBullpenEraLast3 = numericFeature(opponent.bullpen.eraLast3);
  const selectedBullpenWhipLast3 = numericFeature(selected.bullpen.whipLast3);
  const opponentBullpenWhipLast3 = numericFeature(opponent.bullpen.whipLast3);
  const selectedBullpenKbbLast3 = ratioOrNull(
    numericFeature(selected.bullpen.strikeoutsLast3),
    numericFeature(selected.bullpen.walksLast3)
  );
  const opponentBullpenKbbLast3 = ratioOrNull(
    numericFeature(opponent.bullpen.strikeoutsLast3),
    numericFeature(opponent.bullpen.walksLast3)
  );
  const selectedActiveIlPlayers = numericFeature(selected.injuries.activeIlPlayers);
  const opponentActiveIlPlayers = numericFeature(opponent.injuries.activeIlPlayers);
  const selectedActiveIlPitchers = numericFeature(selected.injuries.activeIlPitchers);
  const opponentActiveIlPitchers = numericFeature(opponent.injuries.activeIlPitchers);

  return {
    ...base,
    probablePitcherKnown: Boolean(stored?.context?.probablePitcherKnown),
    bullpenDataKnown: Boolean(stored?.context?.bullpenDataKnown),
    injuryDataKnown: Boolean(stored?.context?.injuryDataKnown),
    selectedHitterOpsVsPitchHand,
    opponentHitterOpsVsPitchHand,
    hitterOpsVsPitchHandDiff: diffOrNull(selectedHitterOpsVsPitchHand, opponentHitterOpsVsPitchHand),
    selectedHitterObpVsPitchHand,
    opponentHitterObpVsPitchHand,
    hitterObpVsPitchHandDiff: diffOrNull(selectedHitterObpVsPitchHand, opponentHitterObpVsPitchHand),
    selectedHitterSlgVsPitchHand,
    opponentHitterSlgVsPitchHand,
    hitterSlgVsPitchHandDiff: diffOrNull(selectedHitterSlgVsPitchHand, opponentHitterSlgVsPitchHand),
    selectedOppositeHandBatters,
    opponentOppositeHandBatters,
    oppositeHandBattersDiff: diffOrNull(selectedOppositeHandBatters, opponentOppositeHandBatters),
    selectedLineupConfirmed: selectedLineup.confirmed,
    opponentLineupConfirmed: opponentLineup.confirmed,
    selectedLineupAvg: selectedLineup.avg,
    opponentLineupAvg: opponentLineup.avg,
    lineupAvgDiff: diffOrNull(selectedLineup.avg, opponentLineup.avg),
    selectedLineupHomeRuns: selectedLineup.homeRuns,
    opponentLineupHomeRuns: opponentLineup.homeRuns,
    lineupHomeRunsDiff: diffOrNull(selectedLineup.homeRuns, opponentLineup.homeRuns),
    selectedLineupRbi: selectedLineup.rbi,
    opponentLineupRbi: opponentLineup.rbi,
    lineupRbiDiff: diffOrNull(selectedLineup.rbi, opponentLineup.rbi),
    selectedStarterEra,
    opponentStarterEra,
    starterEraDiff: diffOrNull(selectedStarterEra, opponentStarterEra),
    selectedStarterAdjustedEra,
    opponentStarterAdjustedEra,
    starterAdjustedEraDiff: diffOrNull(selectedStarterAdjustedEra, opponentStarterAdjustedEra),
    selectedStarterWhip,
    opponentStarterWhip,
    starterWhipDiff: diffOrNull(selectedStarterWhip, opponentStarterWhip),
    selectedStarterHomeRunsPer9,
    opponentStarterHomeRunsPer9,
    starterHomeRunsPer9Diff: diffOrNull(selectedStarterHomeRunsPer9, opponentStarterHomeRunsPer9),
    selectedStarterStrikeoutsPer9,
    opponentStarterStrikeoutsPer9,
    starterStrikeoutsPer9Diff: diffOrNull(selectedStarterStrikeoutsPer9, opponentStarterStrikeoutsPer9),
    selectedStarterWalksPer9,
    opponentStarterWalksPer9,
    starterWalksPer9Diff: diffOrNull(selectedStarterWalksPer9, opponentStarterWalksPer9),
    selectedStarterKbb,
    opponentStarterKbb,
    starterKbbDiff: diffOrNull(selectedStarterKbb, opponentStarterKbb),
    selectedStarterRecentEra,
    opponentStarterRecentEra,
    starterRecentEraDiff: diffOrNull(selectedStarterRecentEra, opponentStarterRecentEra),
    selectedStarterRecentKbb,
    opponentStarterRecentKbb,
    starterRecentKbbDiff: diffOrNull(selectedStarterRecentKbb, opponentStarterRecentKbb),
    selectedStarterRecentPitches,
    opponentStarterRecentPitches,
    starterRecentPitchesDiff: diffOrNull(selectedStarterRecentPitches, opponentStarterRecentPitches),
    selectedBullpenPitchesLast3,
    opponentBullpenPitchesLast3,
    bullpenPitchesLast3Diff: diffOrNull(selectedBullpenPitchesLast3, opponentBullpenPitchesLast3),
    selectedBullpenPitchesLast1,
    opponentBullpenPitchesLast1,
    bullpenPitchesLast1Diff: diffOrNull(selectedBullpenPitchesLast1, opponentBullpenPitchesLast1),
    selectedBullpenEraLast3,
    opponentBullpenEraLast3,
    bullpenEraLast3Diff: diffOrNull(selectedBullpenEraLast3, opponentBullpenEraLast3),
    selectedBullpenWhipLast3,
    opponentBullpenWhipLast3,
    bullpenWhipLast3Diff: diffOrNull(selectedBullpenWhipLast3, opponentBullpenWhipLast3),
    selectedBullpenKbbLast3,
    opponentBullpenKbbLast3,
    bullpenKbbLast3Diff: diffOrNull(selectedBullpenKbbLast3, opponentBullpenKbbLast3),
    selectedActiveIlPlayers,
    opponentActiveIlPlayers,
    activeIlPlayersDiff: diffOrNull(selectedActiveIlPlayers, opponentActiveIlPlayers),
    selectedActiveIlPitchers,
    opponentActiveIlPitchers,
    activeIlPitchersDiff: diffOrNull(selectedActiveIlPitchers, opponentActiveIlPitchers),
    openingOddsAmerican: movement?.openingOddsAmerican ?? null,
    previousOddsAmerican: movement?.previousOddsAmerican ?? null,
    lineMovementAmerican: movement?.lineMovementAmerican ?? null,
    lineMovementImplied: movement?.lineMovementImplied ?? null,
    lineSnapshotCount: movement?.lineSnapshotCount ?? null
  };
};

const movementKey = (line: Pick<CandidateLine, "starts_at" | "away_team" | "home_team" | "market_key" | "selected_team">) =>
  `${line.starts_at.toISOString()}:${line.away_team}:${line.home_team}:${line.market_key}:${line.selected_team}`;

const buildMarketMovements = async (client: pg.PoolClient, lines: CandidateLine[]) => {
  if (!lines.length) {
    return new Map<string, MarketMovementContext>();
  }

  const start = new Date(Math.min(...lines.map((line) => line.starts_at.getTime())));
  start.setUTCDate(start.getUTCDate() - 3);
  const end = new Date(Math.max(...lines.map((line) => line.starts_at.getTime())));
  end.setUTCDate(end.getUTCDate() + 1);
  const teams = [...new Set(lines.flatMap((line) => [line.away_team, line.home_team]))];

  const snapshots = await client.query<{
    starts_at: Date;
    away_team: string;
    home_team: string;
    market_key: "h2h" | "spreads";
    selected_team: string;
    captured_at: Date;
    odds_american: number;
  }>(
    `
      SELECT starts_at, away_team, home_team, market_key, selected_team, captured_at, odds_american
      FROM ai_candidate_snapshot
      WHERE sport = 'MLB'
        AND starts_at BETWEEN $1 AND $2
        AND (away_team = ANY($3::text[]) OR home_team = ANY($3::text[]))
      ORDER BY captured_at ASC
    `,
    [start, end, teams]
  );

  const byKey = new Map<string, typeof snapshots.rows>();
  for (const row of snapshots.rows) {
    const key = movementKey(row);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }

  const movements = new Map<string, MarketMovementContext>();
  for (const line of lines) {
    const rows = byKey.get(movementKey(line)) ?? [];
    if (!rows.length) {
      movements.set(line.id, {
        openingOddsAmerican: null,
        previousOddsAmerican: null,
        lineMovementAmerican: null,
        lineMovementImplied: null,
        lineSnapshotCount: 0
      });
      continue;
    }

    const opening = rows[0];
    const previous = [...rows].reverse().find((row) => row.odds_american !== line.odds_american) ?? rows.at(-1)!;
    movements.set(line.id, {
      openingOddsAmerican: opening.odds_american,
      previousOddsAmerican: previous.odds_american,
      lineMovementAmerican: line.odds_american - opening.odds_american,
      lineMovementImplied: impliedProbability(line.odds_american) - impliedProbability(opening.odds_american),
      lineSnapshotCount: rows.length
    });
  }

  return movements;
};

export const scoreLine = (
  line: CandidateLine,
  eventMarketCounts: Map<string, number>,
  context: MlbHeuristicContext | null = null
): ScoredCandidate => {
  const implied = impliedProbability(line.odds_american);
  const isHome = line.selected_team === line.home_team;
  const isFavorite = line.odds_american < 0;
  const isMoneyline = line.market_key === "h2h";
  const spreadValue = Number(line.spread);
  const marketCompleteness = eventMarketCounts.get(eventKey(line)) ?? 1;

  let fair = implied;
  const reasons: string[] = [];

  if (isHome) {
    fair += 0.018;
    reasons.push("Small home-field bump");
  } else {
    fair -= 0.006;
    reasons.push("Road-team penalty");
  }

  if (isMoneyline && !isFavorite && line.odds_american <= 180) {
    fair += 0.014;
    reasons.push("Playable underdog price");
  }

  if (isMoneyline && isFavorite && line.odds_american >= -145) {
    fair += 0.01;
    reasons.push("Favorite price not overly expensive");
  }

  if (!isMoneyline && Math.abs(spreadValue) <= 1.5) {
    fair += 0.006;
    reasons.push("Standard baseball runline");
  }

  if (marketCompleteness > 1) {
    fair += 0.004;
    reasons.push("Multiple complete markets available for game");
  }

  if (context) {
    if ((context.winPctDiff7 ?? 0) >= 0.15) {
      fair += 0.006;
      reasons.push("Recent win-form edge");
    } else if ((context.winPctDiff7 ?? 0) <= -0.15) {
      fair -= 0.004;
      reasons.push("Recent win-form concern");
    }

    if ((context.runDiffPerGameDiff14 ?? 0) >= 1) {
      fair += 0.008;
      reasons.push("Two-week run-differential edge");
    } else if ((context.runDiffPerGameDiff14 ?? 0) <= -1) {
      fair -= 0.008;
      reasons.push("Two-week run-differential concern");
    }

    if ((context.runsForPerGameDiff7 ?? 0) >= 1) {
      fair += 0.004;
      reasons.push("Recent offense edge");
    } else if ((context.runsForPerGameDiff7 ?? 0) <= -1) {
      fair -= 0.004;
      reasons.push("Recent offense concern");
    }

    if ((context.runsForPerGameDiff14 ?? 0) >= 0.75) {
      fair += 0.003;
      reasons.push("Two-week offense edge");
    } else if ((context.runsForPerGameDiff14 ?? 0) <= -0.75) {
      fair -= 0.003;
      reasons.push("Two-week offense concern");
    }

    if ((context.runsAgainstPerGameDiff7 ?? 0) <= -1) {
      fair += 0.004;
      reasons.push("Recent run-prevention edge");
    } else if ((context.runsAgainstPerGameDiff7 ?? 0) >= 1) {
      fair -= 0.004;
      reasons.push("Recent run-prevention concern");
    }

    if ((context.runsAgainstPerGameDiff14 ?? 0) <= -0.75) {
      fair += 0.003;
      reasons.push("Two-week run-prevention edge");
    } else if ((context.runsAgainstPerGameDiff14 ?? 0) >= 0.75) {
      fair -= 0.003;
      reasons.push("Two-week run-prevention concern");
    }

    if ((context.hitterOpsVsPitchHandDiff ?? 0) >= 0.05) {
      fair += 0.004;
      reasons.push("Hitter split OPS edge vs pitcher hand");
    } else if ((context.hitterOpsVsPitchHandDiff ?? 0) <= -0.05) {
      fair -= 0.004;
      reasons.push("Hitter split OPS concern vs pitcher hand");
    }

    if ((context.hitterObpVsPitchHandDiff ?? 0) >= 0.025) {
      fair += 0.002;
      reasons.push("Hitter split OBP edge vs pitcher hand");
    } else if ((context.hitterObpVsPitchHandDiff ?? 0) <= -0.025) {
      fair -= 0.002;
      reasons.push("Hitter split OBP concern vs pitcher hand");
    }

    if ((context.oppositeHandBattersDiff ?? 0) >= 2) {
      fair += 0.001;
      reasons.push("Platoon-count edge");
    } else if ((context.oppositeHandBattersDiff ?? 0) <= -2) {
      fair -= 0.001;
      reasons.push("Platoon-count concern");
    }

    if (context.selectedLineupConfirmed && context.opponentLineupConfirmed) {
      if ((context.lineupAvgDiff ?? 0) >= 0.015) {
        fair += 0.002;
        reasons.push("Confirmed lineup batting-average edge");
      } else if ((context.lineupAvgDiff ?? 0) <= -0.015) {
        fair -= 0.002;
        reasons.push("Confirmed lineup batting-average concern");
      }

      if ((context.lineupHomeRunsDiff ?? 0) >= 20) {
        fair += 0.002;
        reasons.push("Confirmed lineup power edge");
      } else if ((context.lineupHomeRunsDiff ?? 0) <= -20) {
        fair -= 0.002;
        reasons.push("Confirmed lineup power concern");
      }
    }

    if ((context.venueWinPctDiff ?? 0) >= 0.15) {
      fair += 0.004;
      reasons.push("Home/road split edge");
    } else if ((context.venueWinPctDiff ?? 0) <= -0.15) {
      fair -= 0.004;
      reasons.push("Home/road split concern");
    }

    if ((context.venueRunDiffPerGameDiff ?? 0) >= 1) {
      fair += 0.004;
      reasons.push("Venue run-differential edge");
    } else if ((context.venueRunDiffPerGameDiff ?? 0) <= -1) {
      fair -= 0.004;
      reasons.push("Venue run-differential concern");
    }

    if ((context.restDaysDiff ?? 0) >= 1) {
      fair += 0.003;
      reasons.push("Rest advantage");
    } else if ((context.restDaysDiff ?? 0) <= -1) {
      fair -= 0.003;
      reasons.push("Rest disadvantage");
    }

    if (context.selectedVenueChanged && !context.opponentVenueChanged) {
      fair -= 0.002;
      reasons.push("Travel/venue change disadvantage");
    }

    if ((context.starterEraDiff ?? 0) <= -0.75) {
      fair += 0.005;
      reasons.push("Starting pitcher ERA edge");
    } else if ((context.starterEraDiff ?? 0) >= 0.75) {
      fair -= 0.005;
      reasons.push("Starting pitcher ERA concern");
    }

    if ((context.starterAdjustedEraDiff ?? 0) <= -0.75) {
      fair += 0.003;
      reasons.push("Adjusted starting pitcher ERA edge");
    } else if ((context.starterAdjustedEraDiff ?? 0) >= 0.75) {
      fair -= 0.003;
      reasons.push("Adjusted starting pitcher ERA concern");
    }

    if ((context.starterWhipDiff ?? 0) <= -0.15) {
      fair += 0.003;
      reasons.push("Starting pitcher traffic edge");
    } else if ((context.starterWhipDiff ?? 0) >= 0.15) {
      fair -= 0.003;
      reasons.push("Starting pitcher traffic concern");
    }

    if ((context.starterHomeRunsPer9Diff ?? 0) <= -0.3) {
      fair += 0.002;
      reasons.push("Starting pitcher home-run suppression edge");
    } else if ((context.starterHomeRunsPer9Diff ?? 0) >= 0.3) {
      fair -= 0.002;
      reasons.push("Starting pitcher home-run concern");
    }

    if ((context.starterStrikeoutsPer9Diff ?? 0) >= 1) {
      fair += 0.003;
      reasons.push("Starting pitcher strikeout edge");
    } else if ((context.starterStrikeoutsPer9Diff ?? 0) <= -1) {
      fair -= 0.003;
      reasons.push("Starting pitcher strikeout concern");
    }

    if ((context.starterWalksPer9Diff ?? 0) <= -0.5) {
      fair += 0.002;
      reasons.push("Starting pitcher walk-rate edge");
    } else if ((context.starterWalksPer9Diff ?? 0) >= 0.5) {
      fair -= 0.002;
      reasons.push("Starting pitcher walk-rate concern");
    }

    if ((context.starterKbbDiff ?? 0) >= 1) {
      fair += 0.004;
      reasons.push("Starting pitcher command edge");
    } else if ((context.starterKbbDiff ?? 0) <= -1) {
      fair -= 0.004;
      reasons.push("Starting pitcher command concern");
    }

    if ((context.starterRecentEraDiff ?? 0) <= -0.75) {
      fair += 0.003;
      reasons.push("Recent starting pitcher ERA edge");
    } else if ((context.starterRecentEraDiff ?? 0) >= 0.75) {
      fair -= 0.003;
      reasons.push("Recent starting pitcher ERA concern");
    }

    if ((context.starterRecentKbbDiff ?? 0) >= 1) {
      fair += 0.003;
      reasons.push("Recent starting pitcher command edge");
    } else if ((context.starterRecentKbbDiff ?? 0) <= -1) {
      fair -= 0.003;
      reasons.push("Recent starting pitcher command concern");
    }

    if ((context.starterRecentPitchesDiff ?? 0) <= -35) {
      fair += 0.002;
      reasons.push("Recent starter workload edge");
    } else if ((context.starterRecentPitchesDiff ?? 0) >= 35) {
      fair -= 0.002;
      reasons.push("Recent starter workload concern");
    }

    if ((context.bullpenPitchesLast3Diff ?? 0) <= -45) {
      fair += 0.003;
      reasons.push("Bullpen freshness edge");
    } else if ((context.bullpenPitchesLast3Diff ?? 0) >= 45) {
      fair -= 0.003;
      reasons.push("Bullpen workload concern");
    }

    if ((context.bullpenEraLast3Diff ?? 0) <= -1) {
      fair += 0.003;
      reasons.push("Recent bullpen ERA edge");
    } else if ((context.bullpenEraLast3Diff ?? 0) >= 1) {
      fair -= 0.003;
      reasons.push("Recent bullpen ERA concern");
    }

    if ((context.bullpenPitchesLast1Diff ?? 0) <= -25) {
      fair += 0.002;
      reasons.push("Yesterday bullpen workload edge");
    } else if ((context.bullpenPitchesLast1Diff ?? 0) >= 25) {
      fair -= 0.002;
      reasons.push("Yesterday bullpen workload concern");
    }

    if ((context.bullpenWhipLast3Diff ?? 0) <= -0.2) {
      fair += 0.003;
      reasons.push("Recent bullpen traffic edge");
    } else if ((context.bullpenWhipLast3Diff ?? 0) >= 0.2) {
      fair -= 0.003;
      reasons.push("Recent bullpen traffic concern");
    }

    if ((context.bullpenKbbLast3Diff ?? 0) >= 1) {
      fair += 0.002;
      reasons.push("Recent bullpen command edge");
    } else if ((context.bullpenKbbLast3Diff ?? 0) <= -1) {
      fair -= 0.002;
      reasons.push("Recent bullpen command concern");
    }

    if ((context.activeIlPitchersDiff ?? 0) <= -2) {
      fair += 0.002;
      reasons.push("Pitching injury availability edge");
    } else if ((context.activeIlPitchersDiff ?? 0) >= 2) {
      fair -= 0.002;
      reasons.push("Pitching injury availability concern");
    }

    if ((context.lineSnapshotCount ?? 0) >= 2) {
      if ((context.lineMovementImplied ?? 0) >= 0.02) {
        fair += 0.003;
        reasons.push("Market movement toward pick");
      } else if ((context.lineMovementImplied ?? 0) <= -0.02) {
        fair -= 0.003;
        reasons.push("Market movement against pick");
      }
    }
  }

  fair = clamp(fair, 0.02, 0.92);
  const edge = fair - implied;
  const confidence = clamp(0.45 + edge * 4, 0.1, 0.82);
  const score = edge * 100 + confidence * 10;

  return {
    ...line,
    score,
    confidence,
    impliedProbability: implied,
    fairProbability: fair,
    edge,
    features: {
      impliedProbability: implied,
      fairProbability: fair,
      edge,
      isHome,
      isFavorite,
      isMoneyline,
      spread: spreadValue,
      marketCompleteness,
      decimalOdds: americanToDecimal(line.odds_american),
      winPctDiff7: context?.winPctDiff7 ?? null,
      runDiffPerGameDiff7: context?.runDiffPerGameDiff7 ?? null,
      winPctDiff14: context?.winPctDiff14 ?? null,
      runDiffPerGameDiff14: context?.runDiffPerGameDiff14 ?? null,
      selectedRunsForPerGame7: context?.selectedRunsForPerGame7 ?? null,
      opponentRunsForPerGame7: context?.opponentRunsForPerGame7 ?? null,
      runsForPerGameDiff7: context?.runsForPerGameDiff7 ?? null,
      selectedRunsForPerGame14: context?.selectedRunsForPerGame14 ?? null,
      opponentRunsForPerGame14: context?.opponentRunsForPerGame14 ?? null,
      runsForPerGameDiff14: context?.runsForPerGameDiff14 ?? null,
      selectedRunsAgainstPerGame7: context?.selectedRunsAgainstPerGame7 ?? null,
      opponentRunsAgainstPerGame7: context?.opponentRunsAgainstPerGame7 ?? null,
      runsAgainstPerGameDiff7: context?.runsAgainstPerGameDiff7 ?? null,
      selectedRunsAgainstPerGame14: context?.selectedRunsAgainstPerGame14 ?? null,
      opponentRunsAgainstPerGame14: context?.opponentRunsAgainstPerGame14 ?? null,
      runsAgainstPerGameDiff14: context?.runsAgainstPerGameDiff14 ?? null,
      selectedHitterOpsVsPitchHand: context?.selectedHitterOpsVsPitchHand ?? null,
      opponentHitterOpsVsPitchHand: context?.opponentHitterOpsVsPitchHand ?? null,
      hitterOpsVsPitchHandDiff: context?.hitterOpsVsPitchHandDiff ?? null,
      selectedHitterObpVsPitchHand: context?.selectedHitterObpVsPitchHand ?? null,
      opponentHitterObpVsPitchHand: context?.opponentHitterObpVsPitchHand ?? null,
      hitterObpVsPitchHandDiff: context?.hitterObpVsPitchHandDiff ?? null,
      selectedHitterSlgVsPitchHand: context?.selectedHitterSlgVsPitchHand ?? null,
      opponentHitterSlgVsPitchHand: context?.opponentHitterSlgVsPitchHand ?? null,
      hitterSlgVsPitchHandDiff: context?.hitterSlgVsPitchHandDiff ?? null,
      selectedOppositeHandBatters: context?.selectedOppositeHandBatters ?? null,
      opponentOppositeHandBatters: context?.opponentOppositeHandBatters ?? null,
      oppositeHandBattersDiff: context?.oppositeHandBattersDiff ?? null,
      selectedLineupConfirmed: context?.selectedLineupConfirmed ?? null,
      opponentLineupConfirmed: context?.opponentLineupConfirmed ?? null,
      selectedLineupAvg: context?.selectedLineupAvg ?? null,
      opponentLineupAvg: context?.opponentLineupAvg ?? null,
      lineupAvgDiff: context?.lineupAvgDiff ?? null,
      selectedLineupHomeRuns: context?.selectedLineupHomeRuns ?? null,
      opponentLineupHomeRuns: context?.opponentLineupHomeRuns ?? null,
      lineupHomeRunsDiff: context?.lineupHomeRunsDiff ?? null,
      selectedLineupRbi: context?.selectedLineupRbi ?? null,
      opponentLineupRbi: context?.opponentLineupRbi ?? null,
      lineupRbiDiff: context?.lineupRbiDiff ?? null,
      selectedVenueWinPct: context?.selectedVenueWinPct ?? null,
      opponentVenueWinPct: context?.opponentVenueWinPct ?? null,
      venueWinPctDiff: context?.venueWinPctDiff ?? null,
      selectedVenueRunDiffPerGame: context?.selectedVenueRunDiffPerGame ?? null,
      opponentVenueRunDiffPerGame: context?.opponentVenueRunDiffPerGame ?? null,
      venueRunDiffPerGameDiff: context?.venueRunDiffPerGameDiff ?? null,
      selectedRestDays: context?.selectedRestDays ?? null,
      opponentRestDays: context?.opponentRestDays ?? null,
      restDaysDiff: context?.restDaysDiff ?? null,
      selectedVenueChanged: context?.selectedVenueChanged ?? null,
      opponentVenueChanged: context?.opponentVenueChanged ?? null,
      probablePitcherKnown: context?.probablePitcherKnown ?? false,
      bullpenDataKnown: context?.bullpenDataKnown ?? false,
      injuryDataKnown: context?.injuryDataKnown ?? false,
      selectedStarterEra: context?.selectedStarterEra ?? null,
      opponentStarterEra: context?.opponentStarterEra ?? null,
      starterEraDiff: context?.starterEraDiff ?? null,
      selectedStarterAdjustedEra: context?.selectedStarterAdjustedEra ?? null,
      opponentStarterAdjustedEra: context?.opponentStarterAdjustedEra ?? null,
      starterAdjustedEraDiff: context?.starterAdjustedEraDiff ?? null,
      selectedStarterWhip: context?.selectedStarterWhip ?? null,
      opponentStarterWhip: context?.opponentStarterWhip ?? null,
      starterWhipDiff: context?.starterWhipDiff ?? null,
      selectedStarterHomeRunsPer9: context?.selectedStarterHomeRunsPer9 ?? null,
      opponentStarterHomeRunsPer9: context?.opponentStarterHomeRunsPer9 ?? null,
      starterHomeRunsPer9Diff: context?.starterHomeRunsPer9Diff ?? null,
      selectedStarterStrikeoutsPer9: context?.selectedStarterStrikeoutsPer9 ?? null,
      opponentStarterStrikeoutsPer9: context?.opponentStarterStrikeoutsPer9 ?? null,
      starterStrikeoutsPer9Diff: context?.starterStrikeoutsPer9Diff ?? null,
      selectedStarterWalksPer9: context?.selectedStarterWalksPer9 ?? null,
      opponentStarterWalksPer9: context?.opponentStarterWalksPer9 ?? null,
      starterWalksPer9Diff: context?.starterWalksPer9Diff ?? null,
      selectedStarterKbb: context?.selectedStarterKbb ?? null,
      opponentStarterKbb: context?.opponentStarterKbb ?? null,
      starterKbbDiff: context?.starterKbbDiff ?? null,
      selectedStarterRecentEra: context?.selectedStarterRecentEra ?? null,
      opponentStarterRecentEra: context?.opponentStarterRecentEra ?? null,
      starterRecentEraDiff: context?.starterRecentEraDiff ?? null,
      selectedStarterRecentKbb: context?.selectedStarterRecentKbb ?? null,
      opponentStarterRecentKbb: context?.opponentStarterRecentKbb ?? null,
      starterRecentKbbDiff: context?.starterRecentKbbDiff ?? null,
      selectedStarterRecentPitches: context?.selectedStarterRecentPitches ?? null,
      opponentStarterRecentPitches: context?.opponentStarterRecentPitches ?? null,
      starterRecentPitchesDiff: context?.starterRecentPitchesDiff ?? null,
      selectedBullpenPitchesLast3: context?.selectedBullpenPitchesLast3 ?? null,
      opponentBullpenPitchesLast3: context?.opponentBullpenPitchesLast3 ?? null,
      bullpenPitchesLast3Diff: context?.bullpenPitchesLast3Diff ?? null,
      selectedBullpenPitchesLast1: context?.selectedBullpenPitchesLast1 ?? null,
      opponentBullpenPitchesLast1: context?.opponentBullpenPitchesLast1 ?? null,
      bullpenPitchesLast1Diff: context?.bullpenPitchesLast1Diff ?? null,
      selectedBullpenEraLast3: context?.selectedBullpenEraLast3 ?? null,
      opponentBullpenEraLast3: context?.opponentBullpenEraLast3 ?? null,
      bullpenEraLast3Diff: context?.bullpenEraLast3Diff ?? null,
      selectedBullpenWhipLast3: context?.selectedBullpenWhipLast3 ?? null,
      opponentBullpenWhipLast3: context?.opponentBullpenWhipLast3 ?? null,
      bullpenWhipLast3Diff: context?.bullpenWhipLast3Diff ?? null,
      selectedBullpenKbbLast3: context?.selectedBullpenKbbLast3 ?? null,
      opponentBullpenKbbLast3: context?.opponentBullpenKbbLast3 ?? null,
      bullpenKbbLast3Diff: context?.bullpenKbbLast3Diff ?? null,
      selectedActiveIlPlayers: context?.selectedActiveIlPlayers ?? null,
      opponentActiveIlPlayers: context?.opponentActiveIlPlayers ?? null,
      activeIlPlayersDiff: context?.activeIlPlayersDiff ?? null,
      selectedActiveIlPitchers: context?.selectedActiveIlPitchers ?? null,
      opponentActiveIlPitchers: context?.opponentActiveIlPitchers ?? null,
      activeIlPitchersDiff: context?.activeIlPitchersDiff ?? null,
      openingOddsAmerican: context?.openingOddsAmerican ?? null,
      previousOddsAmerican: context?.previousOddsAmerican ?? null,
      lineMovementAmerican: context?.lineMovementAmerican ?? null,
      lineMovementImplied: context?.lineMovementImplied ?? null,
      lineSnapshotCount: context?.lineSnapshotCount ?? null
    },
    reasons
  };
};

const buildMlbContexts = async (client: pg.PoolClient, lines: CandidateLine[]) => {
  const mlbLines = lines.filter((line) => line.sport === "MLB");
  if (!mlbLines.length) {
    return new Map<string, MlbHeuristicContext>();
  }

  const dates = mlbLines.map((line) => dateOnly(line.starts_at)).sort();
  const start = new Date(`${dates[0]}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 21);
  const end = dates[dates.length - 1];
  const teams = [...new Set(mlbLines.flatMap((line) => [line.away_team, line.home_team]))];

  const results = await client.query<{
    starts_on: string;
    away_team: string;
    home_team: string;
    away_score: number;
    home_score: number;
  }>(
    `
      SELECT starts_on::text, away_team, home_team, away_score, home_score
      FROM game_result
      WHERE sport = 'MLB'
        AND source = 'mlb-stats-api'
        AND starts_on BETWEEN $1::date AND $2::date
        AND (away_team = ANY($3::text[]) OR home_team = ANY($3::text[]))
      ORDER BY starts_on ASC, starts_at ASC NULLS LAST
    `,
    [dateOnly(start), end, teams]
  );

  const storedContexts = await client.query<MlbStoredContext & {
    starts_on: string;
    away_team: string;
    home_team: string;
  }>(
    `
      SELECT
        starts_on::text,
        starts_at,
        away_team,
        home_team,
        away_pitcher_stats,
        home_pitcher_stats,
        away_bullpen,
        home_bullpen,
        away_injuries,
        home_injuries,
        context
      FROM mlb_game_context
      WHERE starts_on BETWEEN $1::date AND $2::date
        AND (away_team = ANY($3::text[]) OR home_team = ANY($3::text[]))
    `,
    [dates[0], end, teams]
  );
  const storedByExactGame = new Map<string, MlbStoredContext>();
  const storedByDateGame = new Map<string, MlbStoredContext[]>();
  for (const context of storedContexts.rows) {
    storedByExactGame.set(storedContextExactKey(context.starts_at, context.away_team, context.home_team), context);
    const dateKey = storedContextDateKey(context.starts_on, context.away_team, context.home_team);
    storedByDateGame.set(dateKey, [...(storedByDateGame.get(dateKey) ?? []), context]);
  }
  const marketMovements = await buildMarketMovements(client, mlbLines);

  const history = new Map<string, TeamGame[]>();
  for (const game of results.rows) {
    const awayHistory = history.get(game.away_team) ?? [];
    const homeHistory = history.get(game.home_team) ?? [];
    history.set(game.away_team, [...awayHistory, {
      startsOn: game.starts_on,
      team: game.away_team,
      opponent: game.home_team,
      homeTeam: game.home_team,
      isHome: false,
      runsFor: game.away_score,
      runsAgainst: game.home_score,
      won: game.away_score > game.home_score
    }]);
    history.set(game.home_team, [...homeHistory, {
      startsOn: game.starts_on,
      team: game.home_team,
      opponent: game.away_team,
      homeTeam: game.home_team,
      isHome: true,
      runsFor: game.home_score,
      runsAgainst: game.away_score,
      won: game.home_score > game.away_score
    }]);
  }

  const contexts = new Map<string, MlbHeuristicContext>();
  for (const line of mlbLines) {
    const startsOn = dateOnly(line.starts_at);
    const selected = line.selected_team;
    const opponent = selected === line.away_team ? line.home_team : line.away_team;
    const selectedGames = (history.get(selected) ?? []).filter((game) => game.startsOn < startsOn);
    const opponentGames = (history.get(opponent) ?? []).filter((game) => game.startsOn < startsOn);
    const selected7 = formForGames(selectedGames, 7);
    const opponent7 = formForGames(opponentGames, 7);
    const selected14 = formForGames(selectedGames, 14);
    const opponent14 = formForGames(opponentGames, 14);
    const selectedLast = selectedGames.at(-1);
    const opponentLast = opponentGames.at(-1);
    const selectedRestDays = selectedLast ? Math.max(0, daysBetween(selectedLast.startsOn, startsOn) - 1) : null;
    const opponentRestDays = opponentLast ? Math.max(0, daysBetween(opponentLast.startsOn, startsOn) - 1) : null;
    const selectedIsHome = selected === line.home_team;
    const opponentIsHome = opponent === line.home_team;
    const selectedVenue = formForGames(selectedGames.filter((game) => game.isHome === selectedIsHome), 20);
    const opponentVenue = formForGames(opponentGames.filter((game) => game.isHome === opponentIsHome), 20);
    const selectedSide = selected === line.away_team ? "away" : "home";
    const exactStored = storedByExactGame.get(storedContextExactKey(line.starts_at, line.away_team, line.home_team));
    const dateStored = storedByDateGame.get(storedContextDateKey(startsOn, line.away_team, line.home_team)) ?? [];
    const stored = exactStored ?? (dateStored.length === 1 ? dateStored[0] : undefined);

    contexts.set(line.id, contextFromStored({
      winPctDiff7: diffOrNull(selected7?.winPct, opponent7?.winPct),
      runDiffPerGameDiff7: diffOrNull(selected7?.runDiffPerGame, opponent7?.runDiffPerGame),
      winPctDiff14: diffOrNull(selected14?.winPct, opponent14?.winPct),
      runDiffPerGameDiff14: diffOrNull(selected14?.runDiffPerGame, opponent14?.runDiffPerGame),
      selectedRunsForPerGame7: selected7?.runsForPerGame ?? null,
      opponentRunsForPerGame7: opponent7?.runsForPerGame ?? null,
      runsForPerGameDiff7: diffOrNull(selected7?.runsForPerGame, opponent7?.runsForPerGame),
      selectedRunsForPerGame14: selected14?.runsForPerGame ?? null,
      opponentRunsForPerGame14: opponent14?.runsForPerGame ?? null,
      runsForPerGameDiff14: diffOrNull(selected14?.runsForPerGame, opponent14?.runsForPerGame),
      selectedRunsAgainstPerGame7: selected7?.runsAgainstPerGame ?? null,
      opponentRunsAgainstPerGame7: opponent7?.runsAgainstPerGame ?? null,
      runsAgainstPerGameDiff7: diffOrNull(selected7?.runsAgainstPerGame, opponent7?.runsAgainstPerGame),
      selectedRunsAgainstPerGame14: selected14?.runsAgainstPerGame ?? null,
      opponentRunsAgainstPerGame14: opponent14?.runsAgainstPerGame ?? null,
      runsAgainstPerGameDiff14: diffOrNull(selected14?.runsAgainstPerGame, opponent14?.runsAgainstPerGame),
      selectedVenueWinPct: selectedVenue?.winPct ?? null,
      opponentVenueWinPct: opponentVenue?.winPct ?? null,
      venueWinPctDiff: diffOrNull(selectedVenue?.winPct, opponentVenue?.winPct),
      selectedVenueRunDiffPerGame: selectedVenue?.runDiffPerGame ?? null,
      opponentVenueRunDiffPerGame: opponentVenue?.runDiffPerGame ?? null,
      venueRunDiffPerGameDiff: diffOrNull(selectedVenue?.runDiffPerGame, opponentVenue?.runDiffPerGame),
      selectedRestDays,
      opponentRestDays,
      restDaysDiff: diffOrNull(selectedRestDays, opponentRestDays),
      selectedVenueChanged: selectedLast ? selectedLast.isHome !== selectedIsHome : null,
      opponentVenueChanged: opponentLast ? opponentLast.isHome !== opponentIsHome : null
    }, stored, selectedSide, marketMovements.get(line.id) ?? null));
  }

  return contexts;
};

const placeAiWager = async (
  client: pg.PoolClient,
  userId: string,
  candidate: ScoredCandidate,
  stakeCents: number
) => {
  const entry = await ensureWeeklyEntry(client, userId);
  if (entry.balance_cents < stakeCents) {
    return null;
  }

  const potentialPayout = estimatePayoutCents(stakeCents, [candidate.odds_american]);
  const wagerId = randomUUID();

  await client.query(
    `
      INSERT INTO wager (id, user_id, weekly_entry_id, kind, stake_cents, potential_payout_cents, legs_count)
      VALUES ($1, $2, $3, 'straight', $4, $5, 1)
      ON CONFLICT DO NOTHING
    `,
    [wagerId, userId, entry.id, stakeCents, potentialPayout]
  );

  await client.query(
    `
      INSERT INTO wager_leg (id, wager_id, game_line_id, selected_team, spread, odds_american)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [randomUUID(), wagerId, candidate.id, candidate.selected_team, candidate.spread, candidate.odds_american]
  );

  await client.query("UPDATE weekly_entry SET balance_cents = balance_cents - $1 WHERE id = $2", [stakeCents, entry.id]);
  return wagerId;
};

const gameKeyForPick = (pick: Pick<CandidateLine, "starts_at" | "away_team" | "home_team">) =>
  `${pick.starts_at.toISOString()}:${pick.away_team}:${pick.home_team}`;

export const generateAiPicks = async ({
  sport = "MLB",
  maxPicks = 3,
  stakeCents = 10000,
  placeWagers = true,
  marketKey,
  forDate,
  sortBy = "score",
  uniqueGames = false,
  stakeFractionOfBalance,
  lockWindowMinutes = 60
}: {
  sport?: "MLB" | "NHL" | "NFL" | "NBA" | "NCAAMB" | "NCAAF";
  maxPicks?: number;
  stakeCents?: number;
  placeWagers?: boolean;
  marketKey?: "h2h" | "spreads";
  forDate?: string;
  sortBy?: "score" | "confidence";
  uniqueGames?: boolean;
  stakeFractionOfBalance?: number;
  lockWindowMinutes?: number;
} = {}) => {
  const result = await transaction(async (client) => {
    const runId = randomUUID();
    const today = forDate ?? centralDate();
    const now = new Date();

    const run = await client.query<{ id: string }>(
      `
        INSERT INTO ai_model_run (id, model_version, sport, run_for, notes)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (model_version, sport, run_for)
        DO UPDATE SET created_at = now(), notes = EXCLUDED.notes
        RETURNING id
      `,
      [runId, modelVersion, sport, today, "Transparent heuristic using market, recent form, rest, and venue-change features"]
    );

    const activeLines = await client.query<CandidateLine>(
      `
        SELECT
          id,
          provider_event_id,
          sport,
          starts_at,
          home_team,
          away_team,
          favorite_team AS selected_team,
          spread,
          odds_american,
          market_key
        FROM game_line
        WHERE is_active = true
          AND sport = $1
          AND starts_at > now()
          AND ($2::text IS NULL OR (starts_at AT TIME ZONE 'America/Chicago')::date = $2::date)
          AND ($3::text IS NULL OR market_key = $3::text)
        ORDER BY starts_at ASC, market_key ASC
      `,
      [sport, forDate ?? null, marketKey ?? null]
    );

    const eventMarketCounts = new Map<string, number>();
    for (const line of activeLines.rows) {
      eventMarketCounts.set(eventKey(line), (eventMarketCounts.get(eventKey(line)) ?? 0) + 1);
    }

    const mlbContexts = await buildMlbContexts(client, activeLines.rows);
    const scored = activeLines.rows
      .map((line) => scoreLine(line, eventMarketCounts, mlbContexts.get(line.id) ?? null))
      .sort((a, b) =>
        sortBy === "confidence"
          ? b.confidence - a.confidence || b.score - a.score
          : b.score - a.score || b.confidence - a.confidence
      );

    for (const candidate of scored) {
      await client.query(
        `
          INSERT INTO ai_pick_candidate (
            id, run_id, game_line_id, selected_team, score, confidence,
            implied_probability, fair_probability, edge, features, reasons
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (run_id, game_line_id) DO UPDATE SET
            score = EXCLUDED.score,
            confidence = EXCLUDED.confidence,
            implied_probability = EXCLUDED.implied_probability,
            fair_probability = EXCLUDED.fair_probability,
            edge = EXCLUDED.edge,
            features = EXCLUDED.features,
            reasons = EXCLUDED.reasons
        `,
        [
          randomUUID(),
          run.rows[0].id,
          candidate.id,
          candidate.selected_team,
          candidate.score,
          candidate.confidence,
          candidate.impliedProbability,
          candidate.fairProbability,
          candidate.edge,
          JSON.stringify(candidate.features),
          candidate.reasons
        ]
      );
    }

    const lockedResult = await client.query<{
      game_line_id: string;
      starts_at: Date;
      away_team: string;
      home_team: string;
      selected_team: string;
    }>(
      `
        SELECT p.game_line_id, gl.starts_at, gl.away_team, gl.home_team, p.selected_team
        FROM ai_pick p
        JOIN game_line gl ON gl.id = p.game_line_id
        WHERE p.published_for = $1
          AND p.locked_at IS NOT NULL
          AND gl.sport = $2
      `,
      [today, sport]
    );
    const lockedGameKeys = new Set(lockedResult.rows.map((pick) => gameKeyForPick(pick)));
    const openSlots = Math.max(0, maxPicks - lockedGameKeys.size);

    const selected = scored.reduce<ScoredCandidate[]>((acc, candidate) => {
      if (acc.length >= openSlots) {
        return acc;
      }
      const gameKey = gameKeyForPick(candidate);
      if (lockedGameKeys.has(gameKey)) {
        return acc;
      }
      if (uniqueGames && acc.some((pick) => gameKeyForPick(pick) === gameKey)) {
        return acc;
      }
      acc.push(candidate);
      return acc;
    }, []);
    const aiUser = await client.query<{ id: string }>("SELECT id FROM app_user WHERE username = $1 AND role = 'system'", [
      config.aiUsername
    ]);
    const aiEntry = placeWagers && aiUser.rowCount ? await ensureWeeklyEntry(client, aiUser.rows[0].id) : null;
    const existingDailyAiWager = placeWagers && aiUser.rowCount
      ? await client.query<{ stake_cents: number }>(
        `
          SELECT w.stake_cents
          FROM wager w
          WHERE w.user_id = $1
            AND (w.placed_at AT TIME ZONE 'America/Chicago')::date = $2::date
          ORDER BY w.placed_at ASC
          LIMIT 1
        `,
        [aiUser.rows[0].id, today]
      )
      : null;
    const dailyStakeCents = existingDailyAiWager?.rowCount
      ? existingDailyAiWager.rows[0].stake_cents
      : aiEntry && stakeFractionOfBalance !== undefined
        ? Math.max(1, Math.floor(aiEntry.balance_cents * stakeFractionOfBalance))
        : stakeCents;

    await client.query(
      `
        DELETE FROM ai_pick p
        USING game_line gl
        WHERE gl.id = p.game_line_id
          AND gl.sport = $1
          AND p.published_for = $2
          AND p.locked_at IS NULL
      `,
      [sport, today]
    );

    const published: PublishedAiPick[] = [];

    for (const candidate of selected) {
      const lockAt = new Date(candidate.starts_at.getTime() - lockWindowMinutes * 60 * 1000);
      const shouldLock = now >= lockAt && now < candidate.starts_at;
      let wagerId: string | null = null;

      if (shouldLock && placeWagers && aiUser.rowCount) {
        const existing = await client.query<{ wager_id: string | null }>(
          `
            SELECT w.id AS wager_id
            FROM wager w
            JOIN wager_leg wl ON wl.wager_id = w.id
            WHERE w.user_id = $1 AND wl.game_line_id = $2
            LIMIT 1
          `,
          [aiUser.rows[0].id, candidate.id]
        );
        wagerId = existing.rows[0]?.wager_id ?? null;
        if (!wagerId) {
          wagerId = await placeAiWager(client, aiUser.rows[0].id, candidate, dailyStakeCents);
        }
      }

      const explanation = fallbackAiExplanation({
        selectedTeam: candidate.selected_team,
        score: Number(candidate.score.toFixed(4)),
        confidence: Number(candidate.confidence.toFixed(4)),
        edge: Number(candidate.edge.toFixed(4)),
        reasons: candidate.reasons,
        awayTeam: candidate.away_team,
        homeTeam: candidate.home_team,
        marketKey: candidate.market_key,
        spread: candidate.spread,
        oddsAmerican: candidate.odds_american,
        startsAt: candidate.starts_at.toISOString(),
        features: candidate.features
      });
      const pickResult = await client.query<{ id: string }>(
        `
          INSERT INTO ai_pick (
            id, game_line_id, selected_team, published_for, run_id, score,
            confidence, reasons, features, locked_at, wager_id, explanation
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (game_line_id, published_for) DO UPDATE SET
            selected_team = EXCLUDED.selected_team,
            run_id = EXCLUDED.run_id,
            score = EXCLUDED.score,
            confidence = EXCLUDED.confidence,
            reasons = EXCLUDED.reasons,
            features = EXCLUDED.features,
            locked_at = COALESCE(ai_pick.locked_at, EXCLUDED.locked_at),
            wager_id = COALESCE(ai_pick.wager_id, EXCLUDED.wager_id),
            explanation = EXCLUDED.explanation
          RETURNING id
        `,
        [
          randomUUID(),
          candidate.id,
          candidate.selected_team,
          today,
          run.rows[0].id,
          candidate.score,
          candidate.confidence,
          candidate.reasons,
          JSON.stringify(candidate.features),
          shouldLock ? now : null,
          wagerId,
          explanation
        ]
      );
      published.push({
        id: pickResult.rows[0].id,
        gameLineId: candidate.id,
        selectedTeam: candidate.selected_team,
        score: Number(candidate.score.toFixed(4)),
        confidence: Number(candidate.confidence.toFixed(4)),
        edge: Number(candidate.edge.toFixed(4)),
        stakeCents: shouldLock && placeWagers ? dailyStakeCents : 0,
        locked: shouldLock,
        wagerId,
        reasons: candidate.reasons,
        explanation,
        awayTeam: candidate.away_team,
        homeTeam: candidate.home_team,
        marketKey: candidate.market_key,
        spread: candidate.spread,
        oddsAmerican: candidate.odds_american,
        startsAt: candidate.starts_at.toISOString(),
        features: candidate.features
      });
    }

    const result = {
      runId: run.rows[0].id,
      modelVersion,
      candidates: scored.length,
      locked: lockedGameKeys.size + published.filter((pick) => pick.locked).length,
      projected: published.filter((pick) => !pick.locked).length,
      published
    };

    return result;
  });

  const published = await enrichPublishedExplanations(result.published);
  return { ...result, published };
};

export const snapshotAiCandidates = async ({
  sport = "MLB",
  source = "manual"
}: {
  sport?: "MLB" | "NHL" | "NFL" | "NBA" | "NCAAMB" | "NCAAF";
  source?: string;
} = {}) => {
  return transaction(async (client) => {
    const activeLines = await client.query<CandidateLine>(
      `
        SELECT
          id,
          provider_event_id,
          sport,
          starts_at,
          home_team,
          away_team,
          favorite_team AS selected_team,
          spread,
          odds_american,
          market_key
        FROM game_line
        WHERE is_active = true
          AND sport = $1
          AND starts_at > now()
        ORDER BY starts_at ASC, market_key ASC
      `,
      [sport]
    );

    const eventMarketCounts = new Map<string, number>();
    for (const line of activeLines.rows) {
      eventMarketCounts.set(eventKey(line), (eventMarketCounts.get(eventKey(line)) ?? 0) + 1);
    }

    const mlbContexts = await buildMlbContexts(client, activeLines.rows);
    const scored = activeLines.rows.map((line) => scoreLine(line, eventMarketCounts, mlbContexts.get(line.id) ?? null));
    const capturedAt = new Date();

    for (const candidate of scored) {
      await client.query(
        `
          INSERT INTO ai_candidate_snapshot (
            id, captured_at, model_version, sport, game_line_id, provider_event_id,
            market_key, selected_team, away_team, home_team, starts_at,
            odds_american, spread, score, confidence, implied_probability,
            fair_probability, edge, features, reasons, source
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, $15, $16,
            $17, $18, $19::jsonb, $20, $21
          )
        `,
        [
          randomUUID(),
          capturedAt,
          modelVersion,
          candidate.sport,
          candidate.id,
          candidate.provider_event_id,
          candidate.market_key,
          candidate.selected_team,
          candidate.away_team,
          candidate.home_team,
          candidate.starts_at,
          candidate.odds_american,
          candidate.spread,
          candidate.score,
          candidate.confidence,
          candidate.impliedProbability,
          candidate.fairProbability,
          candidate.edge,
          JSON.stringify(candidate.features),
          candidate.reasons,
          source
        ]
      );
    }

    return {
      capturedAt: capturedAt.toISOString(),
      modelVersion,
      sport,
      snapshots: scored.length
    };
  });
};
