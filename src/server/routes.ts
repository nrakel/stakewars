import { randomBytes, randomUUID } from "node:crypto";
import type { Router } from "express";
import { z } from "zod";
import { hashPassword, optionalAuth, passwordSchema, requireAuth, signToken, usernameSchema, verifyPassword } from "./auth.js";
import { currentWeekStart, ensureWeeklyEntry, estimatePayoutCents, roundRobinPayoutCents, roundRobinWays } from "./betting.js";
import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { getLiveMlbStates, getLiveStates } from "./live.js";
import { getPushPreferences, getVapidPublicKey, savePushSubscription, sendPushToUsers, sendTestPush, updatePushPreferences } from "./push.js";
import { sendMail } from "./mail.js";
import { buildRedditParlayPreview, buildRedditPreview, lockRedditPostTracking } from "./reddit.js";
import { getVisitorMetrics } from "./visitorMetrics.js";
import { getChineModelAudit } from "./modelAudit.js";
import type { MarketKey, SportKey } from "../shared/types.js";

const registerSchema = z.object({
  username: usernameSchema,
  email: z.string().trim().email().max(254),
  password: passwordSchema,
  displayName: z.string().trim().min(2).max(40).regex(/^[^\x00-\x1F\x7F]+$/u, "Display name cannot contain control characters"),
  referralCode: z.string().trim().regex(/^[a-zA-Z0-9_-]{6,64}$/).optional()
});

const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1)
});

const resendVerificationSchema = z.object({
  userId: z.string().uuid()
});

const emailChangeRecoverySchema = z.object({
  token: z.string().trim().min(40).max(200),
  password: passwordSchema
});

const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).nullable(),
  email: z.string().trim().email().max(254).nullable(),
  allowEmailChange: z.boolean().default(false),
  displayName: z.string().trim().min(2).max(40).regex(/^[^\x00-\x1F\x7F]+$/u, "Display name cannot contain control characters").nullable(),
  payoutMethod: z.enum(["none", "paypal", "venmo"]),
  payoutHandle: z.string().trim().min(2).max(120).nullable(),
  phoneLast4: z.string().trim().regex(/^[0-9]{4}$/, "Phone last 4 must be exactly 4 digits").nullable()
}).superRefine((input, ctx) => {
  if (input.payoutMethod !== "none" && !input.payoutHandle) {
    ctx.addIssue({
      code: "custom",
      path: ["payoutHandle"],
      message: "Payout handle is required for PayPal or Venmo"
    });
  }
});

const placeWagerSchema = z.object({
  kind: z.enum(["straight", "parlay", "round_robin"]),
  stakeCents: z.number().int().positive().max(100_000_000),
  roundRobinMaxLegs: z.number().int().min(2).max(8).optional(),
  acceptLineMoves: z.boolean().default(false),
  legs: z.array(
    z.object({
      gameLineId: z.string().uuid(),
      selectedTeam: z.string().min(1).max(120),
      expectedSpread: z.string().max(40).optional(),
      expectedOddsAmerican: z.number().int().optional()
    })
  ).min(1).max(8)
});

const redditPreviewSchema = z.object({
  subreddit: z.string().trim().min(1).max(50).optional(),
  postType: z.enum(["single", "parlay"]).default("single")
});

const redditLockSchema = z.object({
  postType: z.enum(["single", "parlay"]).default("single"),
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(10_000)
});

const optionalDateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

const weeklyPrizeSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Week start must be YYYY-MM-DD"),
  cashPrizeCents: z.number().int().min(0).max(100_000_000),
  firstPlaceBonus: z.string().trim().max(240).nullable().optional()
});

type WagerLineRow = {
  id: string;
  sport: SportKey;
  starts_at: Date;
  home_team: string;
  away_team: string;
  favorite_team: string;
  spread: string;
  odds_american: number;
  market_key: MarketKey;
  is_active: boolean;
};

const generateReferralCode = () => randomBytes(9).toString("base64url").toLowerCase();

const createUniqueReferralCode = async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateReferralCode();
    const existing = await query("SELECT 1 FROM app_user WHERE referral_code = $1 LIMIT 1", [code]);
    if (!existing.rowCount) {
      return code;
    }
  }
  return randomUUID().replace(/-/g, "").slice(0, 16);
};

const htmlEscape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const publicAppOrigin = () => (config.referralPublicOrigin || config.publicOrigin).replace(/\/+$/, "");

const createVerificationToken = async (userId: string, email: string) => {
  const tokenSecret = randomBytes(32).toString("base64url");
  const tokenHash = await hashPassword(tokenSecret);
  await transaction(async (client) => {
    await client.query(
      "UPDATE email_verification_code SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
      [userId]
    );
    await client.query(
      `
        INSERT INTO email_verification_code (id, user_id, email, code_hash, expires_at)
        VALUES ($1, $2, $3, $4, now() + interval '24 hours')
      `,
      [randomUUID(), userId, email, tokenHash]
    );
  });
  return `${userId}.${tokenSecret}`;
};

const createEmailChangeRecoveryToken = async (userId: string, oldEmail: string, newEmail: string) => {
  const tokenSecret = randomBytes(32).toString("base64url");
  const tokenHash = await hashPassword(tokenSecret);
  await transaction(async (client) => {
    await client.query(
      "UPDATE email_change_recovery SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
      [userId]
    );
    await client.query(
      `
        INSERT INTO email_change_recovery (id, user_id, old_email, new_email, token_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')
      `,
      [randomUUID(), userId, oldEmail, newEmail, tokenHash]
    );
  });
  return `${userId}.${tokenSecret}`;
};

const consumeEmailChangeRecoveryTokens = async (userId: string) => {
  await query(
    "UPDATE email_change_recovery SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
    [userId]
  );
};

const welcomeText = (verifyUrl: string) => [
  "Hey there!",
  "",
  "Welcome to StakeWars! 🎉",
  "",
  "You're officially part of the competition.",
  "",
  "Every week, you'll battle other players—and Chine, our autonomous AI picking games daily—for leaderboard bragging rights and real rewards.",
  "",
  "Before you can claim prizes, we need to verify that this email address belongs to you.",
  "",
  "Click the link below to verify your email:",
  "",
  verifyUrl,
  "",
  "---",
  "",
  "Why verify?",
  "",
  "Verifying your email helps us:",
  "",
  "* Secure your account",
  "* Send important account notifications",
  "* Confirm your eligibility for cash prizes and other rewards",
  "",
  "Unverified accounts can still browse the site, but you must verify your email before you're eligible to receive prizes.",
  "",
  "---",
  "",
  "Ready to compete?",
  "",
  "Once you're verified, you'll be able to:",
  "",
  "🏆 Climb the weekly leaderboard",
  "🤖 Try to Beat Chine, our autonomous AI competitor",
  "💵 Compete for cash prizes and special rewards",
  "🎟️ Win exclusive giveaways and event prizes",
  "",
  "The StakeWars are heating up—we're excited to have you with us!",
  "",
  "See you on the leaderboard,",
  "",
  "The StakeWars Team",
  "",
  "https://stakewars.ai",
  "",
  "---",
  "",
  "If you didn't create a StakeWars account, you can safely ignore this email."
].join("\n");

const welcomeHtml = (verifyUrl: string) => {
  const escapedUrl = htmlEscape(verifyUrl);
  return [
    "<div style=\"font-family:Arial,Helvetica,sans-serif;line-height:1.55;color:#171717;max-width:640px;margin:0 auto;\">",
    "<p>Hey there!</p>",
    "<p>Welcome to <strong>StakeWars</strong>! 🎉</p>",
    "<p>You're officially part of the competition.</p>",
    "<p>Every week, you'll battle other players—and <strong>Chine</strong>, our autonomous AI picking games daily—for leaderboard bragging rights and real rewards.</p>",
    "<p>Before you can claim prizes, we need to verify that this email address belongs to you.</p>",
    "<p><strong>Click the button below to verify your email:</strong></p>",
    `<p><a href="${escapedUrl}" style="display:inline-block;background:#f97316;color:#111827;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:6px;">Verify Email</a></p>`,
    "<p>Or copy and paste this link into your browser:</p>",
    `<p><a href="${escapedUrl}">${escapedUrl}</a></p>`,
    "<hr />",
    "<h3>Why verify?</h3>",
    "<p>Verifying your email helps us:</p>",
    "<ul>",
    "<li>Secure your account</li>",
    "<li>Send important account notifications</li>",
    "<li>Confirm your eligibility for cash prizes and other rewards</li>",
    "</ul>",
    "<p>Unverified accounts can still browse the site, but <strong>you must verify your email before you're eligible to receive prizes.</strong></p>",
    "<hr />",
    "<h3>Ready to compete?</h3>",
    "<p>Once you're verified, you'll be able to:</p>",
    "<p>🏆 Climb the weekly leaderboard</p>",
    "<p>🤖 Try to <strong>Beat Chine</strong>, our autonomous AI competitor</p>",
    "<p>💵 Compete for cash prizes and special rewards</p>",
    "<p>🎟️ Win exclusive giveaways and event prizes</p>",
    "<p>The StakeWars are heating up—we're excited to have you with us!</p>",
    "<p>See you on the leaderboard,</p>",
    "<p><strong>The StakeWars Team</strong></p>",
    "<p><a href=\"https://stakewars.ai\">https://stakewars.ai</a></p>",
    "<hr />",
    "<p><small>If you didn't create a StakeWars account, you can safely ignore this email.</small></p>",
    "</div>"
  ].join("");
};

const sendVerificationLinkWithToken = async (userId: string, email: string, token: string, welcome = false) => {
  const verifyUrl = `${publicAppOrigin()}/?verifyEmail=${encodeURIComponent(token)}`;
  const result = await sendMail({
    to: [{ email }],
    subject: welcome ? "Welcome to StakeWars - verify your email" : "Verify your StakeWars email",
    text: welcome ? welcomeText(verifyUrl) : [
      "Verify your StakeWars email by opening this link:",
      "",
      verifyUrl,
      "",
      "This link expires in 24 hours. If you did not request this email, you can ignore it."
    ].join("\n"),
    html: welcome ? welcomeHtml(verifyUrl) : [
      "<p>Verify your StakeWars email by clicking the button below:</p>",
      `<p><a href="${htmlEscape(verifyUrl)}" style="display:inline-block;background:#f97316;color:#111827;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:6px;">Verify Email</a></p>`,
      `<p>Or copy and paste this link into your browser:<br /><a href="${htmlEscape(verifyUrl)}">${htmlEscape(verifyUrl)}</a></p>`,
      "<p>This link expires in 24 hours. If you did not request this email, you can ignore it.</p>"
    ].join("")
  });
  console.info("Email verification link sent", {
    userId,
    email,
    accepted: result.accepted
  });
};

const sendVerificationLink = async (userId: string, email: string, welcome = false) => {
  const token = await createVerificationToken(userId, email);
  await sendVerificationLinkWithToken(userId, email, token, welcome);
};

const sendEmailChangeRecoveryNoticeWithToken = async (userId: string, oldEmail: string, newEmail: string, token: string) => {
  const recoveryUrl = `${publicAppOrigin()}/?emailRecovery=${encodeURIComponent(token)}`;
  const result = await sendMail({
    to: [{ email: oldEmail }],
    subject: "StakeWars email change requested",
    text: [
      "A request was made to change the email address on your StakeWars account.",
      "",
      `Original email: ${oldEmail}`,
      `New email: ${newEmail}`,
      "",
      "If this was you, no action is needed.",
      "",
      "If this was not you, use the recovery link below within 24 hours. You will be required to set a new password, the original email will remain verified, and the new email change will be discarded.",
      "",
      recoveryUrl,
      "",
      "If you do not use this link within 24 hours, it will expire."
    ].join("\n"),
    html: [
      "<p>A request was made to change the email address on your StakeWars account.</p>",
      `<p><strong>Original email:</strong> ${htmlEscape(oldEmail)}<br /><strong>New email:</strong> ${htmlEscape(newEmail)}</p>`,
      "<p>If this was you, no action is needed.</p>",
      "<p>If this was not you, use the recovery link below within 24 hours. You will be required to set a new password, the original email will remain verified, and the new email change will be discarded.</p>",
      `<p><a href="${htmlEscape(recoveryUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:6px;">This was not me</a></p>`,
      `<p>Or copy and paste this link into your browser:<br /><a href="${htmlEscape(recoveryUrl)}">${htmlEscape(recoveryUrl)}</a></p>`,
      "<p><small>If you do not use this link within 24 hours, it will expire.</small></p>"
    ].join("")
  });
  console.info("Email change recovery notice sent", {
    userId,
    oldEmail,
    newEmail,
    accepted: result.accepted
  });
};

const sendEmailChangeRecoveryNotice = async (userId: string, oldEmail: string, newEmail: string) => {
  const token = await createEmailChangeRecoveryToken(userId, oldEmail, newEmail);
  await sendEmailChangeRecoveryNoticeWithToken(userId, oldEmail, newEmail, token);
};

const sessionUserSelect = `
  id,
  username,
  full_name AS "fullName",
  email,
  email_verified AS "emailVerified",
  display_name AS "displayName",
  reward_balance_cents AS "rewardBalanceCents",
  payout_method AS "payoutMethod",
  payout_handle AS "payoutHandle",
  phone_last4 AS "phoneLast4",
  role
`;

const verifyEmailSecret = async (userId: string, secret: string) => {
  const pending = await query<{
    id: string;
    email: string;
    codeHash: string;
    attempts: number;
  }>(
    `
      SELECT id, email, code_hash AS "codeHash", attempts
      FROM email_verification_code
      WHERE user_id = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId]
  );
  const record = pending.rows[0];
  if (!record || record.attempts >= 5) {
    return null;
  }

  const valid = await verifyPassword(secret, record.codeHash);
  if (!valid) {
    await query(
      "UPDATE email_verification_code SET attempts = attempts + 1 WHERE id = $1",
      [record.id]
    );
    return null;
  }

  const result = await transaction(async (client) => {
    await client.query(
      "UPDATE email_verification_code SET consumed_at = now() WHERE id = $1",
      [record.id]
    );
    return client.query(
      `
        UPDATE app_user
        SET email = $2,
            email_verified = true,
            email_verified_at = now()
        WHERE id = $1
        RETURNING ${sessionUserSelect}
      `,
      [userId, record.email]
    );
  });
  return result.rows[0] ?? null;
};

const verifyEmailToken = async (token: string) => {
  const [userId, tokenSecret] = token.split(".", 2);
  if (!userId || !tokenSecret || !z.string().uuid().safeParse(userId).success || tokenSecret.length < 32) {
    return null;
  }
  return verifyEmailSecret(userId, tokenSecret);
};

const recoverEmailChange = async (token: string, password: string) => {
  const [userId, tokenSecret] = token.split(".", 2);
  if (!userId || !tokenSecret || !z.string().uuid().safeParse(userId).success || tokenSecret.length < 32) {
    return null;
  }

  const pending = await query<{
    id: string;
    oldEmail: string;
    tokenHash: string;
  }>(
    `
      SELECT id, old_email AS "oldEmail", token_hash AS "tokenHash"
      FROM email_change_recovery
      WHERE user_id = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId]
  );
  const record = pending.rows[0];
  if (!record || !(await verifyPassword(tokenSecret, record.tokenHash))) {
    return null;
  }

  const passwordHash = await hashPassword(password);
  const result = await transaction(async (client) => {
    await client.query(
      "UPDATE email_change_recovery SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
      [userId]
    );
    await client.query(
      "UPDATE email_verification_code SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
      [userId]
    );
    return client.query(
      `
        UPDATE app_user
        SET email = $2,
            email_verified = true,
            email_verified_at = now(),
            password_hash = $3
        WHERE id = $1
        RETURNING ${sessionUserSelect}
      `,
      [userId, record.oldEmail, passwordHash]
    );
  });
  return result.rows[0] ?? null;
};

type LineMove = {
  oldGameLineId: string;
  newGameLineId: string;
  game: string;
  selectedTeam: string;
  marketKey: MarketKey;
  oldSpread: string;
  newSpread: string;
  oldOddsAmerican: number;
  newOddsAmerican: number;
};

class LineMoveError extends Error {
  body: {
    error: string;
    code: "LINE_MOVED";
    lineMoves: LineMove[];
  };

  constructor(lineMoves: LineMove[]) {
    super("Line changed");
    this.body = {
      error: "One or more selected lines have changed",
      code: "LINE_MOVED",
      lineMoves
    };
  }
}

const wagerMarketLabel = (marketKey: MarketKey) => {
  if (marketKey === "h2h") return "moneyline";
  if (marketKey === "totals") return "total";
  return "spread/run line";
};

const unavailableLineMessage = (line: WagerLineRow) =>
  `${line.away_team} @ ${line.home_team} ${line.favorite_team} ${wagerMarketLabel(line.market_key)} is no longer available`;

const sameGameKey = (line: Pick<WagerLineRow, "sport" | "away_team" | "home_team" | "starts_at">) =>
  `${line.sport}:${line.away_team}:${line.home_team}:${line.starts_at.toISOString()}`;

const historyQuerySchema = z.object({
  period: z.enum(["day", "week", "all"]).default("week"),
  includeAi: z.enum(["true", "false"]).default("false")
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  })
});

const pushPreferencesSchema = z.object({
  gameReminderEnabled: z.boolean(),
  gameStartedEnabled: z.boolean(),
  scoreChangeEnabled: z.boolean(),
  gameFinalEnabled: z.boolean()
});

const supportCategorySchema = z.enum([
  "account_email",
  "rewards_eligibility",
  "picks_scoring",
  "technical_problem",
  "other"
]);

const supportConversationSchema = z.object({
  category: supportCategorySchema,
  message: z.string().trim().min(1).max(2000).optional()
});

const supportMessageSchema = z.object({
  body: z.string().trim().min(1).max(2000)
});

const supportStatusSchema = z.object({
  status: z.enum(["open", "closed"]),
  sendTranscript: z.boolean().default(false)
});

const isAdminUser = (user: Express.Request["user"]) => Boolean(
  user
  && (user.role === "admin" || config.adminUsernames.includes(user.username.toLowerCase()))
);

const isNateRakelAccount = (user: Express.Request["user"]) => Boolean(
  user && user.username.toLowerCase() === "nathanielrakel@gmail.com"
);

const requireAdmin = (req: Parameters<typeof requireAuth>[0], res: Parameters<typeof requireAuth>[1], next: Parameters<typeof requireAuth>[2]) => {
  requireAuth(req, res, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    if (!isAdminUser(req.user)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  });
};

const requireNateRakelAccount = (
  req: Parameters<typeof requireAuth>[0],
  res: Parameters<typeof requireAuth>[1],
  next: Parameters<typeof requireAuth>[2]
) => {
  requireAuth(req, res, (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }
    if (!isNateRakelAccount(req.user)) {
      res.status(403).json({ error: "Nate Rakel account required" });
      return;
    }
    next();
  });
};

const logAdminAction = async (
  req: Parameters<typeof requireAuth>[0],
  action: string,
  metadata: Record<string, unknown> = {}
) => {
  try {
    await query(
      `
        INSERT INTO admin_audit_log (id, user_id, action, metadata, ip_address, user_agent)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      `,
      [
        randomUUID(),
        req.user?.id ?? null,
        action,
        JSON.stringify(metadata),
        req.ip,
        req.header("user-agent") ?? null
      ]
    );
  } catch (error) {
    console.error("Admin audit log failed", error);
  }
};

const supportCategoryLabel = (category: z.infer<typeof supportCategorySchema>) => {
  switch (category) {
    case "account_email": return "Account or email issue";
    case "rewards_eligibility": return "Rewards or eligibility";
    case "picks_scoring": return "Picks or scoring";
    case "technical_problem": return "Report a technical problem";
    case "other": return "Something else";
  }
};

const notifyNateOfSupportChat = async ({
  conversationId,
  displayName,
  username,
  category
}: {
  conversationId: string;
  displayName: string | null;
  username: string;
  category: z.infer<typeof supportCategorySchema>;
}) => {
  const result = await query<{ id: string }>(
    "SELECT id FROM app_user WHERE lower(username) = 'nathanielrakel@gmail.com' LIMIT 1"
  );
  const nateId = result.rows[0]?.id;
  if (!nateId) return;
  await sendPushToUsers([nateId], {
    title: "Live support chat opened",
    body: `${displayName || username} opened: ${supportCategoryLabel(category)}`,
    url: `/?page=admin&adminTab=support&conversation=${conversationId}`,
    tag: `support-chat:${conversationId}`,
    renotify: true,
    urgency: "high"
  });
};

const sendSupportTranscript = async (conversationId: string) => {
  const conversation = await query<{
    category: z.infer<typeof supportCategorySchema>;
    username: string;
    displayName: string | null;
    email: string | null;
    emailVerified: boolean;
  }>(
    `
      SELECT
        c.category,
        u.username,
        u.display_name AS "displayName",
        u.email,
        u.email_verified AS "emailVerified"
      FROM support_conversation c
      JOIN app_user u ON u.id = c.user_id
      WHERE c.id = $1
    `,
    [conversationId]
  );
  const target = conversation.rows[0];
  if (!target?.email || !target.emailVerified) {
    throw new Error("Conversation owner does not have a verified email address.");
  }
  const messages = await query<{
    senderRole: "user" | "admin";
    body: string;
    createdAt: string;
  }>(
    `
      SELECT sender_role AS "senderRole", body, created_at AS "createdAt"
      FROM support_message
      WHERE conversation_id = $1
      ORDER BY created_at ASC
    `,
    [conversationId]
  );
  const lines = [
    "StakeWars support chat transcript",
    "",
    `Topic: ${supportCategoryLabel(target.category)}`,
    `User: ${target.displayName || target.username}`,
    "",
    ...messages.rows.flatMap((message) => [
      `[${new Date(message.createdAt).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT] ${message.senderRole === "admin" ? "StakeWars Support" : target.displayName || target.username}:`,
      message.body,
      ""
    ])
  ];
  const htmlLines = messages.rows.map((message) => [
    `<p><strong>${message.senderRole === "admin" ? "StakeWars Support" : htmlEscape(target.displayName || target.username)}</strong>`,
    `<br /><small>${htmlEscape(new Date(message.createdAt).toLocaleString("en-US", { timeZone: "America/Chicago" }))} CT</small>`,
    `<br />${htmlEscape(message.body).replace(/\n/g, "<br />")}</p>`
  ].join(""));
  await sendMail({
    to: [{ email: target.email, name: target.displayName ?? undefined }],
    subject: "StakeWars support chat transcript",
    text: lines.join("\n"),
    html: [
      "<h2>StakeWars support chat transcript</h2>",
      `<p><strong>Topic:</strong> ${htmlEscape(supportCategoryLabel(target.category))}</p>`,
      ...htmlLines
    ].join("")
  });
};

export const registerRoutes = (router: Router) => {
  router.post("/auth/register", async (req, res, next) => {
    try {
      const input = registerSchema.parse(req.body);
      const passwordHash = await hashPassword(input.password);
      const referralCode = await createUniqueReferralCode();
      const referrer = input.referralCode
        ? await query<{ id: string }>(
          "SELECT id FROM app_user WHERE referral_code = lower($1) LIMIT 1",
          [input.referralCode]
        )
        : null;
      const result = await query<{
        id: string;
        username: string;
        fullName: string | null;
        email: string | null;
        emailVerified: boolean;
        displayName: string | null;
        rewardBalanceCents: number;
        payoutMethod: "none";
        payoutHandle: string | null;
        phoneLast4: string | null;
        role: "player";
      }>(
        `
          INSERT INTO app_user (id, username, email, email_verified, password_hash, display_name, referral_code, referred_by_user_id)
          VALUES ($1, $2, $3, false, $4, $5, $6, $7)
          RETURNING ${sessionUserSelect}
        `,
        [randomUUID(), input.username, input.email, passwordHash, input.displayName, referralCode, referrer?.rows[0]?.id ?? null]
      );
      let emailVerificationSent = true;
      try {
        await sendVerificationLink(result.rows[0].id, input.email, true);
      } catch (error) {
        emailVerificationSent = false;
        console.error("Registration verification email failed; allowing unverified account login", {
          userId: result.rows[0].id,
          email: input.email,
          error
        });
      }
      const sessionUser = result.rows[0];
      res.status(201).json({
        token: signToken(sessionUser),
        user: sessionUser,
        emailVerificationSent,
        verificationRequired: !sessionUser.emailVerified
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const constraint = (error as { constraint?: string }).constraint;
        res.status(409).json({
          error: constraint === "app_user_display_name_unique_lower_idx"
            ? "Display name is already taken"
            : constraint === "app_user_email_unique_lower_idx"
              ? "Email is already registered"
            : "Username is already taken"
        });
        return;
      }
      next(error);
    }
  });

  router.post("/auth/login", async (req, res, next) => {
    try {
      const input = loginSchema.parse(req.body);
      const result = await query<{
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
        password_hash: string;
        role: "player" | "admin" | "system";
      }>(
        `
          SELECT
            id,
            username,
            full_name AS "fullName",
            email,
            email_verified AS "emailVerified",
            display_name AS "displayName",
            reward_balance_cents AS "rewardBalanceCents",
            payout_method AS "payoutMethod",
            payout_handle AS "payoutHandle",
            phone_last4 AS "phoneLast4",
            password_hash,
            role
          FROM app_user
          WHERE lower(username) = lower($1)
          ORDER BY created_at ASC
          LIMIT 1
        `,
        [input.username]
      );
      const user = result.rows[0];
      if (!user || !(await verifyPassword(input.password, user.password_hash))) {
        res.status(401).json({ error: "Invalid username or password" });
        return;
      }
      const sessionUser = {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        emailVerified: user.emailVerified,
        displayName: user.displayName,
        rewardBalanceCents: user.rewardBalanceCents,
        payoutMethod: user.payoutMethod,
        payoutHandle: user.payoutHandle,
        phoneLast4: user.phoneLast4,
        role: user.role
      };
      let emailVerificationSent = false;
      if (!user.emailVerified && user.email) {
        try {
          await sendVerificationLink(user.id, user.email);
          emailVerificationSent = true;
        } catch (error) {
          console.error("Login verification email failed; allowing unverified account login", {
            userId: user.id,
            email: user.email,
            error
          });
        }
      }
      res.json({
        token: signToken(sessionUser),
        user: sessionUser,
        emailVerificationSent,
        verificationRequired: !sessionUser.emailVerified && Boolean(sessionUser.email)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/auth/verify-email-link", async (req, res, next) => {
    try {
      const token = typeof req.query.token === "string" ? req.query.token : "";
      const user = await verifyEmailToken(token);
      const redirectUrl = new URL(publicAppOrigin());
      if (!user) {
        redirectUrl.searchParams.set("emailVerified", "failed");
        res.redirect(302, redirectUrl.toString());
        return;
      }
      redirectUrl.searchParams.set("emailVerified", "success");
      redirectUrl.searchParams.set("authToken", signToken(user));
      res.redirect(302, redirectUrl.toString());
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/verify-email-link", async (req, res, next) => {
    try {
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      const user = await verifyEmailToken(token);
      if (!user) {
        res.status(400).json({ error: "Invalid or expired verification link" });
        return;
      }
      res.json({ token: signToken(user), user });
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/recover-email-change", async (req, res, next) => {
    try {
      const input = emailChangeRecoverySchema.parse(req.body);
      const user = await recoverEmailChange(input.token, input.password);
      if (!user) {
        res.status(400).json({ error: "Invalid or expired recovery link" });
        return;
      }
      res.json({ token: signToken(user), user });
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/resend-verification", async (req, res, next) => {
    try {
      const input = resendVerificationSchema.parse(req.body);
      const result = await query<{ id: string; email: string | null; emailVerified: boolean }>(
        `
          SELECT id, email, email_verified AS "emailVerified"
          FROM app_user
          WHERE id = $1
        `,
        [input.userId]
      );
      const user = result.rows[0];
      if (!user || !user.email) {
        res.status(404).json({ error: "Verification account not found" });
        return;
      }
      if (user.emailVerified) {
        res.json({ alreadyVerified: true });
        return;
      }
      await sendVerificationLink(user.id, user.email);
      res.json({ sent: true, email: user.email });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", requireAuth, async (req, res, next) => {
    try {
      const entry = await transaction((client) => ensureWeeklyEntry(client, req.user!.id));
      res.json({ user: req.user, bankroll: entry });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me/referral", requireAuth, async (req, res, next) => {
    try {
      const result = await query<{ referralCode: string; referredCount: string }>(
        `
          SELECT
            referral_code AS "referralCode",
            (
              SELECT count(*)::text
              FROM app_user referred
              WHERE referred.referred_by_user_id = app_user.id
            ) AS "referredCount"
          FROM app_user
          WHERE id = $1
        `,
        [req.user!.id]
      );
      const row = result.rows[0];
      if (!row) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const origin = config.referralPublicOrigin.replace(/\/+$/, "");
      res.json({
        referralCode: row.referralCode,
        referralUrl: `${origin}/?ref=${encodeURIComponent(row.referralCode)}`,
        referredCount: Number(row.referredCount)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/push/public-key", requireAuth, async (_req, res, next) => {
    try {
      res.json({ publicKey: getVapidPublicKey() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/push/subscribe", requireAuth, async (req, res, next) => {
    try {
      const subscription = pushSubscriptionSchema.parse(req.body);
      await savePushSubscription({
        userId: req.user!.id,
        subscription,
        userAgent: req.header("user-agent") ?? undefined
      });
      res.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/push/test", requireAuth, async (req, res, next) => {
    try {
      const result = await sendTestPush(req.user!.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/push/preferences", requireAuth, async (req, res, next) => {
    try {
      const preferences = await getPushPreferences(req.user!.id);
      res.json({ preferences });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/push/preferences", requireAuth, async (req, res, next) => {
    try {
      const input = pushPreferencesSchema.parse(req.body);
      const preferences = await updatePushPreferences(req.user!.id, input);
      res.json({ preferences });
    } catch (error) {
      next(error);
    }
  });

  router.post("/support/conversations", requireAuth, async (req, res, next) => {
    try {
      if (!req.user!.emailVerified) {
        res.status(403).json({ error: "Verify your email address before starting a support chat." });
        return;
      }
      const input = supportConversationSchema.parse(req.body);
      const conversationId = randomUUID();
      const messageBody = input.message?.trim()
        || `Support topic selected: ${supportCategoryLabel(input.category)}`;
      const result = await transaction(async (client) => {
        await client.query(
          `
            INSERT INTO support_conversation (id, user_id, category)
            VALUES ($1, $2, $3)
          `,
          [conversationId, req.user!.id, input.category]
        );
        await client.query(
          `
            INSERT INTO support_message (id, conversation_id, sender_user_id, sender_role, body)
            VALUES ($1, $2, $3, 'user', $4)
          `,
          [randomUUID(), conversationId, req.user!.id, messageBody]
        );
        return client.query<{
          id: string;
          category: z.infer<typeof supportCategorySchema>;
          status: "open" | "closed";
          createdAt: string;
          updatedAt: string;
        }>(
          `
            SELECT
              id,
              category,
              status,
              created_at AS "createdAt",
              updated_at AS "updatedAt"
            FROM support_conversation
            WHERE id = $1
          `,
          [conversationId]
        );
      });
      await notifyNateOfSupportChat({
        conversationId,
        displayName: req.user!.displayName,
        username: req.user!.username,
        category: input.category
      }).catch((error) => console.error("Support chat push failed", error));
      res.status(201).json({ conversation: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get("/support/conversations", requireAuth, async (req, res, next) => {
    try {
      const result = await query(
        `
          SELECT
            c.id,
            c.category,
            c.status,
            c.created_at AS "createdAt",
            c.updated_at AS "updatedAt",
            (
              SELECT body
              FROM support_message sm
              WHERE sm.conversation_id = c.id
              ORDER BY sm.created_at DESC
              LIMIT 1
            ) AS "lastMessage"
          FROM support_conversation c
          WHERE c.user_id = $1
          ORDER BY c.updated_at DESC
          LIMIT 20
        `,
        [req.user!.id]
      );
      res.json({ conversations: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/support/conversations/:id", requireAuth, async (req, res, next) => {
    try {
      const conversation = await query(
        `
          SELECT id, category, status, created_at AS "createdAt", updated_at AS "updatedAt"
          FROM support_conversation
          WHERE id = $1 AND user_id = $2
        `,
        [req.params.id, req.user!.id]
      );
      if (!conversation.rows[0]) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      const messages = await query(
        `
          SELECT id, sender_role AS "senderRole", body, created_at AS "createdAt"
          FROM support_message
          WHERE conversation_id = $1
          ORDER BY created_at ASC
        `,
        [req.params.id]
      );
      res.json({ conversation: conversation.rows[0], messages: messages.rows });
    } catch (error) {
      next(error);
    }
  });

  router.post("/support/conversations/:id/messages", requireAuth, async (req, res, next) => {
    try {
      if (!req.user!.emailVerified) {
        res.status(403).json({ error: "Verify your email address before using support chat." });
        return;
      }
      const input = supportMessageSchema.parse(req.body);
      const conversation = await query(
        "SELECT id FROM support_conversation WHERE id = $1 AND user_id = $2 AND status = 'open'",
        [req.params.id, req.user!.id]
      );
      if (!conversation.rows[0]) {
        res.status(404).json({ error: "Open conversation not found" });
        return;
      }
      const result = await transaction(async (client) => {
        const message = await client.query(
          `
            INSERT INTO support_message (id, conversation_id, sender_user_id, sender_role, body)
            VALUES ($1, $2, $3, 'user', $4)
            RETURNING id, sender_role AS "senderRole", body, created_at AS "createdAt"
          `,
          [randomUUID(), req.params.id, req.user!.id, input.body]
        );
        await client.query("UPDATE support_conversation SET updated_at = now() WHERE id = $1", [req.params.id]);
        return message;
      });
      res.status(201).json({ message: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/support/conversations", requireNateRakelAccount, async (req, res, next) => {
    try {
      const status = typeof req.query.status === "string" && req.query.status === "closed" ? "closed" : "open";
      const result = await query(
        `
          SELECT
            c.id,
            c.category,
            c.status,
            c.created_at AS "createdAt",
            c.updated_at AS "updatedAt",
            c.closed_at AS "closedAt",
            u.username,
            u.display_name AS "displayName",
            u.email,
            (
              SELECT body
              FROM support_message sm
              WHERE sm.conversation_id = c.id
              ORDER BY sm.created_at DESC
              LIMIT 1
            ) AS "lastMessage"
          FROM support_conversation c
          JOIN app_user u ON u.id = c.user_id
          WHERE c.status = $1
          ORDER BY c.updated_at DESC
          LIMIT 100
        `,
        [status]
      );
      await logAdminAction(req, "admin.support_conversations.view", { status, rowCount: result.rowCount });
      res.json({ conversations: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/support/conversations/:id", requireNateRakelAccount, async (req, res, next) => {
    try {
      const conversation = await query(
        `
          SELECT
            c.id,
            c.category,
            c.status,
            c.created_at AS "createdAt",
            c.updated_at AS "updatedAt",
            c.closed_at AS "closedAt",
            u.username,
            u.display_name AS "displayName",
            u.email
          FROM support_conversation c
          JOIN app_user u ON u.id = c.user_id
          WHERE c.id = $1
        `,
        [req.params.id]
      );
      if (!conversation.rows[0]) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      const messages = await query(
        `
          SELECT id, sender_role AS "senderRole", body, created_at AS "createdAt"
          FROM support_message
          WHERE conversation_id = $1
          ORDER BY created_at ASC
        `,
        [req.params.id]
      );
      await logAdminAction(req, "admin.support_conversation.view", { conversationId: req.params.id });
      res.json({ conversation: conversation.rows[0], messages: messages.rows });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/support/conversations/:id/messages", requireNateRakelAccount, async (req, res, next) => {
    try {
      const input = supportMessageSchema.parse(req.body);
      const conversation = await query(
        "SELECT id FROM support_conversation WHERE id = $1 AND status = 'open'",
        [req.params.id]
      );
      if (!conversation.rows[0]) {
        res.status(404).json({ error: "Open conversation not found" });
        return;
      }
      const result = await transaction(async (client) => {
        const message = await client.query(
          `
            INSERT INTO support_message (id, conversation_id, sender_user_id, sender_role, body)
            VALUES ($1, $2, $3, 'admin', $4)
            RETURNING id, sender_role AS "senderRole", body, created_at AS "createdAt"
          `,
          [randomUUID(), req.params.id, req.user!.id, input.body]
        );
        await client.query("UPDATE support_conversation SET updated_at = now() WHERE id = $1", [req.params.id]);
        return message;
      });
      await logAdminAction(req, "admin.support_message.create", { conversationId: req.params.id });
      res.status(201).json({ message: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/admin/support/conversations/:id", requireNateRakelAccount, async (req, res, next) => {
    try {
      const input = supportStatusSchema.parse(req.body);
      const conversationId = String(req.params.id);
      const result = await query(
        `
          UPDATE support_conversation
          SET status = $2,
              closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END,
              updated_at = now()
          WHERE id = $1
          RETURNING id, category, status, created_at AS "createdAt", updated_at AS "updatedAt", closed_at AS "closedAt"
        `,
        [conversationId, input.status]
      );
      if (!result.rows[0]) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      let transcriptSent = false;
      if (input.status === "closed" && input.sendTranscript) {
        await sendSupportTranscript(conversationId);
        transcriptSent = true;
      }
      await logAdminAction(req, "admin.support_conversation.status", { conversationId, status: input.status });
      res.json({ conversation: result.rows[0], transcriptSent });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/user-display-map", requireNateRakelAccount, async (req, res, next) => {
    try {
      const result = await query<{
        id: string;
        username: string;
        email: string | null;
        displayName: string | null;
        leaderboardDisplayName: string | null;
        leaderboardRank: number | null;
        fullName: string | null;
        role: "player" | "admin" | "system";
        createdAt: string;
      }>(
        `
          WITH current_week AS (
            SELECT (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date AS week_start
          ),
          wager_profit AS (
            SELECT
              w.weekly_entry_id,
              COALESCE(sum(CASE
                WHEN w.kind = 'round_robin' THEN COALESCE(rr.profit_cents, 0)
                WHEN w.status = 'won' THEN w.potential_payout_cents - w.stake_cents
                WHEN w.status = 'lost' THEN -w.stake_cents
                WHEN w.status IN ('push', 'void') THEN 0
                ELSE 0
              END), 0)::int AS settled_profit_cents
            FROM wager w
            LEFT JOIN (
              SELECT wager_id, sum(profit_cents)::int AS profit_cents
              FROM round_robin_way_settlement
              GROUP BY wager_id
            ) rr ON rr.wager_id = w.id
            GROUP BY w.weekly_entry_id
          ),
          ranked AS (
            SELECT
              u.id,
              (row_number() OVER (
                ORDER BY e.starting_bankroll_cents + COALESCE(wp.settled_profit_cents, 0) DESC, COALESCE(wp.settled_profit_cents, 0) DESC
              ))::int AS rank
            FROM weekly_entry e
            JOIN app_user u ON u.id = e.user_id
            LEFT JOIN wager_profit wp ON wp.weekly_entry_id = e.id
            JOIN current_week cw ON cw.week_start = e.week_starts_on
            WHERE u.role = 'player'
          )
          SELECT
            u.id,
            u.username,
            u.email,
            u.display_name AS "displayName",
            CASE
              WHEN r.rank IS NULL THEN NULL
              ELSE COALESCE(NULLIF(u.display_name, ''), 'Player ' || r.rank::text)
            END AS "leaderboardDisplayName",
            r.rank AS "leaderboardRank",
            u.full_name AS "fullName",
            u.role,
            u.created_at AS "createdAt"
          FROM app_user u
          LEFT JOIN ranked r ON r.id = u.id
          WHERE u.role <> 'system'
          ORDER BY r.rank ASC NULLS LAST, lower(COALESCE(NULLIF(u.display_name, ''), u.username)), lower(u.username)
        `
      );
      await logAdminAction(req, "admin.user_display_map.view", { rowCount: result.rowCount });
      res.json({ users: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/visitors", requireNateRakelAccount, async (req, res, next) => {
    try {
      const metrics = await getVisitorMetrics();
      await logAdminAction(req, "admin.visitors.view", {
        generatedAt: metrics.generatedAt,
        lastUpdatedAt: metrics.lastUpdatedAt
      });
      res.json(metrics);
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/chine-model-audit", requireNateRakelAccount, async (req, res, next) => {
    try {
      const since = optionalDateParam.parse(typeof req.query.since === "string" ? req.query.since : undefined) ?? null;
      const through = optionalDateParam.parse(typeof req.query.through === "string" ? req.query.through : undefined) ?? null;
      const audit = await getChineModelAudit({ since, through });
      await logAdminAction(req, "admin.chine_model_audit.view", {
        since,
        through,
        settledPicks: audit.summary[0]?.picks ?? 0
      });
      res.json(audit);
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/prizes", requireNateRakelAccount, async (req, res, next) => {
    try {
      const current = currentWeekStart();
      const next = new Date(`${current}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 7);
      const nextWeek = next.toISOString().slice(0, 10);
      const result = await query<{
        weekStart: string;
        cashPrizeCents: number;
        firstPlaceBonus: string | null;
        updatedAt: string;
      }>(
        `
          SELECT
            week_starts_on::text AS "weekStart",
            cash_prize_cents AS "cashPrizeCents",
            first_place_bonus AS "firstPlaceBonus",
            updated_at AS "updatedAt"
          FROM weekly_prize
          WHERE week_starts_on >= ($1::date - interval '4 weeks')
          ORDER BY week_starts_on DESC
          LIMIT 12
        `,
        [current]
      );
      await logAdminAction(req, "admin.prizes.view", { rowCount: result.rowCount });
      res.json({ currentWeekStart: current, nextWeekStart: nextWeek, prizes: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.put("/admin/prizes", requireNateRakelAccount, async (req, res, next) => {
    try {
      const input = weeklyPrizeSchema.parse(req.body);
      const week = new Date(`${input.weekStart}T00:00:00Z`);
      if (Number.isNaN(week.getTime()) || week.getUTCDay() !== 1) {
        res.status(400).json({ error: "Week start must be a Monday" });
        return;
      }
      const result = await query<{
        weekStart: string;
        cashPrizeCents: number;
        firstPlaceBonus: string | null;
        updatedAt: string;
      }>(
        `
          INSERT INTO weekly_prize (week_starts_on, cash_prize_cents, first_place_bonus)
          VALUES ($1::date, $2, NULLIF($3, ''))
          ON CONFLICT (week_starts_on) DO UPDATE
          SET cash_prize_cents = EXCLUDED.cash_prize_cents,
              first_place_bonus = EXCLUDED.first_place_bonus,
              updated_at = now()
          RETURNING
            week_starts_on::text AS "weekStart",
            cash_prize_cents AS "cashPrizeCents",
            first_place_bonus AS "firstPlaceBonus",
            updated_at AS "updatedAt"
        `,
        [input.weekStart, input.cashPrizeCents, input.firstPlaceBonus?.trim() ?? null]
      );
      await logAdminAction(req, "admin.prizes.update", {
        weekStart: input.weekStart,
        cashPrizeCents: input.cashPrizeCents,
        hasFirstPlaceBonus: Boolean(input.firstPlaceBonus?.trim())
      });
      res.json({ prize: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/me/profile", requireAuth, async (req, res, next) => {
    try {
      const input = profileSchema.parse(req.body);
      const existing = await query<{ email: string | null; emailVerified: boolean; lastEmailChangeAt: string | null }>(
        "SELECT email, email_verified AS \"emailVerified\", last_email_change_at AS \"lastEmailChangeAt\" FROM app_user WHERE id = $1",
        [req.user!.id]
      );
      const current = existing.rows[0];
      const emailChanged = (current?.email ?? "").trim().toLowerCase() !== (input.email ?? "").trim().toLowerCase();
      if (emailChanged && current?.email) {
        const lastEmailChangeAt = current.lastEmailChangeAt ? new Date(current.lastEmailChangeAt) : null;
        const nextAllowedAt = lastEmailChangeAt ? new Date(lastEmailChangeAt.getTime() + 24 * 60 * 60 * 1000) : null;
        if (nextAllowedAt && nextAllowedAt.getTime() > Date.now()) {
          res.status(429).json({
            error: `Email can only be changed once every 24 hours. Try again after ${nextAllowedAt.toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" })} CT.`,
            retryAt: nextAllowedAt.toISOString()
          });
          return;
        }
      }
      if (current?.emailVerified && emailChanged && !input.allowEmailChange) {
        res.status(409).json({ error: "Verified email is locked. Use Change Email before saving a new address." });
        return;
      }
      const shouldPrepareEmailChange = Boolean(
        current?.emailVerified
        && emailChanged
        && current.email
        && input.email
      );
      if (shouldPrepareEmailChange) {
        await query(
          "UPDATE email_verification_code SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
          [req.user!.id]
        );
        await consumeEmailChangeRecoveryTokens(req.user!.id);
        const newEmailVerificationToken = await createVerificationToken(req.user!.id, input.email!);
        const recoveryToken = await createEmailChangeRecoveryToken(req.user!.id, current!.email!, input.email!);
        try {
          await sendVerificationLinkWithToken(req.user!.id, input.email!, newEmailVerificationToken);
          await sendEmailChangeRecoveryNoticeWithToken(req.user!.id, current!.email!, input.email!, recoveryToken);
        } catch (deliveryError) {
          await query(
            "UPDATE email_verification_code SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL",
            [req.user!.id]
          );
          await consumeEmailChangeRecoveryTokens(req.user!.id);
          console.error("Email change delivery failed", deliveryError);
          res.status(400).json({ error: "Could not send the verification email. Your email was not changed." });
          return;
        }
      }
      const result = await query<{
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
      }>(
        `
          UPDATE app_user
          SET full_name = $2,
              email = $3,
              email_verified = CASE
                WHEN coalesce(lower(trim(email)), '') = coalesce(lower(trim($3::text)), '') THEN email_verified
                ELSE false
              END,
              email_verified_at = CASE
                WHEN coalesce(lower(trim(email)), '') = coalesce(lower(trim($3::text)), '') THEN email_verified_at
                ELSE NULL
              END,
              last_email_change_at = CASE
                WHEN coalesce(trim(email), '') <> ''
                 AND coalesce(lower(trim(email)), '') <> coalesce(lower(trim($3::text)), '') THEN now()
                ELSE last_email_change_at
              END,
              display_name = $4,
              payout_method = $5,
              payout_handle = $6,
              phone_last4 = $7
          WHERE id = $1
          RETURNING ${sessionUserSelect}
        `,
        [
          req.user!.id,
          input.fullName,
          input.email,
          input.displayName,
          input.payoutMethod,
          input.payoutMethod === "none" ? null : input.payoutHandle,
          input.phoneLast4
        ]
      );
      const user = result.rows[0];
      if (!shouldPrepareEmailChange && emailChanged && user.email && !user.emailVerified) {
        await sendVerificationLink(user.id, user.email);
      }
      res.json({ token: signToken(user), user });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const constraint = (error as { constraint?: string }).constraint;
        res.status(409).json({
          error: constraint === "app_user_display_name_unique_lower_idx"
            ? "Display name is already taken"
            : "Profile value is already taken"
        });
        return;
      }
      next(error);
    }
  });

  router.post("/me/email-verification/send", requireAuth, async (req, res, next) => {
    try {
      const result = await query<{ email: string | null; emailVerified: boolean }>(
        "SELECT email, email_verified AS \"emailVerified\" FROM app_user WHERE id = $1",
        [req.user!.id]
      );
      const user = result.rows[0];
      if (!user?.email) {
        res.status(400).json({ error: "Add an email address before requesting a verification link" });
        return;
      }
      if (user.emailVerified) {
        res.json({ alreadyVerified: true });
        return;
      }
      await sendVerificationLink(req.user!.id, user.email);
      res.json({ sent: true, email: user.email });
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/reddit/status", requireAdmin, async (req, res, next) => {
    try {
      res.json({
        configured: true,
        mode: "manual",
        connected: false,
        redditUsername: null,
        connectedAt: null,
        scopes: [],
        defaultSubreddits: config.redditDefaultSubreddits
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/reddit/preview", requireAdmin, async (req, res, next) => {
    try {
      const input = redditPreviewSchema.parse(req.body);
      const preview = input.postType === "parlay"
        ? await buildRedditParlayPreview(input.subreddit)
        : await buildRedditPreview(input.subreddit);
      await logAdminAction(req, "admin.reddit.preview", {
        subreddit: preview.subreddit,
        postType: input.postType,
        titleLength: preview.title.length,
        bodyLength: preview.body.length
      });
      res.json({ preview });
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/reddit/lock", requireAdmin, async (req, res, next) => {
    try {
      const input = redditLockSchema.parse(req.body);
      const result = await lockRedditPostTracking({
        userId: req.user!.id,
        postType: input.postType,
        title: input.title,
        body: input.body
      });
      await logAdminAction(req, "admin.reddit.lock", {
        postType: input.postType,
        trackingId: result.id,
        titleLength: input.title.length,
        bodyLength: input.body.length
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/lines", async (_req, res, next) => {
    try {
      const result = await query<{
        id: string;
        providerEventId: string | null;
        sport: string;
        league: string;
        startsAt: Date;
        homeTeam: string;
        awayTeam: string;
        favoriteTeam: string;
        spread: string;
        oddsAmerican: number;
        marketKey: MarketKey;
        awayProbablePitcherId: number | null;
        awayProbablePitcherName: string | null;
        awayPitcherWins: number | null;
        awayPitcherLosses: number | null;
        awayPitcherEra: number | null;
        homeProbablePitcherId: number | null;
        homeProbablePitcherName: string | null;
        homePitcherWins: number | null;
        homePitcherLosses: number | null;
        homePitcherEra: number | null;
        context: Record<string, unknown> | null;
      }>(
        `
          SELECT
            gl.id,
            gl.provider_event_id AS "providerEventId",
            gl.sport,
            gl.league,
            gl.starts_at AS "startsAt",
            gl.home_team AS "homeTeam",
            gl.away_team AS "awayTeam",
            gl.favorite_team AS "favoriteTeam",
            gl.spread,
            gl.odds_american AS "oddsAmerican",
            gl.market_key AS "marketKey",
            mgc.away_probable_pitcher_id AS "awayProbablePitcherId",
            mgc.away_probable_pitcher_name AS "awayProbablePitcherName",
            NULLIF(mgc.away_pitcher_stats #>> '{season,wins}', '')::numeric AS "awayPitcherWins",
            NULLIF(mgc.away_pitcher_stats #>> '{season,losses}', '')::numeric AS "awayPitcherLosses",
            NULLIF(mgc.away_pitcher_stats #>> '{season,era}', '')::numeric AS "awayPitcherEra",
            mgc.home_probable_pitcher_id AS "homeProbablePitcherId",
            mgc.home_probable_pitcher_name AS "homeProbablePitcherName",
            NULLIF(mgc.home_pitcher_stats #>> '{season,wins}', '')::numeric AS "homePitcherWins",
            NULLIF(mgc.home_pitcher_stats #>> '{season,losses}', '')::numeric AS "homePitcherLosses",
            NULLIF(mgc.home_pitcher_stats #>> '{season,era}', '')::numeric AS "homePitcherEra",
            mgc.context
          FROM game_line gl
          LEFT JOIN LATERAL (
            SELECT *
            FROM mlb_game_context candidate
            WHERE candidate.starts_on = (gl.starts_at AT TIME ZONE 'UTC')::date
              AND regexp_replace(lower(candidate.away_team), '^(oakland|the)\\s+', '') = regexp_replace(lower(gl.away_team), '^(oakland|the)\\s+', '')
              AND regexp_replace(lower(candidate.home_team), '^(oakland|the)\\s+', '') = regexp_replace(lower(gl.home_team), '^(oakland|the)\\s+', '')
              AND abs(extract(epoch from candidate.starts_at - gl.starts_at)) <= 10800
            ORDER BY abs(extract(epoch from candidate.starts_at - gl.starts_at)) ASC
            LIMIT 1
          ) mgc ON true
          WHERE gl.is_active = true AND gl.starts_at > now()
          ORDER BY gl.starts_at ASC
          LIMIT 100
        `
      );
      const lineIds = result.rows.map((row) => row.id);
      const candidateResult = lineIds.length
        ? await query<{
          gameLineId: string;
          selectedTeam: string;
          confidence: number;
          edge: number;
          score: number;
        }>(
          `
            WITH latest AS (
              SELECT id
              FROM ai_model_run
              WHERE sport = 'MLB'
              ORDER BY created_at DESC
              LIMIT 1
            )
            SELECT
              c.game_line_id AS "gameLineId",
              c.selected_team AS "selectedTeam",
              c.confidence,
              c.edge,
              c.score
            FROM ai_pick_candidate c
            JOIN latest ON latest.id = c.run_id
            WHERE c.game_line_id = ANY($1::uuid[])
          `,
          [lineIds]
        )
        : { rows: [] };
      const aiCandidateByLineId = new Map(candidateResult.rows.map((candidate) => [
        candidate.gameLineId,
        {
          selectedTeam: candidate.selectedTeam,
          confidence: Number(candidate.confidence),
          edge: Number(candidate.edge),
          score: Number(candidate.score)
        }
      ]));
      const marketMap = new Map<string, {
        eventKey: string;
        sport: string;
        league: string;
        startsAt: string;
        homeTeam: string;
        awayTeam: string;
        marketKey: MarketKey;
        awayLine: null | { id: string; team: string; spread: string; oddsAmerican: number };
        homeLine: null | { id: string; team: string; spread: string; oddsAmerican: number };
        drawLine: null | { id: string; team: string; spread: string; oddsAmerican: number };
        overLine: null | { id: string; team: string; spread: string; oddsAmerican: number };
        underLine: null | { id: string; team: string; spread: string; oddsAmerican: number };
      }>();

      for (const row of result.rows) {
        const providerEventBase = row.providerEventId?.split(":")[0]?.split("|")[0];
        const eventKey = providerEventBase ?? `${row.sport}:${row.startsAt}:${row.awayTeam}:${row.homeTeam}:${row.marketKey}`;
        const key = `${eventKey}:${row.marketKey}`;
        const market = marketMap.get(key) ?? {
          eventKey,
          sport: row.sport,
          league: row.league,
          startsAt: row.startsAt.toISOString(),
          homeTeam: row.homeTeam,
          awayTeam: row.awayTeam,
          marketKey: row.marketKey,
          awayLine: null,
          homeLine: null,
          drawLine: null,
          overLine: null,
          underLine: null
        };
        const side = { id: row.id, team: row.favoriteTeam, spread: row.spread, oddsAmerican: row.oddsAmerican };
        if (row.favoriteTeam === row.awayTeam) {
          market.awayLine = side;
        }
        if (row.favoriteTeam === row.homeTeam) {
          market.homeLine = side;
        }
        if (row.marketKey === "h2h" && row.favoriteTeam === "Draw") {
          market.drawLine = side;
        }
        if (row.marketKey === "totals" && row.favoriteTeam === "Over") {
          market.overLine = side;
        }
        if (row.marketKey === "totals" && row.favoriteTeam === "Under") {
          market.underLine = side;
        }
        marketMap.set(key, market);
      }

      const markets = [...marketMap.values()]
        .filter((market) =>
          market.marketKey === "totals"
            ? market.overLine && market.underLine
            : market.awayLine && market.homeLine
        )
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      const gameMap = new Map<string, {
        eventKey: string;
        sport: string;
        league: string;
        startsAt: string;
        homeTeam: string;
        awayTeam: string;
        awayProbablePitcher: null | { id: number | null; name: string | null; wins: number | null; losses: number | null; era: number | null };
        homeProbablePitcher: null | { id: number | null; name: string | null; wins: number | null; losses: number | null; era: number | null };
        aiConfidence: null | { selectedTeam: string; confidence: number; edge: number; score: number };
        awayLineup: unknown;
        homeLineup: unknown;
        markets: typeof markets;
      }>();

      for (const market of markets) {
        const sourceRow = result.rows.find((row) => {
          const rowEventKey = row.providerEventId?.split(":")[0]
            ?? `${row.sport}:${row.startsAt}:${row.awayTeam}:${row.homeTeam}:${row.marketKey}`;
          return rowEventKey === market.eventKey;
        });
        const game = gameMap.get(market.eventKey) ?? {
          eventKey: market.eventKey,
          sport: market.sport,
          league: market.league,
          startsAt: market.startsAt,
          homeTeam: market.homeTeam,
          awayTeam: market.awayTeam,
          awayProbablePitcher: sourceRow ? {
            id: sourceRow.awayProbablePitcherId,
            name: sourceRow.awayProbablePitcherName,
            wins: sourceRow.awayPitcherWins === null ? null : Number(sourceRow.awayPitcherWins),
            losses: sourceRow.awayPitcherLosses === null ? null : Number(sourceRow.awayPitcherLosses),
            era: sourceRow.awayPitcherEra === null ? null : Number(sourceRow.awayPitcherEra)
          } : null,
          homeProbablePitcher: sourceRow ? {
            id: sourceRow.homeProbablePitcherId,
            name: sourceRow.homeProbablePitcherName,
            wins: sourceRow.homePitcherWins === null ? null : Number(sourceRow.homePitcherWins),
            losses: sourceRow.homePitcherLosses === null ? null : Number(sourceRow.homePitcherLosses),
            era: sourceRow.homePitcherEra === null ? null : Number(sourceRow.homePitcherEra)
          } : null,
          aiConfidence: null,
          awayLineup: sourceRow?.context?.awayLineup ?? null,
          homeLineup: sourceRow?.context?.homeLineup ?? null,
          markets: []
        };
        game.markets.push(market);
        for (const line of [market.awayLine, market.homeLine, market.drawLine]) {
          const candidate = line ? aiCandidateByLineId.get(line.id) : null;
          if (candidate && (!game.aiConfidence || candidate.confidence > game.aiConfidence.confidence)) {
            game.aiConfidence = candidate;
          }
        }
        gameMap.set(market.eventKey, game);
      }

      const games = [...gameMap.values()]
        .filter((game) =>
          game.sport !== "MLB"
          || game.markets.some((market) => market.marketKey === "h2h" || market.marketKey === "spreads")
        )
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      res.json({ lines: result.rows, markets, games });
    } catch (error) {
      next(error);
    }
  });

  router.get("/leaderboard", optionalAuth, async (req, res, next) => {
    try {
      const requestedWeekStart = typeof req.query.weekStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.weekStart)
        ? req.query.weekStart
        : null;
      const weeks = await query(
        `
          WITH current_week AS (
            SELECT (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date AS week_start
          )
          SELECT
            week_start::text AS "weekStart",
            week_start = (SELECT week_start FROM current_week) AS "isCurrent"
          FROM (
            SELECT week_starts_on AS week_start FROM weekly_entry
            UNION
            SELECT week_starts_on AS week_start FROM weekly_prize
            UNION
            SELECT week_start FROM current_week
          ) weeks
          ORDER BY week_start DESC
        `
      );
      const result = await query(
        `
          WITH current_week AS (
            SELECT (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date AS week_start
          ),
          selected_week AS (
            SELECT COALESCE($2::date, (SELECT week_start FROM current_week)) AS week_start
          ),
          wager_activity AS (
            SELECT
              w.weekly_entry_id,
              count(*)::int AS weekly_wagers,
              coalesce(sum(w.stake_cents), 0)::int AS weekly_stake_cents,
              COALESCE(sum(CASE
                WHEN w.kind = 'round_robin' THEN COALESCE(rr.profit_cents, 0)
                WHEN w.status = 'won' THEN w.potential_payout_cents - w.stake_cents
                WHEN w.status = 'lost' THEN -w.stake_cents
                WHEN w.status IN ('push', 'void') THEN 0
                ELSE 0
              END), 0)::int AS settled_profit_cents
            FROM wager w
            LEFT JOIN (
              SELECT wager_id, sum(profit_cents)::int AS profit_cents
              FROM round_robin_way_settlement
              GROUP BY wager_id
            ) rr ON rr.wager_id = w.id
            GROUP BY w.weekly_entry_id
          ),
          ai AS (
            SELECT e.starting_bankroll_cents
              + CASE
                WHEN sw.week_start = (SELECT week_start FROM current_week)
                THEN COALESCE(wa.settled_profit_cents, e.settled_profit_cents)
                ELSE e.settled_profit_cents
              END AS leaderboard_cents
            FROM weekly_entry e
            JOIN app_user u ON u.id = e.user_id
            LEFT JOIN wager_activity wa ON wa.weekly_entry_id = e.id
            JOIN selected_week sw ON sw.week_start = e.week_starts_on
            WHERE u.username = $1
            LIMIT 1
          ),
          ranked AS (
            SELECT
              u.display_name,
              u.id AS user_id,
              u.role,
              u.email_verified,
              coalesce(wa.weekly_wagers, 0) AS weekly_wagers,
              coalesce(wa.weekly_stake_cents, 0) AS weekly_stake_cents,
              (e.starting_bankroll_cents * 1.5)::int AS required_stake_cents,
              e.starting_bankroll_cents
                + CASE
                  WHEN sw.week_start = (SELECT week_start FROM current_week)
                  THEN COALESCE(wa.settled_profit_cents, e.settled_profit_cents)
                  ELSE e.settled_profit_cents
                END AS leaderboard_cents,
              CASE
                WHEN sw.week_start = (SELECT week_start FROM current_week)
                THEN COALESCE(wa.settled_profit_cents, e.settled_profit_cents)
                ELSE e.settled_profit_cents
              END AS settled_profit_cents
            FROM weekly_entry e
            JOIN app_user u ON u.id = e.user_id
            LEFT JOIN wager_activity wa ON wa.weekly_entry_id = e.id
            JOIN selected_week sw ON sw.week_start = e.week_starts_on
            WHERE u.role IN ('player', 'system')
          )
          SELECT
            (row_number() OVER (ORDER BY leaderboard_cents DESC, settled_profit_cents DESC))::int AS rank,
            CASE
              WHEN role = 'system' THEN COALESCE(NULLIF(display_name, ''), 'StakeWars Chine')
              ELSE COALESCE(NULLIF(display_name, ''), 'Player ' || (row_number() OVER (ORDER BY leaderboard_cents DESC, settled_profit_cents DESC))::text)
            END AS "displayName",
            leaderboard_cents AS "balanceCents",
            settled_profit_cents AS "settledProfitCents",
            role,
            coalesce(user_id = $3::uuid, false) AS "isCurrentUser",
            CASE WHEN user_id = $3::uuid THEN weekly_wagers ELSE NULL END AS "weeklyWagers",
            CASE WHEN user_id = $3::uuid THEN weekly_stake_cents ELSE NULL END AS "weeklyStakeCents",
            CASE WHEN user_id = $3::uuid THEN required_stake_cents ELSE NULL END AS "requiredStakeCents",
            CASE WHEN user_id = $3::uuid THEN email_verified ELSE NULL END AS "emailVerified",
            CASE
              WHEN role = 'system' THEN false
              WHEN (SELECT leaderboard_cents FROM ai) IS NULL THEN false
              ELSE leaderboard_cents > (SELECT leaderboard_cents FROM ai)
            END AS "beatAi",
            CASE
              WHEN role = 'system' THEN false
              WHEN email_verified
                AND weekly_wagers >= 10
                AND weekly_stake_cents >= required_stake_cents
                AND (SELECT leaderboard_cents FROM ai) IS NOT NULL
                AND leaderboard_cents > (SELECT leaderboard_cents FROM ai)
              THEN true
              ELSE false
            END AS eligible
          FROM ranked
          ORDER BY leaderboard_cents DESC, settled_profit_cents DESC
          LIMIT 100
        `,
        [config.aiUsername, requestedWeekStart, req.user?.id ?? null]
      );
      const registeredPlayers = await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM app_user WHERE role = 'player'"
      );
      const currentWeek = weeks.rows.find((week) => week.isCurrent) as { weekStart: string; isCurrent: boolean } | undefined;
      const selectedWeekStart = requestedWeekStart ?? currentWeek?.weekStart ?? null;
      const prize = selectedWeekStart
        ? await query<{ cashPrizeCents: number; firstPlaceBonus: string | null }>(
          `
            SELECT
              cash_prize_cents AS "cashPrizeCents",
              first_place_bonus AS "firstPlaceBonus"
            FROM weekly_prize
            WHERE week_starts_on = $1::date
          `,
          [selectedWeekStart]
        )
        : { rows: [] as Array<{ cashPrizeCents: number; firstPlaceBonus: string | null }> };
      const weeklyPrize = prize.rows[0] ?? { cashPrizeCents: 0, firstPlaceBonus: null };
      res.json({
        leaderboard: result.rows,
        weeks: weeks.rows,
        weekStart: selectedWeekStart,
        isCurrentWeek: requestedWeekStart ? requestedWeekStart === currentWeek?.weekStart : true,
        registeredPlayers: Number(registeredPlayers.rows[0]?.count ?? 0),
        weeklyPrizeCents: weeklyPrize.cashPrizeCents,
        weeklyPrize
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/ai-picks", async (_req, res, next) => {
    try {
      const result = await query(
        `
          WITH ranked AS (
            SELECT DISTINCT ON (
              p.published_for,
              COALESCE(split_part(split_part(l.provider_event_id, ':', 1), '|', 1), l.sport::text || ':' || l.away_team || ':' || l.home_team || ':' || l.starts_at::text),
              l.market_key,
              p.selected_team
            )
              p.id,
              p.selected_team AS "selectedTeam",
              p.published_for AS "publishedFor",
              p.score,
              p.confidence,
              p.reasons,
              p.features,
              p.explanation,
              p.locked_at AS "lockedAt",
              p.wager_id AS "wagerId",
              w.status AS "wagerStatus",
              wl.status AS "legStatus",
              COALESCE(wl.status, w.status) AS "resultStatus",
              l.sport,
              l.league,
              l.starts_at AS "startsAt",
              l.home_team AS "homeTeam",
              l.away_team AS "awayTeam",
              l.spread,
              l.odds_american AS "oddsAmerican",
              l.market_key AS "marketKey"
            FROM ai_pick p
            JOIN game_line l ON l.id = p.game_line_id
            LEFT JOIN wager w ON w.id = p.wager_id
            LEFT JOIN wager_leg wl ON wl.wager_id = w.id
              AND wl.game_line_id = p.game_line_id
              AND wl.selected_team = p.selected_team
            WHERE p.published_for = (now() AT TIME ZONE 'America/Chicago')::date
            ORDER BY
              p.published_for,
              COALESCE(split_part(split_part(l.provider_event_id, ':', 1), '|', 1), l.sport::text || ':' || l.away_team || ':' || l.home_team || ':' || l.starts_at::text),
              l.market_key,
              p.selected_team,
              (p.wager_id IS NOT NULL) DESC,
              p.locked_at DESC NULLS LAST,
              p.confidence DESC NULLS LAST,
              p.score DESC NULLS LAST
          )
          SELECT *
          FROM ranked
          ORDER BY "lockedAt" DESC NULLS LAST, confidence DESC NULLS LAST, score DESC NULLS LAST, "startsAt" ASC
        `
      );
      const chineParlay = (await query<{
        id: string;
        pickDate: string;
        units: string;
        potentialReturnUnits: string;
        status: string;
        profitUnits: string;
        legs: Array<{
          id: string;
          selectedTeam: string;
          legIndex: number;
          status: string;
          decimalOdds: string;
          oddsAmerican: number;
          sport: string;
          league: string;
          startsAt: Date;
          homeTeam: string;
          awayTeam: string;
          spread: string;
          marketKey: string;
        }>;
      }>(
        `
          SELECT
            w.id,
            (w.placed_at AT TIME ZONE 'America/Chicago')::date::text AS "pickDate",
            (w.stake_cents / 10000.0)::numeric(8,2)::text AS units,
            (w.potential_payout_cents / 10000.0)::numeric(8,2)::text AS "potentialReturnUnits",
            w.status::text AS status,
            ((w.potential_payout_cents - w.stake_cents) / 10000.0)::numeric(8,2)::text AS "profitUnits",
            COALESCE(
              json_agg(
                json_build_object(
                  'id', wl.id,
                  'selectedTeam', wl.selected_team,
                  'legIndex', leg_rows.leg_index,
                  'status', wl.status,
                  'decimalOdds', (CASE WHEN wl.odds_american > 0 THEN 1 + wl.odds_american / 100.0 ELSE 1 + 100.0 / abs(wl.odds_american) END)::numeric(8,3)::text,
                  'oddsAmerican', wl.odds_american,
                  'sport', gl.sport,
                  'league', gl.league,
                  'startsAt', gl.starts_at,
                  'homeTeam', gl.home_team,
                  'awayTeam', gl.away_team,
                  'spread', wl.spread::text,
                  'marketKey', gl.market_key
                )
                ORDER BY leg_rows.leg_index ASC
              ) FILTER (WHERE wl.id IS NOT NULL),
              '[]'::json
            ) AS legs
          FROM wager w
          JOIN app_user u ON u.id = w.user_id
          JOIN LATERAL (
            SELECT
              wl_inner.id,
              row_number() OVER (ORDER BY gl_inner.starts_at ASC, wl_inner.id ASC) AS leg_index
            FROM wager_leg wl_inner
            JOIN game_line gl_inner ON gl_inner.id = wl_inner.game_line_id
            WHERE wl_inner.wager_id = w.id
          ) leg_rows ON true
          JOIN wager_leg wl ON wl.id = leg_rows.id
          JOIN game_line gl ON gl.id = wl.game_line_id
          WHERE u.username = $1
            AND w.kind = 'round_robin'
            AND (w.placed_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date
          GROUP BY w.id
          HAVING count(wl.id) = 7
          ORDER BY w.placed_at DESC
          LIMIT 1
        `,
        [config.aiUsername]
      )).rows[0] ?? null;
      res.json({ picks: result.rows, parlay: chineParlay });
    } catch (error) {
      next(error);
    }
  });

  router.get("/live/mlb", async (_req, res, next) => {
    try {
      const games = await getLiveMlbStates();
      res.json({ games });
    } catch (error) {
      next(error);
    }
  });

  router.get("/live/:sport", async (req, res, next) => {
    try {
      const sport = req.params.sport.toUpperCase();
      if (sport !== "WORLDCUP" && sport !== "EPL") {
        res.status(404).json({ error: "Live scoreboard is not available for this sport" });
        return;
      }
      const games = await getLiveStates(sport);
      res.json({ games });
    } catch (error) {
      next(error);
    }
  });

  router.get("/wagers/open", requireAuth, async (req, res, next) => {
    try {
      const result = await query<{
        wagerId: string;
        kind: "straight" | "parlay" | "round_robin";
        stakeCents: number;
        potentialPayoutCents: number;
        placedAt: Date;
        legId: string;
        selectedTeam: string;
        spread: string;
        oddsAmerican: number;
        legStatus: "pending" | "won" | "lost" | "push" | "void";
        marketKey: "spreads" | "h2h";
        sport: SportKey;
        startsAt: Date;
        awayTeam: string;
        homeTeam: string;
      }>(
        `
          SELECT
            w.id AS "wagerId",
            w.kind,
            w.stake_cents AS "stakeCents",
            w.potential_payout_cents AS "potentialPayoutCents",
            w.placed_at AS "placedAt",
            wl.id AS "legId",
            wl.selected_team AS "selectedTeam",
            wl.spread,
            wl.odds_american AS "oddsAmerican",
            wl.status AS "legStatus",
            gl.market_key AS "marketKey",
            gl.sport,
            gl.starts_at AS "startsAt",
            gl.away_team AS "awayTeam",
            gl.home_team AS "homeTeam"
          FROM wager w
          JOIN wager_leg wl ON wl.wager_id = w.id
          JOIN game_line gl ON gl.id = wl.game_line_id
          WHERE w.user_id = $1 AND w.status = 'pending'
          ORDER BY w.placed_at DESC, gl.starts_at ASC
        `,
        [req.user!.id]
      );

      const wagers = new Map<string, {
        id: string;
        kind: "straight" | "parlay" | "round_robin";
        stakeCents: number;
        potentialPayoutCents: number;
        placedAt: string;
        legs: Array<{
          id: string;
          selectedTeam: string;
          spread: string;
          oddsAmerican: number;
          status: "pending" | "won" | "lost" | "push" | "void";
          marketKey: "spreads" | "h2h";
          sport: SportKey;
          startsAt: string;
          awayTeam: string;
          homeTeam: string;
        }>;
      }>();

      for (const row of result.rows) {
        const wager = wagers.get(row.wagerId) ?? {
          id: row.wagerId,
          kind: row.kind,
          stakeCents: row.stakeCents,
          potentialPayoutCents: row.potentialPayoutCents,
          placedAt: row.placedAt.toISOString(),
          legs: []
        };
        wager.legs.push({
          id: row.legId,
          selectedTeam: row.selectedTeam,
          spread: row.spread,
          oddsAmerican: row.oddsAmerican,
          status: row.legStatus,
          marketKey: row.marketKey,
          sport: row.sport,
          startsAt: row.startsAt.toISOString(),
          awayTeam: row.awayTeam,
          homeTeam: row.homeTeam
        });
        wagers.set(row.wagerId, wager);
      }

      res.json({ wagers: [...wagers.values()] });
    } catch (error) {
      next(error);
    }
  });

  router.get("/wagers/history", requireAuth, async (req, res, next) => {
    try {
      const input = historyQuerySchema.parse(req.query);
      const includeAi = input.includeAi === "true";
      const result = await query<{
        wagerId: string;
        owner: "user" | "ai";
        displayName: string;
        kind: "straight" | "parlay" | "round_robin";
        wagerStatus: "won" | "lost" | "push" | "void";
        stakeCents: number;
        potentialPayoutCents: number;
        placedAt: Date;
        legId: string;
        selectedTeam: string;
        spread: string;
        oddsAmerican: number;
        legStatus: "won" | "lost" | "push" | "void";
        marketKey: "spreads" | "h2h";
        sport: SportKey;
        startsAt: Date;
        awayTeam: string;
        homeTeam: string;
      }>(
        `
          WITH target_users AS (
            SELECT id, 'user'::text AS owner, COALESCE(NULLIF(display_name, ''), 'You') AS display_name
            FROM app_user
            WHERE id = $1
            UNION ALL
            SELECT id, 'ai'::text AS owner, COALESCE(NULLIF(display_name, ''), 'StakeWars Chine') AS display_name
            FROM app_user
            WHERE username = $2 AND $3 = true
          ),
          wager_games AS (
            SELECT
              w.id AS wager_id,
              max(gl.starts_at) AS latest_starts_at
            FROM wager w
            JOIN wager_leg wl ON wl.wager_id = w.id
            JOIN game_line gl ON gl.id = wl.game_line_id
            GROUP BY w.id
          )
          SELECT
            w.id AS "wagerId",
            tu.owner AS "owner",
            tu.display_name AS "displayName",
            w.kind,
            w.status AS "wagerStatus",
            w.stake_cents AS "stakeCents",
            w.potential_payout_cents AS "potentialPayoutCents",
            w.placed_at AS "placedAt",
            wl.id AS "legId",
            wl.selected_team AS "selectedTeam",
            wl.spread,
            wl.odds_american AS "oddsAmerican",
            wl.status AS "legStatus",
            gl.market_key AS "marketKey",
            gl.sport,
            gl.starts_at AS "startsAt",
            gl.away_team AS "awayTeam",
            gl.home_team AS "homeTeam"
          FROM wager w
          JOIN target_users tu ON tu.id = w.user_id
          JOIN wager_games wg ON wg.wager_id = w.id
          JOIN wager_leg wl ON wl.wager_id = w.id
          JOIN game_line gl ON gl.id = wl.game_line_id
          WHERE w.status <> 'pending'
            AND (
              $4 = 'all'
              OR (
                $4 = 'day'
                AND (wg.latest_starts_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date
              )
              OR (
                $4 = 'week'
                AND (wg.latest_starts_at AT TIME ZONE 'America/Chicago')::date >= (date_trunc('week', now() AT TIME ZONE 'America/Chicago'))::date
              )
            )
          ORDER BY wg.latest_starts_at DESC, w.placed_at DESC, w.id, gl.starts_at ASC
          LIMIT 500
        `,
        [req.user!.id, config.aiUsername, includeAi, input.period]
      );

      const wagers = new Map<string, {
        id: string;
        owner: "user" | "ai";
        displayName: string;
        kind: "straight" | "parlay" | "round_robin";
        status: "won" | "lost" | "push" | "void";
        stakeCents: number;
        potentialPayoutCents: number;
        profitCents: number;
        placedAt: string;
        legs: Array<{
          id: string;
          selectedTeam: string;
          spread: string;
          oddsAmerican: number;
          status: "won" | "lost" | "push" | "void";
          marketKey: "spreads" | "h2h";
          sport: SportKey;
          startsAt: string;
          awayTeam: string;
          homeTeam: string;
        }>;
      }>();

      for (const row of result.rows) {
        const profitCents = row.kind === "round_robin"
          ? row.potentialPayoutCents - row.stakeCents
          : row.wagerStatus === "won"
          ? row.potentialPayoutCents - row.stakeCents
          : row.wagerStatus === "lost"
            ? -row.stakeCents
            : 0;
        const wager = wagers.get(row.wagerId) ?? {
          id: row.wagerId,
          owner: row.owner,
          displayName: row.displayName,
          kind: row.kind,
          status: row.wagerStatus,
          stakeCents: row.stakeCents,
          potentialPayoutCents: row.potentialPayoutCents,
          profitCents,
          placedAt: row.placedAt.toISOString(),
          legs: []
        };
        wager.legs.push({
          id: row.legId,
          selectedTeam: row.selectedTeam,
          spread: row.spread,
          oddsAmerican: row.oddsAmerican,
          status: row.legStatus,
          marketKey: row.marketKey,
          sport: row.sport,
          startsAt: row.startsAt.toISOString(),
          awayTeam: row.awayTeam,
          homeTeam: row.homeTeam
        });
        wagers.set(row.wagerId, wager);
      }

      res.json({ wagers: [...wagers.values()] });
    } catch (error) {
      next(error);
    }
  });

  router.post("/wagers", requireAuth, async (req, res, next) => {
    try {
      const input = placeWagerSchema.parse(req.body);
      if (input.kind === "straight" && input.legs.length !== 1) {
        res.status(400).json({ error: "Straight wagers must contain exactly one leg" });
        return;
      }
      if (input.kind !== "straight" && input.legs.length < 2) {
        res.status(400).json({ error: "Parlays and round robins need at least two legs" });
        return;
      }
      if (input.kind === "round_robin" && (!input.roundRobinMaxLegs || input.roundRobinMaxLegs > input.legs.length)) {
        res.status(400).json({ error: "Select a valid round robin size" });
        return;
      }

      const wager = await transaction(async (client) => {
        const entry = await ensureWeeklyEntry(client, req.user!.id);
        const ways = input.kind === "round_robin" ? roundRobinWays(input.legs.length, input.roundRobinMaxLegs, 2) : null;
        const totalStakeCents = input.kind === "round_robin" ? input.stakeCents * (ways ?? 0) : input.stakeCents;
        if (!ways && input.kind === "round_robin") {
          throw new Error("Select a valid round robin size");
        }
        if (entry.balance_cents < totalStakeCents) {
          throw new Error("Insufficient bankroll");
        }

        const lineResult = await client.query<WagerLineRow>(
          "SELECT id, sport, starts_at, home_team, away_team, favorite_team, spread, odds_american, market_key, is_active FROM game_line WHERE id = ANY($1::uuid[]) FOR SHARE",
          [input.legs.map((leg) => leg.gameLineId)]
        );

        if (lineResult.rowCount !== input.legs.length) {
          throw new Error("One or more selected lines are unavailable");
        }

        const requestedLines = new Map(lineResult.rows.map((line) => [line.id, line]));
        const selectedLines: WagerLineRow[] = [];
        const lineMoves: LineMove[] = [];

        for (const leg of input.legs) {
          const requestedLine = requestedLines.get(leg.gameLineId);
          if (!requestedLine) {
            throw new Error("One or more selected lines are unavailable");
          }
          if (leg.selectedTeam !== requestedLine.favorite_team) {
            throw new Error("Selected outcome is not available");
          }
          let currentLine = requestedLine;
          if (!requestedLine.is_active) {
            const replacementResult = await client.query<WagerLineRow>(
              `
                SELECT id, sport, starts_at, home_team, away_team, favorite_team, spread, odds_american, market_key, is_active
                FROM game_line
                WHERE is_active = true
                  AND starts_at > now()
                  AND sport = $1
                  AND away_team = $2
                  AND home_team = $3
                  AND market_key = $4
                  AND favorite_team = $5
                  AND starts_at BETWEEN $6::timestamptz - interval '3 hours' AND $6::timestamptz + interval '3 hours'
                ORDER BY abs(extract(epoch from starts_at - $6::timestamptz)) ASC, fetched_at DESC
                LIMIT 1
                FOR SHARE
              `,
              [
                requestedLine.sport,
                requestedLine.away_team,
                requestedLine.home_team,
                requestedLine.market_key,
                requestedLine.favorite_team,
                requestedLine.starts_at
              ]
            );
            if (replacementResult.rowCount !== 1) {
              throw new Error(unavailableLineMessage(requestedLine));
            }
            currentLine = replacementResult.rows[0];
          }
          if (currentLine.starts_at.getTime() <= Date.now()) {
            throw new Error(`${currentLine.away_team} @ ${currentLine.home_team} has already started`);
          }

          const expectedSpread = leg.expectedSpread ?? requestedLine.spread;
          const expectedOddsAmerican = leg.expectedOddsAmerican ?? requestedLine.odds_american;
          if (currentLine.id !== leg.gameLineId || currentLine.spread !== expectedSpread || currentLine.odds_american !== expectedOddsAmerican) {
            lineMoves.push({
              oldGameLineId: leg.gameLineId,
              newGameLineId: currentLine.id,
              game: `${currentLine.away_team} @ ${currentLine.home_team}`,
              selectedTeam: leg.selectedTeam,
              marketKey: currentLine.market_key,
              oldSpread: expectedSpread,
              newSpread: currentLine.spread,
              oldOddsAmerican: expectedOddsAmerican,
              newOddsAmerican: currentLine.odds_american
            });
          }
          selectedLines.push(currentLine);
        }

        if (lineMoves.length > 0 && !input.acceptLineMoves) {
          throw new LineMoveError(lineMoves);
        }

        const lines = new Map(input.legs.map((leg, index) => [leg.gameLineId, selectedLines[index]]));
        const sameGameSelections = new Map<string, { teamMarkets: number; totals: number }>();
        for (const line of selectedLines) {
          const key = sameGameKey(line);
          const summary = sameGameSelections.get(key) ?? { teamMarkets: 0, totals: 0 };
          if (line.market_key === "totals") {
            summary.totals += 1;
          } else {
            summary.teamMarkets += 1;
          }
          if (summary.teamMarkets > 1 || summary.totals > 1) {
            throw new Error("Only one team pick and one over/under are allowed for the same game");
          }
          sameGameSelections.set(key, summary);
        }
        const odds = input.legs.map((leg) => {
          const line = lines.get(leg.gameLineId)!;
          return line.odds_american;
        });

        const potentialPayout = input.kind === "round_robin"
          ? roundRobinPayoutCents(input.stakeCents, odds, input.roundRobinMaxLegs, 2)
          : estimatePayoutCents(input.stakeCents, odds);

        const wagerResult = await client.query<{ id: string }>(
          `
            INSERT INTO wager (
              id, user_id, weekly_entry_id, kind, stake_cents, potential_payout_cents,
              legs_count, round_robin_ways, round_robin_min_legs,
              round_robin_max_legs, round_robin_stake_per_way_cents
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id
          `,
          [
            randomUUID(),
            req.user!.id,
            entry.id,
            input.kind,
            totalStakeCents,
            potentialPayout,
            input.legs.length,
            ways,
            input.kind === "round_robin" ? 2 : null,
            input.kind === "round_robin" ? input.roundRobinMaxLegs : null,
            input.kind === "round_robin" ? input.stakeCents : null
          ]
        );

        for (const leg of input.legs) {
          const line = lines.get(leg.gameLineId)!;
          await client.query(
            `
              INSERT INTO wager_leg (id, wager_id, game_line_id, selected_team, spread, odds_american)
              VALUES ($1, $2, $3, $4, $5, $6)
            `,
            [randomUUID(), wagerResult.rows[0].id, line.id, leg.selectedTeam, line.spread, line.odds_american]
          );
        }

        await client.query("UPDATE weekly_entry SET balance_cents = balance_cents - $1 WHERE id = $2", [
          totalStakeCents,
          entry.id
        ]);

        return { id: wagerResult.rows[0].id, potentialPayoutCents: potentialPayout, roundRobinWays: ways };
      });

      res.status(201).json({ wager });
    } catch (error) {
      if (error instanceof LineMoveError) {
        res.status(409).json(error.body);
        return;
      }
      if ((error as Error).message === "Insufficient bankroll") {
        res.status(400).json({ error: "Insufficient bankroll" });
        return;
      }
      if ((error as Error).message.includes("unavailable") || (error as Error).message.includes("no longer available") || (error as Error).message.includes("already started") || (error as Error).message.includes("Selected outcome") || (error as Error).message.includes("conflict") || (error as Error).message.includes("Only one team pick") || (error as Error).message.includes("round robin")) {
        res.status(400).json({ error: (error as Error).message });
        return;
      }
      next(error);
    }
  });
};
