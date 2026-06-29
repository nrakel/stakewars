import "dotenv/config";

const required = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  publicOrigin: process.env.PUBLIC_ORIGIN ?? "http://localhost:3000",
  databaseUrl: required("DATABASE_URL", "postgres://stakewars:stakewars@localhost:5432/stakewars"),
  jwtSecret: required("JWT_SECRET", "development-only-secret-change-me"),
  weeklyBankrollCents: Number(process.env.WEEKLY_BANKROLL_CENTS ?? 1000000),
  aiUsername: process.env.AI_USERNAME ?? "stakewars_ai",
  parlayApiBaseUrl: process.env.PARLAY_API_BASE_URL ?? process.env.ODDS_PROVIDER_URL ?? "https://parlay-api.com/v1",
  parlayApiKey: process.env.PARLAY_API_KEY ?? process.env.ODDS_PROVIDER_API_KEY,
  parlayBookmakers: (process.env.PARLAY_BOOKMAKERS ?? "bovada")
    .split(",")
    .map((book) => book.trim())
    .filter(Boolean),
  parlayMlbBookmakers: (process.env.PARLAY_MLB_BOOKMAKERS ?? "")
    .split(",")
    .map((book) => book.trim())
    .filter(Boolean),
  adminUsernames: (process.env.ADMIN_USERNAMES ?? "nathanielrakel@gmail.com")
    .split(",")
    .map((username) => username.trim().toLowerCase())
    .filter(Boolean),
  redditClientId: process.env.REDDIT_CLIENT_ID,
  redditClientSecret: process.env.REDDIT_CLIENT_SECRET,
  redditUserAgent: process.env.REDDIT_USER_AGENT ?? "StakeWars/0.1 by nrakel",
  redditDefaultSubreddits: (process.env.REDDIT_DEFAULT_SUBREDDITS ?? "")
    .split(",")
    .map((subreddit) => subreddit.trim().replace(/^r\//i, ""))
    .filter(Boolean),
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL ?? "gpt-5.4-nano",
  vapidSubject: process.env.VAPID_SUBJECT ?? `mailto:admin@${new URL(process.env.PUBLIC_ORIGIN ?? "http://localhost:3000").hostname}`,
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY
};
