export type SportKey = "MLB" | "NHL" | "NFL" | "NBA" | "NCAAMB" | "NCAAF" | "EPL" | "WORLDCUP";
export type WagerKind = "straight" | "parlay" | "round_robin";
export type MarketKey = "spreads" | "h2h" | "totals";

export type SessionUser = {
  id: string;
  username: string;
  fullName: string | null;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  rewardBalanceCents: number;
  payoutMethod: "none" | "paypal" | "venmo";
  payoutHandle: string | null;
  phoneLast4: string | null;
  role: "player" | "admin" | "system";
};

export type RewardAward = {
  id: string;
  weekStart: string;
  rank: number;
  sharePercent: number;
  rewardCents: number;
  firstPlaceBonus: string | null;
  bonusOptions: string[];
  bonusSelection: string | null;
  bonusSize: string | null;
  shippingName: string | null;
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
  shippingCity: string | null;
  shippingRegion: string | null;
  shippingPostalCode: string | null;
  shippingCountry: string | null;
  bonusFulfillmentSubmittedAt: string | null;
  bonusFulfilledAt: string | null;
  bonusFulfillmentMessage: string | null;
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
  isCurrentUser: boolean;
  weeklyWagers: number | null;
  weeklyStakeCents: number | null;
  requiredStakeCents: number | null;
  referralBoostsUsed: number;
  emailVerified: boolean | null;
  eligible: boolean;
};

export type AiPickResultStatus = "pending" | "won" | "lost" | "push" | "void";

export type DailyAiPick = {
  id: string;
  selectedTeam: string;
  publishedFor: string;
  score: number;
  confidence: number | string | null;
  reasons: string[];
  features: Record<string, unknown>;
  explanation: string | null;
  lockedAt: string | null;
  wagerId: string | null;
  wagerStatus: AiPickResultStatus | null;
  legStatus: AiPickResultStatus | null;
  resultStatus: AiPickResultStatus | null;
  stakeCents: number | null;
  potentialReturnCents: number | null;
  resultValueCents: number | null;
  sport: SportKey;
  league: string;
  startsAt: string;
  homeTeam: string;
  awayTeam: string;
  spread: string;
  oddsAmerican: number;
  marketKey: MarketKey;
};

export type DailyChineParlayLeg = {
  id: string;
  selectedTeam: string;
  legIndex: number;
  status: AiPickResultStatus;
  decimalOdds: string;
  oddsAmerican: number;
  sport: SportKey;
  league: string;
  startsAt: string;
  homeTeam: string;
  awayTeam: string;
  spread: string;
  marketKey: MarketKey;
};

export type DailyChineParlay = {
  id: string;
  kind?: WagerKind;
  projected?: boolean;
  pickDate: string;
  units: string;
  stakeCents?: number;
  potentialReturnCents?: number;
  potentialReturnUnits?: string;
  status: AiPickResultStatus;
  profitCents?: number;
  profitUnits: string;
  legs: DailyChineParlayLeg[];
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
  liveAwayScore?: number | null;
  liveHomeScore?: number | null;
  livePeriod?: string | null;
  liveGameStatus?: string | null;
  liveInPlay?: boolean;
};

export type OpenBet = {
  id: string;
  kind: WagerKind;
  stakeCents: number;
  potentialPayoutCents: number;
  roundRobinStakePerWayCents?: number | null;
  roundRobinMinLegs?: number | null;
  roundRobinMaxLegs?: number | null;
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

export type SurvivorStatus = "active" | "eliminated" | "winner";
export type SurvivorPickStatus = "pending" | "won" | "lost" | "tie" | "no_pick" | "void";

export type SurvivorGame = {
  eventKey: string;
  startsAt: string;
  awayTeam: string;
  homeTeam: string;
  awayLineId: string | null;
  homeLineId: string | null;
};

export type SurvivorPick = {
  id: string;
  weekStart: string;
  selectedTeam: string;
  awayTeam: string;
  homeTeam: string;
  startsAt: string;
  status: SurvivorPickStatus;
  locked: boolean;
  visible: boolean;
  displayTeam: string | null;
  ownerName?: string;
};

export type NflConfidenceGame = {
  id: string;
  week: number;
  startsAt: string;
  awayTeam: string;
  homeTeam: string;
  status: "scheduled" | "in_progress" | "final" | "void";
  awayScore: number | null;
  homeScore: number | null;
};

export type NflConfidencePick = {
  id: string;
  gameId: string;
  selectedTeam: string | null;
  confidencePoints: number | null;
  status: "pending" | "won" | "lost" | "void" | "no_pick";
  pointsAwarded: number;
};

export type NflConfidenceStanding = {
  userId: string;
  displayName: string;
  weekPoints: number;
  seasonPoints: number;
  submittedPicks: number;
  possibleWeekPoints: number;
};

export type NflConfidenceState = {
  pool: {
    id: string;
    name: string;
    season: number;
    startsOn: string;
    weeklyPrizeCents: number;
    seasonWinnerPrizeCents: number;
    seasonRunnerUpPrizeCents: number;
    seasonThirdPlacePrizeCents: number;
    registeredPlayers: number;
    prizePoolCents: number;
  };
  entry: {
    id: string;
    status: "active" | "inactive";
  } | null;
  currentWeek: number;
  games: NflConfidenceGame[];
  picks: NflConfidencePick[];
  unavailableConfidencePoints: number[];
  missedThursdayPick: boolean;
  sundayLocked: boolean;
  firstGameStartsAt: string | null;
  firstSundayGameStartsAt: string | null;
  weeklyStandings: NflConfidenceStanding[];
  seasonStandings: NflConfidenceStanding[];
};

export type SurvivorEntry = {
  id: string;
  status: SurvivorStatus;
  eliminatedWeekStart: string | null;
  usedTeams: string[];
  currentPick: SurvivorPick | null;
};

export type SurvivorStanding = {
  userId: string;
  displayName: string;
  status: SurvivorStatus;
  eliminatedWeekStart: string | null;
  picksMade: number;
  currentPick: SurvivorPick | null;
};

export type SurvivorState = {
  pool: {
    id: string;
    name: string;
    season: number;
    status: "active" | "completed" | "archived";
    startsOn: string;
    registeredPlayers: number;
    prizePoolCents: number;
  };
  currentWeekStart: string;
  entry: SurvivorEntry | null;
  games: SurvivorGame[];
  standings: SurvivorStanding[];
};
