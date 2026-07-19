import { randomUUID } from "node:crypto";
import type pg from "pg";

import { currentWeekStart, ensureWeeklyEntry } from "../betting.js";
import { query, transaction } from "../db.js";
import {
  applyDoubleDecision,
  createTowerShoe,
  defaultTowerConfig,
  heightPayoutFor,
  hiddenCardsInPlay,
  isHeightQualified,
  nextHeightPayoutFor,
  playerBuild,
  playerCap,
  publicCard,
  publicShoeCounter,
  shouldReshuffleBeforeHand,
  startTowerHand,
  towerHeight,
  towerValue,
  type TowerConfig,
  type TowerHandCard,
  type TowerHandState,
  type TowerResult,
  type TowerShoeState,
  type TowerWagerType
} from "./engine.js";

type DbTowerConfig = {
  id: string;
  version_label: string;
  config: TowerConfig;
};

type DbTowerShoe = {
  id: string;
  user_id: string;
  status: "active" | "retired";
  shoe_state: TowerShoeState;
};

type DbTowerHand = {
  id: string;
  user_id: string;
  weekly_entry_id: string;
  shoe_id: string;
  status: TowerHandState["status"];
  hand_state: TowerHandState;
  configuration_version_id: string;
  action_version: number;
};

export class TowerError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

const nonTerminalStatuses = [
  "player_turn",
  "awaiting_double_decision",
  "player_capped",
  "dealer_turn",
  "player_collapsed"
];

const activeConfigQuery = `
  SELECT id, version_label, config
  FROM tower_config_version
  WHERE active = true
  ORDER BY created_at DESC
  LIMIT 1
`;

export const getActiveTowerConfig = async (client?: pg.PoolClient) => {
  const result = client
    ? await client.query<DbTowerConfig>(activeConfigQuery)
    : await query<DbTowerConfig>(activeConfigQuery);
  const row = result.rows[0];
  if (!row) {
    return {
      id: "00000000-0000-0000-0000-000000000051",
      versionLabel: defaultTowerConfig.version,
      config: defaultTowerConfig
    };
  }
  return { id: row.id, versionLabel: row.version_label, config: row.config };
};

const getLockedWeeklyEntry = async (client: pg.PoolClient, userId: string) => {
  const entry = await ensureWeeklyEntry(client, userId);
  const locked = await client.query<{ id: string; balance_cents: number }>(
    "SELECT id, balance_cents FROM weekly_entry WHERE id = $1 FOR UPDATE",
    [entry.id]
  );
  return locked.rows[0];
};

const saveShoe = async (client: pg.PoolClient, userId: string, shoe: TowerShoeState) => {
  await client.query(
    `
      INSERT INTO tower_shoe (
        id, user_id, status, shoe_state, current_position, initial_card_count,
        publicly_revealed_count, shuffle_commitment, shuffle_reason, created_at, shuffled_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        shoe_state = EXCLUDED.shoe_state,
        current_position = EXCLUDED.current_position,
        publicly_revealed_count = EXCLUDED.publicly_revealed_count
    `,
    [
      shoe.id,
      userId,
      shoe.status,
      JSON.stringify(shoe),
      shoe.position,
      shoe.initialCardCount,
      shoe.publiclyRevealedCardIds.length,
      shoe.shuffleCommitment,
      shoe.shuffleReason,
      shoe.createdAt,
      shoe.shuffledAt
    ]
  );
};

const getOrCreateActiveShoe = async (client: pg.PoolClient, userId: string, config: TowerConfig) => {
  const existing = await client.query<DbTowerShoe>(
    `
      SELECT id, user_id, status, shoe_state
      FROM tower_shoe
      WHERE user_id = $1 AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [userId]
  );
  const row = existing.rows[0];
  if (!row) {
    const shoe = createTowerShoe({ config, reason: "new_player_shoe" });
    await saveShoe(client, userId, shoe);
    return { shoe, shuffled: true, shuffleReason: "new_player_shoe" };
  }

  const shoe = row.shoe_state;
  if (!shouldReshuffleBeforeHand(shoe, config)) {
    return { shoe, shuffled: false, shuffleReason: null };
  }

  await client.query(
    `
      UPDATE tower_shoe
      SET status = 'retired', retired_at = now(), retirement_reason = 'penetration_threshold'
      WHERE id = $1
    `,
    [shoe.id]
  );
  const nextShoe = createTowerShoe({ config, reason: "penetration_threshold" });
  await saveShoe(client, userId, nextShoe);
  return { shoe: nextShoe, shuffled: true, shuffleReason: "penetration_threshold" };
};

const insertCardEvent = async (
  client: pg.PoolClient,
  handId: string,
  entry: TowerHandCard,
  actionType: string,
  resultingHeight: number | null = null,
  resultingTotal: number | null = null
) => {
  await client.query(
    `
      INSERT INTO tower_hand_event (
        id, hand_id, sequence_number, actor, action_type, card_id, rank, suit, value,
        face_up, publicly_revealed, caused_collapse, previous_card_value,
        resulting_height, resulting_total
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (hand_id, sequence_number) DO NOTHING
    `,
    [
      randomUUID(),
      handId,
      entry.sequenceNumber,
      entry.actor,
      actionType,
      entry.card.id,
      entry.card.rank,
      entry.card.suit,
      entry.card.value,
      entry.faceUp,
      entry.faceUp,
      entry.causedCollapse,
      entry.previousCardValue,
      resultingHeight,
      resultingTotal
    ]
  );
};

const insertSystemEvent = async (
  client: pg.PoolClient,
  handId: string,
  sequenceNumber: number,
  actionType: string,
  metadata: Record<string, unknown> = {}
) => {
  await client.query(
    `
      INSERT INTO tower_hand_event (id, hand_id, sequence_number, actor, action_type, metadata)
      VALUES ($1, $2, $3, 'system', $4, $5)
      ON CONFLICT (hand_id, sequence_number) DO NOTHING
    `,
    [randomUUID(), handId, sequenceNumber, actionType, JSON.stringify(metadata)]
  );
};

const insertWagerEvent = async (
  client: pg.PoolClient,
  handId: string,
  wagerType: TowerWagerType,
  eventType: "placed" | "doubled" | "won" | "lost" | "pushed" | "refunded",
  amountCents: number,
  balanceBeforeCents: number,
  balanceAfterCents: number
) => {
  await client.query(
    `
      INSERT INTO tower_wager_event (
        id, hand_id, wager_type, event_type, amount_cents, balance_before_cents, balance_after_cents
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [randomUUID(), handId, wagerType, eventType, amountCents, balanceBeforeCents, balanceAfterCents]
  );
};

const resultEventType = (result: TowerResult): "won" | "lost" | "pushed" | "refunded" => {
  if (result === "won") return "won";
  if (result === "push") return "pushed";
  if (result === "void") return "refunded";
  return "lost";
};

const syncHand = async (
  client: pg.PoolClient,
  userId: string,
  hand: TowerHandState,
  shoe: TowerShoeState,
  endingBalanceCents?: number | null
) => {
  await saveShoe(client, userId, shoe);
  await client.query(
    `
      UPDATE tower_hand
      SET status = $2,
          hand_state = $3,
          ending_balance_cents = COALESCE($4, ending_balance_cents),
          final_value_wager_cents = $5,
          final_height_wager_cents = $6,
          player_height = $7,
          player_value = $8,
          dealer_height = $9,
          dealer_value = $10,
          player_collapsed = $11,
          dealer_collapsed = $12,
          value_result = $13,
          height_result = $14,
          value_payout_cents = $15,
          height_payout_cents = $16,
          dealer_opening_rank = $17,
          dealer_opening_value = $18,
          action_version = $19,
          completed_at = $20
      WHERE id = $1
    `,
    [
      hand.id,
      hand.status,
      JSON.stringify(hand),
      endingBalanceCents ?? null,
      hand.valueWagerCents,
      hand.heightWagerCents,
      towerHeight(hand.playerCards),
      towerValue(hand.playerCards),
      hand.dealerCards.every((entry) => entry.faceUp) ? towerHeight(hand.dealerCards) : 0,
      hand.dealerCards.every((entry) => entry.faceUp) ? towerValue(hand.dealerCards) : 0,
      hand.playerCollapsed,
      hand.dealerCollapsed,
      hand.valueResult,
      hand.heightResult,
      hand.valuePayoutCents,
      hand.heightPayoutCents,
      hand.dealerCards[0]?.faceUp ? hand.dealerCards[0].card.rank : null,
      hand.dealerCards[0]?.faceUp ? hand.dealerCards[0].card.value : null,
      hand.actionVersion,
      hand.completedAt
    ]
  );
};

const applySettlementBalance = async (client: pg.PoolClient, hand: TowerHandState, weeklyEntryId: string) => {
  const payoutCents = hand.valuePayoutCents + hand.heightPayoutCents;
  const locked = await client.query<{ balance_cents: number }>(
    "SELECT balance_cents FROM weekly_entry WHERE id = $1 FOR UPDATE",
    [weeklyEntryId]
  );
  const before = locked.rows[0].balance_cents;
  if (payoutCents > 0) {
    await client.query(
      `
        UPDATE weekly_entry
        SET balance_cents = balance_cents + $1,
            settled_profit_cents = settled_profit_cents + $2
        WHERE id = $3
      `,
      [
        payoutCents,
        payoutCents - hand.valueWagerCents - hand.heightWagerCents,
        weeklyEntryId
      ]
    );
  } else if (hand.status === "settled") {
    await client.query(
      "UPDATE weekly_entry SET settled_profit_cents = settled_profit_cents - $1 WHERE id = $2",
      [hand.valueWagerCents + hand.heightWagerCents, weeklyEntryId]
    );
  }
  const after = before + payoutCents;
  if (hand.valueWagerCents > 0) {
    await insertWagerEvent(client, hand.id, "value", resultEventType(hand.valueResult), hand.valuePayoutCents, before, before + hand.valuePayoutCents);
  }
  if (hand.heightWagerCents > 0) {
    await insertWagerEvent(client, hand.id, "height", resultEventType(hand.heightResult), hand.heightPayoutCents, before + hand.valuePayoutCents, after);
  }
  return after;
};

const toPublicHand = (hand: TowerHandState | null) => {
  if (!hand) return null;
  const dealerRevealed = hand.dealerCards.every((entry) => entry.faceUp);
  const playerHeight = towerHeight(hand.playerCards);
  const currentBand = playerHeight >= defaultTowerConfig.heightQualificationMinCards
    ? heightPayoutFor(playerHeight, defaultTowerConfig)
    : null;
  return {
    id: hand.id,
    status: hand.status,
    actionVersion: hand.actionVersion,
    playerCards: hand.playerCards.map(publicCard),
    dealerCards: hand.dealerCards.map(publicCard),
    playerHeight,
    playerValue: towerValue(hand.playerCards),
    dealerHeight: dealerRevealed ? towerHeight(hand.dealerCards) : null,
    dealerValue: dealerRevealed ? towerValue(hand.dealerCards) : null,
    playerCollapsed: hand.playerCollapsed,
    dealerCollapsed: dealerRevealed ? hand.dealerCollapsed : false,
    doubleOpportunity: hand.doubleOpportunity,
    doubleOpportunityRank: hand.doubleOpportunityRank,
    valueWagerCents: hand.valueWagerCents,
    heightWagerCents: hand.heightWagerCents,
    originalValueWagerCents: hand.originalValueWagerCents,
    originalHeightWagerCents: hand.originalHeightWagerCents,
    valueResult: hand.valueResult,
    heightResult: hand.heightResult,
    valuePayoutCents: hand.valuePayoutCents,
    heightPayoutCents: hand.heightPayoutCents,
    heightQualified: isHeightQualified(hand, defaultTowerConfig),
    currentHeightPayoutBand: currentBand,
    nextHeightPayoutBand: nextHeightPayoutFor(playerHeight, defaultTowerConfig),
    dealerOpeningRankCategory: dealerRevealed ? hand.dealerOpeningRankCategory : null,
    completedAt: hand.completedAt
  };
};

const getActiveHand = async (client: pg.PoolClient, userId: string) => {
  const result = await client.query<DbTowerHand>(
    `
      SELECT id, user_id, weekly_entry_id, shoe_id, status, hand_state, configuration_version_id, action_version
      FROM tower_hand
      WHERE user_id = $1 AND status = ANY($2)
      ORDER BY started_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [userId, nonTerminalStatuses]
  );
  return result.rows[0] ?? null;
};

const getLockedHand = async (client: pg.PoolClient, userId: string, handId: string, actionVersion: number) => {
  const result = await client.query<DbTowerHand>(
    `
      SELECT id, user_id, weekly_entry_id, shoe_id, status, hand_state, configuration_version_id, action_version
      FROM tower_hand
      WHERE id = $1 AND user_id = $2
      FOR UPDATE
    `,
    [handId, userId]
  );
  const row = result.rows[0];
  if (!row) throw new TowerError("Tower hand not found", 404);
  if (row.hand_state.actionVersion !== actionVersion) {
    throw new TowerError("Tower action version has changed. Refresh the hand before retrying.", 409);
  }
  return row;
};

const getLockedShoe = async (client: pg.PoolClient, shoeId: string) => {
  const result = await client.query<DbTowerShoe>(
    "SELECT id, user_id, status, shoe_state FROM tower_shoe WHERE id = $1 FOR UPDATE",
    [shoeId]
  );
  const row = result.rows[0];
  if (!row) throw new TowerError("Tower shoe not found", 404);
  return row.shoe_state;
};

export const getTowerState = async (userId: string) => transaction(async (client) => {
  const entry = await getLockedWeeklyEntry(client, userId);
  const activeHand = await getActiveHand(client, userId);
  const activeShoe = await client.query<DbTowerShoe>(
    `
      SELECT id, user_id, status, shoe_state
      FROM tower_shoe
      WHERE user_id = $1 AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId]
  );
  const shoe = activeShoe.rows[0]?.shoe_state ?? null;
  return {
    balanceCents: entry.balance_cents,
    hand: toPublicHand(activeHand?.hand_state ?? null),
    counter: shoe ? publicShoeCounter(shoe, activeHand ? hiddenCardsInPlay(activeHand.hand_state) : 0) : null,
    config: (await getActiveTowerConfig(client)).config,
    history: await getRecentTowerHands(userId, client)
  };
});

export const startTowerHandForUser = async ({
  userId,
  valueWagerCents,
  heightWagerCents
}: {
  userId: string;
  valueWagerCents: number;
  heightWagerCents: number;
}) => transaction(async (client) => {
  const existingHand = await getActiveHand(client, userId);
  if (existingHand) throw new TowerError("Finish the current Tower hand before starting another.", 409);

  const activeConfig = await getActiveTowerConfig(client);
  const entry = await getLockedWeeklyEntry(client, userId);
  const totalStakeCents = valueWagerCents + heightWagerCents;
  if (entry.balance_cents < totalStakeCents) throw new TowerError("Insufficient play-money balance for Tower wager.", 400);

  const shoeResult = await getOrCreateActiveShoe(client, userId, activeConfig.config);
  const started = startTowerHand({
    shoe: shoeResult.shoe,
    valueWagerCents,
    heightWagerCents,
    config: activeConfig.config
  });
  const afterStakeBalance = entry.balance_cents - totalStakeCents;
  await client.query("UPDATE weekly_entry SET balance_cents = balance_cents - $1 WHERE id = $2", [totalStakeCents, entry.id]);
  await saveShoe(client, userId, started.shoe);

  await client.query(
    `
      INSERT INTO tower_hand (
        id, user_id, weekly_entry_id, shoe_id, status, hand_state, starting_balance_cents,
        original_value_wager_cents, original_height_wager_cents, final_value_wager_cents,
        final_height_wager_cents, player_height, player_value, dealer_height, dealer_value,
        player_collapsed, dealer_collapsed, value_result, height_result, value_payout_cents,
        height_payout_cents, configuration_version_id, action_version
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, $15,
        false, $16, 'pending', 'pending', 0, 0, $17, $18
      )
    `,
    [
      started.hand.id,
      userId,
      entry.id,
      started.shoe.id,
      started.hand.status,
      JSON.stringify(started.hand),
      entry.balance_cents,
      started.hand.originalValueWagerCents,
      started.hand.originalHeightWagerCents,
      started.hand.valueWagerCents,
      started.hand.heightWagerCents,
      towerHeight(started.hand.playerCards),
      towerValue(started.hand.playerCards),
      towerHeight(started.hand.dealerCards),
      towerValue(started.hand.dealerCards),
      started.hand.dealerCollapsed,
      activeConfig.id,
      started.hand.actionVersion
    ]
  );

  if (shoeResult.shuffled) {
    await insertSystemEvent(client, started.hand.id, 0, "shoe_shuffled", {
      shoeId: started.shoe.id,
      reason: shoeResult.shuffleReason,
      commitment: started.shoe.shuffleCommitment
    });
  }
  for (const dealerCard of started.hand.dealerCards) {
    const dealerCardsThroughEvent = started.hand.dealerCards.filter((entry) => entry.sequenceNumber <= dealerCard.sequenceNumber);
    await insertCardEvent(
      client,
      started.hand.id,
      dealerCard,
      dealerCard.sequenceNumber === 1
        ? "dealer_initial_deal"
        : dealerCard.causedCollapse ? "dealer_build_collapse" : "dealer_build",
      towerHeight(dealerCardsThroughEvent),
      towerValue(dealerCardsThroughEvent)
    );
  }
  await insertCardEvent(client, started.hand.id, started.hand.playerCards[0], "player_initial_deal", 1, towerValue(started.hand.playerCards));
  if (valueWagerCents > 0) {
    await insertWagerEvent(client, started.hand.id, "value", "placed", valueWagerCents, entry.balance_cents, entry.balance_cents - valueWagerCents);
  }
  if (heightWagerCents > 0) {
    await insertWagerEvent(client, started.hand.id, "height", "placed", heightWagerCents, entry.balance_cents - valueWagerCents, afterStakeBalance);
  }

  console.info("Tower hand started", { handId: started.hand.id, userId, shoeId: started.shoe.id, totalStakeCents });
  return {
    balanceCents: afterStakeBalance,
    hand: toPublicHand(started.hand),
    counter: publicShoeCounter(started.shoe, hiddenCardsInPlay(started.hand))
  };
});

export const buildTowerHandForUser = async ({
  userId,
  handId,
  actionVersion
}: {
  userId: string;
  handId: string;
  actionVersion: number;
}) => transaction(async (client) => {
  const row = await getLockedHand(client, userId, handId, actionVersion);
  const shoe = await getLockedShoe(client, row.shoe_id);
  const activeConfig = await getActiveTowerConfig(client);
  const built = playerBuild(row.hand_state, shoe, activeConfig.config);
  const latestPlayerCard = built.hand.playerCards[built.hand.playerCards.length - 1];
  await saveShoe(client, userId, built.shoe);
  await insertCardEvent(
    client,
    built.hand.id,
    latestPlayerCard,
    latestPlayerCard.causedCollapse ? "build_collapse" : "build",
    towerHeight(built.hand.playerCards),
    towerValue(built.hand.playerCards)
  );

  let endingBalance: number | null = null;
  if (built.hand.status === "settled") {
    endingBalance = await applySettlementBalance(client, built.hand, row.weekly_entry_id);
  }
  await syncHand(client, userId, built.hand, built.shoe, endingBalance);
  return {
    balanceCents: endingBalance,
    hand: toPublicHand(built.hand),
    counter: publicShoeCounter(built.shoe, hiddenCardsInPlay(built.hand))
  };
});

export const doubleTowerHandForUser = async ({
  userId,
  handId,
  actionVersion,
  doubleValue,
  doubleHeight
}: {
  userId: string;
  handId: string;
  actionVersion: number;
  doubleValue: boolean;
  doubleHeight: boolean;
}) => transaction(async (client) => {
  const row = await getLockedHand(client, userId, handId, actionVersion);
  const entry = await getLockedWeeklyEntry(client, userId);
  const activeConfig = await getActiveTowerConfig(client);
  const doubled = applyDoubleDecision({
    hand: row.hand_state,
    doubleValue,
    doubleHeight,
    availableBalanceCents: entry.balance_cents,
    config: activeConfig.config
  });
  const afterBalance = entry.balance_cents - doubled.addedExposure;
  if (doubled.addedExposure > 0) {
    await client.query("UPDATE weekly_entry SET balance_cents = balance_cents - $1 WHERE id = $2", [doubled.addedExposure, entry.id]);
  }
  if (doubleValue && row.hand_state.originalValueWagerCents > 0) {
    await insertWagerEvent(client, row.id, "value", "doubled", row.hand_state.originalValueWagerCents, entry.balance_cents, entry.balance_cents - row.hand_state.originalValueWagerCents);
  }
  if (doubleHeight && row.hand_state.originalHeightWagerCents > 0) {
    await insertWagerEvent(client, row.id, "height", "doubled", row.hand_state.originalHeightWagerCents, entry.balance_cents - (doubleValue ? row.hand_state.originalValueWagerCents : 0), afterBalance);
  }
  await insertSystemEvent(client, row.id, doubled.hand.playerCards.length + doubled.hand.dealerCards.length + 1, "double_decision", {
    doubleValue,
    doubleHeight,
    addedExposureCents: doubled.addedExposure
  });
  await syncHand(client, userId, doubled.hand, await getLockedShoe(client, row.shoe_id), null);
  return {
    balanceCents: afterBalance,
    hand: toPublicHand(doubled.hand)
  };
});

export const capTowerHandForUser = async ({
  userId,
  handId,
  actionVersion
}: {
  userId: string;
  handId: string;
  actionVersion: number;
}) => transaction(async (client) => {
  const row = await getLockedHand(client, userId, handId, actionVersion);
  const activeConfig = await getActiveTowerConfig(client);
  const shoe = await getLockedShoe(client, row.shoe_id);
  const capped = playerCap(row.hand_state, shoe, activeConfig.config);
  await saveShoe(client, userId, capped.shoe);

  const endingBalance = await applySettlementBalance(client, capped.hand, row.weekly_entry_id);
  await syncHand(client, userId, capped.hand, capped.shoe, endingBalance);
  return {
    balanceCents: endingBalance,
    hand: toPublicHand(capped.hand),
    counter: publicShoeCounter(capped.shoe, hiddenCardsInPlay(capped.hand))
  };
});

const emptyResultCounts = (): Record<TowerResult, number> => ({
  pending: 0,
  won: 0,
  lost: 0,
  push: 0,
  void: 0
});

export const simulateTowerHandsForUser = async ({
  userId,
  valueWagerCents,
  heightWagerCents,
  hands
}: {
  userId: string;
  valueWagerCents: number;
  heightWagerCents: number;
  hands: number;
}) => {
  const summary = {
    requestedHands: hands,
    completedHands: 0,
    valueResults: emptyResultCounts(),
    heightResults: emptyResultCounts(),
    playerCollapses: 0,
    dealerCollapses: 0,
    playerValueTotal: 0,
    dealerValueTotal: 0,
    avgPlayerValue: null as number | null,
    avgDealerValue: null as number | null,
    balanceCents: 0
  };

  for (let index = 0; index < hands; index += 1) {
    let result = await startTowerHandForUser({ userId, valueWagerCents, heightWagerCents });
    let hand = result.hand;
    if (!hand) throw new TowerError("Tower simulator could not start a hand.", 500);

    while (hand.status !== "settled") {
      if (hand.status === "awaiting_double_decision") {
        let doubleResult;
        try {
          doubleResult = await doubleTowerHandForUser({
            userId,
            handId: hand.id,
            actionVersion: hand.actionVersion,
            doubleValue: hand.originalValueWagerCents > 0,
            doubleHeight: false
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (!message.includes("Tower exposure is above maximum") && !message.includes("Insufficient balance for Tower double")) {
            throw error;
          }
          doubleResult = await doubleTowerHandForUser({
            userId,
            handId: hand.id,
            actionVersion: hand.actionVersion,
            doubleValue: false,
            doubleHeight: false
          });
        }
        hand = doubleResult.hand;
        if (!hand) throw new TowerError("Tower simulator lost hand state after double.", 500);
        continue;
      }

      if (hand.status !== "player_turn") {
        throw new TowerError(`Tower simulator reached unsupported hand state: ${hand.status}`, 409);
      }

      const latestPlayerCard = hand.playerCards[hand.playerCards.length - 1];
      if (typeof latestPlayerCard?.value === "number" && latestPlayerCard.value <= 8) {
        const buildResult = await buildTowerHandForUser({
          userId,
          handId: hand.id,
          actionVersion: hand.actionVersion
        });
        hand = buildResult.hand;
        if (!hand) throw new TowerError("Tower simulator lost hand state after build.", 500);
        continue;
      }

      const capResult = await capTowerHandForUser({
        userId,
        handId: hand.id,
        actionVersion: hand.actionVersion
      });
      hand = capResult.hand;
      if (!hand) throw new TowerError("Tower simulator lost hand state after cap.", 500);
    }

    summary.completedHands += 1;
    summary.valueResults[hand.valueResult] += 1;
    summary.heightResults[hand.heightResult] += 1;
    if (hand.playerCollapsed) summary.playerCollapses += 1;
    if (hand.dealerCollapsed) summary.dealerCollapses += 1;
    summary.playerValueTotal += hand.playerValue;
    summary.dealerValueTotal += hand.dealerValue ?? 0;
  }

  if (summary.completedHands > 0) {
    summary.avgPlayerValue = summary.playerValueTotal / summary.completedHands;
    summary.avgDealerValue = summary.dealerValueTotal / summary.completedHands;
  }
  const state = await getTowerState(userId);
  summary.balanceCents = state.balanceCents;

  return {
    simulation: {
      requestedHands: summary.requestedHands,
      completedHands: summary.completedHands,
      valueResults: summary.valueResults,
      heightResults: summary.heightResults,
      playerCollapses: summary.playerCollapses,
      dealerCollapses: summary.dealerCollapses,
      avgPlayerValue: summary.avgPlayerValue,
      avgDealerValue: summary.avgDealerValue,
      balanceCents: summary.balanceCents
    },
    state
  };
};

export const getRecentTowerHands = async (userId: string, client?: pg.PoolClient) => {
  const result = client
    ? await client.query<{
    id: string;
    status: string;
    hand_state: TowerHandState;
    original_value_wager_cents: number;
    original_height_wager_cents: number;
    final_value_wager_cents: number;
    final_height_wager_cents: number;
    value_result: TowerResult;
    height_result: TowerResult;
    value_payout_cents: number;
    height_payout_cents: number;
    started_at: string;
    completed_at: string | null;
  }>(
    `
      SELECT id, status, hand_state, original_value_wager_cents, original_height_wager_cents,
             final_value_wager_cents, final_height_wager_cents, value_result, height_result,
             value_payout_cents, height_payout_cents, started_at, completed_at
      FROM tower_hand
      WHERE user_id = $1
      ORDER BY started_at DESC
      LIMIT 20
    `,
    [userId]
  )
    : await query<{
      id: string;
      status: string;
      hand_state: TowerHandState;
      original_value_wager_cents: number;
      original_height_wager_cents: number;
      final_value_wager_cents: number;
      final_height_wager_cents: number;
      value_result: TowerResult;
      height_result: TowerResult;
      value_payout_cents: number;
      height_payout_cents: number;
      started_at: string;
      completed_at: string | null;
    }>(
      `
        SELECT id, status, hand_state, original_value_wager_cents, original_height_wager_cents,
               final_value_wager_cents, final_height_wager_cents, value_result, height_result,
               value_payout_cents, height_payout_cents, started_at, completed_at
        FROM tower_hand
        WHERE user_id = $1
        ORDER BY started_at DESC
        LIMIT 20
      `,
      [userId]
    );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    playerCards: row.hand_state.playerCards.map(publicCard),
    dealerCards: row.hand_state.dealerCards.map(publicCard),
    playerHeight: towerHeight(row.hand_state.playerCards),
    playerValue: towerValue(row.hand_state.playerCards),
    dealerHeight: row.hand_state.dealerCards.every((entry) => entry.faceUp) ? towerHeight(row.hand_state.dealerCards) : null,
    dealerValue: row.hand_state.dealerCards.every((entry) => entry.faceUp) ? towerValue(row.hand_state.dealerCards) : null,
    valueWagerCents: row.final_value_wager_cents,
    heightWagerCents: row.final_height_wager_cents,
    valueResult: row.value_result,
    heightResult: row.height_result,
    valuePayoutCents: row.value_payout_cents,
    heightPayoutCents: row.height_payout_cents,
    startedAt: row.started_at,
    completedAt: row.completed_at
  }));
};

export const getTowerAnalytics = async () => {
  const weekStart = currentWeekStart();
  const result = await query<{
    total_hands: string;
    active_users: string;
    avg_value_wager_cents: string | null;
    avg_height_wager_cents: string | null;
    avg_player_height: string | null;
    avg_player_value: string | null;
    player_collapses: string;
    dealer_collapses: string;
    value_wins: string;
    value_losses: string;
    value_pushes: string;
    height_wins: string;
    height_losses: string;
  }>(
    `
      SELECT
        COUNT(*) AS total_hands,
        COUNT(DISTINCT user_id) AS active_users,
        AVG(NULLIF(final_value_wager_cents, 0)) AS avg_value_wager_cents,
        AVG(NULLIF(final_height_wager_cents, 0)) AS avg_height_wager_cents,
        AVG(player_height) AS avg_player_height,
        AVG(player_value) AS avg_player_value,
        COUNT(*) FILTER (WHERE player_collapsed) AS player_collapses,
        COUNT(*) FILTER (WHERE dealer_collapsed) AS dealer_collapses,
        COUNT(*) FILTER (WHERE value_result = 'won') AS value_wins,
        COUNT(*) FILTER (WHERE value_result = 'lost') AS value_losses,
        COUNT(*) FILTER (WHERE value_result = 'push') AS value_pushes,
        COUNT(*) FILTER (WHERE height_result = 'won') AS height_wins,
        COUNT(*) FILTER (WHERE height_result = 'lost') AS height_losses
      FROM tower_hand
      WHERE started_at >= $1::date
    `,
    [weekStart]
  );
  return result.rows[0];
};
