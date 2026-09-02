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

type RefreshOddsOptions = {
  sports?: LocalSport[];
  ignoreUpcomingWindow?: boolean;
};

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
  { local: "EPL", parlay: "soccer_epl", league: "English Premier League" }
];

const soccerSports = new Set<LocalSport>(["EPL"]);
const oddsSourceSports = new Set<LocalSport>(["MLB"]);

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
      return monthDay >= 801 || monthDay <= 110;
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

const ncaafTeamAliases: Record<string, string> = {
  "miami fl": "miami florida",
  "miami florida hurricanes": "miami florida",
  "miami oh": "miami ohio",
  "miami oh redhawks": "miami ohio",
  "massachusetts": "umass",
  "massachusetts minutemen": "umass",
  "umass minutemen": "umass",
  "u albany": "albany",
  "ualbany": "albany",
  "albany great danes": "albany",
  "buffalo bulls": "buffalo",
  "rutgers scarlet knights": "rutgers",
  "wake forest demon deacons": "wake forest",
  "delaware fighting blue hens": "delaware",
  "delaware fightin blue hens": "delaware",
  "colorado buffaloes": "colorado",
  "georgia tech yellow jackets": "georgia tech",
  "minnesota golden gophers": "minnesota",
  "west virginia mountaineers": "west virginia",
  "wv mountaineers": "west virginia",
  "connecticut": "uconn",
  "uconn huskies": "uconn",
  "usc trojans": "usc",
  "pittsburgh panthers": "pittsburgh",
  "cincinnati bearcats": "cincinnati",
  "houston cougars": "houston"
};

const normalizeFootballTeamKey = (team: string) =>
  team
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bst\.?\b/g, "state")
    .replace(/\bu\s+/g, "u")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const ncaafTeamKey = (team: string, batchAliases?: Map<string, string>) => {
  const normalized = normalizeFootballTeamKey(team);
  return batchAliases?.get(normalized) ?? ncaafTeamAliases[normalized] ?? normalized;
};

const ncaafDisplayNames: Record<string, string> = {
  "umass": "UMass",
  "uconn": "UConn",
  "usc": "USC",
  "uab": "UAB",
  "utsa": "UTSA",
  "utrgv": "UTRGV"
};

const toDisplayName = (key: string) =>
  ncaafDisplayNames[key] ?? key.replace(/\b\w/g, (letter) => letter.toUpperCase());

const ncaafDisplayName = (team: string) => toDisplayName(ncaafTeamKey(team));

export const footballEventIdentity = (
  sport: LocalSport,
  event: Pick<ParlayEvent, "canonical_event_id" | "id" | "sport_key" | "commence_time" | "away_team" | "home_team">,
  batchAliases?: Map<string, string>
) => {
  const startKey = eventStartKey(event.commence_time);
  if (sport === "NCAAF") {
    return [event.sport_key, startKey, ncaafTeamKey(event.away_team, batchAliases), ncaafTeamKey(event.home_team, batchAliases)].join("|");
  }
  return [
    event.sport_key,
    event.canonical_event_id ?? event.id,
    startKey,
    normalizeFootballTeamKey(event.away_team),
    normalizeFootballTeamKey(event.home_team)
  ].join("|");
};

export const isExpectedSportEvent = (sport: LocalSport, event: ParlayEvent) => {
  const expected = sports.find((item) => item.local === sport)?.parlay;
  if (event.sport_key !== expected) {
    return false;
  }
  if (sport === "NFL") {
    return nflTeamNameSet.has(event.away_team) && nflTeamNameSet.has(event.home_team);
  }
  if (sport === "NCAAF") {
    return !nflTeamNameSet.has(event.away_team) && !nflTeamNameSet.has(event.home_team);
  }
  return true;
};

const buildNcaafBatchAliases = (eventGroups: ParlayEvent[][]) => {
  const names = unique(eventGroups.flatMap((events) =>
    events.flatMap((event) => [
      ncaafTeamAliases[normalizeFootballTeamKey(event.away_team)] ?? normalizeFootballTeamKey(event.away_team),
      ncaafTeamAliases[normalizeFootballTeamKey(event.home_team)] ?? normalizeFootballTeamKey(event.home_team)
    ])
  )).sort((left, right) => left.length - right.length);

  const aliases = new Map<string, string>();
  for (const name of names) {
    const shorterPrefix = names.find((candidate) =>
      candidate !== name
      && name.startsWith(`${candidate} `)
      && candidate.length >= 4
    );
    aliases.set(name, shorterPrefix ?? name);
  }
  return aliases;
};

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

const footballBookmakerFallbacks = () => unique([
  ...config.parlayBookmakers,
  ...config.parlayFootballBookmakers,
  "bovada",
  "fanduel",
  "draftkings",
  "betmgm",
  "pinnacle",
  "caesars",
  "betrivers",
  "hardrock",
  "novig"
].filter(Boolean));

const hasCompleteMarket = (
  outcomes: ParlayOutcome[] | undefined,
  event: ParlayEvent,
  marketKey: MarketKey,
  requireStandardMlbRunline = false,
  sport?: LocalSport
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

  const teamMatches = (outcome: ParlayOutcome, team: string) =>
    outcome.name === team
    || (sport === "NCAAF" && ncaafTeamKey(outcome.name) === ncaafTeamKey(team));

  const sides = [event.away_team, event.home_team].map((team) =>
    outcomes.find((outcome) =>
      teamMatches(outcome, team)
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

const eventTeamOutcome = (outcomes: ParlayOutcome[], team: string, sport?: LocalSport) =>
  outcomes.find((outcome) =>
    outcome.name === team
    || (sport === "NCAAF" && ncaafTeamKey(outcome.name) === ncaafTeamKey(team))
  );

const h2hHoldIsReasonable = (outcomes: ParlayOutcome[], event: ParlayEvent, sport?: LocalSport) => {
  const away = eventTeamOutcome(outcomes, event.away_team, sport);
  const home = eventTeamOutcome(outcomes, event.home_team, sport);
  if (typeof away?.price !== "number" || typeof home?.price !== "number") {
    return false;
  }

  const impliedSum = impliedProbability(away.price) + impliedProbability(home.price);
  return impliedSum >= 0.94 && impliedSum <= 1.25;
};

const moneylineDeviation = (outcomes: ParlayOutcome[], event: ParlayEvent, consensus: Map<string, number>, sport?: LocalSport) => {
  return Math.max(...[event.away_team, event.home_team].map((team) => {
    const outcome = eventTeamOutcome(outcomes, team, sport);
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

const eventIdentity = (event: ParlayEvent, sport?: LocalSport, batchAliases?: Map<string, string>) => {
  if (sport === "NFL" || sport === "NCAAF") {
    return footballEventIdentity(sport, event, batchAliases);
  }
  const startKey = eventStartKey(event.commence_time);
  const teamKey = (team: string) => team.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return [
    event.canonical_event_id ?? event.id,
    startKey,
    teamKey(event.away_team),
    teamKey(event.home_team)
  ].join("|");
};

const eventMergeKey = (event: ParlayEvent, sport?: LocalSport, batchAliases?: Map<string, string>) => {
  return eventIdentity(event, sport, batchAliases);
};

const mergeEvents = (eventGroups: ParlayEvent[][], sport?: LocalSport) => {
  const merged = new Map<string, ParlayEvent>();
  const batchAliases = sport === "NCAAF" ? buildNcaafBatchAliases(eventGroups) : undefined;

  for (const events of eventGroups) {
    for (const event of events) {
      const key = eventMergeKey(event, sport, batchAliases);
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
  requireTwoWayH2hHold = true,
  sport?: LocalSport
) => {
  const completeMarkets = (event.bookmakers ?? []).flatMap((bookmaker) => {
    const market = bookmaker.markets.find((item) => item.key === marketKey);
    const outcomes = market?.outcomes.filter((outcome) => typeof outcome.price === "number") ?? [];
    return hasCompleteMarket(outcomes, event, marketKey, requireStandardMlbRunline, sport)
      ? [{ bookmaker, outcomes }]
      : [];
  });

  if (marketKey === "h2h" && requireTwoWayH2hHold) {
    const saneMarkets = completeMarkets.filter(({ outcomes }) => h2hHoldIsReasonable(outcomes, event, sport));
    if (saneMarkets.length >= 2) {
      const consensus = new Map([event.away_team, event.home_team].map((team) => [
        team,
        median(saneMarkets.map(({ outcomes }) => {
          const outcome = eventTeamOutcome(outcomes, team, sport)!;
          return impliedProbability(outcome.price as number);
        }))
      ]));
      const byPriority = [...saneMarkets].sort((left, right) => {
        const leftIndex = bookmakerPriority.indexOf(left.bookmaker.key);
        const rightIndex = bookmakerPriority.indexOf(right.bookmaker.key);
        return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      });
      const preferred = byPriority.find(({ outcomes }) => moneylineDeviation(outcomes, event, consensus, sport) <= 0.08);
      return preferred ?? saneMarkets.sort((left, right) =>
        moneylineDeviation(left.outcomes, event, consensus, sport) - moneylineDeviation(right.outcomes, event, consensus, sport)
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
    if (bookmaker && hasCompleteMarket(outcomes, event, marketKey, requireStandardMlbRunline, sport)) {
      return { bookmaker, outcomes };
    }
  }

  for (const bookmaker of event.bookmakers ?? []) {
    const market = bookmaker.markets.find((item) => item.key === marketKey);
    const outcomes = market?.outcomes.filter((outcome) => typeof outcome.price === "number") ?? [];
    if (hasCompleteMarket(outcomes, event, marketKey, requireStandardMlbRunline, sport)) {
      return { bookmaker, outcomes };
    }
  }

  return null;
};

const normalizeSpreads = (
  event: ParlayEvent,
  bookmakerPriority: string[],
  sport: LocalSport,
  requireStandardMlbRunline: boolean
): NormalizedLine[] => {
  const spread = findPreferredMarket(event, "spreads", bookmakerPriority, requireStandardMlbRunline, true, sport);
  if (!spread) {
    return [];
  }
  const eventId = eventIdentity(event, sport);
  const awayTeam = sport === "NCAAF" ? ncaafDisplayName(event.away_team) : event.away_team;
  const homeTeam = sport === "NCAAF" ? ncaafDisplayName(event.home_team) : event.home_team;

  return spread.outcomes
    .filter((outcome): outcome is PricedSpreadOutcome =>
      (
        [event.home_team, event.away_team].includes(outcome.name)
        || (sport === "NCAAF" && [event.home_team, event.away_team].some((team) => ncaafTeamKey(outcome.name) === ncaafTeamKey(team)))
      )
      && typeof outcome.point === "number"
      && typeof outcome.price === "number"
    )
    .map((outcome) => {
      const selectedTeam = sport === "NCAAF" && ncaafTeamKey(outcome.name) === ncaafTeamKey(awayTeam)
        ? awayTeam
        : sport === "NCAAF" && ncaafTeamKey(outcome.name) === ncaafTeamKey(event.home_team)
          ? homeTeam
          : outcome.name;
      return {
      providerEventId: `${eventId}:${spread.bookmaker.key}:spreads:${selectedTeam}`,
      startsAt: event.commence_time,
      homeTeam,
      awayTeam,
      selectedTeam,
      spread: outcome.point!,
      oddsAmerican: outcome.price,
      marketKey: "spreads" as const
    };
    });
};

const normalizeMoneylines = (event: ParlayEvent, bookmakerPriority: string[], sport: LocalSport): NormalizedLine[] => {
  const moneyline = findPreferredMarket(event, "h2h", bookmakerPriority, false, !event.sport_key.startsWith("soccer_"), sport);
  if (!moneyline) {
    return [];
  }
  const eventId = eventIdentity(event, sport);
  const awayTeam = sport === "NCAAF" ? ncaafDisplayName(event.away_team) : event.away_team;
  const homeTeam = sport === "NCAAF" ? ncaafDisplayName(event.home_team) : event.home_team;

  return moneyline.outcomes
    .filter((outcome): outcome is PricedOutcome =>
      (
        [event.home_team, event.away_team].includes(outcome.name)
        || (sport === "NCAAF" && [event.home_team, event.away_team].some((team) => ncaafTeamKey(outcome.name) === ncaafTeamKey(team)))
        || (event.sport_key.startsWith("soccer_") && outcome.name === "Draw")
      )
      && typeof outcome.price === "number"
    )
    .map((outcome) => {
      const selectedTeam = sport === "NCAAF" && ncaafTeamKey(outcome.name) === ncaafTeamKey(awayTeam)
        ? awayTeam
        : sport === "NCAAF" && ncaafTeamKey(outcome.name) === ncaafTeamKey(event.home_team)
          ? homeTeam
          : outcome.name;
      return {
      providerEventId: `${eventId}:${moneyline.bookmaker.key}:h2h:${selectedTeam}`,
      startsAt: event.commence_time,
      homeTeam,
      awayTeam,
      selectedTeam,
      spread: 0,
      oddsAmerican: outcome.price,
      marketKey: "h2h" as const
    };
    });
};

const normalizeTotals = (event: ParlayEvent, bookmakerPriority: string[], sport: LocalSport): NormalizedLine[] => {
  const total = findPreferredMarket(event, "totals", bookmakerPriority, false, false, sport);
  if (!total) {
    return [];
  }
  const eventId = eventIdentity(event, sport);
  const awayTeam = sport === "NCAAF" ? ncaafDisplayName(event.away_team) : event.away_team;
  const homeTeam = sport === "NCAAF" ? ncaafDisplayName(event.home_team) : event.home_team;

  return total.outcomes
    .filter((outcome): outcome is PricedSpreadOutcome =>
      ["Over", "Under"].includes(outcome.name)
      && typeof outcome.point === "number"
      && typeof outcome.price === "number"
    )
    .map((outcome) => ({
      providerEventId: `${eventId}:${total.bookmaker.key}:totals:${outcome.name}:${outcome.point}`,
      startsAt: event.commence_time,
      homeTeam,
      awayTeam,
      selectedTeam: outcome.name,
      spread: outcome.point,
      oddsAmerican: outcome.price,
      marketKey: "totals" as const
    }));
};

const normalizeMarkets = (
  event: ParlayEvent,
  sport: LocalSport,
  includeMoneyline: boolean,
  includeTotals: boolean,
  bookmakerPriority: string[],
  requireStandardMlbRunline = false
) => {
  const lines = normalizeSpreads(event, bookmakerPriority, sport, requireStandardMlbRunline);
  if (includeMoneyline) {
    lines.push(...normalizeMoneylines(event, bookmakerPriority, sport));
  }
  if (includeTotals) {
    lines.push(...normalizeTotals(event, bookmakerPriority, sport));
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

  if (sport === "NFL" || sport === "NCAAF") {
    const bookmakerPriority = footballBookmakerFallbacks();
    const eventGroups: ParlayEvent[][] = [];
    const bookmakerFetches: Array<{ bookmakers: string[]; events: number }> = [];
    for (const bookmaker of bookmakerPriority) {
      const events = await fetchSportOdds(sportKey, markets, [bookmaker]);
      eventGroups.push(events);
      bookmakerFetches.push({ bookmakers: [bookmaker], events: events.length });
    }

    return {
      events: mergeEvents(eventGroups, sport),
      bookmakerPriority,
      bookmakerFetches
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
    events: mergeEvents(eventGroups, sport),
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

export const refreshOdds = async (options: RefreshOddsOptions = {}) => {
  const allowedSports = options.sports ? new Set(options.sports) : null;
  const summary = {
    imported: 0,
    skippedEvents: 0,
    sports: [] as Array<{ sport: LocalSport; events: number; imported: number; skippedReason?: string }>
  };

  for (const sport of sports) {
    if (allowedSports && !allowedSports.has(sport.local)) {
      continue;
    }

    if (!soccerSports.has(sport.local) && !isRegularSeasonWindow(sport.local)) {
      await query("UPDATE game_line SET is_active = false WHERE source = 'parlay-api' AND sport = $1", [sport.local]);
      summary.sports.push({ sport: sport.local, events: 0, imported: 0, skippedReason: "outside regular season window" });
      continue;
    }

    const isInWindow = options.ignoreUpcomingWindow || oddsSourceSports.has(sport.local) || await hasUpcomingEventWithin24Hours(sport.parlay);
    if (!isInWindow) {
      await query("UPDATE game_line SET is_active = false WHERE source = 'parlay-api' AND sport = $1", [sport.local]);
      summary.sports.push({ sport: sport.local, events: 0, imported: 0, skippedReason: "no games within 24 hours" });
      continue;
    }

    const isFootball = sport.local === "NFL" || sport.local === "NCAAF";
    const includeMoneyline = sport.local === "MLB" || soccerSports.has(sport.local) || isFootball;
    const includeTotals = sport.local === "MLB" || isFootball;
    const requestedMarkets: MarketKey[] = ["spreads"];
    if (includeMoneyline) requestedMarkets.push("h2h");
    if (includeTotals) requestedMarkets.push("totals");
    const fetched = await fetchMergedSportOdds(sport.local, sport.parlay, requestedMarkets);
    const events = fetched.events.filter((event) => isExpectedSportEvent(sport.local, event) && !isDerivativeSoccerEvent(event));
    const lines = events.flatMap((event) =>
      normalizeMarkets(event, sport.local, includeMoneyline, includeTotals, fetched.bookmakerPriority, sport.local === "MLB")
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
      normalizeMarkets(event, sport.local, includeMoneyline, includeTotals, fetched.bookmakerPriority, sport.local === "MLB").length === 0
    ).length;
    summary.sports.push({ sport: sport.local, events: events.length, imported: lines.length });
  }

  return summary;
};
