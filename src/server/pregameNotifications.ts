import { randomUUID } from "node:crypto";
import { query, transaction } from "./db.js";
import { sendPushToUsersWithPreference } from "./push.js";

type FirstGame = {
  startsAt: Date;
  startsOn: string;
  sport: string;
  awayTeam: string;
  homeTeam: string;
};

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

const firstGameForDate = async (date: string) => {
  const result = await query<FirstGame>(
    `
      SELECT
        min(starts_at) AS "startsAt",
        (min(starts_at) AT TIME ZONE 'America/Chicago')::date::text AS "startsOn",
        (array_agg(sport ORDER BY starts_at ASC))[1]::text AS sport,
        (array_agg(away_team ORDER BY starts_at ASC))[1] AS "awayTeam",
        (array_agg(home_team ORDER BY starts_at ASC))[1] AS "homeTeam"
      FROM game_line
      WHERE is_active = true
        AND starts_at > now()
        AND (starts_at AT TIME ZONE 'America/Chicago')::date = $1::date
    `,
    [date]
  );
  const row = result.rows[0];
  return row?.startsAt ? row : null;
};

export const sendDailyPregameNotification = async (now = new Date()) => {
  const today = centralDate(now);
  const game = await firstGameForDate(today);
  if (!game) {
    return { sent: false, reason: "no upcoming active games today", date: today };
  }

  const notificationAt = new Date(game.startsAt.getTime() - 60 * 60 * 1000);
  if (now < notificationAt) {
    return { sent: false, reason: "too early", date: today, notificationAt: notificationAt.toISOString(), firstGameAt: game.startsAt.toISOString() };
  }
  if (now >= game.startsAt) {
    return { sent: false, reason: "first game already started", date: today, firstGameAt: game.startsAt.toISOString() };
  }

  const key = `daily-pregame:${today}`;
  const title = "It's almost game time!";
  const body = "Be sure to get your picks in today.";
  const url = "/";

  const inserted = await transaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `
        INSERT INTO notification_log (id, notification_key, title, body, url, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (notification_key) DO NOTHING
        RETURNING id
      `,
      [
        randomUUID(),
        key,
        title,
        body,
        url,
        JSON.stringify({
          firstGameAt: game.startsAt.toISOString(),
          sport: game.sport,
          awayTeam: game.awayTeam,
          homeTeam: game.homeTeam
        })
      ]
    );
    return result.rows[0]?.id ?? null;
  });

  if (!inserted) {
    return { sent: false, reason: "already sent", date: today, key };
  }

  const delivery = await sendPushToUsersWithPreference("game_reminder_enabled", { title, body, url });
  await query(
    `
      UPDATE notification_log
      SET target_count = $2,
          sent_count = $3,
          removed_count = $4
      WHERE id = $1
    `,
    [inserted, delivery.subscriptions, delivery.sent, delivery.removed]
  );

  return {
    notificationSent: true,
    date: today,
    key,
    firstGameAt: game.startsAt.toISOString(),
    ...delivery
  };
};
