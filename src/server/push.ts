import { randomUUID } from "node:crypto";
import webPush from "web-push";
import { config } from "./config.js";
import { query } from "./db.js";

type BrowserPushSubscription = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

const configureWebPush = () => {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    throw new Error("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required for push notifications");
  }
  webPush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
};

type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  renotify?: boolean;
};

export type PushPreferences = {
  gameReminderEnabled: boolean;
  gameStartedEnabled: boolean;
  scoreChangeEnabled: boolean;
  gameFinalEnabled: boolean;
};

const sendToSubscriptions = async (rows: Array<{ endpoint: string; p256dh: string; auth: string }>, payload: PushPayload) => {
  configureWebPush();
  const sent: string[] = [];
  const removed: string[] = [];
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? "/",
    tag: payload.tag,
    renotify: payload.renotify
  });

  for (const row of rows) {
    try {
      await webPush.sendNotification({
        endpoint: row.endpoint,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth
        }
      }, body);
      sent.push(row.endpoint);
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await query("DELETE FROM push_subscription WHERE endpoint = $1", [row.endpoint]);
        removed.push(row.endpoint);
        continue;
      }
      throw error;
    }
  }

  return { subscriptions: rows.length, sent: sent.length, removed: removed.length };
};

export const getVapidPublicKey = () => {
  if (!config.vapidPublicKey) {
    throw new Error("VAPID_PUBLIC_KEY is not configured");
  }
  return config.vapidPublicKey;
};

export const savePushSubscription = async ({
  userId,
  subscription,
  userAgent
}: {
  userId: string;
  subscription: BrowserPushSubscription;
  userAgent?: string;
}) => {
  await query(
    `
      INSERT INTO push_subscription (id, user_id, endpoint, p256dh, auth, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (endpoint) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        updated_at = now()
    `,
    [randomUUID(), userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent ?? null]
  );
};

export const getPushPreferences = async (userId: string): Promise<PushPreferences> => {
  await query(
    `
      INSERT INTO push_notification_preference (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );

  const result = await query<{
    gameReminderEnabled: boolean;
    gameStartedEnabled: boolean;
    scoreChangeEnabled: boolean;
    gameFinalEnabled: boolean;
  }>(
    `
      SELECT
        game_reminder_enabled AS "gameReminderEnabled",
        game_started_enabled AS "gameStartedEnabled",
        score_change_enabled AS "scoreChangeEnabled",
        game_final_enabled AS "gameFinalEnabled"
      FROM push_notification_preference
      WHERE user_id = $1
    `,
    [userId]
  );

  return result.rows[0] ?? {
    gameReminderEnabled: false,
    gameStartedEnabled: false,
    scoreChangeEnabled: false,
    gameFinalEnabled: false
  };
};

export const updatePushPreferences = async (userId: string, preferences: PushPreferences) => {
  const result = await query<{
    gameReminderEnabled: boolean;
    gameStartedEnabled: boolean;
    scoreChangeEnabled: boolean;
    gameFinalEnabled: boolean;
  }>(
    `
      INSERT INTO push_notification_preference (
        user_id,
        game_reminder_enabled,
        game_started_enabled,
        score_change_enabled,
        game_final_enabled
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id) DO UPDATE SET
        game_reminder_enabled = EXCLUDED.game_reminder_enabled,
        game_started_enabled = EXCLUDED.game_started_enabled,
        score_change_enabled = EXCLUDED.score_change_enabled,
        game_final_enabled = EXCLUDED.game_final_enabled,
        updated_at = now()
      RETURNING
        game_reminder_enabled AS "gameReminderEnabled",
        game_started_enabled AS "gameStartedEnabled",
        score_change_enabled AS "scoreChangeEnabled",
        game_final_enabled AS "gameFinalEnabled"
    `,
    [
      userId,
      preferences.gameReminderEnabled,
      preferences.gameStartedEnabled,
      preferences.scoreChangeEnabled,
      preferences.gameFinalEnabled
    ]
  );

  return result.rows[0];
};

export const sendTestPush = async (userId: string) => {
  const result = await query<{
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    `
      SELECT endpoint, p256dh, auth
      FROM push_subscription
      WHERE user_id = $1
      ORDER BY updated_at DESC
      LIMIT 5
    `,
    [userId]
  );

  return sendToSubscriptions(result.rows, {
    title: "StakeWars test",
    body: "Push notifications are working on this device.",
    url: "/"
  });
};

export const sendPushToAll = async (payload: PushPayload) => {
  const result = await query<{
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    `
      SELECT DISTINCT ON (endpoint) endpoint, p256dh, auth
      FROM push_subscription
      ORDER BY endpoint, updated_at DESC
    `
  );

  return sendToSubscriptions(result.rows, payload);
};

export const sendPushToUsers = async (userIds: string[], payload: PushPayload) => {
  if (userIds.length === 0) {
    return { subscriptions: 0, sent: 0, removed: 0 };
  }

  const result = await query<{
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    `
      SELECT DISTINCT ON (endpoint) endpoint, p256dh, auth
      FROM push_subscription
      WHERE user_id = ANY($1::uuid[])
      ORDER BY endpoint, updated_at DESC
    `,
    [userIds]
  );

  return sendToSubscriptions(result.rows, payload);
};

export const sendPushToUsersWithPreference = async (
  preferenceColumn: "game_reminder_enabled" | "game_started_enabled" | "score_change_enabled" | "game_final_enabled",
  payload: PushPayload
) => {
  const result = await query<{
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    `
      SELECT DISTINCT ON (ps.endpoint) ps.endpoint, ps.p256dh, ps.auth
      FROM push_subscription ps
      JOIN push_notification_preference pnp ON pnp.user_id = ps.user_id
      WHERE pnp.${preferenceColumn} = true
      ORDER BY ps.endpoint, ps.updated_at DESC
    `
  );

  return sendToSubscriptions(result.rows, payload);
};
