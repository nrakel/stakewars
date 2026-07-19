import { createHash, randomInt, randomUUID } from "node:crypto";

export type TowerRank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";
export type TowerSuit = "hearts" | "diamonds" | "clubs" | "spades";
export type TowerActor = "player" | "dealer";
export type TowerWagerType = "value" | "height";
export type TowerResult = "pending" | "won" | "lost" | "push" | "void";
export type TowerHandStatus =
  | "awaiting_wager"
  | "player_turn"
  | "awaiting_double_decision"
  | "player_capped"
  | "player_collapsed"
  | "dealer_turn"
  | "settled"
  | "voided";

export type TowerCard = {
  id: string;
  rank: TowerRank;
  suit: TowerSuit;
  value: number;
  deckIndex: number;
};

export type TowerPayoutRatio = {
  numerator: number;
  denominator: number;
};

export type TowerPayoutBand = {
  minHeight: number;
  maxHeight: number | null;
  payout: TowerPayoutRatio;
};

export type TowerConfig = {
  version: string;
  deckCount: number;
  shufflePenetrationRemainingCards: number;
  minWagerCents: number;
  maxWagerCents: number;
  defaultWagerCents: number;
  maxExposureCents: number;
  valuePayout: TowerPayoutRatio;
  valueTieRule: "push" | "dealer_wins" | "player_wins";
  heightQualificationMinCards: number;
  heightPayouts: TowerPayoutBand[];
  dealer: {
    minimumHeight: number;
    buildThroughValue: number;
    stopAtValue: number;
    dealerCollapsePaysValue: boolean;
    dealerCollapsePaysQualifiedHeight: boolean;
    highOpeningRuleEnabled: boolean;
  };
};

export type TowerShoeState = {
  id: string;
  cards: TowerCard[];
  position: number;
  initialCardCount: number;
  publiclyRevealedCardIds: string[];
  createdAt: string;
  shuffledAt: string;
  shuffleReason: string;
  status: "active" | "retired";
  shuffleCommitment: string;
};

export type TowerHandCard = {
  card: TowerCard;
  actor: TowerActor;
  faceUp: boolean;
  causedCollapse: boolean;
  previousCardValue: number | null;
  sequenceNumber: number;
};

export type TowerHandState = {
  id: string;
  status: TowerHandStatus;
  shoeId: string;
  playerCards: TowerHandCard[];
  dealerCards: TowerHandCard[];
  valueWagerCents: number;
  heightWagerCents: number;
  originalValueWagerCents: number;
  originalHeightWagerCents: number;
  playerCollapsed: boolean;
  dealerCollapsed: boolean;
  doubleOpportunity: boolean;
  doubleOpportunityRank: TowerRank | null;
  valueResult: TowerResult;
  heightResult: TowerResult;
  valuePayoutCents: number;
  heightPayoutCents: number;
  dealerOpeningRankCategory: "J" | "Q" | "K" | "lower_than_jack" | null;
  actionVersion: number;
  completedAt: string | null;
};

export type TowerSettlement = {
  valueResult: TowerResult;
  heightResult: TowerResult;
  valuePayoutCents: number;
  heightPayoutCents: number;
  valueProfitCents: number;
  heightProfitCents: number;
};

export type TowerPublicCounter = {
  exactCards: Array<{ rank: TowerRank; suit: TowerSuit; remainingUnseen: number }>;
  ranks: Array<{ rank: TowerRank; value: number; remainingUnseen: number }>;
  totalPubliclyUnseenCards: number;
  totalPhysicallyUndealtCards: number;
  hiddenCardsInPlay: number;
};

export const towerRanks: TowerRank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
export const towerSuits: TowerSuit[] = ["hearts", "diamonds", "clubs", "spades"];

export const rankValue = (rank: TowerRank) => {
  if (rank === "A") return 1;
  if (rank === "J") return 11;
  if (rank === "Q") return 12;
  if (rank === "K") return 13;
  return Number(rank);
};

export const defaultTowerConfig: TowerConfig = {
  version: "tower-height-payout-v2",
  deckCount: 6,
  shufflePenetrationRemainingCards: 78,
  minWagerCents: 100,
  maxWagerCents: 10_000,
  defaultWagerCents: 500,
  maxExposureCents: 40_000,
  valuePayout: { numerator: 1, denominator: 1 },
  valueTieRule: "push",
  heightQualificationMinCards: 3,
  heightPayouts: [
    { minHeight: 3, maxHeight: 3, payout: { numerator: 5, denominator: 1 } },
    { minHeight: 4, maxHeight: 4, payout: { numerator: 10, denominator: 1 } },
    { minHeight: 5, maxHeight: 5, payout: { numerator: 20, denominator: 1 } },
    { minHeight: 6, maxHeight: 6, payout: { numerator: 40, denominator: 1 } },
    { minHeight: 7, maxHeight: 7, payout: { numerator: 75, denominator: 1 } },
    { minHeight: 8, maxHeight: null, payout: { numerator: 150, denominator: 1 } }
  ],
  dealer: {
    minimumHeight: 2,
    buildThroughValue: 7,
    stopAtValue: 8,
    dealerCollapsePaysValue: true,
    dealerCollapsePaysQualifiedHeight: true,
    highOpeningRuleEnabled: false
  }
};

export const createSixDeckCards = (deckCount = 6): TowerCard[] => {
  const cards: TowerCard[] = [];
  for (let deckIndex = 0; deckIndex < deckCount; deckIndex += 1) {
    for (const suit of towerSuits) {
      for (const rank of towerRanks) {
        cards.push({
          id: `${deckIndex + 1}-${rank}-${suit}`,
          rank,
          suit,
          value: rankValue(rank),
          deckIndex
        });
      }
    }
  }
  return cards;
};

export const secureShuffle = <T>(items: T[], randomIndex: (exclusiveMax: number) => number = randomInt) => {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
};

export const createTowerShoe = ({
  config = defaultTowerConfig,
  reason = "new_shoe",
  randomIndex
}: {
  config?: TowerConfig;
  reason?: string;
  randomIndex?: (exclusiveMax: number) => number;
} = {}): TowerShoeState => {
  const now = new Date().toISOString();
  const cards = secureShuffle(createSixDeckCards(config.deckCount), randomIndex);
  const commitment = createHash("sha256")
    .update(JSON.stringify({ cards: cards.map((card) => card.id), createdAt: now, reason }))
    .digest("hex");

  return {
    id: randomUUID(),
    cards,
    position: 0,
    initialCardCount: cards.length,
    publiclyRevealedCardIds: [],
    createdAt: now,
    shuffledAt: now,
    shuffleReason: reason,
    status: "active",
    shuffleCommitment: commitment
  };
};

export const shouldReshuffleBeforeHand = (shoe: Pick<TowerShoeState, "cards" | "position">, config = defaultTowerConfig) =>
  shoe.cards.length - shoe.position < config.shufflePenetrationRemainingCards;

export const dealFromShoe = (shoe: TowerShoeState) => {
  const card = shoe.cards[shoe.position];
  if (!card) {
    throw new Error("Shoe is exhausted");
  }
  return {
    card,
    shoe: { ...shoe, position: shoe.position + 1 }
  };
};

export const revealCard = (shoe: TowerShoeState, card: TowerCard) =>
  shoe.publiclyRevealedCardIds.includes(card.id)
    ? shoe
    : { ...shoe, publiclyRevealedCardIds: [...shoe.publiclyRevealedCardIds, card.id] };

export const towerHeight = (cards: TowerHandCard[]) => cards.length;
export const towerValue = (cards: TowerHandCard[]) => cards.reduce((total, entry) => total + entry.card.value, 0);
export const lastTowerCard = (cards: TowerHandCard[]) => cards[cards.length - 1]?.card ?? null;
export const isHeightQualified = (hand: Pick<TowerHandState, "playerCards">, config = defaultTowerConfig) =>
  towerHeight(hand.playerCards) >= config.heightQualificationMinCards;

export const appendTowerCard = ({
  cards,
  card,
  actor,
  faceUp,
  sequenceNumber
}: {
  cards: TowerHandCard[];
  card: TowerCard;
  actor: TowerActor;
  faceUp: boolean;
  sequenceNumber: number;
}) => {
  const previous = lastTowerCard(cards);
  const causedCollapse = Boolean(previous && card.value < previous.value);
  return {
    card,
    actor,
    faceUp,
    causedCollapse,
    previousCardValue: previous?.value ?? null,
    sequenceNumber
  };
};

export const hasDoubleOpportunity = (cards: TowerHandCard[]) => {
  if (cards.length < 2) return false;
  const current = cards[cards.length - 1].card;
  const previous = cards[cards.length - 2].card;
  return current.value === previous.value;
};

export const openingRankCategory = (rank: TowerRank): TowerHandState["dealerOpeningRankCategory"] => {
  if (rank === "J" || rank === "Q" || rank === "K") return rank;
  return "lower_than_jack";
};

export const startTowerHand = ({
  shoe,
  valueWagerCents,
  heightWagerCents,
  config = defaultTowerConfig
}: {
  shoe: TowerShoeState;
  valueWagerCents: number;
  heightWagerCents: number;
  config?: TowerConfig;
}) => {
  validateInitialWagers(valueWagerCents, heightWagerCents, config);
  let nextShoe = shoe;
  const playerDeal = dealFromShoe(nextShoe);
  nextShoe = revealCard(playerDeal.shoe, playerDeal.card);
  const dealerDeal = dealFromShoe(nextShoe);
  nextShoe = dealerDeal.shoe;

  const hand: TowerHandState = {
    id: randomUUID(),
    status: "player_turn",
    shoeId: shoe.id,
    playerCards: [appendTowerCard({
      cards: [],
      card: playerDeal.card,
      actor: "player",
      faceUp: true,
      sequenceNumber: 1
    })],
    dealerCards: [appendTowerCard({
      cards: [],
      card: dealerDeal.card,
      actor: "dealer",
      faceUp: false,
      sequenceNumber: 2
    })],
    valueWagerCents,
    heightWagerCents,
    originalValueWagerCents: valueWagerCents,
    originalHeightWagerCents: heightWagerCents,
    playerCollapsed: false,
    dealerCollapsed: false,
    doubleOpportunity: false,
    doubleOpportunityRank: null,
    valueResult: "pending",
    heightResult: "pending",
    valuePayoutCents: 0,
    heightPayoutCents: 0,
    dealerOpeningRankCategory: openingRankCategory(dealerDeal.card.rank),
    actionVersion: 1,
    completedAt: null
  };

  return { hand, shoe: nextShoe };
};

export const validateInitialWagers = (valueWagerCents: number, heightWagerCents: number, config = defaultTowerConfig) => {
  if (valueWagerCents <= 0 && heightWagerCents <= 0) {
    throw new Error("At least one Tower wager is required");
  }
  for (const amount of [valueWagerCents, heightWagerCents]) {
    if (amount === 0) continue;
    if (amount < config.minWagerCents) throw new Error("Tower wager is below minimum");
    if (amount > config.maxWagerCents) throw new Error("Tower wager is above maximum");
  }
  if (valueWagerCents + heightWagerCents > config.maxExposureCents) {
    throw new Error("Tower exposure is above maximum");
  }
};

export const playerBuild = (hand: TowerHandState, shoe: TowerShoeState) => {
  if (hand.status !== "player_turn") {
    throw new Error("BUILD is only allowed during player turn");
  }
  const dealt = dealFromShoe(shoe);
  const entry = appendTowerCard({
    cards: hand.playerCards,
    card: dealt.card,
    actor: "player",
    faceUp: true,
    sequenceNumber: hand.playerCards.length + hand.dealerCards.length + 1
  });
  const nextShoe = revealCard(dealt.shoe, dealt.card);
  const playerCards = [...hand.playerCards, entry];
  const collapsed = entry.causedCollapse;
  const doubleOpportunity = !collapsed && hasDoubleOpportunity(playerCards);
  const nextHand: TowerHandState = {
    ...hand,
    playerCards,
    playerCollapsed: collapsed,
    status: collapsed ? "player_collapsed" : doubleOpportunity ? "awaiting_double_decision" : "player_turn",
    doubleOpportunity,
    doubleOpportunityRank: doubleOpportunity ? entry.card.rank : null,
    actionVersion: hand.actionVersion + 1
  };
  return {
    hand: collapsed ? settlePlayerCollapse(nextHand) : nextHand,
    shoe: nextShoe
  };
};

export const applyDoubleDecision = ({
  hand,
  doubleValue,
  doubleHeight,
  availableBalanceCents,
  config = defaultTowerConfig
}: {
  hand: TowerHandState;
  doubleValue: boolean;
  doubleHeight: boolean;
  availableBalanceCents: number;
  config?: TowerConfig;
}) => {
  if (hand.status !== "awaiting_double_decision" || !hand.doubleOpportunity) {
    throw new Error("No double decision is currently available");
  }
  const addedValue = doubleValue && hand.originalValueWagerCents > 0 ? hand.originalValueWagerCents : 0;
  const addedHeight = doubleHeight && hand.originalHeightWagerCents > 0 ? hand.originalHeightWagerCents : 0;
  const addedExposure = addedValue + addedHeight;
  if (addedExposure > availableBalanceCents) {
    throw new Error("Insufficient balance for Tower double");
  }
  if (hand.valueWagerCents + hand.heightWagerCents + addedExposure > config.maxExposureCents) {
    throw new Error("Tower exposure is above maximum");
  }
  return {
    hand: {
      ...hand,
      valueWagerCents: hand.valueWagerCents + addedValue,
      heightWagerCents: hand.heightWagerCents + addedHeight,
      doubleOpportunity: false,
      doubleOpportunityRank: null,
      status: "player_turn" as TowerHandStatus,
      actionVersion: hand.actionVersion + 1
    },
    addedExposure
  };
};

export const playerCap = (hand: TowerHandState, shoe: TowerShoeState, config = defaultTowerConfig) => {
  if (hand.status !== "player_turn") {
    throw new Error("CAP is only allowed during player turn");
  }
  let nextHand: TowerHandState = {
    ...hand,
    status: "dealer_turn",
    doubleOpportunity: false,
    doubleOpportunityRank: null,
    actionVersion: hand.actionVersion + 1
  };
  let nextShoe = revealDealerHoleCard(shoe, nextHand);
  nextHand = {
    ...nextHand,
    dealerCards: nextHand.dealerCards.map((entry) => ({ ...entry, faceUp: true }))
  };

  while (shouldDealerBuild(nextHand, config)) {
    const dealt = dealFromShoe(nextShoe);
    const entry = appendTowerCard({
      cards: nextHand.dealerCards,
      card: dealt.card,
      actor: "dealer",
      faceUp: true,
      sequenceNumber: nextHand.playerCards.length + nextHand.dealerCards.length + 1
    });
    nextShoe = revealCard(dealt.shoe, dealt.card);
    nextHand = {
      ...nextHand,
      dealerCards: [...nextHand.dealerCards, entry],
      dealerCollapsed: entry.causedCollapse
    };
    if (entry.causedCollapse) break;
  }

  return {
    hand: settleStandingHand(nextHand, config),
    shoe: nextShoe
  };
};

export const revealDealerHoleCard = (shoe: TowerShoeState, hand: TowerHandState) => {
  const holeCard = hand.dealerCards[0]?.card;
  return holeCard ? revealCard(shoe, holeCard) : shoe;
};

export const shouldDealerBuild = (hand: TowerHandState, config = defaultTowerConfig) => {
  if (hand.dealerCollapsed) return false;
  if (towerHeight(hand.dealerCards) < config.dealer.minimumHeight) return true;
  const topCard = lastTowerCard(hand.dealerCards);
  if (!topCard) return true;
  if (topCard.value <= config.dealer.buildThroughValue) return true;
  if (topCard.value >= config.dealer.stopAtValue) return false;
  return false;
};

export const payoutProfit = (stakeCents: number, ratio: TowerPayoutRatio) =>
  Math.floor((stakeCents * ratio.numerator) / ratio.denominator);

export const payoutReturn = (stakeCents: number, ratio: TowerPayoutRatio) =>
  stakeCents + payoutProfit(stakeCents, ratio);

export const heightPayoutFor = (height: number, config = defaultTowerConfig) => {
  const band = config.heightPayouts.find((item) =>
    height >= item.minHeight && (item.maxHeight == null || height <= item.maxHeight)
  );
  if (!band) {
    throw new Error(`No Tower height payout configured for ${height}`);
  }
  return band;
};

export const nextHeightPayoutFor = (height: number, config = defaultTowerConfig) => {
  const nextHeight = height + 1;
  return config.heightPayouts.find((item) =>
    nextHeight >= item.minHeight && (item.maxHeight == null || nextHeight <= item.maxHeight)
  ) ?? null;
};

export const settlePlayerCollapse = (hand: TowerHandState): TowerHandState => ({
  ...hand,
  status: "settled",
  playerCollapsed: true,
  valueResult: hand.valueWagerCents > 0 ? "lost" : "void",
  heightResult: hand.heightWagerCents > 0 ? "lost" : "void",
  valuePayoutCents: 0,
  heightPayoutCents: 0,
  completedAt: new Date().toISOString(),
  actionVersion: hand.actionVersion + 1
});

export const settleStandingHand = (hand: TowerHandState, config = defaultTowerConfig): TowerHandState => {
  const settlement = settleTowerWagers(hand, config);
  return {
    ...hand,
    status: "settled",
    ...settlement,
    completedAt: new Date().toISOString(),
    actionVersion: hand.actionVersion + 1
  };
};

export const settleTowerWagers = (hand: TowerHandState, config = defaultTowerConfig): TowerSettlement => {
  if (hand.playerCollapsed) {
    return {
      valueResult: hand.valueWagerCents > 0 ? "lost" : "void",
      heightResult: hand.heightWagerCents > 0 ? "lost" : "void",
      valuePayoutCents: 0,
      heightPayoutCents: 0,
      valueProfitCents: -hand.valueWagerCents,
      heightProfitCents: -hand.heightWagerCents
    };
  }

  const playerTotal = towerValue(hand.playerCards);
  const dealerTotal = towerValue(hand.dealerCards);
  const playerHeight = towerHeight(hand.playerCards);
  const dealerHeight = towerHeight(hand.dealerCards);
  const qualifiedHeight = playerHeight >= config.heightQualificationMinCards;

  let valueResult: TowerResult = "void";
  let heightResult: TowerResult = "void";
  let valuePayoutCents = 0;
  let heightPayoutCents = 0;

  if (hand.valueWagerCents > 0) {
    if (hand.dealerCollapsed && config.dealer.dealerCollapsePaysValue) {
      valueResult = "won";
    } else if (playerTotal > dealerTotal) {
      valueResult = "won";
    } else if (playerTotal < dealerTotal) {
      valueResult = "lost";
    } else {
      valueResult = config.valueTieRule === "push" ? "push" : config.valueTieRule === "player_wins" ? "won" : "lost";
    }
    valuePayoutCents = valueResult === "won"
      ? payoutReturn(hand.valueWagerCents, config.valuePayout)
      : valueResult === "push"
        ? hand.valueWagerCents
        : 0;
  }

  if (hand.heightWagerCents > 0) {
    const winsByDealerCollapse = hand.dealerCollapsed && config.dealer.dealerCollapsePaysQualifiedHeight && qualifiedHeight;
    const winsByComparison = qualifiedHeight && playerHeight > dealerHeight && playerTotal > dealerTotal;
    heightResult = winsByDealerCollapse || winsByComparison ? "won" : "lost";
    heightPayoutCents = heightResult === "won"
      ? payoutReturn(hand.heightWagerCents, heightPayoutFor(playerHeight, config).payout)
      : 0;
  }

  return {
    valueResult,
    heightResult,
    valuePayoutCents,
    heightPayoutCents,
    valueProfitCents: valueResult === "won" ? valuePayoutCents - hand.valueWagerCents : valueResult === "lost" ? -hand.valueWagerCents : 0,
    heightProfitCents: heightResult === "won" ? heightPayoutCents - hand.heightWagerCents : heightResult === "lost" ? -hand.heightWagerCents : 0
  };
};

export const publicShoeCounter = (shoe: TowerShoeState, hiddenCardsInPlay = 0): TowerPublicCounter => {
  const exact = new Map<string, { rank: TowerRank; suit: TowerSuit; remainingUnseen: number }>();
  for (const rank of towerRanks) {
    for (const suit of towerSuits) {
      exact.set(`${rank}-${suit}`, { rank, suit, remainingUnseen: 6 });
    }
  }
  for (const cardId of shoe.publiclyRevealedCardIds) {
    const card = shoe.cards.find((item) => item.id === cardId);
    if (!card) continue;
    const key = `${card.rank}-${card.suit}`;
    const row = exact.get(key);
    if (row) row.remainingUnseen = Math.max(0, row.remainingUnseen - 1);
  }
  const ranks = towerRanks.map((rank) => ({
    rank,
    value: rankValue(rank),
    remainingUnseen: [...exact.values()]
      .filter((item) => item.rank === rank)
      .reduce((total, item) => total + item.remainingUnseen, 0)
  }));
  const exactCards = [...exact.values()];
  return {
    exactCards,
    ranks,
    totalPubliclyUnseenCards: exactCards.reduce((total, item) => total + item.remainingUnseen, 0),
    totalPhysicallyUndealtCards: shoe.cards.length - shoe.position,
    hiddenCardsInPlay
  };
};

export const publicCard = (entry: TowerHandCard) =>
  entry.faceUp
    ? {
      rank: entry.card.rank,
      suit: entry.card.suit,
      value: entry.card.value,
      id: entry.card.id,
      faceUp: true,
      causedCollapse: entry.causedCollapse
    }
    : {
      rank: null,
      suit: null,
      value: null,
      id: null,
      faceUp: false,
      causedCollapse: false
    };

export const hiddenCardsInPlay = (hand: TowerHandState) =>
  [...hand.playerCards, ...hand.dealerCards].filter((entry) => !entry.faceUp).length;
