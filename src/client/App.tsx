import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BadgeDollarSign, BarChart3, Bot, Check, ChevronDown, ChevronRight, ClipboardList, Download, FileText, History, Lock, LogOut, Radio, Save, Trophy, User, UserPlus, Wallet, WifiOff, X } from "lucide-react";
import { createRoot } from "react-dom/client";
import type { GameCard, GameLine, GameMarket, GameMarketSide, LeaderboardRow, LiveGameState, OpenBet, SessionUser, SettledBet, WagerKind } from "../shared/types";
import "./styles.css";

type AuthMode = "login" | "register";
type AppPage = "lines" | "scoreboard" | "leaderboard" | "open-bets" | "history" | "rules" | "install" | "account";
type ScoreboardSport = "MLB" | "NFL" | "NBA" | "NHL" | "NCAAMB" | "NCAAF" | "EPL" | "WORLDCUP";
type HistoryPeriod = "day" | "week" | "all";
const sportsMenu: ScoreboardSport[] = ["MLB", "NFL", "NBA", "NHL", "NCAAMB", "NCAAF", "EPL", "WORLDCUP"];

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
};

type PushPreferences = {
  gameReminderEnabled: boolean;
  gameStartedEnabled: boolean;
  scoreChangeEnabled: boolean;
  gameFinalEnabled: boolean;
};

const money = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const americanOdds = (odds: number) => `${odds > 0 ? "+" : ""}${odds}`;

const americanToDecimal = (odds: number) => odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);

const statusLabel = (status: string) => status === "void" ? "No Action" : status;

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

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
  if (legs < 2 || legs > 8 || maxLegs < 2 || maxLegs > legs) return 0;
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
    return "Pitcher TBD";
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
  if (page === "install") return "Install App";
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
    throw new ApiError(body.error ?? "Request failed", response.status);
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
        <h2>No Action</h2>
        <p>Postponed, suspended, cancelled, or shortened MLB games are No Action. MLB games must complete at least 9 innings to settle. A No Action single returns the wager to the player's bankroll. In parlays, the affected leg is dropped; if only one active leg remains, the wager settles as a straight bet.</p>
      </section>
      <section>
        <h2>AI Bot</h2>
        <p>The StakeWars AI Bot posts public picks. To be eligible for a weekly reward, a player must finish in the top three and beat the StakeWars AI Bot on the final leaderboard. Failure to beat the bot at the end of the week disqualifies the player from receiving a reward.</p>
      </section>
      <section>
        <h2>No Real-Money Gambling</h2>
        <p>StakeWars is a free contest using virtual bankroll only. No purchase, deposit, or real-money wager is required or accepted.</p>
      </section>
      <section>
        <h2>Prizes</h2>
        <p>Reward details may change by week and will be announced separately. Site operators may void errors, duplicate accounts, abusive activity, or wagers affected by incorrect data.</p>
      </section>
      <section>
        <h2>Withdrawals</h2>
        <p>Withdrawals are only available once a player's reward balance meets or exceeds the $20.00 threshold and the required payout details are complete.</p>
      </section>
    </div>
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
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ token: string; user: SessionUser }>(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      localStorage.setItem("stakewars_token", result.token);
      onAuth(result.token, result.user);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="auth-shell">
      <div className="brand-panel">
        <img className="hero-logo" src="/images/sw-hero.png" alt="StakeWars" />
      </div>
      <form className="auth-card" onSubmit={submit} autoComplete="on">
        <div className="auth-heading">
          <img className="auth-logo" src="/icons/icon-192.png" alt="" />
          <div>
            <h1>StakeWars</h1>
            <p>Challenge the field weekly for free prizes and prove AI wrong!</p>
            <button className="rules-link" type="button" onClick={() => setRulesOpen(true)}>
              Rules and Terms
            </button>
          </div>
        </div>
        <div className="segmented">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            <Lock size={16} /> Login
          </button>
          <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
            <UserPlus size={16} /> Register
          </button>
        </div>
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
        {mode === "register" && (
          <p className="hint">Minimum 10 characters with uppercase, lowercase, number, and symbol.</p>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">{mode === "login" ? "Login" : "Create account"}</button>
        <button className="secondary-action" type="button" onClick={() => canInstall ? onInstall() : setInstallOpen(true)}>
          <Download size={17} /> Install App
        </button>
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
  const [liveGames, setLiveGames] = useState<LiveGameState[]>([]);
  const [openBets, setOpenBets] = useState<OpenBet[]>([]);
  const [historyBets, setHistoryBets] = useState<SettledBet[]>([]);
  const [aiPicks, setAiPicks] = useState<any[]>([]);
  const [kind, setKind] = useState<WagerKind>("straight");
  const [stake, setStake] = useState("100");
  const [roundRobinMaxLegs, setRoundRobinMaxLegs] = useState(2);
  const [singleStakeAll, setSingleStakeAll] = useState("");
  const [singleStakes, setSingleStakes] = useState<Record<string, string>>({});
  const [includedLegIds, setIncludedLegIds] = useState<Set<string>>(() => new Set());
  const [slip, setSlip] = useState<SlipLeg[]>([]);
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

  const refresh = async (authToken = token) => {
    const [lineResult, boardResult, aiResult, liveResult] = await Promise.all([
      api<{ lines: GameLine[]; markets: GameMarket[]; games: GameCard[] }>("/lines"),
      api<{ leaderboard: LeaderboardRow[] }>("/leaderboard"),
      api<{ picks: any[] }>("/ai-picks"),
      api<{ games: LiveGameState[] }>("/live/mlb")
    ]);
    setLines(lineResult.lines);
    setMarkets(lineResult.markets ?? []);
    setGames(lineResult.games ?? []);
    setLeaderboard(boardResult.leaderboard);
    setAiPicks(aiResult.picks);
    setLiveGames(liveResult.games);
    if (authToken) {
      const [me, openBetResult, pushPreferenceResult] = await Promise.all([
        api<{ user: SessionUser; bankroll: Bankroll }>("/me", {}, authToken),
        api<{ wagers: OpenBet[] }>("/wagers/open", {}, authToken),
        api<{ preferences: PushPreferences }>("/push/preferences", {}, authToken)
      ]);
      setUser(me.user);
      setFullName(me.user.fullName ?? "");
      setEmail(me.user.email ?? "");
      setDisplayName(me.user.displayName ?? "");
      setPayoutMethod(me.user.payoutMethod);
      setPayoutHandle(me.user.payoutHandle ?? "");
      setPhoneLast4(me.user.phoneLast4 ?? "");
      setBankroll(me.bankroll);
      setOpenBets(openBetResult.wagers);
      setPushPreferences(pushPreferenceResult.preferences);
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

  const isMobileLayout = () => window.matchMedia("(max-width: 860px)").matches;

  const openPage = (page: AppPage) => {
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

  useEffect(() => {
    refresh().catch((error) => {
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem("stakewars_token");
        setToken("");
      }
    });
  }, []);

  useEffect(() => {
    refreshHistory().catch(() => undefined);
  }, [token, historyPeriod, historyIncludeAi]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

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
  const canWithdraw = Boolean(
    user
    && user.rewardBalanceCents > 2000
    && payoutMethod !== "none"
    && payoutHandle.trim().length >= 2
    && /^[0-9]{4}$/.test(phoneLast4)
  );
  const lockedAiPicks = aiPicks.filter((pick) => Boolean(pick.lockedAt));
  const projectedAiPicks = aiPicks.filter((pick) => !pick.lockedAt);

  useEffect(() => {
    if (firstAvailableSport && !sportsWithLines.has(lineSport)) {
      setLineSport(firstAvailableSport);
    }
    if (firstAvailableSport && !sportsWithLines.has(scoreboardSport)) {
      setScoreboardSport(firstAvailableSport);
    }
  }, [firstAvailableSport, lineSport, scoreboardSport, sportsWithLines]);

  const renderAiPick = (pick: any) => (
    <div className="ai-pick" key={pick.id}>
      <small className={pick.lockedAt ? "pick-status locked" : "pick-status projected"}>
        {pick.lockedAt ? "Locked" : "Projected"}
      </small>
      <strong>{pick.selectedTeam} {pick.marketKey === "h2h" ? americanOdds(pick.oddsAmerican) : `${pick.spread} ${americanOdds(pick.oddsAmerican)}`}</strong>
      <span>{pick.awayTeam} at {pick.homeTeam}</span>
      {pick.confidence && <span>Confidence {Math.round(Number(pick.confidence) * 100)}%</span>}
      {pick.explanation
        ? <small className="ai-explanation">{pick.explanation}</small>
        : pick.reasons?.length > 0 && <small>{pick.reasons.join(" · ")}</small>}
    </div>
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
    if (selectedLine.marketKey === "totals") {
      return existingLine.marketKey === "totals" && existingLine.favoriteTeam !== selectedLine.favoriteTeam;
    }
    return existingLine.marketKey !== "totals" && existingLine.favoriteTeam !== selectedLine.favoriteTeam;
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
          if (nextSlip.length < 5) {
            next.add(line.id);
          }
          return next;
        });
      } else if (current.length < 5) {
        setIncludedLegIds((included) => new Set(included).add(line.id));
      }
      if (singleStakeAll.trim()) {
        setSingleStakes((stakes) => ({ ...stakes, [line.id]: singleStakeAll }));
      }
      return [...nextSlip, { gameLineId: line.id, selectedTeam: line.team }];
    });
  };

  const marketLabel = (market: GameMarket, side?: GameMarketSide | null) => {
    if (market.marketKey === "h2h" && side?.team === "Draw") return "Draw";
    if (market.marketKey === "h2h" && side?.team) return `${teamAbbreviation(side.team)} Moneyline`;
    if (market.marketKey === "totals") return "Total";
    return `${side?.team ? `${teamAbbreviation(side.team)} ` : ""}${market.sport === "MLB" ? "Run Line" : "Spread"}`;
  };

  const lineForLeg = (leg: SlipLeg) => lineForId(leg.gameLineId);
  const gameHasStarted = (startsAt: string) => new Date(startsAt).getTime() <= currentTime;
  const lineHasStarted = (line: GameLine | undefined) => Boolean(line && gameHasStarted(line.startsAt));

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

  const placeWager = async () => {
    setNotice("");
    try {
      if (kind === "straight") {
        const wagers = slip
          .map((leg) => ({ leg, stakeCents: stakeCentsFromDollars(singleStakes[leg.gameLineId] ?? "") }))
          .filter((wager) => wager.stakeCents > 0);

        if (wagers.length === 0) {
          setNotice("Enter a stake for at least one single wager.");
          return;
        }
        if (wagers.some((wager) => lineHasStarted(lineForLeg(wager.leg)))) {
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
          body: JSON.stringify({ kind: "straight", stakeCents: wager.stakeCents, legs: [wager.leg] })
        }, token)));
      } else {
        if (includedSlip.length < 2) {
          setNotice(`${kind === "parlay" ? "Parlay" : "Round robin"} wagers need at least two selections.`);
          return;
        }
        if (includedSlip.some((leg) => lineHasStarted(lineForLeg(leg)))) {
          setNotice("One or more selected games have already started. Remove them from the bet slip before placing this wager.");
          return;
        }
        if (includedSlip.length > 8) {
          setNotice(`${kind === "parlay" ? "Parlay" : "Round robin"} wagers are limited to 8 checked selections.`);
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
      if (next.size >= 8) {
        setNotice("Parlay and round robin wagers are limited to 8 checked selections.");
        return current;
      }
      next.add(legId);
      return next;
    });
  };

  const saveProfile = async () => {
    setNotice("");
    try {
      const cleaned = displayName.trim();
      const result = await api<{ token: string; user: SessionUser }>("/me/profile", {
        method: "PATCH",
        body: JSON.stringify({
          fullName: fullName.trim() || null,
          email: email.trim() || null,
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
      setDisplayName(result.user.displayName ?? "");
      setPayoutMethod(result.user.payoutMethod);
      setPayoutHandle(result.user.payoutHandle ?? "");
      setPhoneLast4(result.user.phoneLast4 ?? "");
      setNotice("Profile saved.");
      await refresh(result.token);
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const logout = () => {
    localStorage.removeItem("stakewars_token");
    setToken("");
    setUser(null);
    setBankroll(null);
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
          <button className={activePage === "leaderboard" ? "active" : ""} onClick={() => openPage("leaderboard")}><Trophy size={18} /> Leaderboard</button>
          <button className={activePage === "open-bets" ? "active" : ""} onClick={() => openPage("open-bets")}><ClipboardList size={18} /> Open Bets</button>
          <button className={activePage === "history" ? "active" : ""} onClick={() => openPage("history")}><History size={18} /> History</button>
          <button className={activePage === "rules" ? "active" : ""} onClick={() => openPage("rules")}><FileText size={18} /> Rules</button>
          <button className={activePage === "install" ? "active" : ""} onClick={() => openPage("install")}><Download size={18} /> Install App</button>
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
                            {kind !== "straight" && (
                              <input
                                type="checkbox"
                                checked={included}
                                onChange={(event) => toggleIncludedLeg(leg.gameLineId, event.target.checked)}
                                aria-label={`Include ${leg.selectedTeam}`}
                              />
                            )}
                            <strong>{leg.selectedTeam} {marketText(line)}</strong>
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
                {kind !== "straight" && (
                  <div className="combined-stake-box">
                    <span>{includedSlip.length} checked / 8 max</span>
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
                <button className="primary" disabled={slip.length === 0} onClick={placeWager}>Place wager</button>
              </div>
              <div className="panel">
                <div className="panel-title">
                  <Bot size={20} />
                  <h2>{lockedAiPicks.length ? "Locked Picks" : "Projected Picks"}</h2>
                </div>
                {aiPicks.length === 0 ? <p className="muted">No public AI picks for today.</p> : (
                  <>
                    {lockedAiPicks.map(renderAiPick)}
                    {lockedAiPicks.length > 0 && projectedAiPicks.length > 0 && <h3 className="pick-section-title">Projected Picks</h3>}
                    {projectedAiPicks.map(renderAiPick)}
                  </>
                )}
              </div>
            </aside>
            <button className="floating-bet-slip" type="button" onClick={jumpToBetSlip} aria-label={`Go to bet slip with ${slip.length} selections`}>
              <BadgeDollarSign size={18} />
              <span>Bet Slip</span>
              {slip.length > 0 && <strong>{slip.length}</strong>}
            </button>
          </div>
        )}

        {activePage === "scoreboard" && (
          <div className="panel page-panel">
            <div className="panel-title">
              <Radio size={20} />
              <h2>{scoreboardSport} live box scores</h2>
            </div>
            {scoreboardSport === "MLB" ? (
              <div className="live-list scoreboard-grid">
                {liveGames.length === 0 ? <p className="muted">No live MLB snapshots yet.</p> : liveGames.map((game) => (
                  <article className="live-game" key={game.matchId}>
                    <div className="live-score">
                      <span>{game.awayTeam}</span>
                      <strong>{game.awayScore ?? "-"}</strong>
                    </div>
                    <div className="live-score">
                      <span>{game.homeTeam}</span>
                      <strong>{game.homeScore ?? "-"}</strong>
                    </div>
                    <BaseDiamond game={game} />
                    <div className="live-meta">
                      <span>{[game.period ?? game.gameStatus ?? "Live", liveCount(game), liveOuts(game.outs)].filter(Boolean).join(" • ")}</span>
                      <div className="live-details">
                        {pitcherDetail(game) && <small>{pitcherDetail(game)}</small>}
                        {batterDetail(game) && <small>{batterDetail(game)}</small>}
                        {(game.lastPlay ?? game.description) && <small className="last-play">Last play: {game.lastPlay ?? game.description}</small>}
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
              <h2>Leaderboard</h2>
            </div>
            <ol className="leaderboard leaderboard-page-list">
              {leaderboard.map((row) => (
                <li key={`${row.rank}-${row.displayName}`}>
                  <span>{row.rank}. {row.displayName}</span>
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
                        <span>{leg.selectedTeam} {marketText}</span>
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
                  Show AI Bot
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
                      <h3>StakeWars AI Bot</h3>
                      <div className="history-list">
                        {historyBets.filter((bet) => bet.owner === "ai").length === 0
                          ? <p className="muted">No settled AI Bot wagers for this period.</p>
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

        {activePage === "install" && (
          <div className="panel page-panel">
            <div className="panel-title">
              <Download size={20} />
              <h2>Install App</h2>
            </div>
            <InstallContent canPrompt={Boolean(installPrompt && !isStandalone)} isStandalone={isStandalone} onInstall={installApp} />
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
                <input type="email" value={email} maxLength={254} onChange={(event) => setEmail(event.target.value)} />
              </label>
            </div>
            <label>
              Display name
              <input value={displayName} minLength={2} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} />
            </label>
            <div className="reward-card">
              <span>Reward Balance</span>
              <strong>{user ? money(user.rewardBalanceCents) : "$0.00"}</strong>
              <button className="withdraw-button" disabled={!canWithdraw}>Withdraw</button>
              {!canWithdraw && (
                <small>Available after rewards exceed $20.00 and payout details are complete.</small>
              )}
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
            {notice && <p className={notice === "Profile saved." ? "success" : "error"}>{notice}</p>}
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
