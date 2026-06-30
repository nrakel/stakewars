export type SportKey = "MLB" | "NHL" | "NFL" | "NBA" | "NCAAMB" | "NCAAF" | "EPL" | "WORLDCUP";
export type WagerKind = "straight" | "parlay" | "round_robin";
export type MarketKey = "spreads" | "h2h" | "totals";

export type SessionUser = {
  id: string;
  username: string;
  fullName: string | null;
  email: string | null;
  displayName: string | null;
  rewardBalanceCents: number;
  payoutMethod: "none" | "paypal" | "venmo";
  payoutHandle: string | null;
  phoneLast4: string | null;
  role: "player" | "admin" | "system";
};

export type GameLine = {
  id: string;
  sport: SportKey;
  league: string;
  startsAt: string;
  homeTeam: string;
  awayTeam: string;
  favoriteTeam: string;
  spread: string;
  oddsAmerican: number;
  marketKey: MarketKey;
};

export type GameMarketSide = {
  id: string;
  team: string;
  spread: string;
  oddsAmerican: number;
};

export type GameMarket = {
  eventKey: string;
  sport: SportKey;
  league: string;
  startsAt: string;
  homeTeam: string;
  awayTeam: string;
  marketKey: MarketKey;
  awayLine: GameMarketSide | null;
  homeLine: GameMarketSide | null;
  drawLine?: GameMarketSide | null;
  overLine?: GameMarketSide | null;
  underLine?: GameMarketSide | null;
};

export type ProbablePitcher = {
  id: number | null;
  name: string | null;
  wins: number | null;
  losses: number | null;
  era: number | null;
};

export type LineupPlayer = {
  order: number;
  playerId: number;
  name: string;
  position: string | null;
  batSide: string | null;
  avg: string | null;
  homeRuns: number | null;
  rbi: number | null;
};

export type TeamLineup = {
  confirmed: boolean;
  players: LineupPlayer[];
};

export type GameCard = {
  eventKey: string;
  sport: SportKey;
  league: string;
  startsAt: string;
  homeTeam: string;
  awayTeam: string;
  aiConfidence?: {
    selectedTeam: string;
    confidence: number;
    edge: number;
    score: number;
  } | null;
  awayProbablePitcher?: ProbablePitcher | null;
  homeProbablePitcher?: ProbablePitcher | null;
  awayLineup?: TeamLineup | null;
  homeLineup?: TeamLineup | null;
  markets: GameMarket[];
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

export type LeaderboardRow = {
  rank: number;
  displayName: string;
  role: "player" | "admin" | "system";
  balanceCents: number;
  settledProfitCents: number;
  beatAi: boolean;
};

export type OpenBetLeg = {
  id: string;
  selectedTeam: string;
  spread: string;
  oddsAmerican: number;
  status: "pending" | "won" | "lost" | "push" | "void";
  marketKey: MarketKey;
  sport: SportKey;
  startsAt: string;
  awayTeam: string;
  homeTeam: string;
};

export type OpenBet = {
  id: string;
  kind: WagerKind;
  stakeCents: number;
  potentialPayoutCents: number;
  placedAt: string;
  legs: OpenBetLeg[];
};

export type SettledBetLeg = OpenBetLeg & {
  status: "won" | "lost" | "push" | "void";
};

export type SettledBet = {
  id: string;
  owner: "user" | "ai";
  displayName: string;
  kind: WagerKind;
  status: "won" | "lost" | "push" | "void";
  stakeCents: number;
  potentialPayoutCents: number;
  profitCents: number;
  placedAt: string;
  legs: SettledBetLeg[];
};
