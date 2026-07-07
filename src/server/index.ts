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
    { heading: "Privacy Policy", body: "Effective June 29, 2026. StakeWars is a free sports prediction contest operated at stakewars.phisystems.ai." },
    { heading: "Information We Collect", body: "We collect account information players provide, including username, password hash, full name, email, display name, payout preference, payout handle, and the last four digits of a phone number when entered for reward validation." },
    { heading: "Contest Data", body: "We store virtual wagers, bankroll balances, leaderboard results, settled wager history, notification preferences, push subscription records, and account activity needed to run the contest." },
    { heading: "Reddit Devvit Integration", body: "The StakeWars Reddit app fetches admin-approved post drafts from StakeWars and reports whether the Reddit post succeeded or failed. It does not send Reddit user data to StakeWars, scrape Reddit, vote, message users, or collect Reddit account data." },
    { heading: "How We Use Information", body: "We use information to authenticate users, operate the contest, display leaderboards and wager history, send requested push notifications, validate rewards, prevent abuse, and publish admin-approved public updates." },
    { heading: "Sharing", body: "We do not sell personal information. We may share limited information with service providers necessary to host the site, send push notifications, maintain security, or process rewards." },
    { heading: "Security", body: "Passwords are stored as hashes. Administrative integrations use server-side secrets. No internet service can be guaranteed perfectly secure, but we use reasonable safeguards for the data we store." },
    { heading: "Contact", body: "Questions about this policy can be sent to the StakeWars operator through the contact method listed in the Reddit app details or the site administrator account." }
  ]
});

const termsHtml = legalPage({
  title: "Terms and Conditions",
  sections: [
    { heading: "Terms and Conditions", body: "Effective June 29, 2026. By using StakeWars, you agree to these terms and the contest rules shown on the site." },
    { heading: "Free Contest", body: "StakeWars is a free virtual-bankroll contest. No purchase, deposit, or real-money wager is required or accepted. Virtual wagers have no cash value." },
    { heading: "Eligibility and Accounts", body: "Players must provide accurate account information and may not create duplicate accounts, manipulate results, abuse promotions, or interfere with site operations." },
    { heading: "Rules and Rewards", body: "Weekly rewards, if offered, require players to satisfy the posted rules, including finishing in an eligible leaderboard position and beating the StakeWars AI Bot. Withdrawal eligibility requires a reward balance of at least $20.00 and complete payout details." },
    { heading: "Line and Scoring Data", body: "StakeWars relies on third-party sports, odds, and scoring data. Site operators may correct obvious data errors, void affected wagers, mark games No Action, or adjust settlement when required for fairness. Soccer 3-way moneylines settle on the score after regulation plus stoppage time; penalty kicks do not turn a team moneyline loss into a win." },
    { heading: "Reddit Posts", body: "The StakeWars Reddit app may publish admin-approved contest updates, AI picks, and links to StakeWars. Reddit posting is moderator-controlled and does not authorize automated scraping, voting, direct messaging, or collection of Reddit user data." },
    { heading: "Changes", body: "StakeWars may update these terms, contest rules, features, or reward details. Continued use of the site after updates means you accept the revised terms." }
  ]
});

const redditApiHtml = legalPage({
  title: "StakeWars Reddit API",
  sections: [
    { heading: "Purpose", body: "This hostname is used only by the StakeWars Reddit Devvit app to publish admin-approved public contest posts from Reddit's server runtime." },
    { heading: "Endpoints", body: "The Devvit app calls POST /api/devvit/reddit/claim to claim one approved draft and POST /api/devvit/reddit/result to report whether Reddit publishing succeeded or failed." },
    { heading: "Authentication", body: "Both endpoints require Authorization: Bearer <shared secret>. The shared secret is configured by a subreddit moderator and is not exposed publicly." },
    { heading: "Data", body: "The claim response contains only the queue id, subreddit, title, body, and created timestamp for an admin-approved draft. The result request sends only the queue id, status, Reddit post id or URL when available, and an error message when publishing fails." },
    { heading: "Reddit User Data", body: "This API does not collect Reddit user data, scrape Reddit, vote, send direct messages, or read private subreddit data. Reddit is used only as the publishing destination for moderator-approved public posts." }
  ]
});

const app = express();
const api = express.Router();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const clientDir = path.join(root, "dist/client");

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: config.nodeEnv === "production" ? undefined : false
}));
app.use(cors({ origin: config.publicOrigin, credentials: false }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));

registerRoutes(api);
app.use("/api", api);
app.get("/privacy", (_req, res) => res.type("html").send(privacyHtml));
app.get("/terms", (_req, res) => res.type("html").send(termsHtml));
app.get("/", (req, res, next) => {
  if (req.hostname === "reddit-api.stakewars.phisystems.ai") {
    res.type("html").send(redditApiHtml);
    return;
  }
  next();
});

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
