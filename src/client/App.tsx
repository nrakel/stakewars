import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BadgeDollarSign, BarChart3, Bot, Check, ChevronDown, ChevronRight, ClipboardList, Download, FileText, History, Layers, Lock, LogOut, Mail, Radio, Save, ShieldCheck, ShoppingBag, Sparkles, Trophy, User, UserPlus, Wallet, WifiOff, X } from "lucide-react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import type { DailyAiPick, DailyChineParlay, DailyChineParlayLeg, GameCard, GameLine, GameMarket, GameMarketSide, LeaderboardRow, LiveGameState, OpenBet, SessionUser, SettledBet, WagerKind } from "../shared/types";
import { merchNavItemForUser } from "../shared/merch";
import "./styles.css";

type AuthMode = "login" | "register";
type AppPage = "lines" | "scoreboard" | "ai-picks" | "tower" | "leaderboard" | "open-bets" | "history" | "rules" | "contact" | "install" | "account" | "admin";
type AdminSection = "traffic" | "support" | "prizes" | "model" | "reddit" | "users";
type ScoreboardSport = "MLB" | "NFL" | "NBA" | "NHL" | "NCAAMB" | "NCAAF" | "EPL" | "WORLDCUP";
type HistoryPeriod = "day" | "week" | "all";
const MAX_CHECKED_LEGS = 8;
const sportsMenu: ScoreboardSport[] = ["MLB", "NFL", "NBA", "NHL", "NCAAMB", "NCAAF", "EPL", "WORLDCUP"];
const TOWER_FEATURE_ENABLED = false;

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type Bankroll = {
  id: string;
  balance_cents: number;
};

type SlipLeg = {
  gameLineId: string;
  selectedTeam: string;
  expectedSpread: string;
  expectedOddsAmerican: number;
  sport?: GameLine["sport"];
  startsAt?: string;
  awayTeam?: string;
  homeTeam?: string;
  marketKey?: GameLine["marketKey"];
};

type LineMoveNotice = {
  oldGameLineId: string;
  newGameLineId: string;
  game: string;
  selectedTeam: string;
  marketKey: GameLine["marketKey"];
  oldSpread: string;
  newSpread: string;
  oldOddsAmerican: number;
  newOddsAmerican: number;
};

type LineMoveErrorBody = {
  error: string;
  code: "LINE_MOVED";
  lineMoves: LineMoveNotice[];
};

type PushPreferences = {
  gameReminderEnabled: boolean;
  gameStartedEnabled: boolean;
  scoreChangeEnabled: boolean;
  gameFinalEnabled: boolean;
};

type RedditStatus = {
  configured: boolean;
  mode: "manual";
  connected: boolean;
  redditUsername: string | null;
  connectedAt: string | null;
  scopes: string[];
  defaultSubreddits: string[];
};

type RedditPreview = {
  subreddit: string;
  title: string;
  body: string;
};

type RedditLockResult = {
  id: string;
  lockedAt: string;
  postType: "single" | "parlay";
  legs: number;
};

type ReferralInfo = {
  referralCode: string;
  referralUrl: string;
  referredCount: number;
};

type UserDisplayMapRow = {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  leaderboardDisplayName: string | null;
  leaderboardRank: number | null;
  fullName: string | null;
  role: SessionUser["role"];
  createdAt: string;
};

type VisitorMetricRow = {
  label: string;
  uniqueVisitors: number;
  totalVisitors: number;
  humanVisitors: number;
  otherVisitors: number;
};

type VisitorMetrics = {
  generatedAt: string;
  lastUpdatedAt: string | null;
  rows: VisitorMetricRow[];
};

type SupportCategory = "account_email" | "rewards_eligibility" | "picks_scoring" | "technical_problem" | "other";

type SupportConversation = {
  id: string;
  category: SupportCategory;
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  username?: string;
  displayName?: string | null;
  email?: string | null;
  lastMessage?: string | null;
};

type SupportMessage = {
  id: string;
  senderRole: "user" | "admin";
  body: string;
  createdAt: string;
};

type TowerRank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";
type TowerSuit = "hearts" | "diamonds" | "clubs" | "spades";
type TowerResult = "pending" | "won" | "lost" | "push" | "void";
type TowerPublicCard = {
  rank: TowerRank | null;
  suit: TowerSuit | null;
  value: number | null;
  id: string | null;
  faceUp: boolean;
  causedCollapse: boolean;
};

type TowerPayoutRatio = {
  numerator: number;
  denominator: number;
};

type TowerPayoutBand = {
  minHeight: number;
  maxHeight: number | null;
  payout: TowerPayoutRatio;
};

type TowerConfig = {
  minWagerCents: number;
  maxWagerCents: number;
  defaultWagerCents: number;
  maxExposureCents: number;
  heightQualificationMinCards: number;
  heightPayouts: TowerPayoutBand[];
};

type TowerHand = {
  id: string;
  status: "player_turn" | "awaiting_double_decision" | "settled" | "voided" | string;
  actionVersion: number;
  playerCards: TowerPublicCard[];
  dealerCards: TowerPublicCard[];
  playerHeight: number;
  playerValue: number;
  dealerHeight: number | null;
  dealerValue: number | null;
  playerCollapsed: boolean;
  dealerCollapsed: boolean;
  doubleOpportunity: boolean;
  doubleOpportunityRank: TowerRank | null;
  valueWagerCents: number;
  heightWagerCents: number;
  originalValueWagerCents: number;
  originalHeightWagerCents: number;
  valueResult: TowerResult;
  heightResult: TowerResult;
  valuePayoutCents: number;
  heightPayoutCents: number;
  heightQualified: boolean;
  currentHeightPayoutBand: TowerPayoutBand | null;
  nextHeightPayoutBand: TowerPayoutBand | null;
  dealerOpeningRankCategory: "J" | "Q" | "K" | "lower_than_jack" | null;
  completedAt: string | null;
};

type TowerCounter = {
  exactCards: Array<{ rank: TowerRank; suit: TowerSuit; remainingUnseen: number }>;
  ranks: Array<{ rank: TowerRank; value: number; remainingUnseen: number }>;
  totalPubliclyUnseenCards: number;
  totalPhysicallyUndealtCards: number;
  hiddenCardsInPlay: number;
};

type TowerHistoryHand = {
  id: string;
  status: string;
  playerCards: TowerPublicCard[];
  dealerCards: TowerPublicCard[];
  playerHeight: number;
  playerValue: number;
  dealerHeight: number | null;
  dealerValue: number | null;
  valueWagerCents: number;
  heightWagerCents: number;
  valueResult: TowerResult;
  heightResult: TowerResult;
  valuePayoutCents: number;
  heightPayoutCents: number;
  startedAt: string;
  completedAt: string | null;
};

type TowerState = {
  balanceCents: number;
  hand: TowerHand | null;
  counter: TowerCounter | null;
  config: TowerConfig;
  history: TowerHistoryHand[];
};

type TowerSimulationSummary = {
  requestedHands: number;
  completedHands: number;
  valueResults: Record<TowerResult, number>;
  heightResults: Record<TowerResult, number>;
  playerCollapses: number;
  dealerCollapses: number;
  avgPlayerValue: number | null;
  avgDealerValue: number | null;
  balanceCents: number;
};

type LeaderboardWeek = {
  weekStart: string;
  isCurrent: boolean;
};

type LeaderboardResponse = {
  leaderboard: LeaderboardRow[];
  weeks: LeaderboardWeek[];
  weekStart: string | null;
  isCurrentWeek: boolean;
  registeredPlayers: number;
  weeklyPrizeCents: number;
  weeklyPrize?: WeeklyPrize;
};

type WeeklyPrize = {
  weekStart: string;
  cashPrizeCents: number;
  firstPlaceBonus: string | null;
  updatedAt?: string;
};

type AdminPrizesResponse = {
  currentWeekStart: string;
  nextWeekStart: string;
  prizes: WeeklyPrize[];
};

type ChineModelAuditGroup = {
  label: string;
  picks: number;
  wins: number;
  losses: number;
  pushes: number;
  winPct: number | null;
  netUnits: number;
  avgConfidence: number | null;
  avgEdge: number | null;
};

type ChineModelAudit = {
  generatedAt: string;
  since: string | null;
  through: string | null;
  summary: ChineModelAuditGroup[];
  confidenceBuckets: ChineModelAuditGroup[];
  markets: ChineModelAuditGroup[];
  reasons: ChineModelAuditGroup[];
  reasonCounts: ChineModelAuditGroup[];
  edgeRanges: ChineModelAuditGroup[];
  favoriteUnderdog: ChineModelAuditGroup[];
  homeRoad: ChineModelAuditGroup[];
  starterEdge: ChineModelAuditGroup[];
  bullpenEdge: ChineModelAuditGroup[];
  marketMovement: ChineModelAuditGroup[];
};

type VerificationRequiredResponse = {
  verificationRequired: true;
  userId: string;
  email: string;
};

const isVerificationRequiredResponse = (value: unknown): value is VerificationRequiredResponse =>
  Boolean(
    value
    && typeof value === "object"
    && (value as VerificationRequiredResponse).verificationRequired === true
    && typeof (value as VerificationRequiredResponse).userId === "string"
    && typeof (value as VerificationRequiredResponse).email === "string"
  );

const money = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const pct = (value: number | null | undefined) => value == null ? "-" : `${(value * 100).toFixed(1)}%`;
const units = (value: number | null | undefined) => value == null ? "-" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}u`;

function ModelAuditTable({ title, rows, emptyLabel = "No settled picks in this group yet." }: { title: string; rows: ChineModelAuditGroup[]; emptyLabel?: string }) {
  return (
    <div className="model-audit-table">
      <h3>{title}</h3>
      <div className="user-map-table">
        <table>
          <thead>
            <tr>
              <th>Group</th>
              <th>Picks</th>
              <th>W-L-P</th>
              <th>Win %</th>
              <th>Net Units</th>
              <th>Avg Conf</th>
              <th>Avg Edge</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>{row.picks}</td>
                <td>{row.wins}-{row.losses}-{row.pushes}</td>
                <td>{pct(row.winPct)}</td>
                <td>{units(row.netUnits)}</td>
                <td>{pct(row.avgConfidence)}</td>
                <td>{pct(row.avgEdge)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7}>{emptyLabel}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const weekRangeLabel = (weekStart: string) => {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${startLabel} - ${endLabel}`;
};

const americanOdds = (odds: number) => `${odds > 0 ? "+" : ""}${odds}`;

const americanToDecimal = (odds: number) => odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);

const linePriceText = (marketKey: GameLine["marketKey"], spread: string, odds: number) => {
  if (marketKey === "h2h") return americanOdds(odds);
  if (marketKey === "totals") return `${spread} ${americanOdds(odds)}`;
  return `${Number(spread) > 0 ? `+${spread}` : spread} ${americanOdds(odds)}`;
};

const isLineMoveErrorBody = (body: unknown): body is LineMoveErrorBody =>
  Boolean(
    body
    && typeof body === "object"
    && (body as LineMoveErrorBody).code === "LINE_MOVED"
    && Array.isArray((body as LineMoveErrorBody).lineMoves)
  );

const lineMovePrompt = (moves: LineMoveNotice[]) => {
  if (moves.length === 1) {
    const move = moves[0];
    return `The line for ${move.game} has changed from ${linePriceText(move.marketKey, move.oldSpread, move.oldOddsAmerican)} to ${linePriceText(move.marketKey, move.newSpread, move.newOddsAmerican)}.\n\nDo you accept the new price?`;
  }
  const details = moves.map((move) =>
    `${move.game} ${move.selectedTeam}: ${linePriceText(move.marketKey, move.oldSpread, move.oldOddsAmerican)} -> ${linePriceText(move.marketKey, move.newSpread, move.newOddsAmerican)}`
  ).join("\n");
  return `The lines for these selections have changed:\n\n${details}\n\nDo you accept the new prices?`;
};

const replacementForSlipLeg = (leg: SlipLeg, freshLines: GameLine[]) => {
  const direct = freshLines.find((line) => line.id === leg.gameLineId);
  if (direct) return direct;
  if (!leg.sport || !leg.startsAt || !leg.awayTeam || !leg.homeTeam || !leg.marketKey) {
    return null;
  }

  const originalStart = new Date(leg.startsAt).getTime();
  return freshLines
    .filter((line) =>
      line.sport === leg.sport
      && line.awayTeam === leg.awayTeam
      && line.homeTeam === leg.homeTeam
      && line.marketKey === leg.marketKey
      && line.favoriteTeam === leg.selectedTeam
      && Math.abs(new Date(line.startsAt).getTime() - originalStart) <= 3 * 60 * 60 * 1000
    )
    .sort((left, right) =>
      Math.abs(new Date(left.startsAt).getTime() - originalStart)
      - Math.abs(new Date(right.startsAt).getTime() - originalStart)
    )[0] ?? null;
};

const rebindSlipToFreshLines = (slip: SlipLeg[], freshLines: GameLine[]) => {
  const idMap = new Map<string, string>();
  const nextSlip = slip.map((leg) => {
    const replacement = replacementForSlipLeg(leg, freshLines);
    if (!replacement || replacement.id === leg.gameLineId) {
      return leg;
    }
    idMap.set(leg.gameLineId, replacement.id);
    return {
      ...leg,
      gameLineId: replacement.id,
      expectedSpread: replacement.spread,
      expectedOddsAmerican: replacement.oddsAmerican,
      sport: replacement.sport,
      startsAt: replacement.startsAt,
      awayTeam: replacement.awayTeam,
      homeTeam: replacement.homeTeam,
      marketKey: replacement.marketKey
    };
  });
  return { nextSlip, idMap };
};

const statusLabel = (status: string) => status === "void" ? "No Action" : status;

const aiPickResultLabel = (status: DailyAiPick["resultStatus"]) => {
  if (!status || status === "pending") return null;
  if (status === "won") return "Won";
  if (status === "lost") return "Lost";
  if (status === "push") return "Push";
  return "No Action";
};

const signedMoney = (cents: number) => `${cents >= 0 ? "+" : "-"}${money(Math.abs(cents))}`;

const aiPickWagerSummary = (pick: DailyAiPick) => {
  if (!pick.wagerId || pick.stakeCents == null) return null;
  if (pick.resultStatus && pick.resultStatus !== "pending" && pick.resultValueCents != null) {
    if (pick.resultStatus === "won") return `Won ${signedMoney(pick.resultValueCents)}`;
    if (pick.resultStatus === "lost") return `Lost ${signedMoney(pick.resultValueCents)}`;
    if (pick.resultStatus === "push") return "Push $0.00";
    return "No Action $0.00";
  }
  if (pick.potentialReturnCents == null) return `Wagered ${money(pick.stakeCents)}`;
  return `Wagered ${money(pick.stakeCents)} • Could return ${money(pick.potentialReturnCents)}`;
};

const trackedResultLabel = (status: DailyChineParlay["status"]) => {
  if (!status || status === "pending") return null;
  if (status === "won") return "Won";
  if (status === "lost") return "Lost";
  if (status === "push") return "Push";
  return "No Action";
};

const dailyChineParlayWagerSummary = (parlay: DailyChineParlay) => {
  if (parlay.status !== "pending" && parlay.profitCents != null) {
    if (parlay.status === "won") return `Won ${signedMoney(parlay.profitCents)}`;
    if (parlay.status === "lost") return `Lost ${signedMoney(parlay.profitCents)}`;
    if (parlay.status === "push") return "Push $0.00";
    return "No Action $0.00";
  }
  if (parlay.stakeCents != null && parlay.potentialReturnCents != null) {
    return `Wagered ${money(parlay.stakeCents)} • Could return ${money(parlay.potentialReturnCents)}`;
  }
  return null;
};

const teamAbbreviations: Record<string, string> = {
  "Arizona Diamondbacks": "ARI",
  "Atlanta Braves": "ATL",
  "Baltimore Orioles": "BAL",
  "Boston Red Sox": "BOS",
  "Chicago Cubs": "CHC",
  "Chicago White Sox": "CWS",
  "Cincinnati Reds": "CIN",
  "Cleveland Guardians": "CLE",
  "Colorado Rockies": "COL",
  "Detroit Tigers": "DET",
  "Houston Astros": "HOU",
  "Kansas City Royals": "KC",
  "Los Angeles Angels": "LAA",
  "Los Angeles Dodgers": "LAD",
  "Miami Marlins": "MIA",
  "Milwaukee Brewers": "MIL",
  "Minnesota Twins": "MIN",
  "New York Mets": "NYM",
  "New York Yankees": "NYY",
  "Athletics": "ATH",
  "Oakland Athletics": "ATH",
  "Philadelphia Phillies": "PHI",
  "Pittsburgh Pirates": "PIT",
  "San Diego Padres": "SD",
  "San Francisco Giants": "SF",
  "Seattle Mariners": "SEA",
  "St. Louis Cardinals": "STL",
  "Tampa Bay Rays": "TB",
  "Texas Rangers": "TEX",
  "Toronto Blue Jays": "TOR",
  "Washington Nationals": "WSH"
};

const teamAbbreviation = (team: string) => teamAbbreviations[team] ?? team
  .split(/\s+/)
  .filter(Boolean)
  .map((word) => word[0])
  .join("")
  .slice(0, 3)
  .toUpperCase();

const LegStatusIcon = ({ status }: { status: string }) => {
  if (status === "won") {
    return <Check className="leg-status-icon won" size={16} aria-label="Won leg" />;
  }
  if (status === "lost") {
    return <X className="leg-status-icon lost" size={16} aria-label="Lost leg" />;
  }
  return <span className={`leg-status-icon ${status}`} aria-label={statusLabel(status)} />;
};

class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const estimatePayoutCents = (stakeCents: number, odds: number[]) =>
  Math.floor(stakeCents * odds.reduce((product, lineOdds) => product * americanToDecimal(lineOdds), 1));

const combinations = (n: number, k: number) => {
  let result = 1;
  for (let i = 1; i <= k; i += 1) {
    result = (result * (n - i + 1)) / i;
  }
  return result;
};

const roundRobinWays = (legs: number, maxLegs = legs) => {
  if (legs < 2 || legs > MAX_CHECKED_LEGS || maxLegs < 2 || maxLegs > legs) return 0;
  let total = 0;
  for (let size = 2; size <= maxLegs; size += 1) {
    total += combinations(legs, size);
  }
  return total;
};

const roundRobinPayoutCents = (stakePerWayCents: number, odds: number[], maxLegs: number) => {
  let total = 0;
  const visit = (start: number, size: number, selected: number[]) => {
    if (selected.length === size) {
      total += estimatePayoutCents(stakePerWayCents, selected.map((index) => odds[index]));
      return;
    }

    for (let index = start; index <= odds.length - (size - selected.length); index += 1) {
      visit(index + 1, size, [...selected, index]);
    }
  };

  for (let size = 2; size <= maxLegs; size += 1) {
    visit(0, size, []);
  }

  return total;
};

const urlBase64ToUint8Array = (base64String: string) => {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
};

const lineupStats = (player: { position: string | null; batSide: string | null; avg: string | null; homeRuns: number | null; rbi: number | null }) => [
  player.position,
  player.batSide ? `${player.batSide} bat` : null,
  player.avg ? `AVG ${player.avg}` : null,
  player.homeRuns !== null ? `${player.homeRuns} HR` : null,
  player.rbi !== null ? `${player.rbi} RBI` : null
].filter(Boolean).join(" • ");

const pitcherLine = (pitcher: GameCard["awayProbablePitcher"] | GameCard["homeProbablePitcher"]) => {
  if (!pitcher?.name) {
    return "Probable pitcher pending";
  }
  const record = pitcher.wins !== null && pitcher.losses !== null ? `${pitcher.wins}-${pitcher.losses}` : null;
  const era = pitcher.era !== null ? `${pitcher.era.toFixed(2)} ERA` : null;
  return [pitcher.name, record, era].filter(Boolean).join(" • ");
};

const aiConfidenceLabel = (game: GameCard) => {
  if (game.sport !== "MLB" || !game.aiConfidence) {
    return null;
  }
  return `${teamAbbreviation(game.aiConfidence.selectedTeam)} ${Math.round(game.aiConfidence.confidence * 100)}%`;
};

const liveCount = (game: LiveGameState) => (
  game.balls !== null && game.strikes !== null ? `${game.balls}-${game.strikes}` : null
);

const liveOuts = (outs: number | null) => outs !== null ? `${outs} out${outs === 1 ? "" : "s"}` : null;

const pitcherDetail = (game: LiveGameState) => [
  game.pitcher ? `P: ${game.pitcher}` : null,
  game.pitcherPitches !== null ? `${game.pitcherPitches} pitches` : null
].filter(Boolean).join(" • ");

const batterDetail = (game: LiveGameState) => [
  game.batter ? `AB: ${game.batter}` : null,
  game.batterHits !== null && game.batterAtBats !== null ? `${game.batterHits}-${game.batterAtBats}` : null
].filter(Boolean).join(" • ");

const pageTitle = (page: AppPage, lineSport: ScoreboardSport, scoreboardSport: ScoreboardSport) => {
  if (page === "scoreboard") return `${scoreboardSport} ScoreBoard`;
  if (page === "lines") return `${lineSport} Lines`;
  if (page === "open-bets") return "Open Bets";
  if (page === "contact") return "Contact Us";
  if (page === "install") return "Install App";
  if (page === "ai-picks") return "Daily Chine Picks";
  if (page === "tower") return "Tower";
  if (page === "admin") return "Admin";
  return page.charAt(0).toUpperCase() + page.slice(1);
};

const baseOccupied = (game: LiveGameState, base: "onFirst" | "onSecond" | "onThird") => Boolean(game.bases?.[base]);

const BaseDiamond = ({ game }: { game: LiveGameState }) => (
  <div className="base-diamond" aria-label="Runners on base">
    <span className={`base-marker second ${baseOccupied(game, "onSecond") ? "occupied" : ""}`} title={baseOccupied(game, "onSecond") ? `2B: ${game.bases.onSecond}` : "2B empty"} />
    <span className={`base-marker third ${baseOccupied(game, "onThird") ? "occupied" : ""}`} title={baseOccupied(game, "onThird") ? `3B: ${game.bases.onThird}` : "3B empty"} />
    <span className={`base-marker first ${baseOccupied(game, "onFirst") ? "occupied" : ""}`} title={baseOccupied(game, "onFirst") ? `1B: ${game.bases.onFirst}` : "1B empty"} />
  </div>
);

const isIosDevice = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || ((navigator as Navigator & { platform?: string; maxTouchPoints?: number }).platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1);

const installInstructions = () => {
  const userAgent = navigator.userAgent;
  const isIos = isIosDevice();
  const isAndroid = /android/i.test(userAgent);
  const isChromeIos = /crios/i.test(userAgent);
  const isSafari = /safari/i.test(userAgent) && !/chrome|crios|fxios|edgios/i.test(userAgent);
  const isDesktopChromium = /chrome|edg/i.test(userAgent) && !isAndroid && !isIos;

  if (isIos && (isChromeIos || isSafari)) {
    return {
      title: "Install on iPhone",
      body: "Use the browser share menu to add StakeWars to your Home Screen.",
      steps: [
        "Tap the Share button in the browser toolbar.",
        "Choose Add to Home Screen.",
        "Tap Add to confirm."
      ],
      note: isChromeIos ? "If Add to Home Screen is not shown in Chrome, open stakewars.phisystems.ai in Safari and use the same steps." : null
    };
  }

  if (isAndroid) {
    return {
      title: "Install on Android",
      body: "Use Chrome's app install option to add StakeWars to your Home screen.",
      steps: [
        "Tap the browser menu.",
        "Choose Install app or Add to Home screen.",
        "Confirm the installation."
      ],
      note: null
    };
  }

  if (isDesktopChromium) {
    return {
      title: "Install on Desktop",
      body: "Use the browser's install control to add StakeWars as an app.",
      steps: [
        "Look for the install icon in the address bar.",
        "If it is not visible, open the browser menu.",
        "Choose Install StakeWars or Save and share > Install page as app."
      ],
      note: null
    };
  }

  return {
    title: "Install StakeWars",
    body: "Your browser may support installing this site from its menu.",
    steps: [
      "Open the browser menu or share menu.",
      "Look for Install, Add to Home Screen, or Save to device.",
      "If no install option is available, use Safari on iPhone or Chrome on Android/Desktop."
    ],
    note: null
  };
};

function InstallContent({
  canPrompt,
  isStandalone,
  onInstall
}: {
  canPrompt: boolean;
  isStandalone: boolean;
  onInstall: () => void;
}) {
  const instructions = installInstructions();

  return (
    <div className="install-content">
      <div className="install-status">
        <Download size={22} />
        <div>
          <strong>{isStandalone ? "StakeWars is installed" : instructions.title}</strong>
          <span>{isStandalone ? "You are already running StakeWars as an installed app." : instructions.body}</span>
        </div>
      </div>
      {!isStandalone && canPrompt && (
        <button className="primary install-primary" type="button" onClick={onInstall}>
          <Download size={18} /> Install App
        </button>
      )}
      {!isStandalone && (
        <ol className="install-steps">
          {instructions.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      )}
      {!isStandalone && instructions.note && <p className="hint">{instructions.note}</p>}
    </div>
  );
}

const api = async <T,>(path: string, options: RequestInit = {}, token?: string): Promise<T> => {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(body.error ?? "Request failed", response.status, body);
  }
  return body as T;
};

function RulesContent() {
  return (
    <div className="rules-content">
      <section>
        <h2>How It Works</h2>
        <p>Each week, every player receives a free virtual bankroll. Place wagers on available lines and try to finish the week with one of the top three settled balances.</p>
      </section>
      <section>
        <h2>Contest Window</h2>
        <p>The leaderboard resets every Monday morning. Open wagers may reduce available bankroll for betting, but leaderboard balance reflects settled results.</p>
      </section>
      <section>
        <h2>Wager Types</h2>
        <p>Players can make straight wagers, parlays, and round robins. Parlays and round robins are limited to 8 checked games.</p>
      </section>
      <section>
        <h2>Reward Eligibility</h2>
        <p>To be eligible for a weekly reward, a player must have a verified email address, place at least 10 wagers during the week, and wager at least 1.5x their starting weekly bankroll. With the current $10,000 starting bankroll, that means at least $15,000 in total weekly virtual wagers.</p>
      </section>
      <section>
        <h2>Baseball Settlement</h2>
        <p>Postponed, suspended, cancelled, or shortened MLB games are No Action. MLB games must complete at least 9 innings to settle. A No Action single returns the wager to the player's bankroll. In parlays, the affected leg is dropped; if only one active leg remains, the wager settles as a straight bet.</p>
      </section>
      <section>
        <h2>Soccer Settlement</h2>
        <p>Soccer moneylines are settled as 3-way markets: Team A, Draw, or Team B. The result is based on the official score at the end of regulation plus stoppage time, not extra time or penalty kicks. If the match is tied at that point, Draw wins and both team moneyline selections lose, even if one team later advances or wins on penalties.</p>
      </section>
      <section>
        <h2>Chine</h2>
        <p>StakeWars Chine posts public picks. To receive a weekly reward, an eligible player must finish in the top three and beat StakeWars Chine on the final leaderboard. Failure to beat Chine at the end of the week disqualifies the player from receiving a reward.</p>
      </section>
      <section>
        <h2>No Real-Money Gambling</h2>
        <p>StakeWars is a free contest using virtual bankroll only. No purchase, deposit, or real-money wager is required or accepted.</p>
      </section>
      <section>
        <h2>Prizes</h2>
        <p>The weekly prize pool is shown on the leaderboard and may include a first-place bonus prize. Eligible winners split the cash pool 50%, 35%, and 15% for first, second, and third place. Players remain ranked by bankroll even while ineligible, but they must have a verified email address, satisfy the weekly wager requirements, finish in an eligible leaderboard position, and beat StakeWars Chine to receive a reward. Site operators may void errors, duplicate accounts, abusive activity, or wagers affected by incorrect data.</p>
      </section>
      <section>
        <h2>Withdrawals</h2>
        <p>Withdrawals are only available once a player's reward balance meets or exceeds the $20.00 threshold and the required payout details are complete.</p>
      </section>
    </div>
  );
}

function LegalContent({ kind }: { kind: "privacy" | "terms" }) {
  if (kind === "privacy") {
    return (
      <div className="rules-content legal-content">
        <section>
          <h2>Privacy Policy</h2>
          <p>Effective June 29, 2026. StakeWars is a free sports prediction contest operated at stakewars.ai.</p>
        </section>
        <section>
          <h2>Information We Collect</h2>
          <p>We collect account information players provide, including username, password hash, full name, email, email verification status, display name, payout preference, payout handle, and the last four digits of a phone number when entered for reward validation.</p>
        </section>
        <section>
          <h2>Contest Data</h2>
          <p>We store virtual wagers, bankroll balances, leaderboard results, settled wager history, notification preferences, push subscription records, and account activity needed to run the contest.</p>
        </section>
        <section>
          <h2>How We Use Information</h2>
          <p>We use information to authenticate users, verify email addresses, operate the contest, display leaderboards and wager history, send requested push notifications, validate rewards, prevent abuse, provide support, and publish admin-approved public updates.</p>
        </section>
        <section>
          <h2>Sharing</h2>
          <p>We do not sell personal information. We may share limited information with service providers necessary to host the site, send push notifications, maintain security, or process rewards.</p>
        </section>
        <section>
          <h2>Security</h2>
          <p>Passwords are stored as hashes. Administrative integrations use server-side secrets. No internet service can be guaranteed perfectly secure, but we use reasonable safeguards for the data we store.</p>
        </section>
        <section>
          <h2>Contact</h2>
          <p>Questions about this policy can be sent to support@stakewars.ai.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="rules-content legal-content">
      <section>
        <h2>Terms and Conditions</h2>
        <p>Effective June 29, 2026. By using StakeWars, you agree to these terms and the contest rules shown on the site.</p>
      </section>
      <section>
        <h2>Free Contest</h2>
        <p>StakeWars is a free virtual-bankroll contest. No purchase, deposit, or real-money wager is required or accepted. Virtual wagers have no cash value.</p>
      </section>
      <section>
        <h2>Eligibility and Accounts</h2>
        <p>Players must provide accurate account information, verify their email address for reward eligibility, and may not create duplicate accounts, manipulate results, abuse promotions, or interfere with site operations.</p>
      </section>
      <section>
        <h2>Rules and Rewards</h2>
        <p>The active weekly prize pool is shown on the leaderboard and is split 50%, 35%, and 15% among eligible first, second, and third place finishers. A week may also include a separate first-place bonus prize. Weekly rewards require players to satisfy the posted rules, including verified email, placing at least 10 weekly wagers, wagering at least 1.5x the weekly starting bankroll, finishing in an eligible leaderboard position, and beating StakeWars Chine. Withdrawal eligibility requires a reward balance of at least $20.00, verified email, and complete payout details.</p>
      </section>
      <section>
        <h2>Line and Scoring Data</h2>
        <p>StakeWars relies on third-party sports, odds, and scoring data. Site operators may correct obvious data errors, void affected wagers, mark games No Action, or adjust settlement when required for fairness.</p>
      </section>
      <section>
        <h2>Changes</h2>
        <p>StakeWars may update these terms, contest rules, features, or reward details. Continued use of the site after updates means you accept the revised terms.</p>
      </section>
    </div>
  );
}

function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  return (
    <main className="legal-shell">
      <section className="panel legal-panel">
        <div className="panel-title">
          <FileText size={20} />
          <h1>{kind === "privacy" ? "Privacy Policy" : "Terms and Conditions"}</h1>
        </div>
        <LegalContent kind={kind} />
        <div className="legal-actions">
          <a href="/">Return to StakeWars</a>
          <a href={kind === "privacy" ? "/terms" : "/privacy"}>{kind === "privacy" ? "Terms and Conditions" : "Privacy Policy"}</a>
        </div>
      </section>
    </main>
  );
}

function AuthPanel({
  onAuth,
  canInstall,
  isStandalone,
  onInstall
}: {
  onAuth: (token: string, user: SessionUser) => void;
  canInstall: boolean;
  isStandalone: boolean;
  onInstall: () => void;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [registrationEmail, setRegistrationEmail] = useState("");
  const [registrationDisplayName, setRegistrationDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryToken, setRecoveryToken] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [verificationUserId, setVerificationUserId] = useState("");
  const [verificationEmail, setVerificationEmail] = useState("");
  const [error, setError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [publicMerchStoreUrl, setPublicMerchStoreUrl] = useState<string | null>(null);
  const [referralCode] = useState(() => {
    const urlCode = new URLSearchParams(window.location.search).get("ref")?.trim() ?? "";
    if (urlCode) {
      localStorage.setItem("stakewars_referral_code", urlCode);
      return urlCode;
    }
    return localStorage.getItem("stakewars_referral_code") ?? "";
  });

  useEffect(() => {
    api<{ url: string; label: string }>("/merch/store")
      .then((result) => setPublicMerchStoreUrl(result.url))
      .catch(() => setPublicMerchStoreUrl(null));
  }, []);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError("");
    setAuthNotice("");
    setVerificationUserId("");
    setVerificationEmail("");
    setRecoveryToken("");
    setRecoveryPassword("");
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verificationResult = params.get("emailVerified");
    const authToken = params.get("authToken");
    const emailVerificationToken = params.get("verifyEmail");
    const emailRecoveryToken = params.get("emailRecovery");
    if (emailRecoveryToken) {
      setMode("login");
      setRecoveryToken(emailRecoveryToken);
      setAuthNotice("Set a new password to recover your account and keep your original email verified.");
      params.delete("emailRecovery");
      const nextSearch = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`);
      return;
    }
    if (emailVerificationToken) {
      setMode("login");
      params.delete("verifyEmail");
      const nextSearch = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`);
      const finish = async () => {
        try {
          const result = await api<{ token: string; user: SessionUser }>("/auth/verify-email-link", {
            method: "POST",
            body: JSON.stringify({ token: emailVerificationToken })
          });
          localStorage.removeItem("stakewars_referral_code");
          localStorage.setItem("stakewars_token", result.token);
          onAuth(result.token, result.user);
        } catch {
          setAuthNotice("That verification link is invalid or expired. Log in to request a new one.");
        }
      };
      void finish();
      return;
    }
    if (!verificationResult) return;
    const finish = async () => {
      setMode("login");
      if (verificationResult === "success" && authToken) {
        try {
          const result = await api<{ user: SessionUser; bankroll: Bankroll }>("/me", {}, authToken);
          localStorage.removeItem("stakewars_referral_code");
          localStorage.setItem("stakewars_token", authToken);
          onAuth(authToken, result.user);
          return;
        } catch {
          setAuthNotice("Email verified. You can log in now.");
        }
      } else {
        setAuthNotice(
          verificationResult === "success"
            ? "Email verified. You can log in now."
            : "That verification link is invalid or expired. Log in to request a new one."
        );
      }
    };
    params.delete("emailVerified");
    params.delete("authToken");
    const nextSearch = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`);
    void finish();
  }, [onAuth]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ token: string; user: SessionUser } | VerificationRequiredResponse>(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          ...(mode === "register" ? { email: registrationEmail, displayName: registrationDisplayName } : {}),
          ...(mode === "register" && referralCode ? { referralCode } : {})
        })
      });
      if (isVerificationRequiredResponse(result)) {
        setVerificationUserId(result.userId);
        setVerificationEmail(result.email);
        setAuthNotice("Check your email for a verification link. Once verified, you can log in.");
        return;
      }
      localStorage.removeItem("stakewars_referral_code");
      localStorage.setItem("stakewars_token", result.token);
      onAuth(result.token, result.user);
    } catch (err) {
      if (
        err instanceof ApiError
        && err.status === 403
        && isVerificationRequiredResponse(err.body)
      ) {
        setMode("register");
        setVerificationUserId(err.body.userId);
        setVerificationEmail(err.body.email);
        setAuthNotice("Check your email for a verification link. Once verified, you can log in.");
      }
      setError((err as Error).message);
    }
  };

  const resendVerificationLink = async () => {
    if (!verificationUserId) return;
    setError("");
    try {
      const result = await api<{ sent?: boolean; email?: string; alreadyVerified?: boolean }>("/auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ userId: verificationUserId })
      });
      setError(result.alreadyVerified ? "Email is already verified. Try logging in." : "A new verification link was sent.");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submitEmailRecovery = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setAuthNotice("");
    try {
      const result = await api<{ token: string; user: SessionUser }>("/auth/recover-email-change", {
        method: "POST",
        body: JSON.stringify({
          token: recoveryToken,
          password: recoveryPassword
        })
      });
      localStorage.removeItem("stakewars_referral_code");
      localStorage.setItem("stakewars_token", result.token);
      onAuth(result.token, result.user);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openPublicMerchStore = async () => {
    if (!publicMerchStoreUrl) return;
    try {
      await api<{ ok: boolean }>("/merch/click", {
        method: "POST",
        body: JSON.stringify({ source: "public_landing" }),
        keepalive: true
      });
    } catch {
      // Navigation should not be blocked by click logging.
    } finally {
      window.location.assign(publicMerchStoreUrl);
    }
  };

  return (
    <section className="auth-shell">
      <div className="brand-panel">
        <img className="hero-logo" src="/images/sw-hero.png" alt="StakeWars" />
      </div>
      <form className="auth-card" onSubmit={recoveryToken ? submitEmailRecovery : submit} autoComplete="on">
        <div className="auth-heading">
          <img className="auth-logo" src="/icons/icon-192.png" alt="" />
          <div>
            <div className="auth-title-block">
              <h1>StakeWars</h1>
              <h2>Can You Beat Chine?</h2>
            </div>
            <p className="auth-pitch">
              <span>Chine is building today's card.</span><br />
              <strong>Now build a better one.</strong>
            </p>
            <div className="auth-benefits" aria-label="StakeWars benefits">
              <span>🏆 Free to Play</span>
              <span>🤖 Compete Against Chine</span>
              <span>💰 Win Weekly Prizes</span>
            </div>
            <button className="auth-signup-cta" type="button" onClick={() => switchMode("register")}>
              Sign Up Free
            </button>
            {publicMerchStoreUrl && (
              <button className="auth-gear-link" type="button" onClick={() => void openPublicMerchStore()}>
                <ShoppingBag size={17} /> Gear
              </button>
            )}
            <button className="rules-link" type="button" onClick={() => setRulesOpen(true)}>
              Rules and Terms
            </button>
          </div>
        </div>
        <div className="segmented">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => switchMode("login")}>
            <Lock size={16} /> Login
          </button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => switchMode("register")}>
            <UserPlus size={16} /> Register
          </button>
        </div>
        {recoveryToken ? (
          <>
            <div className="notification-card">
              <div>
                <strong>Recover account</strong>
                <span>This will keep the original email verified, discard the pending email change, and require a new password.</span>
              </div>
            </div>
            <label>
              New password
              <input
                name="new-password"
                type="password"
                autoComplete="new-password"
                value={recoveryPassword}
                onChange={(event) => setRecoveryPassword(event.target.value)}
                minLength={10}
                required
              />
            </label>
            <p className="hint">Minimum 10 characters with uppercase, lowercase, number, and symbol.</p>
          </>
        ) : verificationUserId ? (
          <div className="notification-card">
            <div>
              <strong>Verify your email</strong>
              <span>We sent a verification link to {verificationEmail}. Open it to activate prize eligibility, then log in.</span>
            </div>
          </div>
        ) : (
          <>
            <label>
              Username
              <input
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                minLength={3}
                maxLength={32}
                required
              />
            </label>
            {mode === "register" && (
              <>
                <label>
                  Email
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    value={registrationEmail}
                    onChange={(event) => setRegistrationEmail(event.target.value)}
                    maxLength={254}
                    required
                  />
                </label>
                <label>
                  Display Name
                  <input
                    name="displayName"
                    autoComplete="nickname"
                    value={registrationDisplayName}
                    onChange={(event) => setRegistrationDisplayName(event.target.value)}
                    minLength={2}
                    maxLength={40}
                    required
                  />
                </label>
              </>
            )}
            <label>
              Password
              <input
                name={mode === "login" ? "current-password" : "new-password"}
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={10}
                required
              />
            </label>
          </>
        )}
        {mode === "register" && !verificationUserId && !recoveryToken && (
          <p className="hint">
            Minimum 10 characters with uppercase, lowercase, number, and symbol.
            {referralCode && <span className="referral-applied"> Referral applied.</span>}
          </p>
        )}
        {authNotice && <p className="success">{authNotice}</p>}
        {error && <p className="error">{error}</p>}
        {recoveryToken ? (
          <button className="primary" type="submit">Recover account</button>
        ) : verificationUserId ? (
          <button className="primary" type="button" onClick={() => switchMode("login")}>Back to login</button>
        ) : (
          <button className="primary" type="submit">{mode === "login" ? "Login" : "Create account"}</button>
        )}
        {verificationUserId && (
          <button className="secondary-action" type="button" onClick={resendVerificationLink}>
            Send new link
          </button>
        )}
        <button className="secondary-action" type="button" onClick={() => canInstall ? onInstall() : setInstallOpen(true)}>
          <Download size={17} /> Install App
        </button>
        <div className="legal-links">
          <a href="/terms">Terms and Conditions</a>
          <a href="/privacy">Privacy Policy</a>
        </div>
      </form>
      {rulesOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setRulesOpen(false)}>
          <div className="rules-modal" role="dialog" aria-modal="true" aria-label="Rules and Terms" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <strong>Rules and Terms</strong>
                <span>StakeWars weekly contest basics</span>
              </div>
              <button title="Close rules" type="button" onClick={() => setRulesOpen(false)}><X size={18} /></button>
            </div>
            <RulesContent />
          </div>
        </div>
      )}
      {installOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setInstallOpen(false)}>
          <div className="rules-modal" role="dialog" aria-modal="true" aria-label="Install StakeWars" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <strong>Install App</strong>
                <span>Add StakeWars to this device</span>
              </div>
              <button title="Close install instructions" type="button" onClick={() => setInstallOpen(false)}><X size={18} /></button>
            </div>
            <InstallContent canPrompt={canInstall} isStandalone={isStandalone} onInstall={onInstall} />
          </div>
        </div>
      )}
    </section>
  );
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("stakewars_token") ?? "");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [bankroll, setBankroll] = useState<Bankroll | null>(null);
  const [lines, setLines] = useState<GameLine[]>([]);
  const [markets, setMarkets] = useState<GameMarket[]>([]);
  const [games, setGames] = useState<GameCard[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [leaderboardWeeks, setLeaderboardWeeks] = useState<LeaderboardWeek[]>([]);
  const [leaderboardWeekStart, setLeaderboardWeekStart] = useState("");
  const [leaderboardIsCurrentWeek, setLeaderboardIsCurrentWeek] = useState(true);
  const [registeredPlayers, setRegisteredPlayers] = useState(0);
  const [weeklyPrizeCents, setWeeklyPrizeCents] = useState(0);
  const [weeklyFirstPlaceBonus, setWeeklyFirstPlaceBonus] = useState<string | null>(null);
  const [liveGames, setLiveGames] = useState<LiveGameState[]>([]);
  const [openBets, setOpenBets] = useState<OpenBet[]>([]);
  const [historyBets, setHistoryBets] = useState<SettledBet[]>([]);
  const [aiPicks, setAiPicks] = useState<DailyAiPick[]>([]);
  const [dailyChineParlay, setDailyChineParlay] = useState<DailyChineParlay | null>(null);
  const [towerState, setTowerState] = useState<TowerState | null>(null);
  const [towerValueWager, setTowerValueWager] = useState("5");
  const [towerHeightWager, setTowerHeightWager] = useState("5");
  const [towerPending, setTowerPending] = useState(false);
  const [towerShowResult, setTowerShowResult] = useState(false);
  const [towerAnimationNote, setTowerAnimationNote] = useState("");
  const [towerNotice, setTowerNotice] = useState("");
  const [towerCounterExpanded, setTowerCounterExpanded] = useState(false);
  const [towerCounterView, setTowerCounterView] = useState<"rank" | "exact">("rank");
  const [towerSimValueWager, setTowerSimValueWager] = useState("100");
  const [towerSimHeightWager, setTowerSimHeightWager] = useState("100");
  const [towerSimHands, setTowerSimHands] = useState("10");
  const [towerSimRunning, setTowerSimRunning] = useState(false);
  const [towerSimCompleted, setTowerSimCompleted] = useState(0);
  const [towerSimNotice, setTowerSimNotice] = useState("");
  const [kind, setKind] = useState<WagerKind>("straight");
  const [stake, setStake] = useState("100");
  const [roundRobinMaxLegs, setRoundRobinMaxLegs] = useState(2);
  const [singleStakeAll, setSingleStakeAll] = useState("");
  const [singleStakes, setSingleStakes] = useState<Record<string, string>>({});
  const [includedLegIds, setIncludedLegIds] = useState<Set<string>>(() => new Set());
  const [slip, setSlip] = useState<SlipLeg[]>([]);
  const [acceptLineMoves, setAcceptLineMoves] = useState(false);
  const [notice, setNotice] = useState("");
  const [activePage, setActivePage] = useState<AppPage>("lines");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(() => window.matchMedia("(max-width: 860px)").matches);
  const [expandedNavGroup, setExpandedNavGroup] = useState<"lines" | "scoreboard" | null>(null);
  const [lineSport, setLineSport] = useState<ScoreboardSport>("MLB");
  const [scoreboardSport, setScoreboardSport] = useState<ScoreboardSport>("MLB");
  const [historyPeriod, setHistoryPeriod] = useState<HistoryPeriod>("week");
  const [historyIncludeAi, setHistoryIncludeAi] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [accountEmailNotice, setAccountEmailNotice] = useState("");
  const [emailEditing, setEmailEditing] = useState(false);
  const [accountSaving, setAccountSaving] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [payoutMethod, setPayoutMethod] = useState<SessionUser["payoutMethod"]>("none");
  const [payoutHandle, setPayoutHandle] = useState("");
  const [phoneLast4, setPhoneLast4] = useState("");
  const [lineupGame, setLineupGame] = useState<GameCard | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [pushNotice, setPushNotice] = useState("");
  const [pushPreferences, setPushPreferences] = useState<PushPreferences>({
    gameReminderEnabled: false,
    gameStartedEnabled: false,
    scoreChangeEnabled: false,
    gameFinalEnabled: false
  });
  const [adminSection, setAdminSection] = useState<AdminSection>("traffic");
  const [redditStatus, setRedditStatus] = useState<RedditStatus | null>(null);
  const [redditSubreddit, setRedditSubreddit] = useState("");
  const [redditTitle, setRedditTitle] = useState("");
  const [redditBody, setRedditBody] = useState("");
  const [redditParlayTitle, setRedditParlayTitle] = useState("");
  const [redditParlayBody, setRedditParlayBody] = useState("");
  const [redditNotice, setRedditNotice] = useState("");
  const [redditSingleLock, setRedditSingleLock] = useState<RedditLockResult | null>(null);
  const [redditParlayLock, setRedditParlayLock] = useState<RedditLockResult | null>(null);
  const [redditLockingType, setRedditLockingType] = useState<"single" | "parlay" | null>(null);
  const [userDisplayMap, setUserDisplayMap] = useState<UserDisplayMapRow[]>([]);
  const [userDisplayMapNotice, setUserDisplayMapNotice] = useState("");
  const [visitorMetrics, setVisitorMetrics] = useState<VisitorMetrics | null>(null);
  const [visitorMetricsNotice, setVisitorMetricsNotice] = useState("");
  const [adminPrizes, setAdminPrizes] = useState<WeeklyPrize[]>([]);
  const [adminPrizeWeekStart, setAdminPrizeWeekStart] = useState("");
  const [adminPrizeCash, setAdminPrizeCash] = useState("10.00");
  const [adminPrizeBonus, setAdminPrizeBonus] = useState("");
  const [adminPrizeNotice, setAdminPrizeNotice] = useState("");
  const [chineModelAudit, setChineModelAudit] = useState<ChineModelAudit | null>(null);
  const [chineModelAuditNotice, setChineModelAuditNotice] = useState("");
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportCategory, setSupportCategory] = useState<SupportCategory | "">("");
  const [supportMessage, setSupportMessage] = useState("");
  const [supportNotice, setSupportNotice] = useState("");
  const [supportConversations, setSupportConversations] = useState<SupportConversation[]>([]);
  const [activeSupportConversation, setActiveSupportConversation] = useState<SupportConversation | null>(null);
  const [activeSupportMessages, setActiveSupportMessages] = useState<SupportMessage[]>([]);
  const [supportReplyMessage, setSupportReplyMessage] = useState("");
  const [adminSupportConversations, setAdminSupportConversations] = useState<SupportConversation[]>([]);
  const [selectedSupportConversation, setSelectedSupportConversation] = useState<SupportConversation | null>(null);
  const [supportMessages, setSupportMessages] = useState<SupportMessage[]>([]);
  const [supportReply, setSupportReply] = useState("");
  const [supportTranscriptOnClose, setSupportTranscriptOnClose] = useState(true);
  const userSupportMessagesRef = useRef<HTMLDivElement | null>(null);
  const adminSupportMessagesRef = useRef<HTMLDivElement | null>(null);
  const [referralInfo, setReferralInfo] = useState<ReferralInfo | null>(null);
  const [referralQr, setReferralQr] = useState("");
  const [referralNotice, setReferralNotice] = useState("");
  const [merchStoreUrl, setMerchStoreUrl] = useState<string | null>(null);

  const refresh = async (authToken = token) => {
    const leaderboardPath = leaderboardWeekStart ? `/leaderboard?weekStart=${encodeURIComponent(leaderboardWeekStart)}` : "/leaderboard";
    const [lineResult, boardResult, aiResult, liveMlbResult, liveEplResult, liveWorldCupResult] = await Promise.all([
      api<{ lines: GameLine[]; markets: GameMarket[]; games: GameCard[] }>("/lines"),
      api<LeaderboardResponse>(leaderboardPath, {}, authToken),
      api<{ picks: DailyAiPick[]; parlay: DailyChineParlay | null }>("/ai-picks"),
      api<{ games: LiveGameState[] }>("/live/mlb"),
      api<{ games: LiveGameState[] }>("/live/epl"),
      api<{ games: LiveGameState[] }>("/live/worldcup")
    ]);
    setLines(lineResult.lines);
    setSlip((current) => {
      const { nextSlip, idMap } = rebindSlipToFreshLines(current, lineResult.lines);
      if (idMap.size > 0) {
        setSingleStakes((stakes) => {
          const next = { ...stakes };
          for (const [oldId, newId] of idMap.entries()) {
            if (next[oldId] !== undefined && next[newId] === undefined) {
              next[newId] = next[oldId];
            }
            delete next[oldId];
          }
          return next;
        });
        setIncludedLegIds((included) => {
          const next = new Set(included);
          for (const [oldId, newId] of idMap.entries()) {
            if (next.has(oldId)) {
              next.delete(oldId);
              next.add(newId);
            }
          }
          return next;
        });
      }
      return nextSlip;
    });
    setMarkets(lineResult.markets ?? []);
    setGames(lineResult.games ?? []);
    setLeaderboard(boardResult.leaderboard);
    setLeaderboardWeeks(boardResult.weeks ?? []);
    setLeaderboardIsCurrentWeek(boardResult.isCurrentWeek);
    setRegisteredPlayers(boardResult.registeredPlayers ?? 0);
    setWeeklyPrizeCents(boardResult.weeklyPrizeCents ?? 0);
    setWeeklyFirstPlaceBonus(boardResult.weeklyPrize?.firstPlaceBonus ?? null);
    if (boardResult.weekStart && (!leaderboardWeekStart || leaderboardWeekStart !== boardResult.weekStart)) {
      setLeaderboardWeekStart(boardResult.weekStart);
    }
    setAiPicks(aiResult.picks);
    setDailyChineParlay(aiResult.parlay);
    setLiveGames([...liveMlbResult.games, ...liveEplResult.games, ...liveWorldCupResult.games]);
    if (authToken) {
      const [me, openBetResult, pushPreferenceResult, referralResult] = await Promise.all([
        api<{ user: SessionUser; bankroll: Bankroll }>("/me", {}, authToken),
        api<{ wagers: OpenBet[] }>("/wagers/open", {}, authToken),
        api<{ preferences: PushPreferences }>("/push/preferences", {}, authToken),
        api<ReferralInfo>("/me/referral", {}, authToken)
      ]);
      setUser(me.user);
      setFullName(me.user.fullName ?? "");
      setEmail(me.user.email ?? "");
      setEmailEditing(false);
      setDisplayName(me.user.displayName ?? "");
      setPayoutMethod(me.user.payoutMethod);
      setPayoutHandle(me.user.payoutHandle ?? "");
      setPhoneLast4(me.user.phoneLast4 ?? "");
      setBankroll(me.bankroll);
      setOpenBets(openBetResult.wagers);
      setPushPreferences(pushPreferenceResult.preferences);
      setReferralInfo(referralResult);
      if (TOWER_FEATURE_ENABLED) {
        api<TowerState>("/tower/state", {}, authToken)
          .then((result) => setTowerState(result))
          .catch(() => setTowerState(null));
      } else {
        setTowerState(null);
      }
      if (merchNavItemForUser(me.user.username)) {
        api<{ url: string; label: string }>("/merch/store", {}, authToken)
          .then((result) => setMerchStoreUrl(result.url))
          .catch(() => setMerchStoreUrl(null));
      } else {
        setMerchStoreUrl(null);
      }
      setReferralQr(await QRCode.toDataURL(referralResult.referralUrl, {
        width: 220,
        margin: 1,
        errorCorrectionLevel: "M",
        color: {
          dark: "#14201c",
          light: "#ffffff"
        }
      }));
    }
  };

  const refreshHistory = async (authToken = token, period = historyPeriod, includeAi = historyIncludeAi) => {
    if (!authToken) {
      setHistoryBets([]);
      return;
    }
    const result = await api<{ wagers: SettledBet[] }>(`/wagers/history?period=${period}&includeAi=${includeAi ? "true" : "false"}`, {}, authToken);
    setHistoryBets(result.wagers);
  };

  const refreshReferral = async (authToken = token) => {
    if (!authToken) {
      setReferralInfo(null);
      setReferralQr("");
      return;
    }
    const result = await api<ReferralInfo>("/me/referral", {}, authToken);
    setReferralInfo(result);
    setReferralQr(await QRCode.toDataURL(result.referralUrl, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: "M",
      color: {
        dark: "#14201c",
        light: "#ffffff"
      }
    }));
  };

  const loadLeaderboardWeek = async (weekStart: string) => {
    setLeaderboardWeekStart(weekStart);
    const result = await api<LeaderboardResponse>(`/leaderboard?weekStart=${encodeURIComponent(weekStart)}`, {}, token);
    setLeaderboard(result.leaderboard);
    setLeaderboardWeeks(result.weeks ?? []);
    setLeaderboardIsCurrentWeek(result.isCurrentWeek);
    setRegisteredPlayers(result.registeredPlayers ?? 0);
    setWeeklyPrizeCents(result.weeklyPrizeCents ?? 0);
    setWeeklyFirstPlaceBonus(result.weeklyPrize?.firstPlaceBonus ?? null);
    if (result.weekStart) {
      setLeaderboardWeekStart(result.weekStart);
    }
  };

  const isMobileLayout = () => window.matchMedia("(max-width: 860px)").matches;

  const scrollSupportMessagesToBottom = (element: HTMLDivElement | null) => {
    if (!element) return;
    requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
  };

  const isNateRakelAccount = user?.username.toLowerCase() === "nathanielrakel@gmail.com";
  const merchNavItem = merchStoreUrl ? merchNavItemForUser(user?.username, merchStoreUrl) : null;

  const openPage = (page: AppPage) => {
    if (page === "tower" && (!TOWER_FEATURE_ENABLED || !isNateRakelAccount)) {
      setActivePage("lines");
      return;
    }
    setActivePage(page);
    if (page !== "lines" && page !== "scoreboard") {
      setExpandedNavGroup(null);
    }
    if (isMobileLayout()) {
      setMobileMenuOpen(false);
    }
  };

  const toggleNavGroup = (group: "lines" | "scoreboard") => {
    setExpandedNavGroup((current) => current === group ? null : group);
  };

  const jumpToBetSlip = () => {
    document.getElementById("bet-slip")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const openMerchStore = async () => {
    if (!merchNavItem) return;
    try {
      await api<{ ok: boolean }>("/merch/click", {
        method: "POST",
        body: JSON.stringify({ source: "authenticated_nav" }),
        keepalive: true
      }, token);
    } catch {
      // Navigation should not be blocked by click logging.
    } finally {
      window.location.assign(merchNavItem.url);
    }
  };

  const refreshTower = async (authToken = token) => {
    if (!authToken) return;
    const result = await api<TowerState>("/tower/state", {}, authToken);
    setTowerState(result);
    setTowerShowResult(Boolean(result.hand && result.hand.status === "settled"));
    setTowerAnimationNote("");
    setBankroll((current) => current ? { ...current, balance_cents: result.balanceCents } : current);
  };

  const parseTowerWagerCents = (value: string, label: string, config: TowerConfig) => {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`${label} wager must be a whole number of credits.`);
    }
    const credits = Number(trimmed);
    if (!Number.isSafeInteger(credits)) {
      throw new Error(`${label} wager is too large.`);
    }
    const cents = credits * 100;
    if (cents > 0 && cents < config.minWagerCents) {
      throw new Error(`${label} wager must be at least ${money(config.minWagerCents)}.`);
    }
    if (cents > config.maxWagerCents) {
      throw new Error(`${label} wager cannot exceed ${money(config.maxWagerCents)}.`);
    }
    return cents;
  };

  const applyTowerResult = (result: Partial<TowerState> & { balanceCents?: number; hand?: TowerHand | null; counter?: TowerCounter | null }) => {
    setTowerState((current) => current ? {
      ...current,
      balanceCents: result.balanceCents ?? current.balanceCents,
      hand: result.hand ?? current.hand,
      counter: result.counter ?? current.counter
    } : null);
    if (typeof result.balanceCents === "number") {
      setBankroll((current) => current ? { ...current, balance_cents: result.balanceCents! } : current);
    }
  };

  const animateTowerCapResult = async (
    result: Partial<TowerState> & { balanceCents?: number; hand: TowerHand; counter?: TowerCounter | null }
  ) => {
    setTowerShowResult(false);
    setTowerAnimationNote("Settling the hand...");
    await wait(1100);
    applyTowerResult(result);
    setTowerShowResult(true);
    setTowerAnimationNote("");
  };

  const startTower = async () => {
    if (!token) return;
    const config = towerState?.config;
    if (!config) {
      setTowerNotice("Tower configuration is not loaded yet.");
      return;
    }
    let valueWagerCents = 0;
    let heightWagerCents = 0;
    try {
      valueWagerCents = parseTowerWagerCents(towerValueWager, "Value", config);
      heightWagerCents = parseTowerWagerCents(towerHeightWager, "Height", config);
      if (valueWagerCents + heightWagerCents <= 0) {
        setTowerNotice("Enter a Value wager, Height wager, or both.");
        return;
      }
    } catch (error) {
      setTowerNotice((error as Error).message);
      return;
    }
    setTowerPending(true);
    setTowerNotice("");
    try {
      const result = await api<Partial<TowerState> & { balanceCents: number; hand: TowerHand; counter: TowerCounter }>("/tower/hands", {
        method: "POST",
        body: JSON.stringify({
          valueWagerCents,
          heightWagerCents
        })
      }, token);
      applyTowerResult(result);
      setTowerShowResult(false);
      setTowerAnimationNote("");
    } catch (error) {
      setTowerNotice((error as Error).message);
    } finally {
      setTowerPending(false);
    }
  };

  const towerAction = async (action: "build" | "cap") => {
    if (!token || !towerState?.hand) return;
    setTowerPending(true);
    setTowerNotice("");
    try {
      const result = await api<Partial<TowerState> & { balanceCents?: number; hand: TowerHand; counter?: TowerCounter }>(`/tower/hands/${towerState.hand.id}/${action}`, {
        method: "POST",
        body: JSON.stringify({ actionVersion: towerState.hand.actionVersion })
      }, token);
      if (action === "cap" && result.hand.status === "settled") {
        await animateTowerCapResult(result);
      } else {
        applyTowerResult(result);
        setTowerShowResult(false);
      }
      if (result.hand.status === "settled") {
        if (action !== "cap") {
          setTowerAnimationNote("Settling the hand...");
          await wait(1000);
          setTowerShowResult(true);
          setTowerAnimationNote("");
        }
        await refreshTower().catch(() => undefined);
      }
    } catch (error) {
      setTowerNotice((error as Error).message);
      if (error instanceof ApiError && error.status === 409) {
        await refreshTower().catch(() => undefined);
      }
    } finally {
      setTowerPending(false);
    }
  };

  const towerDouble = async (doubleValue: boolean, doubleHeight: boolean) => {
    if (!token || !towerState?.hand) return;
    setTowerPending(true);
    setTowerNotice("");
    try {
      const result = await api<Partial<TowerState> & { balanceCents: number; hand: TowerHand }>("/tower/hands/" + towerState.hand.id + "/double", {
        method: "POST",
        body: JSON.stringify({
          actionVersion: towerState.hand.actionVersion,
          doubleValue,
          doubleHeight
        })
      }, token);
      applyTowerResult(result);
      setTowerShowResult(false);
      setTowerAnimationNote("");
    } catch (error) {
      setTowerNotice((error as Error).message);
      if (error instanceof ApiError && error.status === 409) {
        await refreshTower().catch(() => undefined);
      }
    } finally {
      setTowerPending(false);
    }
  };

  const startTowerSimulator = async () => {
    if (!token || !towerState?.config || !isNateRakelAccount) return;
    let valueWagerCents = 0;
    let heightWagerCents = 0;
    let handCount = 0;
    try {
      valueWagerCents = parseTowerWagerCents(towerSimValueWager, "Simulator Value", towerState.config);
      heightWagerCents = parseTowerWagerCents(towerSimHeightWager, "Simulator Height", towerState.config);
      handCount = Number(towerSimHands.trim());
      if (!/^\d+$/.test(towerSimHands.trim()) || !Number.isSafeInteger(handCount) || handCount < 1 || handCount > 1000) {
        throw new Error("Hands to simulate must be a whole number from 1 to 1000.");
      }
      if (valueWagerCents + heightWagerCents <= 0) {
        throw new Error("Enter a Value wager, Height wager, or both.");
      }
    } catch (error) {
      setTowerSimNotice((error as Error).message);
      return;
    }

    setTowerSimRunning(true);
    setTowerPending(true);
    setTowerShowResult(false);
    setTowerNotice("");
    setTowerSimNotice("Server simulator running: chase dealer Value unless the dealer collapses; then build for 3+ floors and a 9+ top card.");
    setTowerSimCompleted(0);

    try {
      setTowerAnimationNote(`Running ${handCount} Tower hands server-side`);
      const result = await api<{ simulation: TowerSimulationSummary; state: TowerState }>("/admin/tower/simulate", {
        method: "POST",
        body: JSON.stringify({ valueWagerCents, heightWagerCents, hands: handCount })
      }, token);
      setTowerState(result.state);
      setBankroll((current) => current ? { ...current, balanceCents: result.state.balanceCents } : current);
      setTowerShowResult(false);
      setTowerSimCompleted(result.simulation.completedHands);
      setTowerSimNotice(
        `Simulator complete: ${result.simulation.completedHands} hands. `
        + `Value ${result.simulation.valueResults.won}-${result.simulation.valueResults.lost}-${result.simulation.valueResults.push}; `
        + `Height ${result.simulation.heightResults.won}-${result.simulation.heightResults.lost}. `
        + `Player collapsed ${result.simulation.playerCollapses} times; dealer collapsed ${result.simulation.dealerCollapses} times.`
      );
    } catch (error) {
      setTowerSimNotice((error as Error).message);
      if (error instanceof ApiError && error.status === 409) {
        await refreshTower().catch(() => undefined);
      }
    } finally {
      setTowerAnimationNote("");
      setTowerPending(false);
      setTowerSimRunning(false);
    }
  };

  const canManageReddit = Boolean(user && (user.role === "admin" || isNateRakelAccount));

  useEffect(() => {
    refresh().catch((error) => {
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem("stakewars_token");
        setToken("");
      }
    });
  }, []);

  useEffect(() => {
    if (user && activePage === "tower" && (!TOWER_FEATURE_ENABLED || !isNateRakelAccount)) {
      setActivePage("lines");
    }
  }, [activePage, isNateRakelAccount, user]);

  useEffect(() => {
    refreshHistory().catch(() => undefined);
  }, [token, historyPeriod, historyIncludeAi]);

  useEffect(() => {
    if (!token || !canManageReddit) {
      setRedditStatus(null);
      return;
    }
    api<RedditStatus>("/admin/reddit/status", {}, token)
      .then((status) => {
        setRedditStatus(status);
        if (!redditSubreddit && status.defaultSubreddits[0]) {
          setRedditSubreddit(status.defaultSubreddits[0]);
        }
      })
      .catch(() => setRedditStatus(null));
  }, [token, canManageReddit]);

  useEffect(() => {
    if (!token || !isNateRakelAccount) {
      setUserDisplayMap([]);
      setUserDisplayMapNotice("");
      setVisitorMetrics(null);
      setVisitorMetricsNotice("");
      setAdminSupportConversations([]);
      setAdminPrizes([]);
      setChineModelAudit(null);
      setChineModelAuditNotice("");
      return;
    }
    Promise.all([
      api<{ users: UserDisplayMapRow[] }>("/admin/user-display-map", {}, token),
      api<VisitorMetrics>("/admin/visitors", {}, token),
      api<{ conversations: SupportConversation[] }>("/admin/support/conversations?status=open", {}, token),
      api<AdminPrizesResponse>("/admin/prizes", {}, token),
      api<ChineModelAudit>("/admin/chine-model-audit", {}, token)
    ])
      .then(([usersResult, visitorsResult, supportResult, prizesResult, auditResult]) => {
        setUserDisplayMap(usersResult.users);
        setVisitorMetrics(visitorsResult);
        setAdminSupportConversations(supportResult.conversations);
        setAdminPrizes(prizesResult.prizes);
        setChineModelAudit(auditResult);
        const selectedPrize = prizesResult.prizes.find((prize) => prize.weekStart === prizesResult.nextWeekStart)
          ?? prizesResult.prizes.find((prize) => prize.weekStart === prizesResult.currentWeekStart);
        setAdminPrizeWeekStart(selectedPrize?.weekStart ?? prizesResult.nextWeekStart);
        if (selectedPrize) {
          setAdminPrizeCash((selectedPrize.cashPrizeCents / 100).toFixed(2));
          setAdminPrizeBonus(selectedPrize.firstPlaceBonus ?? "");
        }
        setUserDisplayMapNotice("");
        setVisitorMetricsNotice("");
        setChineModelAuditNotice("");
      })
      .catch((err) => setUserDisplayMapNotice((err as Error).message));
  }, [token, isNateRakelAccount]);

  useEffect(() => {
    if (!token || !isNateRakelAccount) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("page") !== "admin") return;
    openPage("admin");
    if (params.get("adminTab") === "support") {
      setAdminSection("support");
    }
    const conversationId = params.get("conversation");
    if (conversationId) {
      void openAdminSupportConversation(conversationId);
    }
    params.delete("page");
    params.delete("adminTab");
    params.delete("conversation");
    const nextSearch = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`);
  }, [token, isNateRakelAccount]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!token || !user?.emailVerified) return;
    void refreshUserSupportConversations();
  }, [token, user?.emailVerified]);

  useEffect(() => {
    scrollSupportMessagesToBottom(userSupportMessagesRef.current);
  }, [activeSupportConversation?.id, activeSupportMessages.length, supportOpen]);

  useEffect(() => {
    scrollSupportMessagesToBottom(adminSupportMessagesRef.current);
  }, [selectedSupportConversation?.id, supportMessages.length, adminSection, activePage]);

  useEffect(() => {
    if (!supportOpen || !token || !activeSupportConversation) return;
    const refreshThread = async () => {
      try {
        const result = await api<{ conversation: SupportConversation; messages: SupportMessage[] }>(`/support/conversations/${activeSupportConversation.id}`, {}, token);
        setActiveSupportConversation(result.conversation);
        setActiveSupportMessages(result.messages);
      } catch {
        // Ignore transient support refresh failures.
      }
    };
    void refreshThread();
    const timer = window.setInterval(refreshThread, 10_000);
    return () => window.clearInterval(timer);
  }, [supportOpen, token, activeSupportConversation?.id]);

  useEffect(() => {
    if (activePage !== "admin" || adminSection !== "support" || !token || !selectedSupportConversation || !isNateRakelAccount) return;
    let refreshing = false;
    const refreshSelectedThread = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const result = await api<{ conversation: SupportConversation; messages: SupportMessage[] }>(`/admin/support/conversations/${selectedSupportConversation.id}`, {}, token);
        setSelectedSupportConversation(result.conversation);
        setSupportMessages(result.messages);
        await refreshAdminSupport().catch(() => undefined);
      } catch {
        // Ignore transient admin support refresh failures.
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(refreshSelectedThread, 5_000);
    return () => window.clearInterval(timer);
  }, [activePage, adminSection, token, selectedSupportConversation?.id, isNateRakelAccount]);

  useEffect(() => {
    let refreshing = false;
    const refreshVisibleData = async () => {
      if (document.visibilityState !== "visible" || !navigator.onLine || refreshing) {
        return;
      }
      refreshing = true;
      try {
        await refresh();
        await refreshHistory();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          localStorage.removeItem("stakewars_token");
          setToken("");
        }
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(refreshVisibleData, 30_000);
    const onFocus = () => {
      void refreshVisibleData();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshVisibleData();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onFocus);
    };
  }, [token, historyPeriod, historyIncludeAi, leaderboardWeekStart]);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    const standalone = window.matchMedia("(display-mode: standalone)").matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setIsStandalone(standalone);

    const beforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const appInstalled = () => {
      setInstallPrompt(null);
      setIsStandalone(true);
    };
    const online = () => setIsOnline(true);
    const offline = () => setIsOnline(false);

    window.addEventListener("beforeinstallprompt", beforeInstall);
    window.addEventListener("appinstalled", appInstalled);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);

    return () => {
      window.removeEventListener("beforeinstallprompt", beforeInstall);
      window.removeEventListener("appinstalled", appInstalled);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  const selectedIds = useMemo(() => new Set(slip.map((leg) => leg.gameLineId)), [slip]);
  const sportsWithLines = useMemo(() => new Set(games.map((game) => game.sport as ScoreboardSport)), [games]);
  const firstAvailableSport = sportsMenu.find((sport) => sportsWithLines.has(sport));
  const selectedSportGames = useMemo(() => games.filter((game) => game.sport === lineSport), [games, lineSport]);
  const savedEmail = user?.email ?? "";
  const typedEmail = email.trim();
  const emailNeedsSave = typedEmail !== savedEmail;
  const canWithdraw = Boolean(
    user
    && user.rewardBalanceCents > 2000
    && user.emailVerified
    && payoutMethod !== "none"
    && payoutHandle.trim().length >= 2
    && /^[0-9]{4}$/.test(phoneLast4)
  );
  const lockedAiPicks = aiPicks.filter((pick) => Boolean(pick.lockedAt));
  const projectedAiPicks = aiPicks.filter((pick) => !pick.lockedAt);
  const qualifiedLeaderboardRows = leaderboard.filter((row) => row.role !== "system" && row.rank <= 3 && row.eligible);
  const rewardShares = [50, 35, 15];
  const rewardShareByRank = new Map(qualifiedLeaderboardRows.map((row, index) => [row.rank, rewardShares[index] ?? 0]));
  const rewardCentsByRank = new Map(qualifiedLeaderboardRows.map((row, index) => [
    row.rank,
    Math.round(weeklyPrizeCents * ((rewardShares[index] ?? 0) / 100))
  ]));

  useEffect(() => {
    if (firstAvailableSport && !sportsWithLines.has(lineSport)) {
      setLineSport(firstAvailableSport);
    }
    if (firstAvailableSport && !sportsWithLines.has(scoreboardSport)) {
      setScoreboardSport(firstAvailableSport);
    }
  }, [firstAvailableSport, lineSport, scoreboardSport, sportsWithLines]);

  const renderAiPick = (pick: DailyAiPick) => {
    const resultLabel = aiPickResultLabel(pick.resultStatus);
    const wagerSummary = aiPickWagerSummary(pick);
    return (
    <div className="ai-pick" key={pick.id}>
      <div className="pick-badges">
        <small className={pick.lockedAt ? "pick-status locked" : "pick-status projected"}>
          {pick.lockedAt ? "Locked" : "Projected"}
        </small>
        {resultLabel && (
          <small className={`pick-result ${pick.resultStatus}`}>
            {resultLabel}
          </small>
        )}
      </div>
      <strong>{pick.selectedTeam} {pick.marketKey === "h2h" ? americanOdds(pick.oddsAmerican) : `${pick.spread} ${americanOdds(pick.oddsAmerican)}`}</strong>
      <span>{pick.awayTeam} at {pick.homeTeam}</span>
      {wagerSummary && <span className="chine-wager-summary">{wagerSummary}</span>}
      {pick.confidence && <span>Confidence {Math.round(Number(pick.confidence) * 100)}%</span>}
      {pick.explanation
        ? <small className="ai-explanation">{pick.explanation}</small>
        : pick.reasons?.length > 0 && <small>{pick.reasons.join(" · ")}</small>}
    </div>
    );
  };

  const parlayReturnUnits = (parlay: DailyChineParlay) =>
    Number(parlay.units) * parlay.legs.reduce((product, leg) => product * Number(leg.decimalOdds), 1);

  const formatUnitAmount = (value: number) => `${value.toFixed(Number.isInteger(value) ? 0 : 2)}u`;

  const renderParlayLeg = (leg: DailyChineParlayLeg) => {
    const resultLabel = trackedResultLabel(leg.status);
    return (
      <li key={leg.id}>
        <span>
          <strong>{leg.selectedTeam}</strong>
          <small>{linePriceText(leg.marketKey, leg.spread, leg.oddsAmerican)}</small>
        </span>
        <small>{leg.awayTeam} at {leg.homeTeam}</small>
        {resultLabel && <small className={`pick-result ${leg.status}`}>{resultLabel}</small>}
      </li>
    );
  };

  const renderDailyChineParlay = (parlay: DailyChineParlay) => {
    const resultLabel = trackedResultLabel(parlay.status);
    const returnUnits = parlay.potentialReturnUnits ? Number(parlay.potentialReturnUnits) : parlayReturnUnits(parlay);
    const legCount = parlay.legs.length;
    const roundRobinLabel = `${legCount}-Game Round Robin`;
    const wagerSummary = dailyChineParlayWagerSummary(parlay);
    return (
      <div className="ai-pick daily-parlay" key={parlay.id}>
        <div className="pick-badges">
          <small className="pick-status locked">{roundRobinLabel}</small>
          {resultLabel && <small className={`pick-result ${parlay.status}`}>{resultLabel}</small>}
        </div>
        <strong>{formatUnitAmount(Number(parlay.units))} to return {formatUnitAmount(returnUnits)}</strong>
        {wagerSummary && <span className="chine-wager-summary">{wagerSummary}</span>}
        <ul className="daily-parlay-legs">
          {parlay.legs.map(renderParlayLeg)}
        </ul>
      </div>
    );
  };

  const aiPicksContent = (
    <>
      {dailyChineParlay && dailyChineParlay.legs.length === 7 && (
        <>
          <h3 className="pick-section-title">7-Game Round Robin</h3>
          {renderDailyChineParlay(dailyChineParlay)}
        </>
      )}
      {aiPicks.length === 0 ? !dailyChineParlay && <p className="muted">No public AI picks for today.</p> : (
        <>
          {lockedAiPicks.length > 0 && (
            <>
              <h3 className="pick-section-title">Locked Picks</h3>
              {lockedAiPicks.map(renderAiPick)}
            </>
          )}
          {projectedAiPicks.length > 0 && (
            <>
              <h3 className="pick-section-title">Projected Picks</h3>
              {projectedAiPicks.map(renderAiPick)}
            </>
          )}
        </>
      )}
    </>
  );

  const renderSettledBet = (bet: SettledBet) => (
    <article className={`history-bet ${bet.owner === "ai" ? "ai" : "user"}`} key={bet.id}>
      <div className="history-bet-head">
        <div>
          <strong>{bet.displayName}</strong>
          <span>{bet.kind.replace("_", " ")} • {new Date(bet.placedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        </div>
        <div className="history-result">
          <small className={`status-pill ${bet.status}`}>{statusLabel(bet.status)}</small>
          <strong className={bet.profitCents >= 0 ? "profit-positive" : "profit-negative"}>{bet.profitCents >= 0 ? "+" : ""}{money(bet.profitCents)}</strong>
        </div>
      </div>
      <div className="history-legs">
        {bet.legs.map((leg) => {
          const marketText = leg.marketKey === "h2h"
            ? americanOdds(leg.oddsAmerican)
            : `${Number(leg.spread) > 0 ? `+${leg.spread}` : leg.spread} ${americanOdds(leg.oddsAmerican)}`;
          return (
            <div className="history-leg" key={leg.id}>
              <span><LegStatusIcon status={leg.status} /> {leg.selectedTeam} {marketText}</span>
              <small>{leg.awayTeam} @ {leg.homeTeam} • {new Date(leg.startsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small>
            </div>
          );
        })}
      </div>
    </article>
  );

  const lineForId = (id: string) => lines.find((item) => item.id === id);
  const sameGame = (left: GameLine | undefined, right: GameLine | undefined) => Boolean(
    left
    && right
    && left.sport === right.sport
    && left.awayTeam === right.awayTeam
    && left.homeTeam === right.homeTeam
    && left.startsAt === right.startsAt
  );
  const conflictsWithLine = (selectedLine: GameLine, existingLine: GameLine | undefined) => {
    if (!sameGame(selectedLine, existingLine) || !existingLine) return false;
    return selectedLine.marketKey === "totals"
      ? existingLine.marketKey === "totals"
      : existingLine.marketKey !== "totals";
  };

  const addLeg = (line: GameMarketSide) => {
    setNotice("");
    if (selectedIds.has(line.id)) {
      setSlip((current) => current.filter((leg) => leg.gameLineId !== line.id));
      setSingleStakes((current) => {
        const next = { ...current };
        delete next[line.id];
        return next;
      });
      setIncludedLegIds((current) => {
        const next = new Set(current);
        next.delete(line.id);
        return next;
      });
      return;
    }
    const selectedLine = lineForId(line.id);
    setSlip((current) => {
      const conflictIds = selectedLine
        ? current.filter((leg) => conflictsWithLine(selectedLine, lineForId(leg.gameLineId))).map((leg) => leg.gameLineId)
        : [];
      const nextSlip = current.filter((leg) => !conflictIds.includes(leg.gameLineId));
      if (conflictIds.length > 0) {
        setSingleStakes((stakes) => {
          const next = { ...stakes };
          for (const id of conflictIds) {
            delete next[id];
          }
          return next;
        });
        setIncludedLegIds((included) => {
          const next = new Set(included);
          for (const id of conflictIds) {
            next.delete(id);
          }
          if (nextSlip.length < MAX_CHECKED_LEGS) {
            next.add(line.id);
          }
          return next;
        });
      } else if (current.length < MAX_CHECKED_LEGS) {
        setIncludedLegIds((included) => new Set(included).add(line.id));
      }
      if (singleStakeAll.trim()) {
        setSingleStakes((stakes) => ({ ...stakes, [line.id]: singleStakeAll }));
      }
      return [...nextSlip, {
        gameLineId: line.id,
        selectedTeam: line.team,
        expectedSpread: line.spread,
        expectedOddsAmerican: line.oddsAmerican,
        sport: selectedLine?.sport,
        startsAt: selectedLine?.startsAt,
        awayTeam: selectedLine?.awayTeam,
        homeTeam: selectedLine?.homeTeam,
        marketKey: selectedLine?.marketKey
      }];
    });
  };

  const marketLabel = (market: GameMarket, side?: GameMarketSide | null) => {
    if (market.marketKey === "h2h" && side?.team === "Draw") return "Draw";
    const teamLabel = side?.team && market.sport === "MLB" ? teamAbbreviation(side.team) : side?.team;
    if (market.marketKey === "h2h" && teamLabel) return `${teamLabel} Moneyline`;
    if (market.marketKey === "totals") return "Total";
    return `${teamLabel ? `${teamLabel} ` : ""}${market.sport === "MLB" ? "Run Line" : "Spread"}`;
  };

  const lineForLeg = (leg: SlipLeg) => lineForId(leg.gameLineId);
  const gameHasStarted = (startsAt: string) => new Date(startsAt).getTime() <= currentTime;
  const legHasStarted = (leg: SlipLeg) => {
    const line = lineForLeg(leg);
    return line ? gameHasStarted(line.startsAt) : Boolean(leg.startsAt && gameHasStarted(leg.startsAt));
  };

  const marketText = (line: GameLine | undefined) => {
    if (!line) return "";
    return line.marketKey === "h2h"
      ? americanOdds(line.oddsAmerican)
      : line.marketKey === "totals"
        ? `${line.favoriteTeam} ${line.spread} ${americanOdds(line.oddsAmerican)}`
      : `${Number(line.spread) > 0 ? `+${line.spread}` : line.spread} ${americanOdds(line.oddsAmerican)}`;
  };

  const stakeCentsFromDollars = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
  };

  const toWinCents = (stakeCents: number, odds: number[]) =>
    stakeCents > 0 && odds.length > 0 ? Math.max(0, estimatePayoutCents(stakeCents, odds) - stakeCents) : 0;

  const includedSlip = slip.filter((leg) => includedLegIds.has(leg.gameLineId));
  const parlayStakeCents = stakeCentsFromDollars(stake);
  const parlayOdds = includedSlip.map(lineForLeg).filter((line): line is GameLine => Boolean(line)).map((line) => line.oddsAmerican);
  const effectiveRoundRobinMaxLegs = Math.min(roundRobinMaxLegs, Math.max(2, includedSlip.length));
  const roundRobinCount = kind === "round_robin" ? roundRobinWays(includedSlip.length, effectiveRoundRobinMaxLegs) : 0;
  const roundRobinTotalStakeCents = kind === "round_robin" ? parlayStakeCents * roundRobinCount : parlayStakeCents;
  const parlayPotentialPayoutCents = kind === "round_robin"
    ? roundRobinPayoutCents(parlayStakeCents, parlayOdds, effectiveRoundRobinMaxLegs)
    : estimatePayoutCents(parlayStakeCents, parlayOdds);
  const parlayToWinCents = parlayStakeCents > 0 && parlayOdds.length > 0
    ? Math.max(0, parlayPotentialPayoutCents - roundRobinTotalStakeCents)
    : 0;
  const roundRobinOptions = Array.from({ length: Math.max(0, includedSlip.length - 1) }, (_, index) => {
    const maxLegs = index + 2;
    return { maxLegs, ways: roundRobinWays(includedSlip.length, maxLegs) };
  });
  const scoreboardGames = liveGames.filter((game) => game.sport === scoreboardSport);
  const bankrollValue = bankroll ? money(bankroll.balance_cents) : "$0.00";
  const bankrollInline = (
    <div className="betslip-bankroll">
      <span>Available bankroll</span>
      <strong>{bankrollValue}</strong>
    </div>
  );

  useEffect(() => {
    if (roundRobinMaxLegs > includedSlip.length) {
      setRoundRobinMaxLegs(Math.max(2, includedSlip.length));
    }
  }, [includedSlip.length, roundRobinMaxLegs]);

  const renderMarketButton = (market: GameMarket, side: GameMarketSide | null, alignment: "away" | "home" | "neutral", disabled = false) => {
    if (!side) {
      return null;
    }
    const selected = selectedIds.has(side.id);
    const lineText = market.marketKey === "h2h"
      ? americanOdds(side.oddsAmerican)
      : market.marketKey === "totals"
        ? `${side.team} ${side.spread} ${americanOdds(side.oddsAmerican)}`
        : `${Number(side.spread) > 0 ? `+${side.spread}` : side.spread} ${americanOdds(side.oddsAmerican)}`;
    return (
      <button disabled={disabled} className={`market-button ${market.marketKey === "h2h" ? "moneyline" : market.marketKey === "totals" ? "total" : "runline"} ${alignment} ${selected ? "selected" : ""}`} onClick={() => addLeg(side)}>
        <span>{marketLabel(market, side)}</span>
        <span>{lineText}</span>
      </button>
    );
  };

  const orderedMarkets = (game: GameCard, side: "away" | "home") => {
    const order = side === "away" ? ["spreads", "h2h"] : ["h2h", "spreads"];
    return [...game.markets].sort((left, right) => order.indexOf(left.marketKey) - order.indexOf(right.marketKey));
  };

  const neutralMarkets = (game: GameCard, disabled = false) => {
    const buttons: ReactNode[] = [];
    for (const market of game.markets) {
      if (market.marketKey === "h2h" && market.drawLine) {
        buttons.push(renderMarketButton(market, market.drawLine, "neutral", disabled));
      }
      if (market.marketKey === "totals") {
        buttons.push(renderMarketButton(market, market.overLine ?? null, "neutral", disabled));
        buttons.push(renderMarketButton(market, market.underLine ?? null, "neutral", disabled));
      }
    }
    return buttons;
  };

  const hasConfirmedLineups = (game: GameCard) =>
    Boolean(game.awayLineup?.confirmed && game.homeLineup?.confirmed);

  const placeWager = async (forceAcceptLineMoves = false) => {
    setNotice("");
    const shouldAcceptLineMoves = acceptLineMoves || forceAcceptLineMoves;
    try {
      if (kind === "straight") {
        const wagers = slip
          .map((leg) => ({ leg, stakeCents: stakeCentsFromDollars(singleStakes[leg.gameLineId] ?? "") }))
          .filter((wager) => wager.stakeCents > 0);

        if (wagers.length === 0) {
          setNotice("Enter a stake for at least one single wager.");
          return;
        }
        if (wagers.some((wager) => !lineForLeg(wager.leg))) {
          setNotice("One or more selected lines are no longer available. Remove them from the bet slip before placing wagers.");
          return;
        }
        if (wagers.some((wager) => legHasStarted(wager.leg))) {
          setNotice("One or more selected games have already started. Remove them from the bet slip before placing wagers.");
          return;
        }

        const totalStake = wagers.reduce((sum, wager) => sum + wager.stakeCents, 0);
        if (bankroll && totalStake > bankroll.balance_cents) {
          setNotice("Insufficient bankroll");
          return;
        }

        await Promise.all(wagers.map((wager) => api("/wagers", {
          method: "POST",
          body: JSON.stringify({ kind: "straight", stakeCents: wager.stakeCents, acceptLineMoves: shouldAcceptLineMoves, legs: [wager.leg] })
        }, token)));
      } else {
        if (includedSlip.length < 2) {
          setNotice(`${kind === "parlay" ? "Parlay" : "Round robin"} wagers need at least two selections.`);
          return;
        }
        if (includedSlip.some((leg) => !lineForLeg(leg))) {
          setNotice("One or more selected lines are no longer available. Remove them from the bet slip before placing this wager.");
          return;
        }
        if (includedSlip.some((leg) => legHasStarted(leg))) {
          setNotice("One or more selected games have already started. Remove them from the bet slip before placing this wager.");
          return;
        }
        if (includedSlip.length > MAX_CHECKED_LEGS) {
          setNotice(`${kind === "parlay" ? "Parlay" : "Round robin"} wagers are limited to ${MAX_CHECKED_LEGS} checked selections.`);
          return;
        }
        if (parlayStakeCents <= 0) {
          setNotice("Enter a stake for this wager.");
          return;
        }
        if (kind === "round_robin" && roundRobinCount <= 0) {
          setNotice("Select a round robin size.");
          return;
        }
        const totalStake = kind === "round_robin" ? roundRobinTotalStakeCents : parlayStakeCents;
        if (bankroll && totalStake > bankroll.balance_cents) {
          setNotice("Insufficient bankroll");
          return;
        }
        await api("/wagers", {
          method: "POST",
          body: JSON.stringify({
            kind,
            stakeCents: parlayStakeCents,
            roundRobinMaxLegs: kind === "round_robin" ? effectiveRoundRobinMaxLegs : undefined,
            acceptLineMoves: shouldAcceptLineMoves,
            legs: includedSlip
          })
        }, token);
      }
      setSlip([]);
      setSingleStakes({});
      setIncludedLegIds(new Set());
      openPage("open-bets");
      setNotice(kind === "straight" ? "Wagers placed." : "Wager placed.");
      await refresh();
    } catch (err) {
      if (
        !shouldAcceptLineMoves
        && err instanceof ApiError
        && err.status === 409
        && isLineMoveErrorBody(err.body)
      ) {
        const accepted = window.confirm(lineMovePrompt(err.body.lineMoves));
        if (accepted) {
          await placeWager(true);
          return;
        }
        setNotice("Wager not placed.");
        await refresh().catch(() => undefined);
        return;
      }
      setNotice((err as Error).message);
    }
  };

  const updateSingleStakeAll = (value: string) => {
    setSingleStakeAll(value);
    setSingleStakes(Object.fromEntries(slip.map((leg) => [leg.gameLineId, value])));
  };

  const toggleIncludedLeg = (legId: string, checked: boolean) => {
    setNotice("");
    setIncludedLegIds((current) => {
      const next = new Set(current);
      if (!checked) {
        next.delete(legId);
        return next;
      }
      if (next.size >= MAX_CHECKED_LEGS) {
        setNotice(`Parlay and round robin wagers are limited to ${MAX_CHECKED_LEGS} checked selections.`);
        return current;
      }
      next.add(legId);
      return next;
    });
  };

  const removeSlipLeg = (legId: string) => {
    setNotice("");
    setSlip((current) => current.filter((leg) => leg.gameLineId !== legId));
    setSingleStakes((current) => {
      const next = { ...current };
      delete next[legId];
      return next;
    });
    setIncludedLegIds((current) => {
      const next = new Set(current);
      next.delete(legId);
      return next;
    });
  };

  const saveProfile = async () => {
    if (accountSaving) return;
    setNotice("");
    setAccountSaving(true);
    try {
      const cleaned = displayName.trim();
      const wasChangingEmail = emailNeedsSave || emailEditing;
      const result = await api<{ token: string; user: SessionUser }>("/me/profile", {
        method: "PATCH",
        body: JSON.stringify({
          fullName: fullName.trim() || null,
          email: email.trim() || null,
          allowEmailChange: emailEditing,
          displayName: cleaned || null,
          payoutMethod,
          payoutHandle: payoutMethod === "none" ? null : payoutHandle.trim() || null,
          phoneLast4: phoneLast4.trim() || null
        })
      }, token);
      localStorage.setItem("stakewars_token", result.token);
      setToken(result.token);
      setUser(result.user);
      setFullName(result.user.fullName ?? "");
      setEmail(result.user.email ?? "");
      setEmailEditing(false);
      setAccountEmailNotice(result.user.emailVerified ? "Profile saved." : "Profile saved. Verify your email to remain reward eligible.");
      setDisplayName(result.user.displayName ?? "");
      setPayoutMethod(result.user.payoutMethod);
      setPayoutHandle(result.user.payoutHandle ?? "");
      setPhoneLast4(result.user.phoneLast4 ?? "");
      const savedNotice = result.user.emailVerified
        ? "Profile saved."
        : wasChangingEmail && result.user.email
          ? "Profile saved. Verification link sent."
          : "Profile saved. Verify your email to remain reward eligible.";
      setAccountEmailNotice(savedNotice);
      setNotice(savedNotice);
      await refresh(result.token);
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setAccountSaving(false);
    }
  };

  const sendAccountEmailVerification = async () => {
    setAccountEmailNotice("");
    try {
      const result = await api<{ sent?: boolean; email?: string; alreadyVerified?: boolean }>("/me/email-verification/send", {
        method: "POST"
      }, token);
      setAccountEmailNotice(result.alreadyVerified ? "Email is already verified." : "Verification link sent.");
    } catch (err) {
      setAccountEmailNotice((err as Error).message);
    }
  };

  const accountVerificationLinkAlreadySent = accountEmailNotice === "Profile saved. Verification link sent.";

  const copyReferralLink = async () => {
    if (!referralInfo) return;
    try {
      await navigator.clipboard.writeText(referralInfo.referralUrl);
      setReferralNotice("Referral link copied.");
    } catch {
      setReferralNotice("Could not copy referral link.");
    }
  };

  const logout = () => {
    localStorage.removeItem("stakewars_token");
    setToken("");
    setUser(null);
    setBankroll(null);
    setMerchStoreUrl(null);
  };

  const installApp = async () => {
    if (!installPrompt) {
      return;
    }
    await installPrompt.prompt();
    await installPrompt.userChoice.catch(() => undefined);
    setInstallPrompt(null);
  };

  const enablePush = async () => {
    setPushNotice("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setPushNotice("Push notifications are not supported in this browser.");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushNotice("Notification permission was not granted.");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const { publicKey } = await api<{ publicKey: string }>("/push/public-key", {}, token);
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
      await api("/push/subscribe", {
        method: "POST",
        body: JSON.stringify(subscription.toJSON())
      }, token);
      setPushNotice("Notifications enabled for this device.");
    } catch (err) {
      setPushNotice((err as Error).message);
    }
  };

  const sendPushTest = async () => {
    setPushNotice("");
    try {
      const result = await api<{ sent: number; subscriptions: number }>("/push/test", { method: "POST" }, token);
      setPushNotice(result.sent > 0 ? "Test notification sent." : "No push subscription found for this account.");
    } catch (err) {
      setPushNotice((err as Error).message);
    }
  };

  const setPushPreference = async (key: keyof PushPreferences, value: boolean) => {
    setPushNotice("");
    const next = { ...pushPreferences, [key]: value };
    setPushPreferences(next);
    try {
      const result = await api<{ preferences: PushPreferences }>("/push/preferences", {
        method: "PATCH",
        body: JSON.stringify(next)
      }, token);
      setPushPreferences(result.preferences);
      setPushNotice("Notification preferences saved.");
    } catch (err) {
      setPushPreferences(pushPreferences);
      setPushNotice((err as Error).message);
    }
  };

  const refreshRedditStatus = async () => {
    if (!token || !canManageReddit) return;
    const status = await api<RedditStatus>("/admin/reddit/status", {}, token);
    setRedditStatus(status);
    if (!redditSubreddit && status.defaultSubreddits[0]) {
      setRedditSubreddit(status.defaultSubreddits[0]);
    }
  };

  const refreshUserDisplayMap = async () => {
    if (!token || !isNateRakelAccount) return;
    setUserDisplayMapNotice("");
    try {
      const result = await api<{ users: UserDisplayMapRow[] }>("/admin/user-display-map", {}, token);
      setUserDisplayMap(result.users);
      setUserDisplayMapNotice("User map refreshed.");
    } catch (err) {
      setUserDisplayMapNotice((err as Error).message);
    }
  };

  const refreshVisitorMetrics = async () => {
    if (!token || !isNateRakelAccount) return;
    setVisitorMetricsNotice("");
    try {
      const result = await api<VisitorMetrics>("/admin/visitors", {}, token);
      setVisitorMetrics(result);
      setVisitorMetricsNotice("Visitor metrics refreshed.");
    } catch (err) {
      setVisitorMetricsNotice((err as Error).message);
    }
  };

  const refreshChineModelAudit = async () => {
    if (!token || !isNateRakelAccount) return;
    setChineModelAuditNotice("");
    try {
      const result = await api<ChineModelAudit>("/admin/chine-model-audit", {}, token);
      setChineModelAudit(result);
      setChineModelAuditNotice("Chine model audit refreshed.");
    } catch (err) {
      setChineModelAuditNotice((err as Error).message);
    }
  };

  const refreshAdminPrizes = async () => {
    if (!token || !isNateRakelAccount) return;
    setAdminPrizeNotice("");
    try {
      const result = await api<AdminPrizesResponse>("/admin/prizes", {}, token);
      setAdminPrizes(result.prizes);
      const selected = result.prizes.find((prize) => prize.weekStart === adminPrizeWeekStart)
        ?? result.prizes.find((prize) => prize.weekStart === result.nextWeekStart)
        ?? result.prizes.find((prize) => prize.weekStart === result.currentWeekStart);
      const weekStart = adminPrizeWeekStart || selected?.weekStart || result.nextWeekStart;
      setAdminPrizeWeekStart(weekStart);
      if (selected && selected.weekStart === weekStart) {
        setAdminPrizeCash((selected.cashPrizeCents / 100).toFixed(2));
        setAdminPrizeBonus(selected.firstPlaceBonus ?? "");
      }
      setAdminPrizeNotice("Prize settings refreshed.");
    } catch (err) {
      setAdminPrizeNotice((err as Error).message);
    }
  };

  const saveAdminPrize = async () => {
    if (!token || !isNateRakelAccount) return;
    setAdminPrizeNotice("");
    const cashPrizeCents = Math.round(Number(adminPrizeCash || "0") * 100);
    if (!Number.isFinite(cashPrizeCents) || cashPrizeCents < 0) {
      setAdminPrizeNotice("Enter a valid cash prize amount.");
      return;
    }
    try {
      const result = await api<{ prize: WeeklyPrize }>("/admin/prizes", {
        method: "PUT",
        body: JSON.stringify({
          weekStart: adminPrizeWeekStart,
          cashPrizeCents,
          firstPlaceBonus: adminPrizeBonus.trim() || null
        })
      }, token);
      setAdminPrizes((current) => [
        result.prize,
        ...current.filter((prize) => prize.weekStart !== result.prize.weekStart)
      ].sort((left, right) => right.weekStart.localeCompare(left.weekStart)));
      setAdminPrizeNotice("Prize settings saved.");
      if (leaderboardWeekStart === result.prize.weekStart) {
        setWeeklyPrizeCents(result.prize.cashPrizeCents);
        setWeeklyFirstPlaceBonus(result.prize.firstPlaceBonus);
      }
    } catch (err) {
      setAdminPrizeNotice((err as Error).message);
    }
  };

  const supportCategoryLabel = (category: SupportCategory) => {
    switch (category) {
      case "account_email": return "Account or email issue";
      case "rewards_eligibility": return "Rewards or eligibility";
      case "picks_scoring": return "Picks or scoring";
      case "technical_problem": return "Report a technical problem";
      case "other": return "Something else";
    }
  };

  const towerPayoutLabel = (band: TowerPayoutBand | null) =>
    band ? `${band.minHeight}${band.maxHeight && band.maxHeight !== band.minHeight ? `-${band.maxHeight}` : band.maxHeight === null ? "+" : ""} floors pays ${band.payout.numerator}:${band.payout.denominator}` : "No band";

  const towerResultLabel = (result: TowerResult) => {
    if (result === "won") return "Won";
    if (result === "lost") return "Lost";
    if (result === "push") return "Push";
    if (result === "void") return "Void";
    return "Pending";
  };

  const towerNetCents = (result: TowerResult, wagerCents: number, payoutCents: number) => {
    if (result === "won") return payoutCents - wagerCents;
    if (result === "lost") return -wagerCents;
    return 0;
  };

  const towerResultDetail = (result: TowerResult, wagerCents: number, payoutCents: number) => {
    if (wagerCents <= 0) return "No wager";
    const net = towerNetCents(result, wagerCents, payoutCents);
    if (result === "won") return `returns ${money(payoutCents)} • net +${money(net)}`;
    if (result === "lost") return `net -${money(wagerCents)}`;
    if (result === "push") return `returns ${money(wagerCents)} • net $0.00`;
    if (result === "void") return `refunded ${money(wagerCents)} • net $0.00`;
    return "pending";
  };

  const TowerCardView = ({ card }: { card: TowerPublicCard }) => (
    <div className={`tower-card ${card.faceUp ? card.suit ?? "" : "hidden"} ${card.causedCollapse ? "collapse" : ""}`}>
      {card.faceUp ? (
        <>
          <strong>{card.rank}</strong>
          <span>{card.suit}</span>
        </>
      ) : (
        <strong>SW</strong>
      )}
    </div>
  );

  const TowerStack = ({ title, cards, value, height, collapsed }: {
    title: string;
    cards: TowerPublicCard[];
    value: number | null;
    height: number | null;
    collapsed?: boolean;
  }) => (
    <div className={`tower-stack ${collapsed ? "collapsed" : ""}`}>
      <div className="tower-stack-header">
        <strong>{title}</strong>
        <span>{height ?? "-"} floors • {value ?? "-"} value</span>
      </div>
      <div className="tower-card-stack">
        {cards.map((card, index) => <TowerCardView key={`${card.id ?? "hidden"}-${index}`} card={card} />)}
      </div>
    </div>
  );

  const TowerCounterPanel = () => {
    const counter = towerState?.counter;
    if (!counter) return <p className="muted">A shoe counter will appear after the first Tower shoe is created.</p>;
    return (
      <div className="tower-counter">
        <div className="tower-counter-stats">
          <span><strong>{counter.totalPubliclyUnseenCards}</strong> publicly unseen</span>
          <span><strong>{counter.totalPhysicallyUndealtCards}</strong> physically undealt</span>
          <span><strong>{counter.hiddenCardsInPlay}</strong> hidden in play</span>
        </div>
        <div className="kind-tabs compact">
          <button className={towerCounterView === "rank" ? "active" : ""} onClick={() => setTowerCounterView("rank")}>Rank summary</button>
          <button className={towerCounterView === "exact" ? "active" : ""} onClick={() => setTowerCounterView("exact")}>Exact cards</button>
        </div>
        <div className={towerCounterView === "rank" ? "tower-rank-counter" : "tower-exact-counter"}>
          {towerCounterView === "rank"
            ? counter.ranks.map((row) => (
              <span key={row.rank}><strong>{row.rank}</strong>{row.remainingUnseen}</span>
            ))
            : counter.exactCards.map((row) => (
              <span key={`${row.rank}-${row.suit}`}><strong>{row.rank}</strong><small>{row.suit}</small>{row.remainingUnseen}</span>
            ))}
        </div>
      </div>
    );
  };

  const TowerPage = () => {
    const hand = towerState?.hand;
    const config = towerState?.config;
    const canStart = Boolean(config && !hand);
    const canAct = Boolean(hand && hand.status === "player_turn" && !towerPending);
    const canDouble = Boolean(hand && hand.status === "awaiting_double_decision" && !towerPending);
    return (
      <div className="tower-page">
        <section className="panel tower-table">
          <div className="panel-title">
            <Layers size={20} />
            <h2>Tower</h2>
          </div>
          <div className="tower-balance-row">
            <span>Play-money balance</span>
            <strong>{money(towerState?.balanceCents ?? bankroll?.balance_cents ?? 0)}</strong>
          </div>
          {!hand && (
            <div className="tower-wager-grid">
              <label>
                VALUE
                <span>Beat the dealer's total.</span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  value={towerValueWager}
                  onChange={(event) => setTowerValueWager(event.target.value)}
                  aria-label="Value wager in whole credits"
                />
              </label>
              <label>
                HEIGHT
                <span>Build at least 3 floors, then beat height and value.</span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="off"
                  value={towerHeightWager}
                  onChange={(event) => setTowerHeightWager(event.target.value)}
                  aria-label="Height wager in whole credits"
                />
              </label>
              <button className="primary tower-start" type="button" disabled={!canStart || towerPending} onClick={startTower}>
                Start Hand
              </button>
            </div>
          )}
          {isNateRakelAccount && (
            <div className="tower-simulator">
              <div>
                <strong>Nate simulator</strong>
                <span>Auto-plays Tower with server-dealt cards: doubles Value on matches, chases dealer Value, and pushes collapsed dealers for Height.</span>
              </div>
              <div className="tower-sim-grid">
                <label>
                  Value
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    value={towerSimValueWager}
                    onChange={(event) => setTowerSimValueWager(event.target.value)}
                    disabled={towerSimRunning}
                  />
                </label>
                <label>
                  Height
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    value={towerSimHeightWager}
                    onChange={(event) => setTowerSimHeightWager(event.target.value)}
                    disabled={towerSimRunning}
                  />
                </label>
                <label>
                  Hands
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    value={towerSimHands}
                    onChange={(event) => setTowerSimHands(event.target.value)}
                    disabled={towerSimRunning}
                  />
                </label>
                {towerSimRunning ? (
                  <button type="button" disabled>Running...</button>
                ) : (
                  <button className="primary" type="button" disabled={Boolean(hand) || towerPending || !config} onClick={startTowerSimulator}>Simulate</button>
                )}
              </div>
              <small>{towerSimRunning ? `Running ${towerSimHands || "0"} hands server-side.` : towerSimCompleted > 0 ? `Last run completed ${towerSimCompleted} hands.` : "Ready to simulate."}</small>
              {towerSimNotice && <p>{towerSimNotice}</p>}
            </div>
          )}
          {hand && (
            <>
              <div className="tower-status-strip">
                <span>{hand.heightQualified ? "Height: Qualified" : "Height: Not Qualified"}</span>
                <span>Current: {towerPayoutLabel(hand.currentHeightPayoutBand)}</span>
                <span>Next: {towerPayoutLabel(hand.nextHeightPayoutBand)}</span>
              </div>
              <div className="tower-board">
                <TowerStack title="Dealer" cards={hand.dealerCards} value={hand.dealerValue} height={hand.dealerHeight} collapsed={hand.dealerCollapsed} />
                <TowerStack title="Player" cards={hand.playerCards} value={hand.playerValue} height={hand.playerHeight} collapsed={hand.playerCollapsed} />
              </div>
              <div className="tower-action-row">
                {canDouble ? (
                  <>
                    <button type="button" disabled={towerPending || hand.originalValueWagerCents <= 0} onClick={() => towerDouble(true, false)}>Double Value</button>
                    <button type="button" disabled={towerPending || hand.originalHeightWagerCents <= 0} onClick={() => towerDouble(false, true)}>Double Height</button>
                    <button type="button" disabled={towerPending || hand.originalValueWagerCents <= 0 || hand.originalHeightWagerCents <= 0} onClick={() => towerDouble(true, true)}>Double Both</button>
                    <button type="button" disabled={towerPending} onClick={() => towerDouble(false, false)}>No Double</button>
                  </>
                ) : (
                  <>
                    <button className="primary" type="button" disabled={!canAct} onClick={() => towerAction("build")}>BUILD</button>
                    <button type="button" disabled={!canAct} onClick={() => towerAction("cap")}>CAP</button>
                  </>
                )}
              </div>
              {towerAnimationNote && <p className="tower-animation-note">{towerAnimationNote}</p>}
              {hand.status === "settled" && towerShowResult && (
                <div className="tower-result">
                  <span>Value stake {money(hand.valueWagerCents)}: <strong>{towerResultLabel(hand.valueResult)}</strong> • {towerResultDetail(hand.valueResult, hand.valueWagerCents, hand.valuePayoutCents)}</span>
                  <span>Height stake {money(hand.heightWagerCents)}: <strong>{towerResultLabel(hand.heightResult)}</strong> • {towerResultDetail(hand.heightResult, hand.heightWagerCents, hand.heightPayoutCents)}</span>
                  <small>Stake is reserved when the hand starts or doubles. “Returns” is the amount credited back at settlement; “net” is the bankroll change after reserved stake.</small>
                </div>
              )}
              {hand.status === "settled" && towerShowResult && (
                <button type="button" onClick={() => {
                  setTowerState((current) => current ? { ...current, hand: null } : current);
                  setTowerShowResult(false);
                  void refreshTower();
                }}>Clear Hand</button>
              )}
            </>
          )}
          {towerNotice && <p className="error-text">{towerNotice}</p>}
        </section>
        <aside className="tower-rail">
          <section className="panel">
            <button className="tower-counter-toggle" type="button" onClick={() => setTowerCounterExpanded((current) => !current)}>
              Shoe Counter {towerCounterExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
            {towerCounterExpanded && <TowerCounterPanel />}
          </section>
          <section className="panel tower-help">
            <h2>How fairness works</h2>
            <p>Tower uses a six-deck shoe shuffled on the server with cryptographically secure randomness. Cards are dealt from the shoe in order, and the browser never chooses card outcomes or settlement results.</p>
            <p>The counter shows cards not yet publicly revealed. In this dealer-first test, all dealer cards are public before player decisions.</p>
            <p>Every hand, card draw, double decision, and balance change is recorded.</p>
          </section>
          <section className="panel tower-history">
            <h2>Recent hands</h2>
            {towerState?.history?.length ? towerState.history.slice(0, 6).map((row) => (
              <div className="tower-history-row" key={row.id}>
                <strong>{row.playerHeight} floors • {row.playerValue} value</strong>
                <span>Value {towerResultLabel(row.valueResult)} • Height {towerResultLabel(row.heightResult)}</span>
              </div>
            )) : <p className="muted">No Tower hands yet.</p>}
          </section>
        </aside>
      </div>
    );
  };

  const startSupportChat = async (category: SupportCategory) => {
    setSupportNotice("");
    setSupportCategory(category);
    try {
      const result = await api<{ conversation: SupportConversation }>("/support/conversations", {
        method: "POST",
        body: JSON.stringify({ category, message: supportMessage.trim() || undefined })
      }, token);
      setSupportConversations((current) => [result.conversation, ...current.filter((conversation) => conversation.id !== result.conversation.id)]);
      setActiveSupportConversation(result.conversation);
      const loaded = await api<{ conversation: SupportConversation; messages: SupportMessage[] }>(`/support/conversations/${result.conversation.id}`, {}, token);
      setActiveSupportConversation(loaded.conversation);
      setActiveSupportMessages(loaded.messages);
      setSupportNotice("Support chat opened. We will respond as soon as possible.");
      setSupportMessage("");
    } catch (err) {
      setSupportNotice((err as Error).message);
    }
  };

  const openUserSupportConversation = async (conversationId: string) => {
    if (!token) return;
    try {
      const result = await api<{ conversation: SupportConversation; messages: SupportMessage[] }>(`/support/conversations/${conversationId}`, {}, token);
      setActiveSupportConversation(result.conversation);
      setActiveSupportMessages(result.messages);
      setSupportNotice("");
    } catch (err) {
      setSupportNotice((err as Error).message);
    }
  };

  const refreshUserSupportConversations = async () => {
    if (!token || !user?.emailVerified) return;
    try {
      const result = await api<{ conversations: SupportConversation[] }>("/support/conversations", {}, token);
      setSupportConversations(result.conversations);
      if (!activeSupportConversation && result.conversations[0]?.status === "open") {
        await openUserSupportConversation(result.conversations[0].id);
      }
    } catch {
      // Support should not block the rest of the app.
    }
  };

  const sendUserSupportMessage = async () => {
    if (!token || !activeSupportConversation || !supportReplyMessage.trim()) return;
    try {
      const result = await api<{ message: SupportMessage }>(`/support/conversations/${activeSupportConversation.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: supportReplyMessage.trim() })
      }, token);
      setActiveSupportMessages((current) => [...current, result.message]);
      setSupportReplyMessage("");
      const loaded = await api<{ conversation: SupportConversation; messages: SupportMessage[] }>(`/support/conversations/${activeSupportConversation.id}`, {}, token);
      setActiveSupportConversation(loaded.conversation);
      setActiveSupportMessages(loaded.messages);
      await refreshUserSupportConversations();
    } catch (err) {
      setSupportNotice((err as Error).message);
    }
  };

  const refreshAdminSupport = async () => {
    if (!token || !isNateRakelAccount) return;
    const result = await api<{ conversations: SupportConversation[] }>("/admin/support/conversations?status=open", {}, token);
    setAdminSupportConversations(result.conversations);
  };

  const openAdminSupportConversation = async (conversationId: string) => {
    if (!token || !isNateRakelAccount) return;
    const result = await api<{ conversation: SupportConversation; messages: SupportMessage[] }>(`/admin/support/conversations/${conversationId}`, {}, token);
    setSelectedSupportConversation(result.conversation);
    setSupportMessages(result.messages);
    setSupportReply("");
  };

  const sendSupportReply = async () => {
    if (!token || !selectedSupportConversation || !supportReply.trim()) return;
    const result = await api<{ message: SupportMessage }>(`/admin/support/conversations/${selectedSupportConversation.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: supportReply.trim() })
    }, token);
    setSupportMessages((current) => [...current, result.message]);
    setSupportReply("");
    await refreshAdminSupport().catch(() => undefined);
  };

  const closeSupportConversation = async () => {
    if (!token || !selectedSupportConversation) return;
    const result = await api<{ conversation: SupportConversation; transcriptSent: boolean }>(`/admin/support/conversations/${selectedSupportConversation.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "closed", sendTranscript: supportTranscriptOnClose })
    }, token);
    setSelectedSupportConversation(result.conversation);
    setSupportNotice(result.transcriptSent ? "Conversation closed and transcript sent." : "Conversation closed.");
    await refreshAdminSupport().catch(() => undefined);
  };

  const generateRedditPreview = async () => {
    setRedditNotice("");
    try {
      const [singleResult, parlayResult] = await Promise.all([
        api<{ preview: RedditPreview }>("/admin/reddit/preview", {
          method: "POST",
          body: JSON.stringify({ subreddit: redditSubreddit.trim() || undefined, postType: "single" })
        }, token),
        api<{ preview: RedditPreview }>("/admin/reddit/preview", {
          method: "POST",
          body: JSON.stringify({ subreddit: redditSubreddit.trim() || undefined, postType: "parlay" })
        }, token)
      ]);
      setRedditSubreddit(singleResult.preview.subreddit);
      setRedditTitle(singleResult.preview.title);
      setRedditBody(singleResult.preview.body);
      setRedditParlayTitle(parlayResult.preview.title);
      setRedditParlayBody(parlayResult.preview.body);
      setRedditSingleLock(null);
      setRedditParlayLock(null);
      setRedditNotice("Manual Reddit posts generated.");
      await refreshRedditStatus();
    } catch (err) {
      setRedditNotice((err as Error).message);
    }
  };

  const generateRedditParlayPreview = async () => {
    setRedditNotice("");
    try {
      const result = await api<{ preview: RedditPreview }>("/admin/reddit/preview", {
        method: "POST",
        body: JSON.stringify({ subreddit: redditSubreddit.trim() || undefined, postType: "parlay" })
      }, token);
      setRedditSubreddit(result.preview.subreddit);
      setRedditParlayTitle(result.preview.title);
      setRedditParlayBody(result.preview.body);
      setRedditParlayLock(null);
      setRedditNotice("3-team parlay Reddit post generated.");
      await refreshRedditStatus();
    } catch (err) {
      setRedditNotice((err as Error).message);
    }
  };

  const copyRedditPost = async () => {
    setRedditNotice("");
    try {
      await navigator.clipboard.writeText([redditTitle.trim(), "", redditBody.trim()].filter(Boolean).join("\n"));
      setRedditNotice("Reddit post copied.");
    } catch (err) {
      setRedditNotice((err as Error).message);
    }
  };

  const copyRedditParlayPost = async () => {
    setRedditNotice("");
    try {
      await navigator.clipboard.writeText([redditParlayTitle.trim(), "", redditParlayBody.trim()].filter(Boolean).join("\n"));
      setRedditNotice("3-team parlay Reddit post copied.");
    } catch (err) {
      setRedditNotice((err as Error).message);
    }
  };

  const lockRedditPostTracking = async (postType: "single" | "parlay") => {
    setRedditNotice("");
    const isParlay = postType === "parlay";
    const title = isParlay ? redditParlayTitle.trim() : redditTitle.trim();
    const body = isParlay ? redditParlayBody.trim() : redditBody.trim();
    setRedditLockingType(postType);
    try {
      const result = await api<RedditLockResult>("/admin/reddit/lock", {
        method: "POST",
        body: JSON.stringify({ postType, title, body })
      }, token);
      if (isParlay) {
        setRedditParlayLock(result);
      } else {
        setRedditSingleLock(result);
      }
      const lockTime = new Date(result.lockedAt).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
      setRedditNotice(isParlay ? `3-team parlay tracking locked at ${lockTime}. Safe to post.` : `Single pick tracking locked at ${lockTime}. Safe to post.`);
    } catch (err) {
      setRedditNotice((err as Error).message);
    } finally {
      setRedditLockingType(null);
    }
  };

  const pushPreferenceRows: Array<{ key: keyof PushPreferences; label: string; description: string }> = [
    {
      key: "gameReminderEnabled",
      label: "Games start in an hour",
      description: "Daily reminder before the first available game."
    },
    {
      key: "gameStartedEnabled",
      label: "Game started",
      description: "For games tied to one of your open wagers."
    },
    {
      key: "scoreChangeEnabled",
      label: "Score changes",
      description: "Scoring updates for games tied to one of your open wagers."
    },
    {
      key: "gameFinalEnabled",
      label: "Game final",
      description: "Final result for games tied to one of your open wagers."
    }
  ];
  const legalPath = window.location.pathname === "/privacy"
    ? "privacy"
    : window.location.pathname === "/terms"
      ? "terms"
      : null;

  if (legalPath) {
    return <LegalPage kind={legalPath} />;
  }

  if (!user) {
    return <AuthPanel onAuth={(nextToken, nextUser) => {
      setToken(nextToken);
      setUser(nextUser);
      refresh(nextToken).catch((err) => setNotice((err as Error).message));
    }} canInstall={Boolean(installPrompt && !isStandalone)} isStandalone={isStandalone} onInstall={installApp} />;
  }

  return (
    <main className={`app-shell ${mobileMenuOpen ? "mobile-menu-open" : "mobile-page-open"}`}>
      <aside className="side-nav">
        <div className="side-brand">
          <img className="nav-logo" src="/icons/icon-192.png" alt="" />
          <div>
            <strong>StakeWars</strong>
            <span>{user.displayName ?? "Weekly contest"}</span>
          </div>
        </div>
        <nav className="nav-primary" aria-label="Primary">
          <div className={`nav-group ${activePage === "lines" ? "active" : ""} ${expandedNavGroup === "lines" ? "expanded" : ""}`}>
            <button onClick={() => {
              toggleNavGroup("lines");
            }} aria-expanded={expandedNavGroup === "lines"}>
              <BarChart3 size={18} /> Lines {expandedNavGroup === "lines" ? <ChevronDown className="nav-chevron" size={16} /> : <ChevronRight className="nav-chevron" size={16} />}
            </button>
            <div className="nav-submenu">
              {sportsMenu.map((sport) => {
                const enabled = sportsWithLines.has(sport);
                return (
                  <button key={sport} disabled={!enabled} className={activePage === "lines" && lineSport === sport ? "active" : ""} onClick={() => {
                    if (!enabled) return;
                    setLineSport(sport);
                    openPage("lines");
                  }}>
                    {sport}
                  </button>
                );
              })}
            </div>
          </div>
          <div className={`nav-group ${activePage === "scoreboard" ? "active" : ""} ${expandedNavGroup === "scoreboard" ? "expanded" : ""}`}>
            <button onClick={() => {
              toggleNavGroup("scoreboard");
            }} aria-expanded={expandedNavGroup === "scoreboard"}>
              <Radio size={18} /> ScoreBoard {expandedNavGroup === "scoreboard" ? <ChevronDown className="nav-chevron" size={16} /> : <ChevronRight className="nav-chevron" size={16} />}
            </button>
            <div className="nav-submenu">
              {sportsMenu.map((sport) => {
                const enabled = sportsWithLines.has(sport);
                return (
                  <button key={sport} disabled={!enabled} className={activePage === "scoreboard" && scoreboardSport === sport ? "active" : ""} onClick={() => {
                    if (!enabled) return;
                    setScoreboardSport(sport);
                    openPage("scoreboard");
                  }}>
                    {sport}
                  </button>
                );
              })}
            </div>
          </div>
          <button className={activePage === "ai-picks" ? "active" : ""} onClick={() => openPage("ai-picks")}><Sparkles size={18} /> Daily Chine Picks</button>
          {TOWER_FEATURE_ENABLED && isNateRakelAccount && (
            <button className={activePage === "tower" ? "active" : ""} onClick={() => openPage("tower")}><Layers size={18} /> Tower</button>
          )}
          <button className={activePage === "leaderboard" ? "active" : ""} onClick={() => openPage("leaderboard")}><Trophy size={18} /> Leaderboard</button>
          <button className={activePage === "open-bets" ? "active" : ""} onClick={() => openPage("open-bets")}><ClipboardList size={18} /> Open Bets</button>
          <button className={activePage === "history" ? "active" : ""} onClick={() => openPage("history")}><History size={18} /> History</button>
          <button className={activePage === "rules" ? "active" : ""} onClick={() => openPage("rules")}><FileText size={18} /> Rules</button>
          <button className={activePage === "contact" ? "active" : ""} onClick={() => openPage("contact")}><Mail size={18} /> Contact Us</button>
          {merchNavItem && (
            <button onClick={() => void openMerchStore()}><ShoppingBag size={18} /> {merchNavItem.label}</button>
          )}
          <button className={activePage === "install" ? "active" : ""} onClick={() => openPage("install")}><Download size={18} /> Install App</button>
          {isNateRakelAccount && (
            <button className={activePage === "admin" ? "active" : ""} onClick={() => openPage("admin")}><ShieldCheck size={18} /> Admin</button>
          )}
        </nav>
        <div className="nav-bottom">
          {!isOnline && <span className="connection-pill"><WifiOff size={14} /> Offline</span>}
          <div className="bankroll-card">
            <span><Wallet size={17} /> Bankroll</span>
            <strong>{bankroll ? money(bankroll.balance_cents) : "$0.00"}</strong>
          </div>
          <button className={`nav-action ${activePage === "account" ? "active" : ""}`} onClick={() => openPage("account")}><User size={18} /> Account</button>
          <button className="nav-action" onClick={logout}><LogOut size={18} /> LogOut</button>
        </div>
      </aside>

      <section className="page-shell">
        <header className="page-header">
          <button className="mobile-menu-back" type="button" onClick={() => setMobileMenuOpen(true)}>
            <ArrowLeft size={18} /> Menu
          </button>
          <div>
            <h1>{pageTitle(activePage, lineSport, scoreboardSport)}</h1>
            <span>{activePage === "lines" ? "Select wagers and manage your slip" : "StakeWars"}</span>
          </div>
        </header>

        {activePage === "lines" && (
          <div className="lines-page">
            <div className="panel lines-panel">
              <div className="panel-title">
                <BarChart3 size={20} />
                <h2>{lineSport} available lines</h2>
              </div>
              <div className="line-list">
                {selectedSportGames.length === 0 ? <p className="muted">No valid {lineSport} lines are currently available.</p> : selectedSportGames.map((game) => {
                  const started = gameHasStarted(game.startsAt);
                  const confidenceLabel = aiConfidenceLabel(game);
                  return (
                  <article className={`game-card ${started ? "started" : ""}`} key={game.eventKey}>
                    <div className="game-card-top">
                      <span>{game.sport} • {new Date(game.startsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
                      {confidenceLabel && (
                        <span className="ai-confidence-pill">
                          <img src="/icons/icon-192.png" alt="" />
                          {confidenceLabel}
                        </span>
                      )}
                      {started && <span className="game-started-pill">Started</span>}
                    </div>
                    <div className="game-card-matchup">
                      <div>
                        <strong>{game.awayTeam}</strong>
                        {game.sport === "MLB" && <span title={pitcherLine(game.awayProbablePitcher)}>{pitcherLine(game.awayProbablePitcher)}</span>}
                      </div>
                      <span className="versus">@</span>
                      <div>
                        <strong>{game.homeTeam}</strong>
                        {game.sport === "MLB" && <span title={pitcherLine(game.homeProbablePitcher)}>{pitcherLine(game.homeProbablePitcher)}</span>}
                      </div>
                    </div>
                    <div className="game-card-markets">
                      <div className="market-side away">
                        {orderedMarkets(game, "away").map((market) => renderMarketButton(market, market.awayLine, "away", started))}
                      </div>
                      <div className="market-side neutral">
                        {neutralMarkets(game, started)}
                      </div>
                      <div className="market-side home">
                        {orderedMarkets(game, "home").map((market) => renderMarketButton(market, market.homeLine, "home", started))}
                      </div>
                    </div>
                    {hasConfirmedLineups(game) && (
                      <button className="lineup-toggle" type="button" onClick={() => setLineupGame(game)}>
                        Show Lineups
                      </button>
                    )}
                  </article>
                  );
                })}
              </div>
            </div>
            <aside className="page-rail">
              <div className="panel bet-slip-panel" id="bet-slip">
                <div className="panel-title">
                  <BadgeDollarSign size={20} />
                  <h2>Bet slip</h2>
                </div>
                <div className="kind-tabs">
                  {(["straight", "parlay", "round_robin"] as WagerKind[]).map((option) => (
                    <button key={option} className={kind === option ? "active" : ""} onClick={() => {
                      setKind(option);
                    }}>
                      {option === "straight" ? "Single" : option.replace("_", " ")}
                    </button>
                  ))}
                </div>
                {kind === "straight" && slip.length > 0 && (
                  <>
                    {bankrollInline}
                    <label className="stake-all-field">
                      Place wager for all games
                      <input
                        type="number"
                        value={singleStakeAll}
                        min={1}
                        step="1"
                        placeholder="0"
                        onChange={(event) => updateSingleStakeAll(event.target.value)}
                      />
                    </label>
                  </>
                )}
                <div className="slip-list">
                  {slip.length === 0 ? <p className="muted">No selections yet.</p> : slip.map((leg) => {
                    const line = lineForLeg(leg);
                    const singleStakeCents = stakeCentsFromDollars(singleStakes[leg.gameLineId] ?? "");
                    const singleToWin = line ? toWinCents(singleStakeCents, [line.oddsAmerican]) : 0;
                    const included = includedLegIds.has(leg.gameLineId);
                    return (
                      <div className="slip-leg" key={leg.gameLineId}>
                        <div className="slip-leg-main">
                          <div className="slip-leg-title">
                            <div className="slip-leg-select">
                              {kind !== "straight" && (
                              <input
                                type="checkbox"
                                checked={included}
                                onChange={(event) => toggleIncludedLeg(leg.gameLineId, event.target.checked)}
                                aria-label={`Include ${leg.selectedTeam}`}
                              />
                              )}
                            </div>
                            <strong>{leg.selectedTeam} {marketText(line)}</strong>
                            <button className="slip-remove" type="button" title="Remove selection" aria-label={`Remove ${leg.selectedTeam}`} onClick={() => removeSlipLeg(leg.gameLineId)}>
                              <X size={16} />
                            </button>
                          </div>
                          {line && <small>{line.awayTeam} @ {line.homeTeam}</small>}
                        </div>
                        {kind === "straight" && (
                          <div className="single-stake-row">
                            <label>
                              Wager
                              <input
                                type="number"
                                value={singleStakes[leg.gameLineId] ?? ""}
                                min={1}
                                step="1"
                                placeholder="0"
                                onChange={(event) => setSingleStakes((current) => ({ ...current, [leg.gameLineId]: event.target.value }))}
                              />
                            </label>
                            <label>
                              To Win
                              <input value={money(singleToWin)} readOnly />
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {slip.length > 0 && (
                  <label className="line-move-option">
                    <input
                      type="checkbox"
                      checked={acceptLineMoves}
                      onChange={(event) => setAcceptLineMoves(event.target.checked)}
                    />
                    Always accept line moves when placing wagers
                  </label>
                )}
                {kind !== "straight" && (
                  <div className="combined-stake-box">
                    <span>{includedSlip.length} checked / {MAX_CHECKED_LEGS} max</span>
                    {kind === "round_robin" && includedSlip.length >= 2 && (
                      <label className="stake-field">
                        Round robin
                        <select value={effectiveRoundRobinMaxLegs} onChange={(event) => setRoundRobinMaxLegs(Number(event.target.value))}>
                          {roundRobinOptions.map((option) => (
                            <option key={option.maxLegs} value={option.maxLegs}>
                              {option.ways} ways: 2-{option.maxLegs} team parlays
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {bankrollInline}
                    <label className="stake-field">
                      {kind === "round_robin" ? "Wager per bet ($)" : "Wager ($)"}
                      <input type="number" value={stake} min={1} step="1" onChange={(event) => setStake(event.target.value)} />
                    </label>
                    {kind === "round_robin" && (
                      <label className="stake-field">
                        Total Wager
                        <input value={money(roundRobinTotalStakeCents)} readOnly />
                      </label>
                    )}
                    <label className="stake-field">
                      To Win
                      <input value={money(parlayToWinCents)} readOnly />
                    </label>
                  </div>
                )}
                {notice && <p className={notice.endsWith("placed.") ? "success" : "error"}>{notice}</p>}
                <button className="primary" disabled={slip.length === 0} onClick={() => placeWager()}>Place wager</button>
              </div>
              <div className="panel">
                <div className="panel-title">
                  <Bot size={20} />
                  <h2>{lockedAiPicks.length ? "Locked Picks" : "Projected Picks"}</h2>
                </div>
                {aiPicksContent}
              </div>
            </aside>
            <button className="floating-bet-slip" type="button" onClick={jumpToBetSlip} aria-label={`Go to bet slip with ${slip.length} selections`}>
              <BadgeDollarSign size={18} />
              <span>Bet Slip</span>
              {slip.length > 0 && <strong>{slip.length}</strong>}
            </button>
          </div>
        )}

        {activePage === "ai-picks" && (
          <div className="panel page-panel">
            <div className="panel-title">
              <Sparkles size={20} />
              <div>
                <h2>Daily Chine Picks</h2>
                <span>Projected and locked public picks for today</span>
              </div>
            </div>
            <div className="daily-ai-picks">
              {aiPicksContent}
            </div>
          </div>
        )}

        {activePage === "tower" && TOWER_FEATURE_ENABLED && isNateRakelAccount && TowerPage()}

        {activePage === "scoreboard" && (
          <div className="panel page-panel">
            <div className="panel-title">
              <Radio size={20} />
              <h2>{scoreboardSport} live box scores</h2>
            </div>
            {scoreboardSport === "MLB" || scoreboardSport === "WORLDCUP" || scoreboardSport === "EPL" ? (
              <div className="live-list scoreboard-grid">
                {scoreboardGames.length === 0 ? <p className="muted">No live {scoreboardSport} snapshots yet.</p> : scoreboardGames.map((game) => (
                  <article className="live-game" key={game.matchId}>
                    <div className="live-score">
                      <span>{game.awayTeam}</span>
                      <strong>{game.awayScore ?? "-"}</strong>
                    </div>
                    <div className="live-score">
                      <span>{game.homeTeam}</span>
                      <strong>{game.homeScore ?? "-"}</strong>
                    </div>
                    {game.sport === "MLB" && <BaseDiamond game={game} />}
                    <div className="live-meta">
                      <span>{[game.period ?? game.gameStatus ?? "Live", liveCount(game), liveOuts(game.outs)].filter(Boolean).join(" • ")}</span>
                      <div className="live-details">
                        {game.sport === "MLB" && pitcherDetail(game) && <small>{pitcherDetail(game)}</small>}
                        {game.sport === "MLB" && batterDetail(game) && <small>{batterDetail(game)}</small>}
                        {(game.lastPlay ?? game.description) && <small className="last-play">{game.sport === "MLB" ? "Last play: " : ""}{game.lastPlay ?? game.description}</small>}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted">Live {scoreboardSport} box scores will appear here when that sport is enabled.</p>
            )}
          </div>
        )}

        {activePage === "leaderboard" && (
          <div className="panel page-panel">
            <div className="panel-title">
              <Trophy size={20} />
              <div>
                <div className="leaderboard-title-row">
                  <h2>Leaderboard</h2>
                  <span className="registered-count">Registered Players: {registeredPlayers}</span>
                </div>
                <span>{leaderboardIsCurrentWeek ? "Current week" : "Previous week"} standings</span>
              </div>
            </div>
            {leaderboardWeeks.length > 0 && (
              <label className="leaderboard-week-select">
                Week
                <select value={leaderboardWeekStart} onChange={(event) => void loadLeaderboardWeek(event.target.value)}>
                  {leaderboardWeeks.map((week) => (
                    <option key={week.weekStart} value={week.weekStart}>
                      {weekRangeLabel(week.weekStart)}{week.isCurrent ? " (Current)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="leaderboard-leaders-box">
              <img className="leaders-crown" src="/images/stakewars-crown.png" alt="" aria-hidden="true" />
              <div className="leaders-content">
                <span>{leaderboardIsCurrentWeek ? "Current eligible leaders" : "Eligible winners"}</span>
                {leaderboardIsCurrentWeek && weeklyPrizeCents > 0 && (
                  <strong className="weekly-prize">Weekly prize pool: {money(weeklyPrizeCents)}</strong>
                )}
                {!leaderboardIsCurrentWeek && weeklyPrizeCents > 0 && (
                  <strong className="weekly-prize">Prize pool: {money(weeklyPrizeCents)}</strong>
                )}
                {weeklyFirstPlaceBonus && (
                  <strong className="weekly-prize">1st place bonus: {weeklyFirstPlaceBonus}</strong>
                )}
                {qualifiedLeaderboardRows.length > 0 ? (
                  <ol className="leaders-list">
                    {qualifiedLeaderboardRows.map((row) => (
                      <li key={`leader-${row.rank}-${row.displayName}`}>
                        <strong>{row.rank}. {row.displayName}</strong>
                        <small>
                          {money(row.balanceCents)}
                          {weeklyPrizeCents > 0
                            ? ` • ${money(rewardCentsByRank.get(row.rank) ?? 0)} reward`
                            : !leaderboardIsCurrentWeek && ` • ${rewardShareByRank.get(row.rank) ?? 0}% reward`}
                        </small>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <strong>No eligible leaders yet</strong>
                )}
              </div>
            </div>
            <ol className="leaderboard leaderboard-page-list">
              {leaderboard.map((row) => (
                <li key={`${row.rank}-${row.displayName}`}>
                  <span>
                    {row.rank}. {row.displayName}
                    {!leaderboardIsCurrentWeek && row.role !== "system" && row.rank <= 3 && row.eligible && (
                      <small className="reward-share-badge">
                        {`${rewardShareByRank.get(row.rank) ?? 0}% reward`}
                      </small>
                    )}
                    {leaderboardIsCurrentWeek && weeklyPrizeCents > 0 && row.role !== "system" && row.rank <= 3 && row.eligible && (
                      <small className="reward-share-badge">
                        {`${money(rewardCentsByRank.get(row.rank) ?? 0)} reward`}
                      </small>
                    )}
                    {row.role !== "system" && !row.eligible && (
                      <>
                        <small className="disqualified-badge">Ineligible</small>
                        {row.isCurrentUser && (
                          <small className="eligibility-progress">
                            {row.emailVerified === false ? "verify email • " : ""}{row.weeklyWagers ?? 0}/10 wagers • {money(row.weeklyStakeCents ?? 0)}/{money(row.requiredStakeCents ?? 0)}
                            {row.beatAi ? "" : " • must beat Chine"}
                          </small>
                        )}
                      </>
                    )}
                  </span>
                  <strong>{money(row.balanceCents)}</strong>
                </li>
              ))}
            </ol>
          </div>
        )}

        {activePage === "open-bets" && (
          <div className="panel page-panel">
            <div className="panel-title">
              <ClipboardList size={20} />
              <h2>Open Bets</h2>
            </div>
            <div className="open-bets open-bets-page">
              {openBets.length === 0 ? <p className="muted">No open bets.</p> : openBets.map((bet) => (
                <article className="open-bet" key={bet.id}>
                  <div className="open-bet-head">
                    <strong>{bet.kind.replace("_", " ")}</strong>
                    <span>{money(bet.stakeCents)} to win {money(Math.max(0, bet.potentialPayoutCents - bet.stakeCents))}</span>
                  </div>
                  {bet.legs.map((leg) => {
                    const marketText = leg.marketKey === "h2h"
                      ? americanOdds(leg.oddsAmerican)
                      : `${Number(leg.spread) > 0 ? `+${leg.spread}` : leg.spread} ${americanOdds(leg.oddsAmerican)}`;
                    return (
                      <div className="open-bet-leg" key={leg.id}>
                        <span><LegStatusIcon status={leg.status} /> {leg.selectedTeam} {marketText}</span>
                        <small>{leg.awayTeam} @ {leg.homeTeam}</small>
                      </div>
                    );
                  })}
                </article>
              ))}
            </div>
          </div>
        )}

        {activePage === "history" && (
          <div className="panel page-panel">
            <div className="panel-title page-title-row">
              <div className="panel-title">
                <History size={20} />
                <h2>History</h2>
              </div>
              <div className="history-controls">
                <div className="segmented compact">
                  {(["day", "week", "all"] as HistoryPeriod[]).map((period) => (
                    <button key={period} className={historyPeriod === period ? "active" : ""} onClick={() => setHistoryPeriod(period)}>
                      {period}
                    </button>
                  ))}
                </div>
                <label className="toggle-row">
                  <input type="checkbox" checked={historyIncludeAi} onChange={(event) => setHistoryIncludeAi(event.target.checked)} />
                  Show Chine
                </label>
              </div>
            </div>
            <div className={`history-board ${historyIncludeAi ? "with-ai" : ""}`}>
              {historyBets.length === 0 ? <p className="muted">No settled wagers for this period.</p> : (
                <>
                  <section>
                    <h3>Your Picks</h3>
                    <div className="history-list">
                      {historyBets.filter((bet) => bet.owner === "user").length === 0
                        ? <p className="muted">No settled user wagers for this period.</p>
                        : historyBets.filter((bet) => bet.owner === "user").map(renderSettledBet)}
                    </div>
                  </section>
                  {historyIncludeAi && (
                    <section>
                      <h3>StakeWars Chine</h3>
                      <div className="history-list">
                        {historyBets.filter((bet) => bet.owner === "ai").length === 0
                          ? <p className="muted">No settled Chine wagers for this period.</p>
                          : historyBets.filter((bet) => bet.owner === "ai").map(renderSettledBet)}
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {activePage === "rules" && (
          <div className="panel page-panel">
            <div className="panel-title">
              <FileText size={20} />
              <h2>Rules</h2>
            </div>
            <RulesContent />
          </div>
        )}

        {activePage === "contact" && (
          <div className="panel page-panel">
            <div className="panel-title">
              <Mail size={20} />
              <h2>Contact Us</h2>
            </div>
            <div className="notification-card">
              <div>
                <strong>Email Support</strong>
                <span>Support is currently email only. Responses will occur within 1 business day.</span>
              </div>
              <div className="notification-actions">
                <a className="primary" href="mailto:support@stakewars.ai">support@stakewars.ai</a>
              </div>
            </div>
          </div>
        )}

        {activePage === "install" && (
          <div className="panel page-panel">
            <div className="panel-title">
              <Download size={20} />
              <h2>Install App</h2>
            </div>
            <InstallContent canPrompt={Boolean(installPrompt && !isStandalone)} isStandalone={isStandalone} onInstall={installApp} />
          </div>
        )}

        {activePage === "admin" && isNateRakelAccount && (
          <div className="panel page-panel admin-page">
            <div className="panel-title">
              <ShieldCheck size={20} />
              <h2>Admin</h2>
            </div>
            <div className="segmented admin-tabs">
              {([
                ["traffic", "Traffic"],
                ["support", "Support Chat"],
                ["prizes", "Prizes"],
                ["model", "Chine Model"],
                ["reddit", "Reddit"],
                ["users", "Users"]
              ] as Array<[AdminSection, string]>).map(([section, label]) => (
                <button key={section} className={adminSection === section ? "active" : ""} onClick={() => setAdminSection(section)}>
                  {label}
                </button>
              ))}
            </div>
            {adminSection === "traffic" && (
            <div className="notification-card visitor-card">
              <div>
                <strong>Visitors</strong>
                <span>Counts are based on StakeWars page visits in Central time. API polling and static assets are excluded.</span>
              </div>
              <div className="notification-actions">
                <button className="secondary-action" onClick={refreshVisitorMetrics}>Refresh visitors</button>
              </div>
              <div className="user-map-table visitor-table">
                <table>
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Unique Visitors</th>
                      <th>Total Visitors</th>
                      <th>Human Visitors</th>
                      <th>Other Visitors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(visitorMetrics?.rows ?? []).map((row) => (
                      <tr key={row.label}>
                        <td>{row.label}</td>
                        <td>{row.uniqueVisitors.toLocaleString()}</td>
                        <td>{row.totalVisitors.toLocaleString()}</td>
                        <td>{row.humanVisitors.toLocaleString()}</td>
                        <td>{row.otherVisitors.toLocaleString()}</td>
                      </tr>
                    ))}
                    {(!visitorMetrics || visitorMetrics.rows.length === 0) && (
                      <tr>
                        <td colSpan={5}>No visitor metrics available yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {visitorMetrics?.lastUpdatedAt && (
                <small className="muted">Last updated {new Date(visitorMetrics.lastUpdatedAt).toLocaleString()}</small>
              )}
              {visitorMetricsNotice && <p className={visitorMetricsNotice.includes("refreshed") ? "success" : "error"}>{visitorMetricsNotice}</p>}
            </div>
            )}
            {adminSection === "prizes" && (
            <div className="notification-card prize-admin-card">
              <div>
                <strong>Weekly Prizes</strong>
                <span>Set the cash prize pool and optional first-place bonus for a specific contest week.</span>
              </div>
              <div className="notification-actions">
                <button className="secondary-action" onClick={refreshAdminPrizes}>Refresh prizes</button>
              </div>
              <div className="reddit-editor">
                <label>
                  Week start
                  <input type="date" value={adminPrizeWeekStart} onChange={(event) => setAdminPrizeWeekStart(event.target.value)} />
                </label>
                <label>
                  Cash prize pool
                  <input
                    inputMode="decimal"
                    value={adminPrizeCash}
                    placeholder="10.00"
                    onChange={(event) => setAdminPrizeCash(event.target.value)}
                  />
                </label>
                <label>
                  First-place bonus
                  <input
                    value={adminPrizeBonus}
                    maxLength={240}
                    placeholder="2 St. Louis Cardinals tickets"
                    onChange={(event) => setAdminPrizeBonus(event.target.value)}
                  />
                </label>
                <div className="notification-actions">
                  <button className="primary" disabled={!adminPrizeWeekStart} onClick={saveAdminPrize}>Save prize</button>
                </div>
              </div>
              <div className="user-map-table visitor-table">
                <table>
                  <thead>
                    <tr>
                      <th>Week</th>
                      <th>Cash</th>
                      <th>First-place bonus</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminPrizes.map((prize) => (
                      <tr key={prize.weekStart}>
                        <td>
                          <button
                            className="link-button"
                            onClick={() => {
                              setAdminPrizeWeekStart(prize.weekStart);
                              setAdminPrizeCash((prize.cashPrizeCents / 100).toFixed(2));
                              setAdminPrizeBonus(prize.firstPlaceBonus ?? "");
                            }}
                          >
                            {weekRangeLabel(prize.weekStart)}
                          </button>
                        </td>
                        <td>{money(prize.cashPrizeCents)}</td>
                        <td>{prize.firstPlaceBonus || "-"}</td>
                      </tr>
                    ))}
                    {adminPrizes.length === 0 && (
                      <tr>
                        <td colSpan={3}>No weekly prizes configured yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {adminPrizeNotice && <p className={adminPrizeNotice.includes("saved") || adminPrizeNotice.includes("refreshed") ? "success" : "error"}>{adminPrizeNotice}</p>}
            </div>
            )}
            {adminSection === "support" && (
            <div className="notification-card support-admin-card">
              <div>
                <strong>Support Conversations</strong>
                <span>Open chats initiated by verified StakeWars users.</span>
              </div>
              <div className="notification-actions">
                <button className="secondary-action" onClick={refreshAdminSupport}>Refresh support</button>
              </div>
              <div className="support-admin-layout">
                <div className="support-conversation-list">
                  {adminSupportConversations.length === 0 ? (
                    <p className="muted">No active support conversations.</p>
                  ) : adminSupportConversations.map((conversation) => (
                    <button
                      key={conversation.id}
                      className={selectedSupportConversation?.id === conversation.id ? "active" : ""}
                      onClick={() => openAdminSupportConversation(conversation.id)}
                    >
                      <strong>{conversation.displayName || conversation.username || "Player"}</strong>
                      <span>{supportCategoryLabel(conversation.category)}</span>
                      <small>{conversation.lastMessage || "No message yet"}</small>
                    </button>
                  ))}
                </div>
                <div className="support-thread">
                  {!selectedSupportConversation ? (
                    <p className="muted">Select a conversation to view messages.</p>
                  ) : (
                    <>
                      <div className="support-thread-head">
                        <div>
                          <strong>{selectedSupportConversation.displayName || selectedSupportConversation.username}</strong>
                          <span>{supportCategoryLabel(selectedSupportConversation.category)}</span>
                        </div>
                        <label className="checkbox-row compact">
                          <input type="checkbox" checked={supportTranscriptOnClose} onChange={(event) => setSupportTranscriptOnClose(event.target.checked)} />
                          Send transcript on close
                        </label>
                      </div>
                      <div className="support-messages" ref={adminSupportMessagesRef}>
                        {supportMessages.map((message) => (
                          <div key={message.id} className={`support-message ${message.senderRole}`}>
                            <strong>{message.senderRole === "admin" ? "StakeWars Support" : selectedSupportConversation.displayName || selectedSupportConversation.username}</strong>
                            <p>{message.body}</p>
                            <small>{new Date(message.createdAt).toLocaleString()}</small>
                          </div>
                        ))}
                      </div>
                      {selectedSupportConversation.status === "open" && (
                        <div className="support-reply">
                          <textarea value={supportReply} rows={4} maxLength={2000} onChange={(event) => setSupportReply(event.target.value)} placeholder="Type a reply..." />
                          <div className="notification-actions">
                            <button className="primary" disabled={!supportReply.trim()} onClick={sendSupportReply}>Send reply</button>
                            <button className="secondary-action" onClick={closeSupportConversation}>End chat</button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
              {supportNotice && <p className={supportNotice.includes("closed") || supportNotice.includes("opened") ? "success" : "error"}>{supportNotice}</p>}
            </div>
            )}
            {adminSection === "model" && (
            <div className="notification-card model-audit-card">
              <div>
                <strong>Chine Model Audit</strong>
                <span>Settled locked Chine picks, scored as one simulated unit per pick. This measures heuristic quality without parlay staking noise.</span>
              </div>
              <div className="notification-actions">
                <button className="secondary-action" onClick={refreshChineModelAudit}>Refresh audit</button>
              </div>
              {chineModelAudit?.generatedAt && (
                <small className="muted">Generated {new Date(chineModelAudit.generatedAt).toLocaleString()}</small>
              )}
              <div className="model-audit-grid">
                <ModelAuditTable title="Summary" rows={chineModelAudit?.summary ?? []} />
                <ModelAuditTable title="Confidence Buckets" rows={chineModelAudit?.confidenceBuckets ?? []} />
                <ModelAuditTable title="Market" rows={chineModelAudit?.markets ?? []} />
                <ModelAuditTable title="Edge Range" rows={chineModelAudit?.edgeRanges ?? []} />
                <ModelAuditTable title="Favorite / Underdog" rows={chineModelAudit?.favoriteUnderdog ?? []} />
                <ModelAuditTable title="Home / Road" rows={chineModelAudit?.homeRoad ?? []} />
                <ModelAuditTable title="Reason Count" rows={chineModelAudit?.reasonCounts ?? []} />
                <ModelAuditTable title="Starter Edge" rows={chineModelAudit?.starterEdge ?? []} />
                <ModelAuditTable title="Bullpen Edge" rows={chineModelAudit?.bullpenEdge ?? []} />
                <ModelAuditTable title="Market Movement" rows={chineModelAudit?.marketMovement ?? []} />
                <ModelAuditTable title="Top Heuristic Reasons" rows={(chineModelAudit?.reasons ?? []).slice(0, 30)} />
              </div>
              {chineModelAuditNotice && <p className={chineModelAuditNotice.includes("refreshed") ? "success" : "error"}>{chineModelAuditNotice}</p>}
            </div>
            )}
            {adminSection === "reddit" && canManageReddit && (
              <div className="notification-card reddit-card">
                <div>
                  <strong>Reddit Posting</strong>
                  <span>
                    Generate a copy-ready manual Reddit post from today's AI picks.
                  </span>
                </div>
                <div className="notification-actions">
                  <button className="secondary-action" onClick={refreshRedditStatus}>Refresh status</button>
                </div>
                <div className="reddit-editor">
                  <label>
                    Subreddit
                    <input value={redditSubreddit} placeholder="sportsbook" onChange={(event) => setRedditSubreddit(event.target.value)} />
                  </label>
                  <button className="secondary-action" onClick={generateRedditPreview}>Generate preview</button>
                  <label>
                    Title
                    <input value={redditTitle} maxLength={300} onChange={(event) => {
                      setRedditTitle(event.target.value);
                      setRedditSingleLock(null);
                    }} />
                  </label>
                  <label>
                    Body
                    <textarea value={redditBody} rows={12} onChange={(event) => {
                      setRedditBody(event.target.value);
                      setRedditSingleLock(null);
                    }} />
                  </label>
                  <div className="notification-actions">
                    <button className="primary" disabled={!redditTitle || !redditBody} onClick={copyRedditPost}>Copy post</button>
                    <button className={redditSingleLock ? "primary" : "secondary-action"} disabled={!redditTitle || !redditBody || redditLockingType !== null} onClick={() => lockRedditPostTracking("single")}>
                      {redditLockingType === "single" ? "Locking..." : redditSingleLock ? "Single locked" : "Lock single"}
                    </button>
                  </div>
                  {redditSingleLock && (
                    <div className="reddit-lock-status">
                      <Lock size={16} />
                      <span>Single saved at {new Date(redditSingleLock.lockedAt).toLocaleString()}. Safe to post.</span>
                    </div>
                  )}
                  <button className="secondary-action" onClick={generateRedditParlayPreview}>Generate 3-team parlay</button>
                  <label>
                    3-Team Parlay Title
                    <input value={redditParlayTitle} maxLength={300} onChange={(event) => {
                      setRedditParlayTitle(event.target.value);
                      setRedditParlayLock(null);
                    }} />
                  </label>
                  <label>
                    3-Team Parlay Body
                    <textarea value={redditParlayBody} rows={10} onChange={(event) => {
                      setRedditParlayBody(event.target.value);
                      setRedditParlayLock(null);
                    }} />
                  </label>
                  <div className="notification-actions">
                    <button className="primary" disabled={!redditParlayTitle || !redditParlayBody} onClick={copyRedditParlayPost}>Copy parlay post</button>
                    <button className={redditParlayLock ? "primary" : "secondary-action"} disabled={!redditParlayTitle || !redditParlayBody || redditLockingType !== null} onClick={() => lockRedditPostTracking("parlay")}>
                      {redditLockingType === "parlay" ? "Locking..." : redditParlayLock ? "Parlay locked" : "Lock parlay"}
                    </button>
                  </div>
                  {redditParlayLock && (
                    <div className="reddit-lock-status">
                      <Lock size={16} />
                      <span>Parlay saved at {new Date(redditParlayLock.lockedAt).toLocaleString()}. Safe to post.</span>
                    </div>
                  )}
                </div>
                {redditNotice && <p className={redditNotice.includes("generated") || redditNotice.includes("copied") || redditNotice.includes("locked") ? "success" : "error"}>{redditNotice}</p>}
              </div>
            )}
            {adminSection === "users" && (
            <div className="notification-card user-map-card">
              <div>
                <strong>User Display Map</strong>
                <span>Visible only to Nate Rakel. Use this to match public display names to login usernames.</span>
              </div>
              <div className="notification-actions">
                <button className="secondary-action" onClick={refreshUserDisplayMap}>Refresh users</button>
              </div>
              <div className="user-map-table">
                <table>
                  <thead>
                    <tr>
                      <th>Leaderboard Name</th>
                      <th>Display Name</th>
                      <th>Login</th>
                      <th>Email</th>
                      <th>Full Name</th>
                      <th>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userDisplayMap.map((mappedUser) => (
                      <tr key={mappedUser.id}>
                        <td>{mappedUser.leaderboardDisplayName || "-"}</td>
                        <td>{mappedUser.displayName || "-"}</td>
                        <td>{mappedUser.username}</td>
                        <td>{mappedUser.email || "-"}</td>
                        <td>{mappedUser.fullName || "-"}</td>
                        <td>{mappedUser.role}</td>
                      </tr>
                    ))}
                    {userDisplayMap.length === 0 && (
                      <tr>
                        <td colSpan={6}>No users found.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {userDisplayMapNotice && <p className={userDisplayMapNotice.includes("refreshed") ? "success" : "error"}>{userDisplayMapNotice}</p>}
            </div>
            )}
          </div>
        )}

        {activePage === "account" && (
          <div className="panel page-panel account-page">
            <div className="panel-title">
              <User size={20} />
              <h2>Account</h2>
            </div>
            <div className="account-grid">
              <label>
                Full Name
                <input value={fullName} minLength={2} maxLength={120} onChange={(event) => setFullName(event.target.value)} />
              </label>
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  maxLength={254}
                  disabled={Boolean(user?.emailVerified && !emailEditing)}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <span className={user?.emailVerified ? "success inline-status" : "error inline-status"}>
                  {user?.emailVerified && !emailEditing ? "Verified and locked" : "Verification required for rewards"}
                </span>
              </label>
              {user?.emailVerified && !emailEditing && (
                <button
                  className="secondary-action account-inline-action"
                  type="button"
                  onClick={() => {
                    setEmailEditing(true);
                    setAccountEmailNotice("Enter the new email, save profile, then verify the link sent to that address.");
                  }}
                >
                  Change Email
                </button>
              )}
              {(!user?.emailVerified || emailEditing || emailNeedsSave) && (
                <div className="account-save-callout">
                  <span>{emailNeedsSave ? "Save this email before requesting a verification link." : "Save profile changes before verification."}</span>
                  <button className="primary icon-action" type="button" disabled={accountSaving} onClick={saveProfile}><Save size={18} /> {accountSaving ? "Saving..." : "Save Profile"}</button>
                </div>
              )}
            </div>
            {user && (!user.emailVerified || emailEditing) && (
              <div className="notification-card">
                <div>
                  <strong>Verify Email</strong>
                  <span>{emailNeedsSave ? "Save the email above first. A verification link will be sent after saving." : "Reward eligibility requires a verified email address."}</span>
                </div>
                <div className="notification-actions">
                  <button
                    className="secondary-action"
                    type="button"
                    disabled={emailNeedsSave || !user.email || accountVerificationLinkAlreadySent}
                    onClick={sendAccountEmailVerification}
                  >
                    {accountVerificationLinkAlreadySent ? "Verification link sent" : "Send verification link"}
                  </button>
                </div>
                {accountEmailNotice && <p className={accountEmailNotice.includes("sent") || accountEmailNotice.includes("verified") ? "success" : "error"}>{accountEmailNotice}</p>}
              </div>
            )}
            <label>
              Display name
              <input value={displayName} minLength={2} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
            <div className="reward-card">
              <span>Reward Balance</span>
              <strong>{user ? money(user.rewardBalanceCents) : "$0.00"}</strong>
              <button className="withdraw-button" disabled={!canWithdraw}>Withdraw</button>
              {!canWithdraw && (
                <small>Available after rewards exceed $20.00, email is verified, and payout details are complete.</small>
              )}
            </div>
            <div className="notification-card referral-card">
              <div>
                <strong>Referral</strong>
                <span>Share this QR code or link. New accounts created from it will be marked as referred by you.</span>
              </div>
              <div className="referral-layout">
                <div className="referral-qr-box">
                  {referralQr ? <img src={referralQr} alt="Referral QR code" /> : <span>QR unavailable</span>}
                </div>
                <div className="referral-details">
                  <label>
                    Referral link
                    <input value={referralInfo?.referralUrl ?? ""} readOnly />
                  </label>
                  <small>{referralInfo ? `${referralInfo.referredCount} referred ${referralInfo.referredCount === 1 ? "account" : "accounts"}` : "Referral details loading."}</small>
                  <div className="notification-actions">
                    <button className="secondary-action" type="button" onClick={copyReferralLink}><ClipboardList size={17} /> Copy link</button>
                    <button className="secondary-action" type="button" onClick={() => void refreshReferral()}><Radio size={17} /> Refresh</button>
                  </div>
                </div>
              </div>
              {referralNotice && <p className={referralNotice.includes("copied") ? "success" : "error"}>{referralNotice}</p>}
            </div>
            <div className="notification-card">
              <div>
                <strong>Push Notifications</strong>
                <span>Enable notifications on this device, then choose which alerts you want.</span>
              </div>
              <div className="notification-actions">
                <button className="secondary-action" onClick={enablePush}>Enable notifications</button>
                <button className="secondary-action" onClick={sendPushTest}>Send test</button>
              </div>
              <div className="notification-preferences">
                {pushPreferenceRows.map((preference) => (
                  <label className="notification-toggle" key={preference.key}>
                    <input
                      type="checkbox"
                      checked={pushPreferences[preference.key]}
                      onChange={(event) => setPushPreference(preference.key, event.target.checked)}
                    />
                    <span>
                      <strong>{preference.label}</strong>
                      <small>{preference.description}</small>
                    </span>
                  </label>
                ))}
              </div>
              {pushNotice && <p className={pushNotice.includes("enabled") || pushNotice.includes("sent") || pushNotice.includes("saved") ? "success" : "error"}>{pushNotice}</p>}
            </div>
            <div className="account-grid">
              <label>
                Preferred payout method
                <select value={payoutMethod} onChange={(event) => {
                  const method = event.target.value as SessionUser["payoutMethod"];
                  setPayoutMethod(method);
                  if (method === "none") {
                    setPayoutHandle("");
                  }
                }}>
                  <option value="none">None</option>
                  <option value="paypal">PayPal</option>
                  <option value="venmo">Venmo</option>
                </select>
              </label>
              <label>
                {payoutMethod === "paypal" ? "PayPal handle" : payoutMethod === "venmo" ? "Venmo handle" : "Payout handle"}
                <input value={payoutHandle} maxLength={120} disabled={payoutMethod === "none"} onChange={(event) => setPayoutHandle(event.target.value)} />
              </label>
            </div>
            <label>
              Last 4 of phone
              <input inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={phoneLast4} onChange={(event) => setPhoneLast4(event.target.value.replace(/\D/g, "").slice(0, 4))} />
            </label>
            <button className="primary icon-action" onClick={saveProfile}><Save size={18} /> Save profile</button>
            {notice && <p className={notice.includes("saved") ? "success" : "error"}>{notice}</p>}
          </div>
        )}
      </section>
      {lineupGame && (
        <div className="modal-backdrop" role="presentation" onClick={() => setLineupGame(null)}>
          <div className="lineup-modal" role="dialog" aria-modal="true" aria-label={`${lineupGame.awayTeam} at ${lineupGame.homeTeam} lineups`} onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <strong>{lineupGame.awayTeam} @ {lineupGame.homeTeam}</strong>
                <span>{new Date(lineupGame.startsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
              </div>
              <button title="Close lineups" onClick={() => setLineupGame(null)}><X size={18} /></button>
            </div>
            <div className="lineup-grid modal-lineups">
              <div>
                <strong>{lineupGame.awayTeam}</strong>
                <ol>
                  {lineupGame.awayLineup?.players.map((player) => (
                    <li key={player.playerId}>
                      <span>{player.name}</span>
                      <small>{lineupStats(player)}</small>
                    </li>
                  ))}
                </ol>
              </div>
              <div>
                <strong>{lineupGame.homeTeam}</strong>
                <ol>
                  {lineupGame.homeLineup?.players.map((player) => (
                    <li key={player.playerId}>
                      <span>{player.name}</span>
                      <small>{lineupStats(player)}</small>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="support-widget">
        {supportOpen && (
          <div className="support-window" role="dialog" aria-label="StakeWars support chat">
            <div className="support-window-head">
              <strong>Hi! How can we help?</strong>
              <button type="button" title="Close support" onClick={() => setSupportOpen(false)}><X size={16} /></button>
            </div>
            {!user.emailVerified ? (
              <div className="support-window-body">
                <p className="muted">Support chat is available after your email address is verified.</p>
                <button className="secondary-action" type="button" onClick={() => {
                  setSupportOpen(false);
                  openPage("account");
                }}>Go to Account</button>
              </div>
            ) : (
              <div className="support-window-body">
                {activeSupportConversation ? (
                  <>
                    <div className="support-thread-head">
                      <div>
                        <strong>{supportCategoryLabel(activeSupportConversation.category)}</strong>
                        <span>{activeSupportConversation.status === "open" ? "Open" : "Closed"}</span>
                      </div>
                      <button className="secondary-action" type="button" onClick={() => setActiveSupportConversation(null)}>New chat</button>
                    </div>
                    <div className="support-messages user-thread" ref={userSupportMessagesRef}>
                      {activeSupportMessages.map((message) => (
                        <div key={message.id} className={`support-message ${message.senderRole}`}>
                          <strong>{message.senderRole === "admin" ? "StakeWars Support" : "You"}</strong>
                          <p>{message.body}</p>
                          <small>{new Date(message.createdAt).toLocaleString()}</small>
                        </div>
                      ))}
                    </div>
                    {activeSupportConversation.status === "open" ? (
                      <div className="support-reply">
                        <textarea
                          value={supportReplyMessage}
                          rows={3}
                          maxLength={2000}
                          onChange={(event) => setSupportReplyMessage(event.target.value)}
                          placeholder="Reply to support..."
                        />
                        <button className="primary" type="button" disabled={!supportReplyMessage.trim()} onClick={sendUserSupportMessage}>Send</button>
                      </div>
                    ) : (
                      <p className="muted">This chat has been closed.</p>
                    )}
                  </>
                ) : (
                  <>
                    <div className="support-category-grid">
                      {([
                        "account_email",
                        "rewards_eligibility",
                        "picks_scoring",
                        "technical_problem",
                        "other"
                      ] as SupportCategory[]).map((category) => (
                        <button
                          key={category}
                          type="button"
                          className={supportCategory === category ? "active" : ""}
                          onClick={() => setSupportCategory(category)}
                        >
                          {supportCategoryLabel(category)}
                        </button>
                      ))}
                    </div>
                    <textarea
                      value={supportMessage}
                      rows={3}
                      maxLength={2000}
                      onChange={(event) => setSupportMessage(event.target.value)}
                      placeholder="Add a short message..."
                    />
                    <button
                      className="primary"
                      type="button"
                      disabled={!supportCategory}
                      onClick={() => supportCategory && startSupportChat(supportCategory)}
                    >
                      Start chat
                    </button>
                    {supportConversations.length > 0 && (
                      <div className="support-conversation-list compact-list">
                        {supportConversations.slice(0, 3).map((conversation) => (
                          <button key={conversation.id} type="button" onClick={() => openUserSupportConversation(conversation.id)}>
                            <strong>{supportCategoryLabel(conversation.category)}</strong>
                            <span>{conversation.status}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {supportNotice && <p className={supportNotice.includes("opened") ? "success" : "error"}>{supportNotice}</p>}
              </div>
            )}
          </div>
        )}
        <button className="support-fab" type="button" onClick={() => setSupportOpen((current) => !current)}>
          <Mail size={18} /> Support
        </button>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
