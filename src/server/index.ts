import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cron from "node-cron";
import { ZodError } from "zod";
import { config } from "./config.js";
import { pool } from "./db.js";
import { refreshMlbGameContext } from "./mlbContext.js";
import { refreshOdds } from "./odds.js";
import { generateAiPicks, snapshotAiCandidates } from "./ai.js";
import { registerRoutes } from "./routes.js";

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

const addDays = (date: string, days: number) => {
  const copy = new Date(`${date}T00:00:00Z`);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
};

const legalPage = ({
  title,
  sections
}: {
  title: string;
  sections: Array<{ heading: string; body: string }>;
}) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} | StakeWars</title>
    <style>
      body { margin: 0; background: #f4f6f2; color: #14201c; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; }
      main { max-width: 860px; margin: 0 auto; padding: 40px 18px; }
      article { background: #fff; border: 1px solid #dfe5df; border-radius: 8px; padding: 24px; }
      h1 { margin: 0 0 22px; font-size: 2rem; }
      section { margin-top: 18px; }
      h2 { margin: 0 0 4px; font-size: 1rem; color: #111827; }
      p { margin: 0; color: #43524c; }
      nav { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 24px; }
      a { color: #ff6900; font-weight: 800; text-underline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      <article>
        <h1>${title}</h1>
        ${sections.map((section) => `<section><h2>${section.heading}</h2><p>${section.body}</p></section>`).join("")}
        <nav>
          <a href="/">Return to StakeWars</a>
          <a href="/terms">Terms and Conditions</a>
          <a href="/privacy">Privacy Policy</a>
        </nav>
      </article>
    </main>
  </body>
</html>`;

const privacyHtml = legalPage({
  title: "Privacy Policy",
  sections: [
    { heading: "Privacy Policy", body: "Effective June 29, 2026. StakeWars is a free sports prediction contest operated at stakewars.ai." },
    { heading: "Information We Collect", body: "We collect account information players provide, including username, password hash, full name, email, email verification status, display name, payout preference, payout handle, and the last four digits of a phone number when entered for reward validation." },
    { heading: "Contest Data", body: "We store virtual wagers, bankroll balances, leaderboard results, settled wager history, notification preferences, push subscription records, and account activity needed to run the contest." },
    { heading: "How We Use Information", body: "We use information to authenticate users, verify email addresses, operate the contest, display leaderboards and wager history, send requested push notifications, validate rewards, prevent abuse, provide support, and publish admin-approved public updates." },
    { heading: "Sharing", body: "We do not sell personal information. We may share limited information with service providers necessary to host the site, send push notifications, maintain security, or process rewards." },
    { heading: "Security", body: "Passwords are stored as hashes. Administrative integrations use server-side secrets. No internet service can be guaranteed perfectly secure, but we use reasonable safeguards for the data we store." },
    { heading: "Contact", body: "Questions about this policy can be sent to support@stakewars.ai." }
  ]
});

const termsHtml = legalPage({
  title: "Terms and Conditions",
  sections: [
    { heading: "Terms and Conditions", body: "Effective June 29, 2026. By using StakeWars, you agree to these terms and the contest rules shown on the site." },
    { heading: "Free Contest", body: "StakeWars is a free virtual-bankroll contest. No purchase, deposit, or real-money wager is required or accepted. Virtual wagers have no cash value." },
    { heading: "Eligibility and Accounts", body: "Players must provide accurate account information, verify their email address for reward eligibility, and may not create duplicate accounts, manipulate results, abuse promotions, or interfere with site operations." },
    { heading: "Rules and Rewards", body: "The active weekly prize pool is shown on the leaderboard and is split 50%, 35%, and 15% among eligible first, second, and third place finishers. A week may also include a separate first-place bonus prize. Weekly rewards require players to satisfy the posted rules, including verified email, placing at least 10 weekly wagers, wagering at least 1.5x the weekly starting bankroll, finishing in an eligible leaderboard position, and beating StakeWars Chine. Withdrawal eligibility requires a reward balance of at least $20.00, verified email, and complete payout details." },
    { heading: "Line and Scoring Data", body: "StakeWars relies on third-party sports, odds, and scoring data. Site operators may correct obvious data errors, void affected wagers, mark games No Action, or adjust settlement when required for fairness. Soccer 3-way moneylines settle on the score after regulation plus stoppage time; penalty kicks do not turn a team moneyline loss into a win." },
    { heading: "Changes", body: "StakeWars may update these terms, contest rules, features, or reward details. Continued use of the site after updates means you accept the revised terms." }
  ]
});

const app = express();
const api = express.Router();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const clientDir = path.join(root, "dist/client");
const allowedOrigins = new Set(config.allowedOrigins);
const privateApiPath = /^\/(me(?:\/|$)|wagers(?:\/|$)|push(?:\/|$)|admin(?:\/|$)|support(?:\/|$)|tower(?:\/|$)|merch(?:\/|$))/;

const noStorePrivateApi = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (privateApiPath.test(req.path) || req.header("authorization")) {
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
};

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: config.nodeEnv === "production" ? {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "base-uri": ["'self'"],
      "connect-src": ["'self'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'self'"],
      "img-src": ["'self'", "data:"],
      "manifest-src": ["'self'"],
      "object-src": ["'none'"],
      "script-src": ["'self'"],
      "script-src-attr": ["'none'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "worker-src": ["'self'"]
    }
  } : false,
  frameguard: { action: "deny" },
  hsts: config.nodeEnv === "production" ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  noSniff: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin.replace(/\/+$/, ""))) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: false
}));
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
api.use(noStorePrivateApi);
api.use("/admin", rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));
api.use("/me/profile", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
api.use("/push", rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));
api.use("/support", rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));
api.use("/tower", rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));
api.use("/merch", rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
api.use("/wagers", rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

registerRoutes(api);
app.use("/api", api);
app.get("/privacy", (_req, res) => res.type("html").send(privacyHtml));
app.get("/terms", (_req, res) => res.type("html").send(termsHtml));

if (process.env.STAKEWARS_ENABLE_INTERNAL_ODDS_CRON === "true") {
  cron.schedule("*/10 8-20 * * *", async () => {
    try {
      await refreshOdds();
      const todayCentral = centralDate();
      try {
        await refreshMlbGameContext({ startDate: todayCentral, endDate: addDays(todayCentral, 1) });
      } catch (error) {
        console.error("Scheduled MLB context refresh failed", error);
      }
      await snapshotAiCandidates({ sport: "MLB", source: "scheduled-odds-refresh" });
      await generateAiPicks({
        sport: "MLB",
        maxPicks: 5,
        placeWagers: true,
        marketKey: "h2h",
        sortBy: "confidence",
        uniqueGames: true
      });
    } catch (error) {
      console.error("Scheduled odds refresh failed", error);
    }
  }, {
    timezone: "America/Chicago"
  });
}

if (config.nodeEnv === "production") {
  app.use(express.static(clientDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: error.issues[0]?.message ?? "Invalid request" });
    return;
  }

  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

const host = config.nodeEnv === "production" ? "127.0.0.1" : "0.0.0.0";

const server = app.listen(config.port, host, () => {
  console.log(`StakeWars listening on ${config.port}`);
});

const shutdown = async () => {
  server.close();
  await pool.end();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
