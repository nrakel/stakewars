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
      uniqueGames: true,
      stakeFractionOfBalance: 0.05
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
