import { transaction } from "./db.js";
import type pg from "pg";

type MlbScheduleGame = {
  gamePk: number;
  gameDate: string;
  officialDate?: string;
  gameNumber?: number;
  doubleHeader?: string;
  seriesGameNumber?: number;
  status: {
    abstractGameState?: string;
    detailedState?: string;
    statusCode?: string;
  };
  linescore?: {
    scheduledInnings?: number;
    currentInning?: number;
    innings?: unknown[];
  };
  teams: {
    away: {
      score?: number;
      team: { name: string };
    };
    home: {
      score?: number;
      team: { name: string };
    };
  };
};

type MlbScheduleResponse = {
  dates?: Array<{
    games: MlbScheduleGame[];
  }>;
};

export type FinalGame = {
  providerGameId?: string;
  startsAt?: string;
  startsOn: string;
  awayTeam: string;
  homeTeam: string;
  awayScore: number;
  homeScore: number;
  noAction?: boolean;
  gameNumber?: number;
  metadata?: Record<string, unknown>;
};

type WagerOutcome = "won" | "lost" | "push" | "void";

type PendingLeg = {
  wager_id: string;
  wager_status: WagerOutcome | "pending";
  weekly_entry_id: string;
  kind: "straight" | "parlay" | "round_robin";
  stake_cents: number;
  round_robin_ways: number | null;
  round_robin_min_legs: number | null;
  round_robin_max_legs: number | null;
  round_robin_stake_per_way_cents: number | null;
  potential_payout_cents: number;
  leg_id: string;
  selected_team: string;
  spread: string;
  odds_american: number;
  leg_status: WagerOutcome | "pending";
  sport: "MLB" | "EPL" | "WORLDCUP";
  market_key: "h2h" | "spreads" | "totals";
  starts_at: string;
  starts_on: string;
  away_team: string;
  home_team: string;
};

type SettledLeg = PendingLeg & {
  outcome: WagerOutcome;
};

type TeamAliasMap = Map<string, string>;

type MatchCandidateSummary = {
  awayTeam: string;
  homeTeam: string;
  startsAt: string | null;
  awayScore: number;
  homeScore: number;
  awayTeamMatch: number;
  homeTeamMatch: number;
  score: number;
  orientation: "same" | "swapped";
  timeDiffMinutes: number | null;
};

const yyyyMmDd = (date: Date) => date.toISOString().slice(0, 10);

const isFinal = (game: MlbScheduleGame) => {
  const state = `${game.status.abstractGameState ?? ""} ${game.status.detailedState ?? ""} ${game.status.statusCode ?? ""}`.toLowerCase();
  return state.includes("final") || game.status.statusCode === "F";
};

const isNoActionStatus = (game: MlbScheduleGame) => {
  const state = `${game.status.abstractGameState ?? ""} ${game.status.detailedState ?? ""} ${game.status.statusCode ?? ""}`.toLowerCase();
  return /\b(postponed|suspended|cancelled|canceled)\b/.test(state);
};

const completedAtLeastNineInnings = (game: MlbScheduleGame) => {
  const scheduledInnings = game.linescore?.scheduledInnings;
  const inningsPlayed = game.linescore?.innings?.length ?? game.linescore?.currentInning;
  return (typeof scheduledInnings !== "number" || scheduledInnings >= 9)
    && typeof inningsPlayed === "number"
    && inningsPlayed >= 9;
};

export const finalGameKey = (game: Pick<FinalGame, "startsOn" | "awayTeam" | "homeTeam">) => {
  return `${game.startsOn}:${game.awayTeam}:${game.homeTeam}`;
};

export const unambiguousFinalGameMap = (finals: FinalGame[]) => {
  const grouped = new Map<string, FinalGame[]>();
  for (const game of finals) {
    const key = finalGameKey(game);
    grouped.set(key, [...(grouped.get(key) ?? []), game]);
  }

  const map = new Map<string, FinalGame>();
  for (const [key, games] of grouped.entries()) {
    if (games.length === 1) {
      map.set(key, games[0]);
    }
  }
  return map;
};

type EspnScoreboardResponse = {
  events?: Array<{
    id: string;
    date: string;
    competitions?: Array<{
      status?: {
        type?: {
          completed?: boolean;
          state?: string;
          name?: string;
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
  }>;
};

const espnLeagueForSport = (sport: "EPL" | "WORLDCUP") => sport === "EPL" ? "eng.1" : "fifa.world";

const aliasKey = (sport: string | null | undefined, provider: string | null | undefined, team: string) =>
  `${sport ?? "*"}:${provider ?? "*"}:${team}`;

const baseNormalizeTeamName = (team: string) => {
  return team
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
};

const builtInCanonicalTeamName = (normalized: string) => {
  return normalized
    .replace(/\boakland athletics\b/g, "athletics")
    .replace(/\bunited states of america\b/g, "usa")
    .replace(/\bunited states\b/g, "usa")
    .replace(/\bbosnia and herzegovina\b/g, "bosnia herzegovina")
    .replace(/\bdemocratic republic of the congo\b/g, "congo dr")
    .replace(/\bdemocratic republic of congo\b/g, "congo dr")
    .replace(/\bdr congo\b/g, "congo dr")
    .replace(/\bcote d ivoire\b/g, "ivory coast")
    .replace(/\s+/g, " ")
    .trim();
};

const normalizeTeamName = (team: string, sport?: string, provider?: string, aliases?: TeamAliasMap) => {
  const normalized = builtInCanonicalTeamName(baseNormalizeTeamName(team));
  if (!aliases) {
    return normalized;
  }
  return aliases.get(aliasKey(sport, provider, normalized))
    ?? aliases.get(aliasKey(sport, "*", normalized))
    ?? aliases.get(aliasKey("*", provider, normalized))
    ?? aliases.get(aliasKey("*", "*", normalized))
    ?? normalized;
};

const teamSimilarity = (left: string, right: string, sport?: string, provider?: string, aliases?: TeamAliasMap) => {
  const normalizedLeft = normalizeTeamName(left, sport, provider, aliases);
  const normalizedRight = normalizeTeamName(right, sport, provider, aliases);
  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const leftTokens = new Set(normalizedLeft.split(" ").filter(Boolean));
  const rightTokens = new Set(normalizedRight.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
};

const loadTeamAliases = async (client: pg.PoolClient, sports: Array<PendingLeg["sport"]>) => {
  const result = await client.query<{
    sport: PendingLeg["sport"] | null;
    provider: string | null;
    canonicalName: string;
    aliasName: string;
  }>(
    `
      SELECT sport, provider, canonical_name AS "canonicalName", alias_name AS "aliasName"
      FROM team_alias
      WHERE sport IS NULL OR sport = ANY($1::sport_key[])
    `,
    [sports]
  );

  const aliases: TeamAliasMap = new Map();
  for (const row of result.rows) {
    const sport = row.sport ?? "*";
    const provider = row.provider ?? "*";
    const canonical = builtInCanonicalTeamName(baseNormalizeTeamName(row.canonicalName));
    const alias = builtInCanonicalTeamName(baseNormalizeTeamName(row.aliasName));
    aliases.set(aliasKey(sport, provider, alias), canonical);
    aliases.set(aliasKey(sport, "*", alias), canonical);
  }
  return aliases;
};

const espnDatesParam = (startDate: string, endDate: string) => {
  return `${startDate.replace(/-/g, "")}-${endDate.replace(/-/g, "")}`;
};

export const fetchSoccerFinals = async (sport: "EPL" | "WORLDCUP", startDate: string, endDate: string) => {
  const url = new URL(`https://site.api.espn.com/apis/site/v2/sports/soccer/${espnLeagueForSport(sport)}/scoreboard`);
  url.searchParams.set("limit", "300");
  url.searchParams.set("dates", espnDatesParam(startDate, endDate));

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ESPN soccer scoreboard ${sport} failed with ${response.status}`);
  }

  const body = (await response.json()) as EspnScoreboardResponse;
  const finals: FinalGame[] = [];
  const startTime = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const endTime = new Date(`${endDate}T23:59:59.999Z`).getTime();

  for (const event of body.events ?? []) {
    const startsAt = new Date(event.date);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < startTime || startsAt.getTime() > endTime) {
      continue;
    }

    const competition = event.competitions?.[0];
    const status = competition?.status?.type;
    if (!status?.completed && status?.state !== "post" && status?.name !== "STATUS_FULL_TIME") {
      continue;
    }

    const home = competition?.competitors?.find((competitor) => competitor.homeAway === "home");
    const away = competition?.competitors?.find((competitor) => competitor.homeAway === "away");
    const homeScore = Number(home?.score);
    const awayScore = Number(away?.score);
    const homeTeam = home?.team?.displayName ?? home?.team?.name ?? home?.team?.shortDisplayName;
    const awayTeam = away?.team?.displayName ?? away?.team?.name ?? away?.team?.shortDisplayName;

    if (!homeTeam || !awayTeam || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
      continue;
    }

    finals.push({
      providerGameId: event.id,
      startsAt: startsAt.toISOString(),
      startsOn: yyyyMmDd(startsAt),
      awayTeam,
      homeTeam,
      awayScore,
      homeScore,
      metadata: { source: "espn-scoreboard", sport, status }
    });
  }

  return finals;
};

export const fetchMlbFinals = async (startDate: string, endDate: string) => {
  const url = new URL("https://statsapi.mlb.com/api/v1/schedule");
  url.searchParams.set("sportId", "1");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("hydrate", "team,linescore");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`MLB Stats API failed with ${response.status}`);
  }

  const body = (await response.json()) as MlbScheduleResponse;
  const finals: FinalGame[] = [];

  for (const date of body.dates ?? []) {
    for (const game of date.games) {
      const baseGame = {
        providerGameId: String(game.gamePk),
        startsAt: game.gameDate,
        startsOn: yyyyMmDd(new Date(game.gameDate)),
        awayTeam: game.teams.away.team.name,
        homeTeam: game.teams.home.team.name,
        gameNumber: game.gameNumber,
        metadata: {
          officialDate: game.officialDate,
          gameNumber: game.gameNumber,
          doubleHeader: game.doubleHeader,
          seriesGameNumber: game.seriesGameNumber,
          status: game.status,
          linescore: game.linescore
        }
      };

      if (isNoActionStatus(game)) {
        finals.push({
          ...baseGame,
          awayScore: 0,
          homeScore: 0,
          noAction: true
        });
        continue;
      }

      if (!isFinal(game) || typeof game.teams.away.score !== "number" || typeof game.teams.home.score !== "number") {
        continue;
      }

      if (!completedAtLeastNineInnings(game)) {
        finals.push({
          ...baseGame,
          awayScore: game.teams.away.score,
          homeScore: game.teams.home.score,
          noAction: true
        });
        continue;
      }

      finals.push({
        ...baseGame,
        awayScore: game.teams.away.score,
        homeScore: game.teams.home.score
      });
    }
  }

  return finals;
};

export const outcomeForSelection = ({
  selectedTeam,
  awayTeam,
  homeTeam,
  marketKey,
  spread,
  game
}: {
  selectedTeam: string;
  awayTeam: string;
  homeTeam: string;
  marketKey: "h2h" | "spreads" | "totals";
  spread: number;
  game: FinalGame;
}) => {
  if (game.noAction) {
    return "void" as const;
  }

  if (marketKey === "totals") {
    const total = game.awayScore + game.homeScore;
    if (total > spread) return selectedTeam === "Over" ? "won" as const : "lost" as const;
    if (total < spread) return selectedTeam === "Under" ? "won" as const : "lost" as const;
    return "push" as const;
  }

  if (selectedTeam === "Draw" && marketKey === "h2h") {
    return game.awayScore === game.homeScore ? "won" as const : "lost" as const;
  }

  if (selectedTeam !== awayTeam && selectedTeam !== homeTeam) {
    return "void" as const;
  }

  const selectedScore = selectedTeam === awayTeam ? game.awayScore : game.homeScore;
  const opponentScore = selectedTeam === awayTeam ? game.homeScore : game.awayScore;

  if (marketKey === "h2h") {
    if (selectedScore > opponentScore) return "won" as const;
    if (selectedScore < opponentScore) return "lost" as const;
    return "lost" as const;
  }

  const adjusted = selectedScore + spread;
  if (adjusted > opponentScore) return "won" as const;
  if (adjusted < opponentScore) return "lost" as const;
  return "push" as const;
};

const outcomeForLeg = (leg: PendingLeg, game: FinalGame) => {
  return outcomeForSelection({
    selectedTeam: leg.selected_team,
    awayTeam: leg.away_team,
    homeTeam: leg.home_team,
    marketKey: leg.market_key,
    spread: Number(leg.spread),
    game
  });
};

const candidateSummary = (
  leg: PendingLeg,
  game: FinalGame,
  aliases: TeamAliasMap,
  orientation: "same" | "swapped"
): MatchCandidateSummary | null => {
  if (!game.startsAt) {
    return null;
  }

  const lineStart = new Date(leg.starts_at).getTime();
  const gameStart = new Date(game.startsAt).getTime();
  if (Number.isNaN(lineStart) || Number.isNaN(gameStart)) {
    return null;
  }

  const timeDiffMinutes = Math.round(Math.abs(gameStart - lineStart) / 60_000);
  const twelveHoursMinutes = 12 * 60;
  if (timeDiffMinutes > twelveHoursMinutes) {
    return null;
  }

  const awayTeamMatch = orientation === "same"
    ? teamSimilarity(game.awayTeam, leg.away_team, leg.sport, "espn-scoreboard", aliases)
    : teamSimilarity(game.homeTeam, leg.away_team, leg.sport, "espn-scoreboard", aliases);
  const homeTeamMatch = orientation === "same"
    ? teamSimilarity(game.homeTeam, leg.home_team, leg.sport, "espn-scoreboard", aliases)
    : teamSimilarity(game.awayTeam, leg.home_team, leg.sport, "espn-scoreboard", aliases);
  const timeScore = 1 - (timeDiffMinutes / twelveHoursMinutes);
  const score = (awayTeamMatch * 0.42) + (homeTeamMatch * 0.42) + (timeScore * 0.16);

  return {
    awayTeam: game.awayTeam,
    homeTeam: game.homeTeam,
    startsAt: game.startsAt,
    awayScore: game.awayScore,
    homeScore: game.homeScore,
    awayTeamMatch: Number(awayTeamMatch.toFixed(3)),
    homeTeamMatch: Number(homeTeamMatch.toFixed(3)),
    score: Number(score.toFixed(3)),
    orientation,
    timeDiffMinutes
  };
};

const matchFinalGame = (
  leg: PendingLeg,
  finalMap: Map<string, FinalGame>,
  finals: FinalGame[],
  aliases: TeamAliasMap
) => {
  const exact = finalMap.get(finalGameKey({ startsOn: leg.starts_on, awayTeam: leg.away_team, homeTeam: leg.home_team }));
  if (exact && (!exact.startsAt || candidateSummary(leg, exact, aliases, "same"))) {
    return { game: exact, candidates: [] as MatchCandidateSummary[] };
  }

  const candidates = finals
    .filter((game) => game.startsOn === leg.starts_on)
    .flatMap((game) => {
      const same = candidateSummary(leg, game, aliases, "same");
      const swapped = candidateSummary(leg, game, aliases, "swapped");
      return [
        same ? { game, summary: same } : null,
        swapped ? {
          game: {
            ...game,
            awayTeam: leg.away_team,
            homeTeam: leg.home_team,
            awayScore: game.homeScore,
            homeScore: game.awayScore,
            metadata: { ...(game.metadata ?? {}), settlementOrientation: "swapped", originalAwayTeam: game.awayTeam, originalHomeTeam: game.homeTeam }
          },
          summary: swapped
        } : null
      ].filter((candidate): candidate is { game: FinalGame; summary: MatchCandidateSummary } => Boolean(candidate));
    })
    .sort((a, b) => b.summary.score - a.summary.score);

  if (candidates.length === 0) {
    return { game: null, candidates: [] as MatchCandidateSummary[] };
  }

  const closest = candidates[0];
  const secondClosest = candidates[1];
  const minimumScore = 0.9;
  const minimumTeamScore = 0.82;
  const clearMargin = 0.08;
  const teamScoresStrong = closest.summary.awayTeamMatch >= minimumTeamScore && closest.summary.homeTeamMatch >= minimumTeamScore;
  const hasClearMargin = !secondClosest || closest.summary.score - secondClosest.summary.score >= clearMargin;

  if (closest.summary.score < minimumScore || !teamScoresStrong || !hasClearMargin) {
    return { game: null, candidates: candidates.slice(0, 3).map((candidate) => candidate.summary) };
  }

  return { game: closest.game, candidates: candidates.slice(0, 3).map((candidate) => candidate.summary) };
};

const decimalOdds = (americanOdds: number) => {
  if (americanOdds > 0) {
    return 1 + americanOdds / 100;
  }
  return 1 + 100 / Math.abs(americanOdds);
};

const payoutCentsForWinningLegs = (stakeCents: number, legs: Array<Pick<PendingLeg, "odds_american">>) => {
  const multiplier = legs.reduce((current, leg) => current * decimalOdds(leg.odds_american), 1);
  return Math.round(stakeCents * multiplier);
};

const combinationsCount = (total: number, size: number) => {
  if (size < 0 || size > total) return 0;
  let result = 1;
  for (let index = 1; index <= size; index += 1) {
    result = (result * (total - size + index)) / index;
  }
  return Math.round(result);
};

const expectedRoundRobinWays = (totalLegs: number, minLegs: number, maxLegs: number) => {
  let total = 0;
  for (let size = minLegs; size <= maxLegs; size += 1) {
    total += combinationsCount(totalLegs, size);
  }
  return total;
};

const roundRobinWayOutcome = (
  stakePerWayCents: number,
  selected: PendingLeg[],
  outcomes: Map<string, WagerOutcome>
) => {
  const selectedWithOutcomes = selected
    .map((leg) => ({ leg, outcome: outcomes.get(leg.leg_id) }))
    .filter((item): item is { leg: PendingLeg; outcome: WagerOutcome } => Boolean(item.outcome));

  if (selectedWithOutcomes.some((item) => item.outcome === "lost")) {
    return { status: "lost" as const, payoutCents: 0, profitCents: -stakePerWayCents };
  }

  if (selectedWithOutcomes.length !== selected.length) {
    return null;
  }

  const winningLegs = selectedWithOutcomes
    .filter((item) => item.outcome === "won")
    .map((item) => item.leg);

  if (!winningLegs.length) {
    return { status: "push" as const, payoutCents: stakePerWayCents, profitCents: 0 };
  }

  const payoutCents = payoutCentsForWinningLegs(stakePerWayCents, winningLegs);
  return { status: "won" as const, payoutCents, profitCents: payoutCents - stakePerWayCents };
};

const settleRoundRobinWays = async (
  client: pg.PoolClient,
  firstLeg: PendingLeg,
  legs: PendingLeg[],
  settledLegs: SettledLeg[]
) => {
  const stakePerWayCents = firstLeg.round_robin_stake_per_way_cents
    ?? (firstLeg.round_robin_ways ? Math.floor(firstLeg.stake_cents / firstLeg.round_robin_ways) : firstLeg.stake_cents);
  const minLegs = firstLeg.round_robin_min_legs ?? 2;
  const maxLegs = firstLeg.round_robin_max_legs ?? legs.length;
  const outcomes = new Map(settledLegs.map((leg) => [leg.leg_id, leg.outcome] as const));
  const newlySettled: Array<{ wayKey: string; status: WagerOutcome; payoutCents: number; profitCents: number }> = [];

  const visit = async (start: number, size: number, selected: PendingLeg[]): Promise<void> => {
    if (selected.length === size) {
      const outcome = roundRobinWayOutcome(stakePerWayCents, selected, outcomes);
      if (!outcome) {
        return;
      }

      const legIds = selected.map((leg) => leg.leg_id).sort();
      const wayKey = legIds.join(":");
      const inserted = await client.query<{
        way_key: string;
        status: WagerOutcome;
        payout_cents: number;
        profit_cents: number;
      }>(
        `
          INSERT INTO round_robin_way_settlement (
            wager_id,
            way_key,
            leg_ids,
            leg_count,
            status,
            payout_cents,
            profit_cents
          )
          VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7)
          ON CONFLICT (wager_id, way_key) DO NOTHING
          RETURNING way_key, status, payout_cents, profit_cents
        `,
        [
          firstLeg.wager_id,
          wayKey,
          legIds,
          selected.length,
          outcome.status,
          outcome.payoutCents,
          outcome.profitCents
        ]
      );

      for (const row of inserted.rows) {
        newlySettled.push({
          wayKey: row.way_key,
          status: row.status,
          payoutCents: row.payout_cents,
          profitCents: row.profit_cents
        });
      }
      return;
    }

    for (let index = start; index <= legs.length - (size - selected.length); index += 1) {
      await visit(index + 1, size, [...selected, legs[index]]);
    }
  };

  for (let size = minLegs; size <= maxLegs; size += 1) {
    await visit(0, size, []);
  }

  const payoutDeltaCents = newlySettled.reduce((total, way) => total + way.payoutCents, 0);
  const profitDeltaCents = newlySettled.reduce((total, way) => total + way.profitCents, 0);

  if (newlySettled.length) {
    await client.query(
      `
        UPDATE weekly_entry
        SET balance_cents = balance_cents + $1,
            settled_profit_cents = settled_profit_cents + $2
        WHERE id = $3
      `,
      [payoutDeltaCents, profitDeltaCents, firstLeg.weekly_entry_id]
    );
  }

  const summary = await client.query<{
    settled_ways: string;
    payout_cents: string;
  }>(
    `
      SELECT count(*)::text AS settled_ways,
             COALESCE(sum(payout_cents), 0)::text AS payout_cents
      FROM round_robin_way_settlement
      WHERE wager_id = $1
    `,
    [firstLeg.wager_id]
  );
  const settledWays = Number(summary.rows[0]?.settled_ways ?? 0);
  const payoutCents = Number(summary.rows[0]?.payout_cents ?? 0);
  const expectedWays = expectedRoundRobinWays(legs.length, minLegs, maxLegs);

  return {
    expectedWays,
    settledWays,
    payoutCents,
    payoutDeltaCents,
    profitDeltaCents,
    newlySettled
  };
};

const roundRobinSettlement = (stakePerWayCents: number, totalStakeCents: number, minLegs: number, maxLegs: number, legs: SettledLeg[]) => {
  let settledWays = 0;
  let wonWays = 0;
  let pushedWays = 0;
  let payoutCents = 0;

  const visit = (start: number, size: number, selected: SettledLeg[]) => {
    if (selected.length === size) {
      settledWays += 1;
      if (selected.some((leg) => leg.outcome === "lost")) {
        return;
      }
      const winningLegs = selected.filter((leg) => leg.outcome === "won");
      if (!winningLegs.length) {
        pushedWays += 1;
        payoutCents += stakePerWayCents;
        return;
      }
      wonWays += 1;
      payoutCents += payoutCentsForWinningLegs(stakePerWayCents, winningLegs);
      return;
    }

    for (let index = start; index <= legs.length - (size - selected.length); index += 1) {
      visit(index + 1, size, [...selected, legs[index]]);
    }
  };

  for (let size = minLegs; size <= maxLegs; size += 1) {
    visit(0, size, []);
  }

  return {
    status: payoutCents > totalStakeCents ? "won" as const : payoutCents === totalStakeCents ? "push" as const : "lost" as const,
    payoutCents
  };
};

const outcomeForSettledLegs = (kind: PendingLeg["kind"], legs: SettledLeg[]) => {
  if (legs.some((leg) => leg.outcome === "lost")) {
    return "lost" as const;
  }

  const winningLegs = legs.filter((leg) => leg.outcome === "won");
  if (winningLegs.length === 0) {
    return "push" as const;
  }

  if (kind === "straight" || kind === "parlay") {
    return "won" as const;
  }

  return "void" as const;
};

export const profitCentsForOutcome = ({
  outcome,
  stakeCents,
  potentialPayoutCents
}: {
  outcome: "won" | "lost" | "push" | "void";
  stakeCents: number;
  potentialPayoutCents: number;
}) => {
  if (outcome === "won") {
    return potentialPayoutCents - stakeCents;
  }
  if (outcome === "lost") {
    return -stakeCents;
  }
  return 0;
};

const balanceDeltaForOutcome = ({
  outcome,
  stakeCents,
  potentialPayoutCents
}: {
  outcome: "won" | "lost" | "push" | "void";
  stakeCents: number;
  potentialPayoutCents: number;
}) => {
  if (outcome === "won") {
    return potentialPayoutCents;
  }
  if (outcome === "push" || outcome === "void") {
    return stakeCents;
  }
  return 0;
};

const settleWagersForFinals = async ({
  startDate,
  endDate,
  sports,
  finals
}: {
  startDate: string;
  endDate: string;
  sports: Array<PendingLeg["sport"]>;
  finals: FinalGame[];
}) => {
  const finalMap = unambiguousFinalGameMap(finals);

  return transaction(async (client) => {
    const aliases = await loadTeamAliases(client, sports);
    const pending = await client.query<PendingLeg>(
      `
        SELECT
          w.id AS wager_id,
          w.status AS wager_status,
          w.weekly_entry_id,
          w.kind,
          w.stake_cents,
          w.round_robin_ways,
          w.round_robin_min_legs,
          w.round_robin_max_legs,
          w.round_robin_stake_per_way_cents,
          w.potential_payout_cents,
          wl.id AS leg_id,
          wl.selected_team,
          wl.spread,
          wl.odds_american,
          wl.status AS leg_status,
          gl.sport,
          gl.market_key,
          gl.starts_at::text AS starts_at,
          (gl.starts_at AT TIME ZONE 'UTC')::date::text AS starts_on,
          gl.away_team,
          gl.home_team
        FROM wager w
        JOIN wager_leg wl ON wl.wager_id = w.id
        JOIN game_line gl ON gl.id = wl.game_line_id
        WHERE (w.status = 'pending' OR (w.status <> 'pending' AND wl.status = 'pending'))
          AND w.kind IN ('straight', 'parlay', 'round_robin')
          AND EXISTS (
            SELECT 1
            FROM wager_leg target_wl
            JOIN game_line target_gl ON target_gl.id = target_wl.game_line_id
            WHERE target_wl.wager_id = w.id
              AND target_wl.status = 'pending'
              AND target_gl.sport = ANY($1::sport_key[])
          )
      `,
      [sports]
    );

    const settled: Array<{ wagerId: string; kind: PendingLeg["kind"]; status: WagerOutcome; balanceDeltaCents: number }> = [];
    const settledLegsPartial: Array<{ wagerId: string; legId: string; outcome: WagerOutcome }> = [];
    const settledRoundRobinWays: Array<{
      wagerId: string;
      wayKey: string;
      status: WagerOutcome;
      payoutCents: number;
      profitCents: number;
    }> = [];
    const unmatched: Array<{
      wagerId: string;
      awayTeam: string;
      homeTeam: string;
      startsOn: string;
      candidates: MatchCandidateSummary[];
    }> = [];
    const wagers = new Map<string, PendingLeg[]>();

    for (const leg of pending.rows) {
      wagers.set(leg.wager_id, [...(wagers.get(leg.wager_id) ?? []), leg]);
    }

    for (const [wagerId, legs] of wagers.entries()) {
      const settledLegs: SettledLeg[] = [];
      let hasUnmatchedLeg = false;

      for (const leg of legs) {
        if (leg.leg_status !== "pending") {
          settledLegs.push({ ...leg, outcome: leg.leg_status });
          continue;
        }

        if (!sports.includes(leg.sport)) {
          hasUnmatchedLeg = true;
          continue;
        }

        const match = matchFinalGame(leg, finalMap, finals, aliases);
        const game = match.game;
        if (!game) {
          unmatched.push({
            wagerId: leg.wager_id,
            awayTeam: leg.away_team,
            homeTeam: leg.home_team,
            startsOn: leg.starts_on,
            candidates: match.candidates
          });
          hasUnmatchedLeg = true;
          continue;
        }

        settledLegs.push({ ...leg, outcome: outcomeForLeg(leg, game) });
      }

      for (const leg of settledLegs) {
        const updated = await client.query(
          "UPDATE wager_leg SET status = $1 WHERE id = $2 AND status = 'pending' RETURNING id",
          [leg.outcome, leg.leg_id]
        );
        if ((updated.rowCount ?? 0) > 0) {
          settledLegsPartial.push({ wagerId, legId: leg.leg_id, outcome: leg.outcome });
        }
      }

      const firstLeg = legs[0];
      if (firstLeg.wager_status !== "pending") {
        continue;
      }

      if (hasUnmatchedLeg) {
        if (firstLeg.kind === "round_robin") {
          const roundRobin = await settleRoundRobinWays(client, firstLeg, legs, settledLegs);
          for (const way of roundRobin.newlySettled) {
            settledRoundRobinWays.push({ wagerId, ...way });
          }
        }
        if (firstLeg.kind === "parlay" && settledLegs.some((leg) => leg.outcome === "lost")) {
          await client.query("UPDATE wager SET status = 'lost', potential_payout_cents = 0 WHERE id = $1", [wagerId]);
          await client.query(
            `
              UPDATE weekly_entry
              SET settled_profit_cents = settled_profit_cents - $1
              WHERE id = $2
            `,
            [firstLeg.stake_cents, firstLeg.weekly_entry_id]
          );
          settled.push({ wagerId, kind: firstLeg.kind, status: "lost", balanceDeltaCents: 0 });
        }
        continue;
      }

      if (firstLeg.kind === "round_robin") {
        const roundRobin = await settleRoundRobinWays(client, firstLeg, legs, settledLegs);
        for (const way of roundRobin.newlySettled) {
          settledRoundRobinWays.push({ wagerId, ...way });
        }

        if (roundRobin.settledWays >= roundRobin.expectedWays) {
          const status = roundRobin.payoutCents > firstLeg.stake_cents
            ? "won" as const
            : roundRobin.payoutCents === firstLeg.stake_cents
              ? "push" as const
              : "lost" as const;

          await client.query("UPDATE wager SET status = $1, potential_payout_cents = $2 WHERE id = $3", [status, roundRobin.payoutCents, wagerId]);
          settled.push({ wagerId, kind: firstLeg.kind, status, balanceDeltaCents: roundRobin.payoutDeltaCents });
        }
        continue;
      }

      const status = outcomeForSettledLegs(firstLeg.kind, settledLegs);
      const winningLegs = settledLegs.filter((leg) => leg.outcome === "won");
      const potentialPayoutCents = status === "won" && winningLegs.length < settledLegs.length
        ? payoutCentsForWinningLegs(firstLeg.stake_cents, winningLegs)
        : firstLeg.potential_payout_cents;
      const settledPayoutCents = status === "won"
        ? potentialPayoutCents
        : status === "push" || status === "void"
          ? firstLeg.stake_cents
          : 0;
      const balanceDeltaCents = balanceDeltaForOutcome({
        outcome: status,
        stakeCents: firstLeg.stake_cents,
        potentialPayoutCents
      });
      const profitDeltaCents = profitCentsForOutcome({
        outcome: status,
        stakeCents: firstLeg.stake_cents,
        potentialPayoutCents
      });

      await client.query("UPDATE wager SET status = $1, potential_payout_cents = $2 WHERE id = $3", [status, settledPayoutCents, wagerId]);
      await client.query(
        `
          UPDATE weekly_entry
          SET balance_cents = balance_cents + $1,
              settled_profit_cents = settled_profit_cents + $2
          WHERE id = $3
        `,
        [balanceDeltaCents, profitDeltaCents, firstLeg.weekly_entry_id]
      );

      settled.push({ wagerId, kind: firstLeg.kind, status, balanceDeltaCents });
    }

    return {
      dateRange: { startDate, endDate },
      finals: finals.length,
      pendingChecked: wagers.size,
      settled,
      settledLegsPartial,
      settledRoundRobinWays,
      unmatched
    };
  });
};

export const settleMlbStraightWagers = async (
  startDate = yyyyMmDd(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)),
  endDate = yyyyMmDd(new Date())
) => {
  const finals = await fetchMlbFinals(startDate, endDate);
  return settleWagersForFinals({ startDate, endDate, sports: ["MLB"], finals });
};

export const settleSoccerWagers = async (
  startDate = yyyyMmDd(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
  endDate = yyyyMmDd(new Date())
) => {
  const finals = [
    ...await fetchSoccerFinals("EPL", startDate, endDate),
    ...await fetchSoccerFinals("WORLDCUP", startDate, endDate)
  ];
  return settleWagersForFinals({ startDate, endDate, sports: ["EPL", "WORLDCUP"], finals });
};
