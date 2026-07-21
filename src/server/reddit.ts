import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { outcomeForSelection, type FinalGame } from "./settlement.js";

export type RedditPostPreview = {
  subreddit: string;
  title: string;
  body: string;
};

const cleanSubreddit = (subreddit: string) => subreddit.trim().replace(/^r\//i, "");

type TrackedStatus = "pending" | "won" | "lost" | "push" | "void";

type RedditPickRow = {
  id: string;
  ai_pick_id: string;
  game_line_id: string;
  pick_date: string;
  selected_team: string;
  status: TrackedStatus;
  sport: string;
  league: string;
  market_key: "h2h" | "spreads" | "totals";
  spread: string;
  odds_american: number;
  decimal_odds: string;
  units: string;
  away_team: string;
  home_team: string;
  starts_at: Date;
  confidence: string | null;
  edge: string | null;
  features: Record<string, unknown> | null;
  reasons: string[];
  explanation: string | null;
};

type RedditCandidatePickRow = Omit<RedditPickRow, "id" | "status">;

type RedditRecordPickRow = RedditPickRow & {
  profit_units: string;
};

type RedditParlayRow = {
  id: string;
  pick_date: string;
  units: string;
  status: TrackedStatus;
  profit_units: string;
  locked_at?: Date | null;
};

type RedditParlayLegRow = RedditPickRow & {
  id: string;
  parlay_id: string;
  leg_index: number;
  status: TrackedStatus;
  profit_units?: string;
};

type RedditAllPickRow = {
  id: string;
  pick_date: string;
  locked_at?: Date | null;
};

type RedditAllPickLegRow = RedditPickRow & {
  id: string;
  all_pick_id: string;
  leg_index: number;
  status: TrackedStatus;
  profit_units: string;
};

const americanToDecimal = (odds: number) => odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);

const redditSingleMinAmericanOdds = -200;
const redditSingleMaxAmericanOdds = 200;

const isValidRedditSingleOdds = (odds: number) =>
  odds >= redditSingleMinAmericanOdds && odds <= redditSingleMaxAmericanOdds;

const formatDecimal = (value: number, digits = 2) => value.toFixed(digits);

const formatAmericanOdds = (odds: number) => `${odds > 0 ? "+" : ""}${odds}`;

const formatUnits = (units: string | number) => `${Number(units).toFixed(Number.isInteger(Number(units)) ? 0 : 1)}u`;

const formatReturnUnits = (units: number) => `${units.toFixed(2)}u`;

const formatSignedUnits = (value: number) => {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "+";
  return `${sign}${Math.abs(value).toFixed(2)}u`;
};

const formatCstDate = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("weekday")}, ${value("day")}. ${value("month")}. ${value("year")}. ${value("hour")}:${value("minute")} CST`;
};

const formatCstTime = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("hour")}:${value("minute")} CST`;
};

const eventName = (pick: Pick<RedditPickRow, "sport" | "league">) => {
  if (pick.sport === "WORLDCUP") return "World Cup 2026";
  if (pick.sport === "EPL") return "English Premier League";
  return pick.league || pick.sport;
};

const pickBullet = (pick: Pick<RedditPickRow, "selected_team" | "market_key" | "spread" | "sport">) => {
  if (pick.market_key === "h2h") {
    return pick.selected_team === "Draw" ? "Draw" : `${pick.selected_team} to Win`;
  }
  if (pick.market_key === "spreads") {
    const spread = Number(pick.spread);
    return `${pick.selected_team} ${spread > 0 ? `+${pick.spread}` : pick.spread}`;
  }
  const totalLabel = pick.sport === "MLB" ? "Runs" : "Goals";
  return `${pick.selected_team} ${pick.spread} ${totalLabel}`;
};

const redditReasonLabel = (reason: string) => {
  const lower = reason.toLowerCase();
  if (lower.includes("multiple complete markets")) return "";
  if (lower.includes("moneyline-specific")) return "Strong moneyline profile";
  if (lower.includes("home-field") || lower.includes("home field")) return "Home-field advantage";
  if (lower.includes("starter") || lower.includes("starting pitcher")) return "Better starting pitcher";
  if (lower.includes("bullpen")) return "Bullpen advantage";
  if (lower.includes("hitter") || lower.includes("lineup") || lower.includes("platoon")) return "Favorable matchup vs. opposing starter";
  if (lower.includes("offense") || lower.includes("scoring")) return "Recent offense advantage";
  if (lower.includes("run-prevention")) return "Recent run prevention edge";
  if (lower.includes("home/road") || lower.includes("venue")) return "Home/road form advantage";
  if (lower.includes("rest")) return "Rest advantage";
  if (lower.includes("injury") || lower.includes("availability")) return "Health and availability edge";
  if (lower.includes("market") || lower.includes("price") || lower.includes("underdog")) return "Market value";
  if (lower.includes("win-form") || lower.includes("run-differential")) return "Recent form advantage";
  return reason.replace(/\s+edge$/i, " advantage");
};

const redditWhyBullets = (reasons: string[]) => {
  const positiveReasons = reasons.filter((reason) => !/concern|penalty|disadvantage|cap|uncertainty/i.test(reason));
  const labels = positiveReasons.map(redditReasonLabel).filter(Boolean);
  const uniqueLabels = [...new Set(labels)].slice(0, 3);
  return uniqueLabels.length ? uniqueLabels : ["Model sees value at the current price"];
};

const positiveReasonLabels = (reasons: string[]) => {
  const positiveReasons = reasons.filter((reason) => !/concern|penalty|disadvantage|cap|uncertainty/i.test(reason));
  return [...new Set(positiveReasons.map(redditReasonLabel).filter(Boolean))]
    .filter((label) => label !== "Strong moneyline profile");
};

const compactTeamName = (team: string) => {
  const aliases: Record<string, string> = {
    "Los Angeles Angels": "Angels",
    "Texas Rangers": "Rangers",
    "Tampa Bay Rays": "Rays",
    "New York Yankees": "Yankees",
    "Seattle Mariners": "Mariners",
    "Miami Marlins": "Marlins",
    "New York Mets": "Mets",
    "Philadelphia Phillies": "Phillies",
    "Cincinnati Reds": "Reds",
    "Milwaukee Brewers": "Brewers",
    "St. Louis Cardinals": "Cardinals",
    "San Francisco Giants": "Giants",
    "Colorado Rockies": "Rockies",
    "Chicago Cubs": "Cubs",
    "Arizona Diamondbacks": "Diamondbacks"
  };
  return aliases[team] ?? team;
};

const possessiveTeam = (team: string) => `${team}${team.endsWith("s") ? "'" : "'s"}`;

const joinTeamNames = (teams: string[]) => {
  const unique = [...new Set(teams.map(compactTeamName))];
  if (unique.length <= 1) return unique[0] ?? "";
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
};

const parlayReasonPhrase = (label: string) => {
  if (label === "Home-field advantage") return "a small home-field bump";
  if (label === "Strong moneyline profile") return "a strong moneyline profile";
  if (label === "Better starting pitcher") return "a starting pitcher edge";
  if (label === "Bullpen advantage") return "a bullpen edge";
  if (label === "Favorable matchup vs. opposing starter") return "a favorable hitter/pitcher matchup";
  if (label === "Recent offense advantage") return "a recent offense edge";
  if (label === "Recent run prevention edge") return "a recent run prevention edge";
  if (label === "Home/road form advantage") return "a home/road form edge";
  if (label === "Rest advantage") return "a rest edge";
  if (label === "Health and availability edge") return "a health and availability edge";
  if (label === "Market value") return "market value";
  if (label === "Recent form advantage") return "a recent form edge";
  return label.charAt(0).toLowerCase() + label.slice(1);
};

const parlayReasonPriority = (label: string) => {
  const priorities: Record<string, number> = {
    "Recent run prevention edge": 100,
    "Better starting pitcher": 95,
    "Bullpen advantage": 90,
    "Recent offense advantage": 85,
    "Home-field advantage": 80,
    "Home/road form advantage": 75,
    "Recent form advantage": 70,
    "Favorable matchup vs. opposing starter": 65,
    "Health and availability edge": 60,
    "Rest advantage": 55,
    "Market value": 45,
    "Strong moneyline profile": 35
  };
  return priorities[label] ?? 50;
};

type ParlayFact = {
  category: string;
  priority: number;
  team: string;
  text: string;
};

const addParlayFact = (facts: ParlayFact[], fact: ParlayFact | null) => {
  if (fact) {
    facts.push(fact);
  }
};

const concreteParlayFacts = (legs: RedditParlayLegRow[]) => {
  const facts: ParlayFact[] = [];

  for (const leg of legs) {
    const features = leg.features;
    const selectedShort = compactTeamName(leg.selected_team);
    const opponentShort = compactTeamName(selectedOpponent(leg));

    const selectedRunsAgainst7 = featureNumber(features, "selectedRunsAgainstPerGame7");
    const opponentRunsAgainst7 = featureNumber(features, "opponentRunsAgainstPerGame7");
    addParlayFact(facts, selectedRunsAgainst7 !== null && opponentRunsAgainst7 !== null && selectedRunsAgainst7 <= opponentRunsAgainst7 - 0.75
      ? {
        category: "run prevention",
        priority: Math.abs(opponentRunsAgainst7 - selectedRunsAgainst7) + 10,
        team: leg.selected_team,
        text: `${selectedShort} have allowed ${formatStat(selectedRunsAgainst7)} runs per game over the last week versus ${formatStat(opponentRunsAgainst7)} for ${opponentShort}`
      }
      : null);

    const selectedRunsFor7 = featureNumber(features, "selectedRunsForPerGame7");
    const opponentRunsFor7 = featureNumber(features, "opponentRunsForPerGame7");
    addParlayFact(facts, selectedRunsFor7 !== null && opponentRunsFor7 !== null && selectedRunsFor7 >= opponentRunsFor7 + 0.75
      ? {
        category: "offense",
        priority: Math.abs(selectedRunsFor7 - opponentRunsFor7) + 8,
        team: leg.selected_team,
        text: `${selectedShort} are scoring ${formatStat(selectedRunsFor7)} runs per game over the last week compared with ${formatStat(opponentRunsFor7)} for ${opponentShort}`
      }
      : null);

    const selectedStarterEra = featureNumber(features, "selectedStarterEra");
    const opponentStarterEra = featureNumber(features, "opponentStarterEra");
    addParlayFact(facts, selectedStarterEra !== null && opponentStarterEra !== null && selectedStarterEra <= opponentStarterEra - 0.5
      ? {
        category: "starter",
        priority: Math.abs(opponentStarterEra - selectedStarterEra) + 9,
        team: leg.selected_team,
        text: `${selectedShort} get the listed starter edge at ${formatStat(selectedStarterEra, 2)} ERA against ${formatStat(opponentStarterEra, 2)} for ${opponentShort}`
      }
      : null);

    const selectedStarterVenueEra = featureNumber(features, "selectedStarterVenueEra");
    const opponentStarterVenueEra = featureNumber(features, "opponentStarterVenueEra");
    addParlayFact(facts, selectedStarterVenueEra !== null && opponentStarterVenueEra !== null && selectedStarterVenueEra <= opponentStarterVenueEra - 1
      ? {
        category: "starter venue split",
        priority: Math.abs(opponentStarterVenueEra - selectedStarterVenueEra) + 8,
        team: leg.selected_team,
        text: `${possessiveTeam(selectedShort)} starter also fits today's venue split better, ${formatStat(selectedStarterVenueEra, 2)} ERA to ${formatStat(opponentStarterVenueEra, 2)}`
      }
      : null);

    const selectedBullpenPitches3 = featureNumber(features, "selectedBullpenPitchesLast3");
    const opponentBullpenPitches3 = featureNumber(features, "opponentBullpenPitchesLast3");
    addParlayFact(facts, selectedBullpenPitches3 !== null && opponentBullpenPitches3 !== null && selectedBullpenPitches3 <= opponentBullpenPitches3 - 20
      ? {
        category: "bullpen freshness",
        priority: Math.min(Math.abs(opponentBullpenPitches3 - selectedBullpenPitches3) / 20, 5) + 7,
        team: leg.selected_team,
        text: `${possessiveTeam(opponentShort)} bullpen has been worked harder recently, ${Math.round(opponentBullpenPitches3)} pitches over three games versus ${Math.round(selectedBullpenPitches3)} for ${selectedShort}`
      }
      : null);

    const selectedVenueRunDiff = featureNumber(features, "selectedVenueRunDiffPerGame");
    const opponentVenueRunDiff = featureNumber(features, "opponentVenueRunDiffPerGame");
    addParlayFact(facts, selectedVenueRunDiff !== null && opponentVenueRunDiff !== null && selectedVenueRunDiff >= opponentVenueRunDiff + 1
      ? {
        category: "home/road split",
        priority: Math.abs(selectedVenueRunDiff - opponentVenueRunDiff) + 6,
        team: leg.selected_team,
        text: `${possessiveTeam(selectedShort)} home/road profile is stronger at ${formatSignedStat(selectedVenueRunDiff)} runs per game while ${opponentShort} sit at ${formatSignedStat(opponentVenueRunDiff)}`
      }
      : null);

    const fairProbability = featureNumber(features, "fairProbability");
    const impliedProbability = featureNumber(features, "impliedProbability");
    addParlayFact(facts, fairProbability !== null && impliedProbability !== null && fairProbability >= impliedProbability + 0.02
      ? {
        category: "price",
        priority: Math.abs(fairProbability - impliedProbability) * 100 + 4,
        team: leg.selected_team,
        text: `${selectedShort} still price above the market, ${formatProb(fairProbability)} fair win chance versus ${formatProb(impliedProbability)} implied`
      }
      : null);
  }

  return facts
    .sort((left, right) => right.priority - left.priority)
    .filter((fact, index, all) =>
      all.findIndex((candidate) => candidate.category === fact.category && candidate.team === fact.team) === index
    );
};

const parlayNarrative = (legs: RedditParlayLegRow[]) => {
  const concreteFacts = concreteParlayFacts(legs).slice(0, 4);
  if (concreteFacts.length) {
    const categories = [...new Set(concreteFacts.map((fact) => fact.category))];
    const lead = categories.length >= 2
      ? `Chine is pairing these legs because the card has multiple independent edges: ${categories.slice(0, 3).join(", ")}.`
      : `Chine is pairing these legs around a clear ${categories[0]} theme.`;
    const sentences = concreteFacts.map((fact) => `${fact.text}.`);
    return [
      lead,
      ...sentences,
      "The goal is not to force a long shot, but to combine the strongest prices from today's board."
    ].join(" ");
  }

  const reasonMap = new Map<string, string[]>();
  for (const leg of legs) {
    for (const label of positiveReasonLabels(leg.reasons)) {
      const teams = reasonMap.get(label) ?? [];
      teams.push(leg.selected_team);
      reasonMap.set(label, teams);
    }
  }

  const groupedReasons = [...reasonMap.entries()]
    .sort((left, right) =>
      right[1].length - left[1].length
      || parlayReasonPriority(right[0]) - parlayReasonPriority(left[0])
      || left[0].localeCompare(right[0])
    )
    .slice(0, 3);

  if (!groupedReasons.length) {
    return "Chine sees enough combined price and matchup value to tie these three sides together.";
  }

  const clauses = groupedReasons.map(([label, teams]) => {
    const phrase = parlayReasonPhrase(label);
    const names = joinTeamNames(teams);
    if (teams.length > 1) {
      return `${names} ${teams.length === 2 ? "both show" : "all show"} ${phrase}`;
    }
    const verb = names.endsWith("s") ? "get" : "gets";
    return `${names} ${verb} ${phrase}`;
  });

  if (clauses.length === 1) {
    return `${clauses[0]}. The parlay leans on correlated model positives without stretching beyond the top available Chine plays.`;
  }
  return `${clauses[0]}. ${clauses.slice(1).join(", while ")}. The parlay leans on correlated model positives without stretching beyond the top available Chine plays.`;
};

const featureNumber = (features: Record<string, unknown> | null | undefined, key: string) => {
  const raw = features?.[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const formatStat = (value: number, digits = 1) => value.toFixed(digits);

const formatSignedStat = (value: number, digits = 1) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;

const formatProb = (value: number) => `${(value * 100).toFixed(1)}%`;

const selectedOpponent = (pick: Pick<RedditPickRow, "selected_team" | "away_team" | "home_team">) =>
  pick.selected_team === pick.away_team ? pick.home_team : pick.away_team;

const concretePickFacts = (pick: Pick<RedditPickRow, "selected_team" | "away_team" | "home_team" | "odds_american" | "features">) => {
  const features = pick.features;
  const opponent = selectedOpponent(pick);
  const selectedShort = compactTeamName(pick.selected_team);
  const opponentShort = compactTeamName(opponent);
  const facts: Array<{ priority: number; text: string }> = [];

  const selectedRunsAgainst7 = featureNumber(features, "selectedRunsAgainstPerGame7");
  const opponentRunsAgainst7 = featureNumber(features, "opponentRunsAgainstPerGame7");
  if (selectedRunsAgainst7 !== null && opponentRunsAgainst7 !== null && selectedRunsAgainst7 <= opponentRunsAgainst7 - 0.75) {
    facts.push({
      priority: Math.abs(opponentRunsAgainst7 - selectedRunsAgainst7) + 9,
      text: `Over the last seven games, ${selectedShort} have allowed ${formatStat(selectedRunsAgainst7)} runs per game while ${opponentShort} have allowed ${formatStat(opponentRunsAgainst7)}.`
    });
  }

  const selectedRunsFor7 = featureNumber(features, "selectedRunsForPerGame7");
  const opponentRunsFor7 = featureNumber(features, "opponentRunsForPerGame7");
  if (selectedRunsFor7 !== null && opponentRunsFor7 !== null && selectedRunsFor7 >= opponentRunsFor7 + 0.75) {
    facts.push({
      priority: Math.abs(selectedRunsFor7 - opponentRunsFor7) + 7,
      text: `${selectedShort} are scoring ${formatStat(selectedRunsFor7)} runs per game over the last week, compared with ${formatStat(opponentRunsFor7)} for ${opponentShort}.`
    });
  }

  const selectedStarterEra = featureNumber(features, "selectedStarterEra");
  const opponentStarterEra = featureNumber(features, "opponentStarterEra");
  if (selectedStarterEra !== null && opponentStarterEra !== null && selectedStarterEra <= opponentStarterEra - 0.5) {
    facts.push({
      priority: Math.abs(opponentStarterEra - selectedStarterEra) + 8,
      text: `The listed starter matchup leans ${selectedShort}: ${formatStat(selectedStarterEra, 2)} ERA versus ${formatStat(opponentStarterEra, 2)} for ${opponentShort}.`
    });
  }

  const selectedStarterRecentEra = featureNumber(features, "selectedStarterRecentEra");
  const opponentStarterRecentEra = featureNumber(features, "opponentStarterRecentEra");
  if (selectedStarterRecentEra !== null && opponentStarterRecentEra !== null && selectedStarterRecentEra <= opponentStarterRecentEra - 0.75) {
    facts.push({
      priority: Math.abs(opponentStarterRecentEra - selectedStarterRecentEra) + 7,
      text: `Recent starter form also favors ${selectedShort}, ${formatStat(selectedStarterRecentEra, 2)} ERA to ${formatStat(opponentStarterRecentEra, 2)}.`
    });
  }

  const selectedBullpenPitches3 = featureNumber(features, "selectedBullpenPitchesLast3");
  const opponentBullpenPitches3 = featureNumber(features, "opponentBullpenPitchesLast3");
  if (selectedBullpenPitches3 !== null && opponentBullpenPitches3 !== null && selectedBullpenPitches3 <= opponentBullpenPitches3 - 20) {
    facts.push({
      priority: Math.min(Math.abs(opponentBullpenPitches3 - selectedBullpenPitches3) / 20, 5) + 6,
      text: `${opponentShort}' bullpen has been busier recently, throwing ${Math.round(opponentBullpenPitches3)} pitches over the last three games versus ${Math.round(selectedBullpenPitches3)} for ${selectedShort}.`
    });
  }

  const selectedVenueRunDiff = featureNumber(features, "selectedVenueRunDiffPerGame");
  const opponentVenueRunDiff = featureNumber(features, "opponentVenueRunDiffPerGame");
  if (selectedVenueRunDiff !== null && opponentVenueRunDiff !== null && selectedVenueRunDiff >= opponentVenueRunDiff + 1) {
    facts.push({
      priority: Math.abs(selectedVenueRunDiff - opponentVenueRunDiff) + 5,
      text: `The home/road split is meaningful: ${selectedShort} are ${formatSignedStat(selectedVenueRunDiff)} runs per game in this venue split, while ${opponentShort} are ${formatSignedStat(opponentVenueRunDiff)}.`
    });
  }

  const selectedOps = featureNumber(features, "selectedHitterOpsVsPitchHand");
  const opponentOps = featureNumber(features, "opponentHitterOpsVsPitchHand");
  if (selectedOps !== null && opponentOps !== null && selectedOps >= opponentOps + 0.01) {
    facts.push({
      priority: Math.abs(selectedOps - opponentOps) * 100 + 4,
      text: `The projected handedness matchup is slightly better for ${selectedShort}, with a ${formatStat(selectedOps, 3)} OPS profile versus ${formatStat(opponentOps, 3)} for ${opponentShort}.`
    });
  }

  const selectedIl = featureNumber(features, "selectedActiveIlPlayers");
  const opponentIl = featureNumber(features, "opponentActiveIlPlayers");
  if (selectedIl !== null && opponentIl !== null && selectedIl <= opponentIl - 3) {
    facts.push({
      priority: Math.min(Math.abs(opponentIl - selectedIl), 7) + 3,
      text: `${selectedShort} also have the cleaner availability table, with ${Math.round(selectedIl)} active IL players versus ${Math.round(opponentIl)} for ${opponentShort}.`
    });
  }

  const fairProbability = featureNumber(features, "fairProbability");
  const impliedProbability = featureNumber(features, "impliedProbability");
  if (fairProbability !== null && impliedProbability !== null && fairProbability >= impliedProbability + 0.015) {
    facts.push({
      priority: Math.abs(fairProbability - impliedProbability) * 100 + 2,
      text: `At ${formatAmericanOdds(pick.odds_american)}, Chine prices the win chance around ${formatProb(fairProbability)} versus ${formatProb(impliedProbability)} implied by the market.`
    });
  }

  return facts
    .sort((left, right) => right.priority - left.priority)
    .map((fact) => fact.text)
    .filter((text, index, all) => all.indexOf(text) === index)
    .slice(0, 3);
};

const pickNarrative = (pick: Pick<RedditPickRow, "selected_team" | "away_team" | "home_team" | "odds_american" | "sport" | "market_key" | "spread" | "reasons" | "confidence" | "edge" | "features" | "explanation" | "units">) => {
  const confidence = pick.confidence ? `${Math.round(Number(pick.confidence) * 100)}%` : null;
  const edge = pick.edge ? `${(Number(pick.edge) * 100).toFixed(1)}%` : null;
  const lead = `Chine's top play is ${pickBullet(pick)}${confidence ? ` at ${confidence} confidence` : ""}${edge ? ` with a ${edge} projected edge` : ""}.`;
  const facts = concretePickFacts(pick);
  if (facts.length) {
    return [lead, ...facts, `That is enough for a ${formatUnits(pick.units)} play.`].join(" ");
  }

  const reasons = redditWhyBullets(pick.reasons).map((reason) => reason.toLowerCase());
  const reasonText = reasons.length > 1
    ? `${reasons.slice(0, -1).join(", ")} and ${reasons.at(-1)}`
    : reasons[0] ?? "a favorable model profile";
  return `${lead} The model points to ${reasonText}. That is enough for a ${formatUnits(pick.units)} play.`;
};

const allPickNarrative = (pick: Pick<RedditAllPickLegRow, "selected_team" | "away_team" | "home_team" | "odds_american" | "sport" | "market_key" | "spread" | "reasons" | "confidence" | "edge" | "features" | "explanation" | "units">) => {
  const confidence = pick.confidence ? `${Math.round(Number(pick.confidence) * 100)}%` : null;
  const edge = pick.edge ? `${(Number(pick.edge) * 100).toFixed(1)}%` : null;
  const lead = `Chine likes ${pickBullet(pick)}${confidence ? ` at ${confidence} confidence` : ""}${edge ? ` with a ${edge} projected edge` : ""}.`;
  const facts = concretePickFacts(pick);
  if (facts.length) {
    return [lead, ...facts].join(" ");
  }

  const reasons = redditWhyBullets(pick.reasons).map((reason) => reason.toLowerCase());
  const reasonText = reasons.length > 1
    ? `${reasons.slice(0, -1).join(", ")} and ${reasons.at(-1)}`
    : reasons[0] ?? "a favorable model profile";
  return `${lead} The model points to ${reasonText}.`;
};

const settleTrackedRedditPicks = async () => {
  const rows = await query<RedditRecordPickRow & {
    result_id: string | null;
    result_starts_on: string | null;
    result_away_team: string | null;
    result_home_team: string | null;
    away_score: number | null;
    home_score: number | null;
    result_metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT
        rpt.id,
        rpt.ai_pick_id,
        rpt.game_line_id,
        rpt.pick_date::text,
        rpt.selected_team,
        rpt.status,
        rpt.profit_units,
        rpt.decimal_odds,
        rpt.units,
        gl.sport::text AS sport,
        gl.league,
        gl.market_key,
        gl.spread,
        COALESCE(rpt.odds_american, gl.odds_american) AS odds_american,
        gl.away_team,
        gl.home_team,
        gl.starts_at,
        p.confidence,
        p.features->>'edge' AS edge,
        p.features,
        p.reasons,
        p.explanation,
        COALESCE(gr.id::text, lgs.match_id) AS result_id,
        COALESCE(gr.starts_on::text, lgs.starts_at::date::text) AS result_starts_on,
        COALESCE(gr.away_team, lgs.away_team) AS result_away_team,
        COALESCE(gr.home_team, lgs.home_team) AS result_home_team,
        COALESCE(gr.away_score, lgs.away_score) AS away_score,
        COALESCE(gr.home_score, lgs.home_score) AS home_score,
        COALESCE(gr.result_metadata, '{}'::jsonb) AS result_metadata
      FROM reddit_pick_track rpt
      JOIN ai_pick p ON p.id = rpt.ai_pick_id
      JOIN game_line gl ON gl.id = rpt.game_line_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM game_result candidate
        WHERE candidate.sport = gl.sport
          AND candidate.away_team = gl.away_team
          AND candidate.home_team = gl.home_team
          AND abs(extract(epoch from coalesce(candidate.starts_at, candidate.starts_on::timestamptz) - gl.starts_at)) <= 10800
        ORDER BY abs(extract(epoch from coalesce(candidate.starts_at, candidate.starts_on::timestamptz) - gl.starts_at)) ASC,
                 candidate.fetched_at DESC
        LIMIT 1
      ) gr ON true
      LEFT JOIN LATERAL (
        SELECT *
        FROM live_game_state candidate
        WHERE candidate.sport = gl.sport
          AND candidate.away_team = gl.away_team
          AND candidate.home_team = gl.home_team
          AND candidate.away_score IS NOT NULL
          AND candidate.home_score IS NOT NULL
          AND lower(candidate.game_status) IN ('final', 'final/ot', 'final/aet', 'full time')
          AND abs(extract(epoch from candidate.starts_at - gl.starts_at)) <= 10800
        ORDER BY abs(extract(epoch from candidate.starts_at - gl.starts_at)) ASC,
                 candidate.updated_at DESC
        LIMIT 1
      ) lgs ON gr.id IS NULL
      WHERE rpt.status = 'pending'
        AND rpt.locked_at IS NOT NULL
    `
  );

  for (const row of rows.rows) {
    if (!row.result_id || row.away_score === null || row.home_score === null || !row.result_starts_on || !row.result_away_team || !row.result_home_team) {
      continue;
    }
    const finalGame: FinalGame = {
      startsOn: row.result_starts_on,
      awayTeam: row.result_away_team,
      homeTeam: row.result_home_team,
      awayScore: row.away_score,
      homeScore: row.home_score,
      noAction: Boolean(row.result_metadata?.noAction)
    };
    const status = outcomeForSelection({
      selectedTeam: row.selected_team,
      awayTeam: row.away_team,
      homeTeam: row.home_team,
      marketKey: row.market_key,
      spread: Number(row.spread),
      game: finalGame
    });
    const units = Number(row.units);
    const decimalOdds = Number(row.decimal_odds);
    const profitUnits = status === "won"
      ? units * (decimalOdds - 1)
      : status === "lost"
        ? -units
        : 0;
    await query(
      `
        UPDATE reddit_pick_track
        SET status = $2,
            profit_units = $3,
            settled_at = now()
        WHERE id = $1 AND status = 'pending'
      `,
      [row.id, status, profitUnits.toFixed(2)]
    );
  }
};

const getRedditRecord = async () => {
  await settleTrackedRedditPicks();
  const result = await query<{
    wins: number;
    losses: number;
    net_units: string;
  }>(
    `
      SELECT
        count(*) FILTER (WHERE status = 'won')::int AS wins,
        count(*) FILTER (WHERE status = 'lost')::int AS losses,
        coalesce(sum(profit_units), 0)::text AS net_units
      FROM reddit_pick_track
      WHERE locked_at IS NOT NULL
        AND status IN ('won', 'lost', 'push', 'void')
    `
  );
  return {
    wins: result.rows[0]?.wins ?? 0,
    losses: result.rows[0]?.losses ?? 0,
    netUnits: Number(result.rows[0]?.net_units ?? 0)
  };
};

const settleTrackedRedditParlays = async () => {
  const legRows = await query<RedditParlayLegRow & {
    result_id: string | null;
    result_starts_on: string | null;
    result_away_team: string | null;
    result_home_team: string | null;
    away_score: number | null;
    home_score: number | null;
    result_metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT
        rplt.id,
        rplt.parlay_id,
        rplt.ai_pick_id,
        rplt.game_line_id,
        rpt.pick_date::text,
        rplt.selected_team,
        rplt.leg_index,
        rplt.status,
        rplt.decimal_odds,
        rpt.units,
        gl.sport::text AS sport,
        gl.league,
        gl.market_key,
        gl.spread,
        rplt.odds_american,
        gl.away_team,
        gl.home_team,
        gl.starts_at,
        p.confidence,
        p.features->>'edge' AS edge,
        p.features,
        p.reasons,
        p.explanation,
        COALESCE(gr.id::text, lgs.match_id) AS result_id,
        COALESCE(gr.starts_on::text, lgs.starts_at::date::text) AS result_starts_on,
        COALESCE(gr.away_team, lgs.away_team) AS result_away_team,
        COALESCE(gr.home_team, lgs.home_team) AS result_home_team,
        COALESCE(gr.away_score, lgs.away_score) AS away_score,
        COALESCE(gr.home_score, lgs.home_score) AS home_score,
        COALESCE(gr.result_metadata, '{}'::jsonb) AS result_metadata
      FROM reddit_parlay_leg_track rplt
      JOIN reddit_parlay_track rpt ON rpt.id = rplt.parlay_id
      JOIN ai_pick p ON p.id = rplt.ai_pick_id
      JOIN game_line gl ON gl.id = rplt.game_line_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM game_result candidate
        WHERE candidate.sport = gl.sport
          AND candidate.away_team = gl.away_team
          AND candidate.home_team = gl.home_team
          AND abs(extract(epoch from coalesce(candidate.starts_at, candidate.starts_on::timestamptz) - gl.starts_at)) <= 10800
        ORDER BY abs(extract(epoch from coalesce(candidate.starts_at, candidate.starts_on::timestamptz) - gl.starts_at)) ASC,
                 candidate.fetched_at DESC
        LIMIT 1
      ) gr ON true
      LEFT JOIN LATERAL (
        SELECT *
        FROM live_game_state candidate
        WHERE candidate.sport = gl.sport
          AND candidate.away_team = gl.away_team
          AND candidate.home_team = gl.home_team
          AND candidate.away_score IS NOT NULL
          AND candidate.home_score IS NOT NULL
          AND lower(candidate.game_status) IN ('final', 'final/ot', 'final/aet', 'full time')
          AND abs(extract(epoch from candidate.starts_at - gl.starts_at)) <= 10800
        ORDER BY abs(extract(epoch from candidate.starts_at - gl.starts_at)) ASC,
                 candidate.updated_at DESC
        LIMIT 1
      ) lgs ON gr.id IS NULL
      WHERE rplt.status = 'pending'
        AND rpt.locked_at IS NOT NULL
    `
  );

  for (const row of legRows.rows) {
    if (!row.result_id || row.away_score === null || row.home_score === null || !row.result_starts_on || !row.result_away_team || !row.result_home_team) {
      continue;
    }
    const finalGame: FinalGame = {
      startsOn: row.result_starts_on,
      awayTeam: row.result_away_team,
      homeTeam: row.result_home_team,
      awayScore: row.away_score,
      homeScore: row.home_score,
      noAction: Boolean(row.result_metadata?.noAction)
    };
    const status = outcomeForSelection({
      selectedTeam: row.selected_team,
      awayTeam: row.away_team,
      homeTeam: row.home_team,
      marketKey: row.market_key,
      spread: Number(row.spread),
      game: finalGame
    });
    await query(
      `
        UPDATE reddit_parlay_leg_track
        SET status = $2,
            settled_at = now()
        WHERE id = $1 AND status = 'pending'
      `,
      [row.id, status]
    );
  }

  const parlays = await query<{
    id: string;
    units: string;
    legs: Array<{ status: TrackedStatus; decimal_odds: string }>;
  }>(
    `
      SELECT
        rpt.id,
        rpt.units,
        json_agg(json_build_object(
          'status', rplt.status,
          'decimal_odds', rplt.decimal_odds
        ) ORDER BY rplt.leg_index) AS legs
      FROM reddit_parlay_track rpt
      JOIN reddit_parlay_leg_track rplt ON rplt.parlay_id = rpt.id
      WHERE rpt.status = 'pending'
        AND rpt.locked_at IS NOT NULL
      GROUP BY rpt.id, rpt.units
      HAVING count(*) = 3
         AND count(*) FILTER (WHERE rplt.status = 'pending') = 0
    `
  );

  for (const parlay of parlays.rows) {
    const units = Number(parlay.units);
    const legs = parlay.legs;
    const hasLoss = legs.some((leg) => leg.status === "lost");
    const winningLegs = legs.filter((leg) => leg.status === "won");
    const status: TrackedStatus = hasLoss ? "lost" : winningLegs.length ? "won" : "push";
    const decimalPayout = winningLegs.reduce((product, leg) => product * Number(leg.decimal_odds), 1);
    const profitUnits = status === "won" ? units * (decimalPayout - 1) : status === "lost" ? -units : 0;
    await query(
      `
        UPDATE reddit_parlay_track
        SET status = $2,
            profit_units = $3,
            settled_at = now()
        WHERE id = $1 AND status = 'pending'
      `,
      [parlay.id, status, profitUnits.toFixed(2)]
    );
  }
};

const getRedditParlayRecord = async () => {
  await settleTrackedRedditParlays();
  const result = await query<{
    wins: number;
    losses: number;
    net_units: string;
  }>(
    `
      SELECT
        count(*) FILTER (WHERE status = 'won')::int AS wins,
        count(*) FILTER (WHERE status = 'lost')::int AS losses,
        coalesce(sum(profit_units), 0)::text AS net_units
      FROM reddit_parlay_track
      WHERE locked_at IS NOT NULL
        AND status IN ('won', 'lost', 'push', 'void')
    `
  );
  return {
    wins: result.rows[0]?.wins ?? 0,
    losses: result.rows[0]?.losses ?? 0,
    netUnits: Number(result.rows[0]?.net_units ?? 0)
  };
};

const settleTrackedRedditAllPicks = async () => {
  const rows = await query<RedditAllPickLegRow & {
    result_id: string | null;
    result_starts_on: string | null;
    result_away_team: string | null;
    result_home_team: string | null;
    away_score: number | null;
    home_score: number | null;
    result_metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT
        rapl.id,
        rapl.all_pick_id,
        rapl.ai_pick_id,
        rapl.game_line_id,
        rapt.pick_date::text,
        rapl.selected_team,
        rapl.leg_index,
        rapl.status,
        rapl.profit_units,
        rapl.decimal_odds,
        1.00::numeric(5,2) AS units,
        gl.sport::text AS sport,
        gl.league,
        gl.market_key,
        gl.spread,
        rapl.odds_american,
        gl.away_team,
        gl.home_team,
        gl.starts_at,
        p.confidence,
        p.features->>'edge' AS edge,
        p.features,
        p.reasons,
        p.explanation,
        COALESCE(gr.id::text, lgs.match_id) AS result_id,
        COALESCE(gr.starts_on::text, lgs.starts_at::date::text) AS result_starts_on,
        COALESCE(gr.away_team, lgs.away_team) AS result_away_team,
        COALESCE(gr.home_team, lgs.home_team) AS result_home_team,
        COALESCE(gr.away_score, lgs.away_score) AS away_score,
        COALESCE(gr.home_score, lgs.home_score) AS home_score,
        COALESCE(gr.result_metadata, '{}'::jsonb) AS result_metadata
      FROM reddit_all_pick_leg_track rapl
      JOIN reddit_all_pick_track rapt ON rapt.id = rapl.all_pick_id
      JOIN ai_pick p ON p.id = rapl.ai_pick_id
      JOIN game_line gl ON gl.id = rapl.game_line_id
      LEFT JOIN LATERAL (
        SELECT *
        FROM game_result candidate
        WHERE candidate.sport = gl.sport
          AND candidate.away_team = gl.away_team
          AND candidate.home_team = gl.home_team
          AND abs(extract(epoch from coalesce(candidate.starts_at, candidate.starts_on::timestamptz) - gl.starts_at)) <= 10800
        ORDER BY abs(extract(epoch from coalesce(candidate.starts_at, candidate.starts_on::timestamptz) - gl.starts_at)) ASC,
                 candidate.fetched_at DESC
        LIMIT 1
      ) gr ON true
      LEFT JOIN LATERAL (
        SELECT *
        FROM live_game_state candidate
        WHERE candidate.sport = gl.sport
          AND candidate.away_team = gl.away_team
          AND candidate.home_team = gl.home_team
          AND candidate.away_score IS NOT NULL
          AND candidate.home_score IS NOT NULL
          AND lower(candidate.game_status) IN ('final', 'final/ot', 'final/aet', 'full time')
          AND abs(extract(epoch from candidate.starts_at - gl.starts_at)) <= 10800
        ORDER BY abs(extract(epoch from candidate.starts_at - gl.starts_at)) ASC,
                 candidate.updated_at DESC
        LIMIT 1
      ) lgs ON gr.id IS NULL
      WHERE rapl.status = 'pending'
        AND rapt.locked_at IS NOT NULL
    `
  );

  for (const row of rows.rows) {
    if (!row.result_id || row.away_score === null || row.home_score === null || !row.result_starts_on || !row.result_away_team || !row.result_home_team) {
      continue;
    }
    const finalGame: FinalGame = {
      startsOn: row.result_starts_on,
      awayTeam: row.result_away_team,
      homeTeam: row.result_home_team,
      awayScore: row.away_score,
      homeScore: row.home_score,
      noAction: Boolean(row.result_metadata?.noAction)
    };
    const status = outcomeForSelection({
      selectedTeam: row.selected_team,
      awayTeam: row.away_team,
      homeTeam: row.home_team,
      marketKey: row.market_key,
      spread: Number(row.spread),
      game: finalGame
    });
    const profitUnits = status === "won"
      ? Number(row.decimal_odds) - 1
      : status === "lost"
        ? -1
        : 0;
    await query(
      `
        UPDATE reddit_all_pick_leg_track
        SET status = $2,
            profit_units = $3,
            settled_at = now()
        WHERE id = $1 AND status = 'pending'
      `,
      [row.id, status, profitUnits.toFixed(2)]
    );
  }
};

const getRedditAllPickRecord = async () => {
  await settleTrackedRedditAllPicks();
  const result = await query<{
    wins: number;
    losses: number;
    net_units: string;
  }>(
    `
      SELECT
        count(*) FILTER (WHERE rapl.status = 'won')::int AS wins,
        count(*) FILTER (WHERE rapl.status = 'lost')::int AS losses,
        coalesce(sum(rapl.profit_units), 0)::text AS net_units
      FROM reddit_all_pick_leg_track rapl
      JOIN reddit_all_pick_track rapt ON rapt.id = rapl.all_pick_id
      WHERE rapt.locked_at IS NOT NULL
        AND rapt.pick_date >= ((now() AT TIME ZONE 'America/Chicago')::date - interval '7 days')
        AND rapl.status IN ('won', 'lost', 'push', 'void')
    `
  );
  const wins = result.rows[0]?.wins ?? 0;
  const losses = result.rows[0]?.losses ?? 0;
  return {
    wins,
    losses,
    winLossPercent: wins + losses > 0 ? wins / (wins + losses) : null,
    netUnits: Number(result.rows[0]?.net_units ?? 0)
  };
};

const selectTodayRedditPick = async () => {
  return query<RedditPickRow>(
    `
      SELECT
        rpt.id,
        rpt.ai_pick_id,
        rpt.game_line_id,
        rpt.pick_date::text,
        rpt.selected_team,
        rpt.status,
        rpt.decimal_odds,
        rpt.units,
        gl.sport::text AS sport,
        gl.league,
        gl.market_key,
        gl.spread,
        COALESCE(rpt.odds_american, gl.odds_american) AS odds_american,
        gl.away_team,
        gl.home_team,
        gl.starts_at,
        p.confidence,
        p.features->>'edge' AS edge,
        p.features,
        p.reasons,
        p.explanation
      FROM reddit_pick_track rpt
      JOIN ai_pick p ON p.id = rpt.ai_pick_id
      JOIN game_line gl ON gl.id = rpt.game_line_id
      WHERE rpt.pick_date = (now() AT TIME ZONE 'America/Chicago')::date
      LIMIT 1
    `,
  );
};

const selectTodayRedditParlay = async () => {
  const parlay = await query<RedditParlayRow>(
    `
      SELECT id, pick_date::text, units, status, profit_units, locked_at
      FROM reddit_parlay_track
      WHERE pick_date = (now() AT TIME ZONE 'America/Chicago')::date
      LIMIT 1
    `
  );
  if (!parlay.rows[0]) {
    return null;
  }
  const legs = await query<RedditParlayLegRow>(
    `
      SELECT
        rplt.id,
        rplt.parlay_id,
        rplt.ai_pick_id,
        rplt.game_line_id,
        rpt.pick_date::text,
        rplt.selected_team,
        rplt.leg_index,
        rplt.status,
        rplt.decimal_odds,
        rpt.units,
        gl.sport::text AS sport,
        gl.league,
        gl.market_key,
        gl.spread,
        rplt.odds_american,
        gl.away_team,
        gl.home_team,
        gl.starts_at,
        p.confidence,
        p.features->>'edge' AS edge,
        p.features,
        p.reasons,
        p.explanation
      FROM reddit_parlay_leg_track rplt
      JOIN reddit_parlay_track rpt ON rpt.id = rplt.parlay_id
      JOIN ai_pick p ON p.id = rplt.ai_pick_id
      JOIN game_line gl ON gl.id = rplt.game_line_id
      WHERE rplt.parlay_id = $1
      ORDER BY rplt.leg_index ASC
    `,
    [parlay.rows[0].id]
  );
  return {
    parlay: parlay.rows[0],
    legs: legs.rows
  };
};

const selectRedditAllPickLegs = async (allPickId: string) => {
  return query<RedditAllPickLegRow>(
    `
      SELECT
        rapl.id,
        rapl.all_pick_id,
        rapl.ai_pick_id,
        rapl.game_line_id,
        rapt.pick_date::text,
        rapl.selected_team,
        rapl.leg_index,
        rapl.status,
        rapl.profit_units,
        rapl.decimal_odds,
        1.00::numeric(5,2) AS units,
        gl.sport::text AS sport,
        gl.league,
        gl.market_key,
        gl.spread,
        rapl.odds_american,
        gl.away_team,
        gl.home_team,
        gl.starts_at,
        p.confidence,
        p.features->>'edge' AS edge,
        p.features,
        p.reasons,
        p.explanation
      FROM reddit_all_pick_leg_track rapl
      JOIN reddit_all_pick_track rapt ON rapt.id = rapl.all_pick_id
      JOIN ai_pick p ON p.id = rapl.ai_pick_id
      JOIN game_line gl ON gl.id = rapl.game_line_id
      WHERE rapl.all_pick_id = $1
      ORDER BY rapl.leg_index ASC
    `,
    [allPickId]
  );
};

const selectTodayRedditAllPicks = async () => {
  const allPick = await query<RedditAllPickRow>(
    `
      SELECT id, pick_date::text, locked_at
      FROM reddit_all_pick_track
      WHERE pick_date = (now() AT TIME ZONE 'America/Chicago')::date
      LIMIT 1
    `
  );
  if (!allPick.rows[0]) {
    return null;
  }
  const legs = await selectRedditAllPickLegs(allPick.rows[0].id);
  return {
    allPick: allPick.rows[0],
    legs: legs.rows
  };
};

const getOrCreateTodayRedditPick = async () => {
  const existing = await selectTodayRedditPick();
  if (existing.rows[0]) {
    const lockResult = await query<{ lockedAt: Date | null }>(
      `SELECT locked_at AS "lockedAt" FROM reddit_pick_track WHERE id = $1`,
      [existing.rows[0].id]
    );
    if (lockResult.rows[0]?.lockedAt) {
      return existing.rows[0];
    }
    if (isValidRedditSingleOdds(existing.rows[0].odds_american)) {
      return existing.rows[0];
    }
    if (existing.rows[0].status !== "pending") {
      return null;
    }
    await query(
      "DELETE FROM reddit_pick_track WHERE id = $1 AND status = 'pending' AND locked_at IS NULL",
      [existing.rows[0].id]
    );
  }

  await query(
    `
      INSERT INTO reddit_pick_track (
        id, pick_date, ai_pick_id, game_line_id, selected_team, units, decimal_odds, odds_american
      )
      SELECT
        $1::uuid,
        (now() AT TIME ZONE 'America/Chicago')::date,
        p.id,
        p.game_line_id,
        p.selected_team,
        CASE
          WHEN p.confidence >= 0.80 THEN 3.00
          WHEN p.confidence >= 0.77 THEN 2.00
          ELSE 1.00
        END,
        (CASE WHEN gl.odds_american > 0 THEN 1 + gl.odds_american / 100.0 ELSE 1 + 100.0 / abs(gl.odds_american) END)::numeric(8,3),
        gl.odds_american
      FROM ai_pick p
      JOIN game_line gl ON gl.id = p.game_line_id
      WHERE p.published_for = (now() AT TIME ZONE 'America/Chicago')::date
        AND gl.starts_at > now()
        AND gl.odds_american BETWEEN $2 AND $3
      ORDER BY p.confidence DESC NULLS LAST, p.score DESC NULLS LAST, gl.starts_at ASC
      LIMIT 1
      ON CONFLICT (pick_date) DO NOTHING
    `,
    [randomUUID(), redditSingleMinAmericanOdds, redditSingleMaxAmericanOdds]
  );

  const selected = await selectTodayRedditPick();
  return selected.rows[0] ?? null;
};

const getOrCreateTodayRedditParlay = async () => {
  const existing = await selectTodayRedditParlay();
  if (existing) {
    if (existing.parlay.locked_at) {
      return existing.legs.length === 3 ? existing : null;
    }
    if (existing.legs.length === 3) {
      return existing;
    }
    await query("DELETE FROM reddit_parlay_track WHERE id = $1 AND status = 'pending' AND locked_at IS NULL", [existing.parlay.id]);
  }

  const candidates = await query<RedditCandidatePickRow>(
    `
      WITH candidates AS (
        SELECT
          p.id AS ai_pick_id,
          p.game_line_id,
          (now() AT TIME ZONE 'America/Chicago')::date::text AS pick_date,
          p.selected_team,
          (CASE WHEN gl.odds_american > 0 THEN 1 + gl.odds_american / 100.0 ELSE 1 + 100.0 / abs(gl.odds_american) END)::numeric(8,3) AS decimal_odds,
          1.00::numeric(5,2) AS units,
          gl.sport::text AS sport,
          gl.league,
          gl.market_key,
          gl.spread,
          gl.odds_american,
          gl.away_team,
          gl.home_team,
          gl.starts_at,
          p.confidence,
          p.score,
          p.features->>'edge' AS edge,
          p.features,
          p.reasons,
          p.explanation,
          split_part(gl.provider_event_id, ':', 1) AS event_key
        FROM ai_pick p
        JOIN game_line gl ON gl.id = p.game_line_id
        WHERE p.published_for = (now() AT TIME ZONE 'America/Chicago')::date
          AND gl.starts_at > now()
      ),
      one_per_event AS (
        SELECT DISTINCT ON (event_key) *
        FROM candidates
        ORDER BY event_key, confidence DESC NULLS LAST, score DESC NULLS LAST, starts_at ASC
      )
      SELECT
        ai_pick_id,
        game_line_id,
        pick_date,
        selected_team,
        decimal_odds,
        units,
        sport,
        league,
        market_key,
        spread,
        odds_american,
        away_team,
        home_team,
        starts_at,
        confidence,
        edge,
        features,
        reasons,
        explanation
      FROM one_per_event
      ORDER BY confidence DESC NULLS LAST, score DESC NULLS LAST, starts_at ASC
      LIMIT 3
    `
  );

  if (candidates.rows.length < 3) {
    return null;
  }

  await transaction(async (client) => {
    const parlayResult = await client.query<{ id: string }>(
      `
        INSERT INTO reddit_parlay_track (id, pick_date, units)
        VALUES ($1, (now() AT TIME ZONE 'America/Chicago')::date, 1.00)
        ON CONFLICT (pick_date) DO UPDATE
        SET units = reddit_parlay_track.units
        WHERE reddit_parlay_track.status = 'pending'
        RETURNING id
      `,
      [randomUUID()]
    );
    const trackedParlayId = parlayResult.rows[0]?.id;
    if (!trackedParlayId) {
      return;
    }
    await client.query(
      "DELETE FROM reddit_parlay_leg_track WHERE parlay_id = $1",
      [trackedParlayId]
    );
    for (const [index, pick] of candidates.rows.entries()) {
      await client.query(
        `
          INSERT INTO reddit_parlay_leg_track (
            id, parlay_id, ai_pick_id, game_line_id, selected_team, leg_index, decimal_odds, odds_american
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (parlay_id, leg_index) DO NOTHING
        `,
        [
          randomUUID(),
          trackedParlayId,
          pick.ai_pick_id,
          pick.game_line_id,
          pick.selected_team,
          index + 1,
          Number(pick.decimal_odds).toFixed(3),
          pick.odds_american
        ]
      );
    }
  });

  return selectTodayRedditParlay();
};

const getOrCreateTodayRedditAllPicks = async () => {
  const existing = await selectTodayRedditAllPicks();
  if (existing) {
    if (existing.allPick.locked_at) {
      return existing.legs.length ? existing : null;
    }
    await query("DELETE FROM reddit_all_pick_track WHERE id = $1 AND locked_at IS NULL", [existing.allPick.id]);
  }

  const candidates = await query<RedditCandidatePickRow>(
    `
      WITH candidates AS (
        SELECT
          p.id AS ai_pick_id,
          p.game_line_id,
          (now() AT TIME ZONE 'America/Chicago')::date::text AS pick_date,
          p.selected_team,
          (CASE WHEN gl.odds_american > 0 THEN 1 + gl.odds_american / 100.0 ELSE 1 + 100.0 / abs(gl.odds_american) END)::numeric(8,3) AS decimal_odds,
          1.00::numeric(5,2) AS units,
          gl.sport::text AS sport,
          gl.league,
          gl.market_key,
          gl.spread,
          gl.odds_american,
          gl.away_team,
          gl.home_team,
          gl.starts_at,
          p.confidence,
          p.score,
          p.features->>'edge' AS edge,
          p.features,
          p.reasons,
          p.explanation,
          split_part(gl.provider_event_id, ':', 1) AS event_key
        FROM ai_pick p
        JOIN game_line gl ON gl.id = p.game_line_id
        WHERE p.published_for = (now() AT TIME ZONE 'America/Chicago')::date
          AND gl.starts_at > now()
          AND gl.market_key = 'h2h'
      ),
      one_per_event AS (
        SELECT DISTINCT ON (event_key) *
        FROM candidates
        ORDER BY event_key, confidence DESC NULLS LAST, score DESC NULLS LAST, starts_at ASC
      )
      SELECT
        ai_pick_id,
        game_line_id,
        pick_date,
        selected_team,
        decimal_odds,
        units,
        sport,
        league,
        market_key,
        spread,
        odds_american,
        away_team,
        home_team,
        starts_at,
        confidence,
        edge,
        features,
        reasons,
        explanation
      FROM one_per_event
      ORDER BY confidence DESC NULLS LAST, score DESC NULLS LAST, starts_at ASC
    `
  );

  if (!candidates.rows.length) {
    return null;
  }

  await transaction(async (client) => {
    const allPickResult = await client.query<{ id: string }>(
      `
        INSERT INTO reddit_all_pick_track (id, pick_date)
        VALUES ($1, (now() AT TIME ZONE 'America/Chicago')::date)
        ON CONFLICT (pick_date) DO UPDATE
        SET pick_date = reddit_all_pick_track.pick_date
        WHERE reddit_all_pick_track.locked_at IS NULL
        RETURNING id
      `,
      [randomUUID()]
    );
    const trackedAllPickId = allPickResult.rows[0]?.id;
    if (!trackedAllPickId) {
      return;
    }
    await client.query("DELETE FROM reddit_all_pick_leg_track WHERE all_pick_id = $1", [trackedAllPickId]);
    for (const [index, pick] of candidates.rows.entries()) {
      await client.query(
        `
          INSERT INTO reddit_all_pick_leg_track (
            id, all_pick_id, ai_pick_id, game_line_id, selected_team, leg_index, decimal_odds, odds_american
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (all_pick_id, leg_index) DO NOTHING
        `,
        [
          randomUUID(),
          trackedAllPickId,
          pick.ai_pick_id,
          pick.game_line_id,
          pick.selected_team,
          index + 1,
          Number(pick.decimal_odds).toFixed(3),
          pick.odds_american
        ]
      );
    }
  });

  return selectTodayRedditAllPicks();
};

export const lockRedditPostTracking = async ({
  userId,
  postType,
  title,
  body
}: {
  userId: string;
  postType: "single" | "parlay" | "all";
  title: string;
  body: string;
}) => {
  if (postType === "all") {
    const current = await getOrCreateTodayRedditAllPicks();
    if (!current || !current.legs.length) {
      throw new Error("No Chine all-picks card is available to lock.");
    }
    const result = await query<{ id: string; lockedAt: Date }>(
      `
        UPDATE reddit_all_pick_track
        SET locked_at = COALESCE(locked_at, now()),
            locked_by_user_id = COALESCE(locked_by_user_id, $2::uuid),
            locked_title = $3,
            locked_body = $4
        WHERE id = $1
        RETURNING id, locked_at AS "lockedAt"
      `,
      [current.allPick.id, userId, title, body]
    );
    return {
      postType,
      id: result.rows[0].id,
      lockedAt: result.rows[0].lockedAt,
      legs: current.legs.length
    };
  }

  if (postType === "parlay") {
    const current = await getOrCreateTodayRedditParlay();
    if (!current || current.legs.length !== 3) {
      throw new Error("No complete 3-team Chine parlay is available to lock.");
    }
    const result = await query<{ id: string; lockedAt: Date }>(
      `
        UPDATE reddit_parlay_track
        SET locked_at = COALESCE(locked_at, now()),
            locked_by_user_id = COALESCE(locked_by_user_id, $2::uuid),
            locked_title = $3,
            locked_body = $4
        WHERE id = $1
        RETURNING id, locked_at AS "lockedAt"
      `,
      [current.parlay.id, userId, title, body]
    );
    return {
      postType,
      id: result.rows[0].id,
      lockedAt: result.rows[0].lockedAt,
      legs: current.legs.length
    };
  }

  const current = await getOrCreateTodayRedditPick();
  if (!current) {
    throw new Error("No Chine single pick is available to lock.");
  }
  const result = await query<{ id: string; lockedAt: Date }>(
    `
      UPDATE reddit_pick_track
      SET locked_at = COALESCE(locked_at, now()),
          locked_by_user_id = COALESCE(locked_by_user_id, $2::uuid),
          locked_title = $3,
          locked_body = $4
      WHERE id = $1
      RETURNING id, locked_at AS "lockedAt"
    `,
    [current.id, userId, title, body]
  );
  return {
    postType,
    id: result.rows[0].id,
    lockedAt: result.rows[0].lockedAt,
    legs: 1
  };
};

const getPreviousRedditPick = async () => {
  await settleTrackedRedditPicks();
  const result = await query<RedditRecordPickRow>(
    `
      SELECT
        rpt.id,
        rpt.ai_pick_id,
        rpt.game_line_id,
        rpt.pick_date::text,
        rpt.selected_team,
        rpt.status,
        rpt.profit_units,
        rpt.decimal_odds,
        rpt.units,
        gl.sport::text AS sport,
        gl.league,
        gl.market_key,
        gl.spread,
        COALESCE(rpt.odds_american, gl.odds_american) AS odds_american,
        gl.away_team,
        gl.home_team,
        gl.starts_at,
        p.confidence,
        p.features->>'edge' AS edge,
        p.features,
        p.reasons,
        p.explanation
      FROM reddit_pick_track rpt
      JOIN ai_pick p ON p.id = rpt.ai_pick_id
      JOIN game_line gl ON gl.id = rpt.game_line_id
      WHERE rpt.pick_date < (now() AT TIME ZONE 'America/Chicago')::date
        AND rpt.locked_at IS NOT NULL
        AND rpt.status IN ('won', 'lost', 'push', 'void')
      ORDER BY rpt.pick_date DESC
      LIMIT 1
    `
  );
  return result.rows[0] ?? null;
};

const getPreviousRedditParlay = async () => {
  await settleTrackedRedditParlays();
  const parlay = await query<RedditParlayRow>(
    `
      SELECT id, pick_date::text, units, status, profit_units
      FROM reddit_parlay_track
      WHERE pick_date < (now() AT TIME ZONE 'America/Chicago')::date
        AND locked_at IS NOT NULL
        AND status IN ('won', 'lost', 'push', 'void')
      ORDER BY pick_date DESC
      LIMIT 1
    `
  );
  if (!parlay.rows[0]) {
    return null;
  }
  const legs = await query<RedditParlayLegRow>(
    `
      SELECT
        rplt.id,
        rplt.parlay_id,
        rplt.ai_pick_id,
        rplt.game_line_id,
        rpt.pick_date::text,
        rplt.selected_team,
        rplt.leg_index,
        rplt.status,
        rplt.decimal_odds,
        rpt.units,
        gl.sport::text AS sport,
        gl.league,
        gl.market_key,
        gl.spread,
        rplt.odds_american,
        gl.away_team,
        gl.home_team,
        gl.starts_at,
        p.confidence,
        p.features->>'edge' AS edge,
        p.features,
        p.reasons,
        p.explanation
      FROM reddit_parlay_leg_track rplt
      JOIN reddit_parlay_track rpt ON rpt.id = rplt.parlay_id
      JOIN ai_pick p ON p.id = rplt.ai_pick_id
      JOIN game_line gl ON gl.id = rplt.game_line_id
      WHERE rplt.parlay_id = $1
      ORDER BY rplt.leg_index ASC
    `,
    [parlay.rows[0].id]
  );
  return {
    parlay: parlay.rows[0],
    legs: legs.rows
  };
};

const parlayResultLabel = (status: TrackedStatus) => {
  if (status === "won") return "Win";
  if (status === "lost") return "Loss";
  if (status === "push" || status === "void") return "Push";
  return "Pending";
};

const trackedResultLabel = (status: TrackedStatus) => {
  if (status === "won") return "Win";
  if (status === "lost") return "Loss";
  if (status === "push" || status === "void") return "Push";
  return "Pending";
};

const parlayLegSymbol = (status: TrackedStatus) => {
  if (status === "won") return "✓";
  if (status === "lost") return "✗";
  if (status === "push" || status === "void") return "Push";
  return "•";
};

const trackedPickSymbol = (status: TrackedStatus) => {
  if (status === "won") return "✓";
  if (status === "lost") return "✗";
  if (status === "push" || status === "void") return "Push";
  return "•";
};

const parlayLegLine = (leg: Pick<RedditParlayLegRow, "selected_team" | "market_key" | "spread" | "sport" | "odds_american" | "starts_at">) =>
  `${pickBullet(leg)} (${formatAmericanOdds(leg.odds_american)}) - ${formatCstTime(leg.starts_at)}`;

const trackedPickLine = (pick: Pick<RedditPickRow, "selected_team" | "market_key" | "spread" | "sport" | "odds_american" | "starts_at">) =>
  `${pickBullet(pick)} (${formatAmericanOdds(pick.odds_american)}) - ${formatCstTime(pick.starts_at)}`;

const parlayReturnUnits = (units: string | number, legs: Array<Pick<RedditParlayLegRow, "decimal_odds">>) =>
  Number(units) * legs.reduce((product, leg) => product * Number(leg.decimal_odds), 1);

const formatWinLossPercent = (value: number | null) => value === null ? "N/A" : `${(value * 100).toFixed(1)}%`;

const allPickLine = (pick: Pick<RedditAllPickLegRow, "selected_team" | "market_key" | "spread" | "sport" | "odds_american" | "starts_at" | "confidence">) =>
  `${pickBullet(pick)} - ${formatCstTime(pick.starts_at)} - ${formatAmericanOdds(pick.odds_american)} - Confidence: ${pick.confidence ? `${Math.round(Number(pick.confidence) * 100)}%` : "N/A"}`;

const getYesterdayRedditAllPicks = async () => {
  await settleTrackedRedditAllPicks();
  const allPick = await query<RedditAllPickRow>(
    `
      SELECT id, pick_date::text, locked_at
      FROM reddit_all_pick_track
      WHERE pick_date = ((now() AT TIME ZONE 'America/Chicago')::date - interval '1 day')
        AND locked_at IS NOT NULL
      LIMIT 1
    `
  );
  if (!allPick.rows[0]) {
    return null;
  }
  const legs = await selectRedditAllPickLegs(allPick.rows[0].id);
  return {
    allPick: allPick.rows[0],
    legs: legs.rows
  };
};

export const buildRedditPreview = async (subredditInput?: string): Promise<RedditPostPreview> => {
  const subreddit = cleanSubreddit(subredditInput || config.redditDefaultSubreddits[0] || "sportsbook");
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric"
  });

  const [record, previous, pick] = await Promise.all([
    getRedditRecord(),
    getPreviousRedditPick(),
    getOrCreateTodayRedditPick()
  ]);

  const previousLines = previous
    ? [
      `Previous: ${trackedResultLabel(previous.status)} ${formatSignedUnits(Number(previous.profit_units))}`,
      `${trackedPickSymbol(previous.status)} ${trackedPickLine(previous)}`
    ]
    : ["Previous: No previous tracked pick."];

  const body = pick
    ? [
      `Record: ${record.wins}-${record.losses} W/L`,
      `Net Units: ${formatSignedUnits(record.netUnits)}`,
      "",
      ...previousLines,
      "",
      formatCstDate(pick.starts_at),
      `Event: ${eventName(pick)}`,
      `${pick.away_team} vs ${pick.home_team}`,
      "",
      "Pick:",
      `• ${pickBullet(pick)}`,
      "",
      `ODDS ${formatAmericanOdds(pick.odds_american)}`,
      `UNITS ${formatUnits(pick.units)} to return ${formatReturnUnits(Number(pick.units) * Number(pick.decimal_odds))}`,
      "",
      pickNarrative(pick)
    ].join("\n")
    : [
      `Record: ${record.wins}-${record.losses} W/L`,
      `Net Units: ${formatSignedUnits(record.netUnits)}`,
      "",
      ...previousLines,
      "",
      "No Chine pick is posted yet today."
    ].join("\n");

  return {
    subreddit,
    title: `StakeWars Chine pick - ${today}`,
    body
  };
};

export const buildRedditAllPicksPreview = async (subredditInput?: string): Promise<RedditPostPreview> => {
  const subreddit = cleanSubreddit(subredditInput || config.redditDefaultSubreddits[0] || "sportsbook");
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric"
  });

  const [record, yesterday, current] = await Promise.all([
    getRedditAllPickRecord(),
    getYesterdayRedditAllPicks(),
    getOrCreateTodayRedditAllPicks()
  ]);

  const yesterdayPicks = yesterday?.legs.length
    ? yesterday.legs.map((leg) => trackedPickLine(leg)).join("; ")
    : "No tracked all-picks card yesterday.";
  const yesterdayUnits = yesterday?.legs.length
    ? yesterday.legs.reduce((sum, leg) => sum + Number(leg.profit_units), 0)
    : null;
  const todayLines = current?.legs.length
    ? current.legs.flatMap((pick, index) => [
      `Pick #${index + 1}: ${allPickLine(pick)}`,
      allPickNarrative(pick)
    ])
    : ["No Chine all-picks card is posted yet today."];

  const body = [
    "You can follow all of my picks on stakewars-dot-ai. I am Chine, the autonomous daily picker fueling the challenge. To win, you must defeat me. Here is my recent form with all wagers being 1u:",
    "",
    "Past 7 days:",
    `Win-Loss: ${record.wins}-${record.losses}`,
    `Win-Loss%: ${formatWinLossPercent(record.winLossPercent)}`,
    `Net Units: ${formatSignedUnits(record.netUnits)}`,
    `Yesterday's picks: ${yesterdayPicks}`,
    `Yesterday's Results: ${yesterdayUnits === null ? "N/A" : formatSignedUnits(yesterdayUnits)}`,
    "Today's Picks:",
    ...todayLines
  ].join("\n");

  return {
    subreddit,
    title: `StakeWars Chine all picks - ${today}`,
    body
  };
};

export const buildRedditParlayPreview = async (subredditInput?: string): Promise<RedditPostPreview> => {
  const subreddit = cleanSubreddit(subredditInput || config.redditDefaultSubreddits[0] || "sportsbook");
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric"
  });

  const [record, previous, current] = await Promise.all([
    getRedditParlayRecord(),
    getPreviousRedditParlay(),
    getOrCreateTodayRedditParlay()
  ]);

  const previousLines = previous
    ? [
      `Previous: ${parlayResultLabel(previous.parlay.status)} ${formatSignedUnits(Number(previous.parlay.profit_units))}`,
      ...previous.legs.map((leg) => `${parlayLegSymbol(leg.status)} ${parlayLegLine(leg)}`)
    ]
    : ["Previous: No previous tracked parlay."];

  const body = current
    ? [
      `3-Team Parlay Record: ${record.wins}-${record.losses} W/L`,
      `Net Units: ${formatSignedUnits(record.netUnits)}`,
      "",
      ...previousLines,
      "",
      `Date: ${today} CST`,
      "3-Team Parlay",
      "",
      "Picks:",
      ...current.legs.map((leg) => `• ${parlayLegLine(leg)}`),
      "",
      `UNITS ${formatUnits(current.parlay.units)} to return ${formatReturnUnits(parlayReturnUnits(current.parlay.units, current.legs))}`,
      "",
      parlayNarrative(current.legs)
    ].join("\n")
    : [
      `3-Team Parlay Record: ${record.wins}-${record.losses} W/L`,
      `Net Units: ${formatSignedUnits(record.netUnits)}`,
      "",
      ...previousLines,
      "",
      "No 3-team Chine parlay is available yet today."
    ].join("\n");

  return {
    subreddit,
    title: `StakeWars Chine 3-team parlay - ${today}`,
    body
  };
};
