import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { query, transaction } from "./db.js";

type LocalSport = "MLB" | "NHL" | "NFL" | "NBA" | "NCAAMB" | "NCAAF" | "EPL" | "WORLDCUP";

type ParlayOutcome = {
  name: string;
  price: number | null;
  point?: number;
};

type PricedOutcome = ParlayOutcome & { price: number };
type PricedSpreadOutcome = PricedOutcome & { point: number };
type MarketKey = "spreads" | "h2h" | "totals";

type ParlayMarket = {
  key: string;
  outcomes: ParlayOutcome[];
};

type ParlayBookmaker = {
  key: string;
  title: string;
  markets: ParlayMarket[];
};

type ParlayEvent = {
  id: string;
  canonical_event_id?: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: ParlayBookmaker[];
};

const sports: Array<{ local: LocalSport; parlay: string; league: string }> = [
  { local: "MLB", parlay: "baseball_mlb", league: "MLB" },
  { local: "NHL", parlay: "icehockey_nhl", league: "NHL" },
  { local: "NFL", parlay: "americanfootball_nfl", league: "NFL" },
  { local: "NBA", parlay: "basketball_nba", league: "NBA" },
  { local: "NCAAMB", parlay: "basketball_ncaab", league: "NCAA Men's Basketball" },
  { local: "NCAAF", parlay: "americanfootball_ncaaf", league: "NCAA Football" },
  { local: "EPL", parlay: "soccer_epl", league: "English Premier League" },
  { local: "WORLDCUP", parlay: "soccer_fifa_world_cup", league: "FIFA World Cup" }
];

const soccerSports = new Set<LocalSport>(["EPL", "WORLDCUP"]);
const oddsSourceSports = new Set<LocalSport>(["MLB", ...soccerSports]);

const soccerBookmakerFallbacks = () => unique([
  ...config.parlayBookmakers,
  "pinnacle",
  "fanduel",
  "draftkings",
  "betmgm",
  "caesars",
  "betrivers",
  "bovada"
].filter(Boolean));

const isRegularSeasonWindow = (sport: LocalSport, date = new Date()) => {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const monthDay = month * 100 + day;

  switch (sport) {
    case "MLB":
      return monthDay >= 320 && monthDay <= 930;
    case "NFL":
      return monthDay >= 901 || monthDay <= 110;
    case "NBA":
      return monthDay >= 1015 || monthDay <= 415;
    case "NHL":
      return monthDay >= 1001 || monthDay <= 420;
    case "NCAAMB":
      return monthDay >= 1101 || monthDay <= 315;
    case "NCAAF":
      return monthDay >= 820 || monthDay <= 115;
    case "EPL":
      return monthDay >= 801 || monthDay <= 531;
    case "WORLDCUP":
      return monthDay >= 601 && monthDay <= 731;
  }
};

type NormalizedLine = {
  providerEventId: string;
  startsAt: string;
  homeTeam: string;
  awayTeam: string;
  selectedTeam: string;
  spread: number;
  oddsAmerican: number;
  marketKey: MarketKey;
};

const unique = <T>(values: T[]) => [...new Set(values)];

const mlbBookmakerFallbacks = () => unique([
  ...config.parlayBookmakers,
  ...config.parlayMlbBookmakers,
  "bovada",
  "fanduel",
  "pinnacle",
  "betrivers",
  "betmgm",
  "caesars",
  "draftkings"
].filter(Boolean));

const hasCompleteMarket = (
  outcomes: ParlayOutcome[] | undefined,
  event: ParlayEvent,
  marketKey: MarketKey,
  requireStandardMlbRunline = false
) => {
  if (!outcomes) {
    return false;
  }

  if (marketKey === "totals") {
    return ["Over", "Under"].every((name) =>
      outcomes.some((outcome) =>
        outcome.name === name
        && typeof outcome.price === "number"
        && typeof outcome.point === "number"
      )
    );
  }

  const sides = [event.away_team, event.home_team].map((team) =>
    outcomes.find((outcome) =>
      outcome.name === team
      && typeof outcome.price === "number"
      && (marketKey === "h2h" || typeof outcome.point === "number")
    )
  );

  if (!sides.every(Boolean)) {
    return false;
  }

  if (!requireStandardMlbRunline || marketKey !== "spreads") {
    return true;
  }

  const [away, home] = sides as [ParlayOutcome, ParlayOutcome];
  return typeof away.point === "number"
    && typeof home.point === "number"
    && Math.abs(away.point) === 1.5
    && Math.abs(home.point) === 1.5
    && away.point + home.point === 0;
};

const impliedProbability = (americanOdds: number) => {
  return americanOdds > 0
    ? 100 / (americanOdds + 100)
    : Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
};

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const h2hHoldIsReasonable = (outcomes: ParlayOutcome[], event: ParlayEvent) => {
  const away = outcomes.find((outcome) => outcome.name === event.away_team);
  const home = outcomes.find((outcome) => outcome.name === event.home_team);
  if (typeof away?.price !== "number" || typeof home?.price !== "number") {
    return false;
  }

  const impliedSum = impliedProbability(away.price) + impliedProbability(home.price);
  return impliedSum >= 0.94 && impliedSum <= 1.25;
};

const moneylineDeviation = (outcomes: ParlayOutcome[], event: ParlayEvent, consensus: Map<string, number>) => {
  return Math.max(...[event.away_team, event.home_team].map((team) => {
    const outcome = outcomes.find((item) => item.name === team);
    const teamConsensus = consensus.get(team);
    if (typeof outcome?.price !== "number" || teamConsensus === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.abs(impliedProbability(outcome.price) - teamConsensus);
  }));
};

const eventStartKey = (commenceTime: string) => {
  const date = new Date(commenceTime);
  date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 5) * 5, 0, 0);
  return date.toISOString().replace(/[:.]/g, "");
};

const eventIdentity = (event: ParlayEvent) => {
  const startKey = eventStartKey(event.commence_time);
  const teamKey = (team: string) => team.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return [
    event.canonical_event_id ?? event.id,
    startKey,
    teamKey(event.away_team),
    teamKey(event.home_team)
  ].join("|");
};

const eventMergeKey = (event: ParlayEvent) => {
  return eventIdentity(event);
};

const mergeEvents = (eventGroups: ParlayEvent[][]) => {
  const merged = new Map<string, ParlayEvent>();

  for (const events of eventGroups) {
    for (const event of events) {
      const key = eventMergeKey(event);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...event, bookmakers: [...(event.bookmakers ?? [])] });
        continue;
      }

      if (new Date(event.commence_time).getTime() < new Date(existing.commence_time).getTime()) {
        existing.commence_time = event.commence_time;
      }

      const bookmakerMap = new Map((existing.bookmakers ?? []).map((bookmaker) => [bookmaker.key, bookmaker]));
      for (const bookmaker of event.bookmakers ?? []) {
        bookmakerMap.set(bookmaker.key, bookmaker);
      }
      existing.bookmakers = [...bookmakerMap.values()];
    }
  }

  return [...merged.values()];
};

const findPreferredMarket = (
  event: ParlayEvent,
  marketKey: MarketKey,
  bookmakerPriority: string[],
  requireStandardMlbRunline = false,
  requireTwoWayH2hHold = true
) => {
  const completeMarkets = (event.bookmakers ?? []).flatMap((bookmaker) => {
    const market = bookmaker.markets.find((item) => item.key === marketKey);
    const outcomes = market?.outcomes.filter((outcome) => typeof outcome.price === "number") ?? [];
    return hasCompleteMarket(outcomes, event, marketKey, requireStandardMlbRunline)
      ? [{ bookmaker, outcomes }]
      : [];
  });

  if (marketKey === "h2h" && requireTwoWayH2hHold) {
    const saneMarkets = completeMarkets.filter(({ outcomes }) => h2hHoldIsReasonable(outcomes, event));
    if (saneMarkets.length >= 2) {
      const consensus = new Map([event.away_team, event.home_team].map((team) => [
        team,
        median(saneMarkets.map(({ outcomes }) => {
          const outcome = outcomes.find((item) => item.name === team)!;
          return impliedProbability(outcome.price as number);
        }))
      ]));
      const byPriority = [...saneMarkets].sort((left, right) => {
        const leftIndex = bookmakerPriority.indexOf(left.bookmaker.key);
        const rightIndex = bookmakerPriority.indexOf(right.bookmaker.key);
        return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      });
      const preferred = byPriority.find(({ outcomes }) => moneylineDeviation(outcomes, event, consensus) <= 0.08);
      return preferred ?? saneMarkets.sort((left, right) =>
        moneylineDeviation(left.outcomes, event, consensus) - moneylineDeviation(right.outcomes, event, consensus)
      )[0];
    }

    if (saneMarkets.length === 1) {
      return saneMarkets[0];
    }

    return null;
  }

  for (const key of bookmakerPriority) {
    const bookmaker = event.bookmakers?.find((book) => book.key === key);
    const market = bookmaker?.markets.find((item) => item.key === marketKey);
    const outcomes = market?.outcomes.filter((outcome) => typeof outcome.price === "number") ?? [];
    if (bookmaker && hasCompleteMarket(outcomes, event, marketKey, requireStandardMlbRunline)) {
      return { bookmaker, outcomes };
    }
  }

  for (const bookmaker of event.bookmakers ?? []) {
    const market = bookmaker.markets.find((item) => item.key === marketKey);
    const outcomes = market?.outcomes.filter((outcome) => typeof outcome.price === "number") ?? [];
    if (hasCompleteMarket(outcomes, event, marketKey, requireStandardMlbRunline)) {
      return { bookmaker, outcomes };
    }
  }

  return null;
};

const normalizeSpreads = (
  event: ParlayEvent,
  bookmakerPriority: string[],
  requireStandardMlbRunline: boolean
): NormalizedLine[] => {
  const spread = findPreferredMarket(event, "spreads", bookmakerPriority, requireStandardMlbRunline);
  if (!spread) {
    return [];
  }
  const eventId = eventIdentity(event);

  return spread.outcomes
    .filter((outcome): outcome is PricedSpreadOutcome =>
      [event.home_team, event.away_team].includes(outcome.name)
      && typeof outcome.point === "number"
      && typeof outcome.price === "number"
    )
    .map((outcome) => ({
      providerEventId: `${eventId}:${spread.bookmaker.key}:spreads:${outcome.name}`,
      startsAt: event.commence_time,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      selectedTeam: outcome.name,
      spread: outcome.point!,
      oddsAmerican: outcome.price,
      marketKey: "spreads" as const
    }));
};

const normalizeMoneylines = (event: ParlayEvent, bookmakerPriority: string[]): NormalizedLine[] => {
  const moneyline = findPreferredMarket(event, "h2h", bookmakerPriority, false, !event.sport_key.startsWith("soccer_"));
  if (!moneyline) {
    return [];
  }
  const eventId = eventIdentity(event);

  return moneyline.outcomes
    .filter((outcome): outcome is PricedOutcome =>
      ([event.home_team, event.away_team].includes(outcome.name) || (event.sport_key.startsWith("soccer_") && outcome.name === "Draw"))
      && typeof outcome.price === "number"
    )
    .map((outcome) => ({
      providerEventId: `${eventId}:${moneyline.bookmaker.key}:h2h:${outcome.name}`,
      startsAt: event.commence_time,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      selectedTeam: outcome.name,
      spread: 0,
      oddsAmerican: outcome.price,
      marketKey: "h2h" as const
    }));
};

const normalizeTotals = (event: ParlayEvent, bookmakerPriority: string[]): NormalizedLine[] => {
  const total = findPreferredMarket(event, "totals", bookmakerPriority, false, false);
  if (!total) {
    return [];
  }
  const eventId = eventIdentity(event);

  return total.outcomes
    .filter((outcome): outcome is PricedSpreadOutcome =>
      ["Over", "Under"].includes(outcome.name)
      && typeof outcome.point === "number"
      && typeof outcome.price === "number"
    )
    .map((outcome) => ({
      providerEventId: `${eventId}:${total.bookmaker.key}:totals:${outcome.name}:${outcome.point}`,
      startsAt: event.commence_time,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      selectedTeam: outcome.name,
      spread: outcome.point,
      oddsAmerican: outcome.price,
      marketKey: "totals" as const
    }));
};

const normalizeMarkets = (
  event: ParlayEvent,
  includeMoneyline: boolean,
  includeTotals: boolean,
  bookmakerPriority: string[],
  requireStandardMlbRunline = false
) => {
  const lines = normalizeSpreads(event, bookmakerPriority, requireStandardMlbRunline);
  if (includeMoneyline) {
    lines.push(...normalizeMoneylines(event, bookmakerPriority));
  }
  if (includeTotals) {
    lines.push(...normalizeTotals(event, bookmakerPriority));
  }

  return lines;
};

const fetchSportOdds = async (sportKey: string, markets: MarketKey[], bookmakers: string[]) => {
  if (!config.parlayApiKey) {
    throw new Error("PARLAY_API_KEY is not configured");
  }

  const base = config.parlayApiBaseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/sports/${sportKey}/odds`);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", markets.join(","));
  if (bookmakers.length === 1) {
    url.searchParams.set("bookmakers", bookmakers[0]);
  } else if (bookmakers.length > 1) {
    url.searchParams.set("bookmakers", bookmakers.join(","));
  }
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("dateFormat", "iso");

  const response = await fetch(url, {
    headers: { "X-API-Key": config.parlayApiKey }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Parlay API ${sportKey} failed with ${response.status}: ${body.slice(0, 200)}`);
  }

  return (await response.json()) as ParlayEvent[];
};

const fetchMergedSportOdds = async (sport: LocalSport, sportKey: string, markets: MarketKey[]) => {
  if (soccerSports.has(sport)) {
    const events = await fetchSportOdds(sportKey, markets, []);
    return {
      events,
      bookmakerPriority: soccerBookmakerFallbacks(),
      bookmakerFetches: [{ bookmakers: [], events: events.length }]
    };
  }

  if (sport !== "MLB") {
    const events = await fetchSportOdds(sportKey, markets, config.parlayBookmakers);
    return {
      events,
      bookmakerPriority: config.parlayBookmakers,
      bookmakerFetches: [{ bookmakers: config.parlayBookmakers, events: events.length }]
    };
  }

  const bookmakerPriority = mlbBookmakerFallbacks();
  const eventGroups: ParlayEvent[][] = [];
  const bookmakerFetches: Array<{ bookmakers: string[]; events: number }> = [];
  for (const bookmaker of bookmakerPriority) {
    const events = await fetchSportOdds(sportKey, markets, [bookmaker]);
    eventGroups.push(events);
    bookmakerFetches.push({ bookmakers: [bookmaker], events: events.length });
  }

  return {
    events: mergeEvents(eventGroups),
    bookmakerPriority,
    bookmakerFetches
  };
};

const hasUpcomingEventWithin24Hours = async (sportKey: string) => {
  if (!config.parlayApiKey) {
    throw new Error("PARLAY_API_KEY is not configured");
  }

  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const base = config.parlayApiBaseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/sports/${sportKey}/events`);
  url.searchParams.set("commenceTimeFrom", now.toISOString());
  url.searchParams.set("commenceTimeTo", tomorrow.toISOString());
  url.searchParams.set("dateFormat", "iso");

  const response = await fetch(url, {
    headers: { "X-API-Key": config.parlayApiKey }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Parlay API events ${sportKey} failed with ${response.status}: ${body.slice(0, 200)}`);
  }

  const events = (await response.json()) as ParlayEvent[];
  return events.length > 0;
};

const isDerivativeSoccerEvent = (event: ParlayEvent) => {
  return event.sport_key.startsWith("soccer_") && (
    /\([^)]*\)/.test(event.away_team)
    || /\([^)]*\)/.test(event.home_team)
  );
};

export const refreshOdds = async () => {
  const summary = {
    imported: 0,
    skippedEvents: 0,
    sports: [] as Array<{ sport: LocalSport; events: number; imported: number; skippedReason?: string }>
  };

  for (const sport of sports) {
    if (!soccerSports.has(sport.local) && !isRegularSeasonWindow(sport.local)) {
      await query("UPDATE game_line SET is_active = false WHERE source = 'parlay-api' AND sport = $1", [sport.local]);
      summary.sports.push({ sport: sport.local, events: 0, imported: 0, skippedReason: "outside regular season window" });
      continue;
    }

    const isInWindow = oddsSourceSports.has(sport.local) || await hasUpcomingEventWithin24Hours(sport.parlay);
    if (!isInWindow) {
      await query("UPDATE game_line SET is_active = false WHERE source = 'parlay-api' AND sport = $1", [sport.local]);
      summary.sports.push({ sport: sport.local, events: 0, imported: 0, skippedReason: "no games within 24 hours" });
      continue;
    }

    const includeMoneyline = sport.local === "MLB" || soccerSports.has(sport.local);
    const includeTotals = sport.local === "MLB";
    const requestedMarkets: MarketKey[] = ["spreads"];
    if (includeMoneyline) requestedMarkets.push("h2h");
    if (includeTotals) requestedMarkets.push("totals");
    const fetched = await fetchMergedSportOdds(sport.local, sport.parlay, requestedMarkets);
    const events = fetched.events.filter((event) => !isDerivativeSoccerEvent(event));
    const lines = events.flatMap((event) =>
      normalizeMarkets(event, includeMoneyline, includeTotals, fetched.bookmakerPriority, sport.local === "MLB")
    );

    await transaction(async (client) => {
      await client.query("UPDATE game_line SET is_active = false WHERE source = 'parlay-api' AND sport = $1", [sport.local]);

      for (const line of lines) {
        await client.query(
          `
            INSERT INTO game_line (
              id, provider_event_id, sport, league, starts_at, home_team, away_team,
              favorite_team, spread, odds_american, market_key, source, fetched_at, is_active
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'parlay-api', now(), true)
            ON CONFLICT (provider_event_id, source) WHERE provider_event_id IS NOT NULL
            DO UPDATE SET
              starts_at = EXCLUDED.starts_at,
              home_team = EXCLUDED.home_team,
              away_team = EXCLUDED.away_team,
              favorite_team = EXCLUDED.favorite_team,
              spread = EXCLUDED.spread,
              odds_american = EXCLUDED.odds_american,
              market_key = EXCLUDED.market_key,
              fetched_at = now(),
              is_active = true
          `,
          [
            randomUUID(),
            line.providerEventId,
            sport.local,
            sport.league,
            line.startsAt,
            line.homeTeam,
            line.awayTeam,
            line.selectedTeam,
            line.spread,
            line.oddsAmerican,
            line.marketKey
          ]
        );
      }
    });

    summary.imported += lines.length;
    summary.skippedEvents += events.filter((event) =>
      normalizeMarkets(event, includeMoneyline, includeTotals, fetched.bookmakerPriority, sport.local === "MLB").length === 0
    ).length;
    summary.sports.push({ sport: sport.local, events: events.length, imported: lines.length });
  }

  return summary;
};
