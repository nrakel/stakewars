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
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? process.env.PUBLIC_ORIGINS ?? [
    process.env.PUBLIC_ORIGIN,
    process.env.REFERRAL_PUBLIC_ORIGIN,
    "https://stakewars.ai",
    "https://www.stakewars.ai",
    "https://stakewars.phisystems.ai"
  ].filter(Boolean).join(","))
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  referralPublicOrigin: process.env.REFERRAL_PUBLIC_ORIGIN ?? process.env.PUBLIC_ORIGIN ?? "http://localhost:3000",
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
  redditDefaultSubreddits: (process.env.REDDIT_DEFAULT_SUBREDDITS ?? "")
    .split(",")
    .map((subreddit) => subreddit.trim().replace(/^r\//i, ""))
    .filter(Boolean),
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL ?? "gpt-5.4-nano",
  vapidSubject: process.env.VAPID_SUBJECT ?? `mailto:admin@${new URL(process.env.PUBLIC_ORIGIN ?? "http://localhost:3000").hostname}`,
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
  sesRegion: process.env.SES_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
  sesAccessKeyId: process.env.SES_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID,
  sesSecretAccessKey: process.env.SES_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY,
  sesSessionToken: process.env.SES_SESSION_TOKEN ?? process.env.AWS_SESSION_TOKEN,
  sesFromEmail: process.env.SES_FROM_EMAIL,
  sesFromName: process.env.SES_FROM_NAME ?? "StakeWars"
};
