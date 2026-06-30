import { randomUUID } from "node:crypto";
import { query, transaction } from "./db.js";
import { outcomeForSelection } from "./settlement.js";
import { sendPushToUsers } from "./push.js";
import type { SportKey } from "../shared/types.js";

type LiveNotificationPreference = "game_started_enabled" | "score_change_enabled" | "game_final_enabled";

type LiveState = {
  matchId: string;
  provider: string;
  sport: SportKey;
  eventKey: string | null;
  startsAt: Date | null;
  awayTeam: string;
  homeTeam: string;
  awayScore: number | null;
  homeScore: number | null;
  gameStatus: string | null;
  description: string | null;
  lastPlay?: string | null;
  batter?: string | null;
  pitcher?: string | null;
  balls?: number | null;
  strikes?: number | null;
  outs?: number | null;
  pitcherPitches?: number | null;
  batterHits?: number | null;
  batterAtBats?: number | null;
  inPlay: boolean;
};

export type LiveStateChange = {
  previous: LiveState | null;
  current: LiveState;
};

const isFinalStatus = (status: string | null) => (status ?? "").toLowerCase().includes("final");

const scoreText = (game: Pick<LiveState, "awayTeam" | "homeTeam" | "awayScore" | "homeScore">) =>
  `${game.awayTeam} ${game.awayScore ?? 0} - ${game.homeTeam} ${game.homeScore ?? 0}`;

const notificationUrl = "/scoreboard";

const insertNotificationLog = async ({
  key,
  title,
  body,
  metadata
}: {
  key: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}) => {
  return transaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `
        INSERT INTO notification_log (id, notification_key, title, body, url, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (notification_key) DO NOTHING
        RETURNING id
      `,
      [randomUUID(), key, title, body, notificationUrl, JSON.stringify(metadata)]
    );
    return result.rows[0]?.id ?? null;
  });
};

const updateNotificationLog = async (id: string, delivery: { subscriptions: number; sent: number; removed: number }) => {
  await query(
    `
      UPDATE notification_log
      SET target_count = $2,
          sent_count = $3,
          removed_count = $4
      WHERE id = $1
    `,
    [id, delivery.subscriptions, delivery.sent, delivery.removed]
  );
};

const usersForGame = async (game: LiveState, preference: LiveNotificationPreference) => {
  const result = await query<{
    userId: string;
    selectedTeams: string[];
  }>(
    `
      WITH matching_lines AS (
        SELECT gl.id
        FROM game_line gl
        WHERE gl.sport = $1
          AND (
            ($2::text IS NOT NULL AND COALESCE(split_part(gl.provider_event_id, ':', 1), gl.id::text) = $2::text)
            OR (
              gl.away_team = $3
              AND gl.home_team = $4
              AND (
                $5::timestamptz IS NULL
                OR gl.starts_at BETWEEN $5::timestamptz - INTERVAL '8 hours' AND $5::timestamptz + INTERVAL '8 hours'
              )
            )
          )
      )
      SELECT DISTINCT
        w.user_id AS "userId",
        array_agg(DISTINCT wl.selected_team ORDER BY wl.selected_team) AS "selectedTeams"
      FROM wager w
      JOIN wager_leg wl ON wl.wager_id = w.id
      JOIN matching_lines ml ON ml.id = wl.game_line_id
      JOIN push_notification_preference pnp ON pnp.user_id = w.user_id
      JOIN push_subscription ps ON ps.user_id = w.user_id
      WHERE w.status = 'pending'
        AND pnp.${preference} = true
      GROUP BY w.user_id
    `,
    [game.sport, game.eventKey, game.awayTeam, game.homeTeam, game.startsAt]
  );

  return result.rows;
};

const wagerLegsForFinalGame = async (game: LiveState) => {
  const result = await query<{
    userId: string;
    legId: string;
    selectedTeam: string;
    spread: string;
    oddsAmerican: number;
    marketKey: "h2h" | "spreads" | "totals";
    awayTeam: string;
    homeTeam: string;
  }>(
    `
      WITH matching_lines AS (
        SELECT gl.id
        FROM game_line gl
        WHERE gl.sport = $1
          AND (
            ($2::text IS NOT NULL AND COALESCE(split_part(gl.provider_event_id, ':', 1), gl.id::text) = $2::text)
            OR (
              gl.away_team = $3
              AND gl.home_team = $4
              AND (
                $5::timestamptz IS NULL
                OR gl.starts_at BETWEEN $5::timestamptz - INTERVAL '8 hours' AND $5::timestamptz + INTERVAL '8 hours'
              )
            )
          )
      )
      SELECT
        w.user_id AS "userId",
        wl.id AS "legId",
        wl.selected_team AS "selectedTeam",
        wl.spread,
        wl.odds_american AS "oddsAmerican",
        gl.market_key AS "marketKey",
        gl.away_team AS "awayTeam",
        gl.home_team AS "homeTeam"
      FROM wager w
      JOIN wager_leg wl ON wl.wager_id = w.id
      JOIN matching_lines ml ON ml.id = wl.game_line_id
      JOIN game_line gl ON gl.id = wl.game_line_id
      JOIN push_notification_preference pnp ON pnp.user_id = w.user_id
      JOIN push_subscription ps ON ps.user_id = w.user_id
      WHERE w.status = 'pending'
        AND pnp.game_final_enabled = true
      ORDER BY w.user_id, wl.id
    `,
    [game.sport, game.eventKey, game.awayTeam, game.homeTeam, game.startsAt]
  );

  return result.rows;
};

const sendGroupedNotification = async ({
  key,
  title,
  body,
  game,
  preference,
  metadata,
  tag,
  renotify = true
}: {
  key: string;
  title: string;
  body: string;
  game: LiveState;
  preference: LiveNotificationPreference;
  metadata: Record<string, unknown>;
  tag?: string;
  renotify?: boolean;
}) => {
  const targets = await usersForGame(game, preference);
  if (targets.length === 0) {
    return { sent: false, reason: "no opted-in wager users", key };
  }

  const logId = await insertNotificationLog({
    key,
    title,
    body,
    metadata: {
      ...metadata,
      matchId: game.matchId,
      eventKey: game.eventKey,
      awayTeam: game.awayTeam,
      homeTeam: game.homeTeam,
      userCount: targets.length
    }
  });
  if (!logId) {
    return { sent: false, reason: "already sent", key };
  }

  const delivery = await sendPushToUsers(targets.map((target) => target.userId), { title, body, url: notificationUrl, tag, renotify });
  await updateNotificationLog(logId, delivery);
  return { delivered: true, key, ...delivery };
};

const notificationGameKey = (game: LiveState) => game.eventKey ?? game.matchId;

const americanOdds = (odds: number) => `${odds > 0 ? "+" : ""}${odds}`;

const legDescription = (leg: Awaited<ReturnType<typeof wagerLegsForFinalGame>>[number]) => {
  if (leg.marketKey === "h2h") {
    return `${leg.selectedTeam} ${americanOdds(leg.oddsAmerican)}`;
  }
  if (leg.marketKey === "totals") {
    return `${leg.selectedTeam} ${leg.spread} ${americanOdds(leg.oddsAmerican)}`;
  }
  return `${leg.selectedTeam} ${Number(leg.spread) > 0 ? `+${leg.spread}` : leg.spread} ${americanOdds(leg.oddsAmerican)}`;
};

const sendFinalNotifications = async (game: LiveState) => {
  const legs = await wagerLegsForFinalGame(game);
  const sent: Array<{ key: string; sent: number }> = [];
  if (legs.length === 0 || game.awayScore === null || game.homeScore === null) {
    return sent;
  }

  for (const leg of legs) {
    const outcome = outcomeForSelection({
      selectedTeam: leg.selectedTeam,
      awayTeam: leg.awayTeam,
      homeTeam: leg.homeTeam,
      marketKey: leg.marketKey,
      spread: Number(leg.spread),
      game: {
        startsOn: game.startsAt?.toISOString().slice(0, 10) ?? new Date().toISOString().slice(0, 10),
        awayTeam: leg.awayTeam,
        homeTeam: leg.homeTeam,
        awayScore: game.awayScore,
        homeScore: game.homeScore
      }
    });
    const title = outcome === "won" ? "Winner" : outcome === "lost" ? "Tough Luck" : "Game Final";
    const body = outcome === "won"
      ? `${legDescription(leg)} won. ${scoreText(game)} is final.`
      : outcome === "lost"
        ? `${legDescription(leg)} lost. ${scoreText(game)} is final.`
        : `${legDescription(leg)} is ${outcome === "void" ? "No Action" : "a push"}. ${scoreText(game)} is final.`;
    const key = `live-final:${notificationGameKey(game)}:${leg.userId}:${leg.legId}:${game.awayScore}-${game.homeScore}`;
    const logId = await insertNotificationLog({
      key,
      title,
      body,
      metadata: {
        matchId: game.matchId,
        eventKey: game.eventKey,
        legId: leg.legId,
        selectedTeam: leg.selectedTeam,
        spread: leg.spread,
        oddsAmerican: leg.oddsAmerican,
        marketKey: leg.marketKey,
        outcome,
        awayTeam: game.awayTeam,
        homeTeam: game.homeTeam,
        awayScore: game.awayScore,
        homeScore: game.homeScore
      }
    });
    if (!logId) {
      continue;
    }
    const delivery = await sendPushToUsers([leg.userId], { title, body, url: notificationUrl });
    await updateNotificationLog(logId, delivery);
    sent.push({ key, sent: delivery.sent });
  }

  return sent;
};

export const sendLiveGameNotifications = async (changes: LiveStateChange[]) => {
  const results: unknown[] = [];
  for (const change of changes) {
    const game = change.current;
    if (game.sport === "MLB" && game.provider !== "mlb-stats-api") {
      continue;
    }
    if (game.sport !== "MLB" && game.provider !== "parlay-api" && game.provider !== "parlay-live") {
      continue;
    }

    const previous = change.previous;
    const gameStarted = game.inPlay && !previous?.inPlay;
    if (gameStarted) {
      results.push(await sendGroupedNotification({
        key: `live-start:${notificationGameKey(game)}`,
        title: "Game Started",
        body: `${game.awayTeam} at ${game.homeTeam} is underway.`,
        game,
        preference: "game_started_enabled",
        metadata: { type: "game_started" }
      }));
    }

    const scoreChanged = game.inPlay
      && game.awayScore !== null
      && game.homeScore !== null
      && previous?.awayScore !== null
      && previous?.homeScore !== null
      && (game.awayScore !== previous?.awayScore || game.homeScore !== previous?.homeScore);
    if (scoreChanged) {
      results.push(await sendGroupedNotification({
        key: `live-score:${notificationGameKey(game)}:${game.awayScore}-${game.homeScore}`,
        title: "Score Update",
        body: [scoreText(game), game.description].filter(Boolean).join("\n"),
        game,
        preference: "score_change_enabled",
        metadata: { type: "score_change", awayScore: game.awayScore, homeScore: game.homeScore },
        tag: `score-update:${notificationGameKey(game)}`,
        renotify: false
      }));
    }

    const finalNow = isFinalStatus(game.gameStatus);
    const wasFinal = isFinalStatus(previous?.gameStatus ?? null);
    if (finalNow && !wasFinal) {
      results.push(...await sendFinalNotifications(game));
    }
  }

  return results;
};
