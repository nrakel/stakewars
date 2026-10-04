import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "./config.js";
import { query } from "./db.js";
import type { SessionUser } from "../shared/types.js";

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[^\s\x00-\x1F\x7F]+$/u, "Username cannot contain spaces or control characters");

export const passwordSchema = z
  .string()
  .min(10)
  .regex(/[a-z]/, "Password needs a lowercase letter")
  .regex(/[A-Z]/, "Password needs an uppercase letter")
  .regex(/[0-9]/, "Password needs a number")
  .regex(/[^a-zA-Z0-9]/, "Password needs a symbol");

export const signToken = (user: SessionUser) => {
  return jwt.sign(user, config.jwtSecret, { expiresIn: "7d" });
};

export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as SessionUser & { iat?: number };
    const result = await query<SessionUser & { role: SessionUser["role"]; passwordChangedAt: Date }>(
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
          role,
          password_changed_at AS "passwordChangedAt"
        FROM app_user
        WHERE id = $1
      `,
      [payload.id]
    );
    if (!result.rowCount) {
      res.status(401).json({ error: "User no longer exists" });
      return;
    }
    const user = result.rows[0];
    if (!payload.iat || payload.iat < Math.floor(new Date(user.passwordChangedAt).getTime() / 1000)) {
      res.status(401).json({ error: "Session expired. Please log in again." });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid session" });
  }
};

export const optionalAuth = async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    next();
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret) as SessionUser & { iat?: number };
    const result = await query<SessionUser & { role: SessionUser["role"]; passwordChangedAt: Date }>(
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
          role,
          password_changed_at AS "passwordChangedAt"
        FROM app_user
        WHERE id = $1
      `,
      [payload.id]
    );
    const user = result.rows[0];
    req.user = user && payload.iat && payload.iat >= Math.floor(new Date(user.passwordChangedAt).getTime() / 1000)
      ? user
      : undefined;
  } catch {
    req.user = undefined;
  }
  next();
};
