import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDoubleDecision,
  appendTowerCard,
  createSixDeckCards,
  createTowerShoe,
  defaultTowerConfig,
  dealFromShoe,
  hasDoubleOpportunity,
  heightPayoutFor,
  isHeightQualified,
  playerBuild,
  publicCard,
  publicShoeCounter,
  rankValue,
  revealCard,
  secureShuffle,
  settleTowerWagers,
  shouldDealerBuild,
  shouldReshuffleBeforeHand,
  startTowerHand,
  towerRanks,
  towerSuits,
  type TowerCard,
  type TowerHandCard,
  type TowerHandState,
  type TowerRank,
  type TowerShoeState,
  type TowerSuit
} from "../src/server/tower/engine.ts";

const card = (rank: TowerRank, suit: TowerSuit = "hearts", deckIndex = 0): TowerCard => ({
  id: `${deckIndex + 1}-${rank}-${suit}`,
  rank,
  suit,
  value: rankValue(rank),
  deckIndex
});

const handEntry = (rank: TowerRank, sequenceNumber: number, suit: TowerSuit = "hearts"): TowerHandCard =>
  appendTowerCard({
    cards: [],
    card: card(rank, suit, sequenceNumber),
    actor: "player",
    faceUp: true,
    sequenceNumber
  });

const shoeWith = (cards: TowerCard[]): TowerShoeState => ({
  id: "test-shoe",
  cards,
  position: 0,
  initialCardCount: cards.length,
  publiclyRevealedCardIds: [],
  createdAt: "2026-07-19T00:00:00.000Z",
  shuffledAt: "2026-07-19T00:00:00.000Z",
  shuffleReason: "test",
  status: "active",
  shuffleCommitment: "test"
});

const standingHand = ({
  playerRanks,
  dealerRanks,
  valueWagerCents = 100,
  heightWagerCents = 100,
  dealerCollapsed = false
}: {
  playerRanks: TowerRank[];
  dealerRanks: TowerRank[];
  valueWagerCents?: number;
  heightWagerCents?: number;
  dealerCollapsed?: boolean;
}): TowerHandState => ({
  id: "hand",
  status: "dealer_turn",
  shoeId: "shoe",
  playerCards: playerRanks.map((rank, index) => ({
    ...handEntry(rank, index + 1),
    actor: "player"
  })),
  dealerCards: dealerRanks.map((rank, index) => ({
    ...handEntry(rank, index + 1 + playerRanks.length),
    actor: "dealer"
  })),
  valueWagerCents,
  heightWagerCents,
  originalValueWagerCents: valueWagerCents,
  originalHeightWagerCents: heightWagerCents,
  playerCollapsed: false,
  dealerCollapsed,
  doubleOpportunity: false,
  doubleOpportunityRank: null,
  valueResult: "pending",
  heightResult: "pending",
  valuePayoutCents: 0,
  heightPayoutCents: 0,
  dealerOpeningRankCategory: "lower_than_jack",
  actionVersion: 1,
  completedAt: null
});

test("six-deck shoe composition is complete and stable", () => {
  const cards = createSixDeckCards();
  assert.equal(cards.length, 312);

  for (const rank of towerRanks) {
    const rankCards = cards.filter((item) => item.rank === rank);
    assert.equal(rankCards.length, 24, `${rank} rank count`);
  }

  for (const rank of towerRanks) {
    for (const suit of towerSuits) {
      const exactCards = cards.filter((item) => item.rank === rank && item.suit === suit);
      assert.equal(exactCards.length, 6, `${rank} ${suit} exact count`);
      assert.equal(new Set(exactCards.map((item) => item.id)).size, 6);
    }
  }
});

test("card values map Ace through King", () => {
  const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  assert.deepEqual(towerRanks.map(rankValue), expected);
});

test("secure shuffle preserves every card instance", () => {
  const cards = createSixDeckCards();
  const shuffled = secureShuffle(cards, (max) => max - 1);

  assert.equal(shuffled.length, cards.length);
  assert.deepEqual(
    [...shuffled.map((item) => item.id)].sort(),
    [...cards.map((item) => item.id)].sort()
  );
});

test("higher or equal player BUILD keeps tower standing", () => {
  const initial = startTowerHand({
    shoe: shoeWith([card("K"), card("K", "clubs"), card("2"), card("2", "clubs"), card("5")]),
    valueWagerCents: 100,
    heightWagerCents: 0
  });
  const equal = playerBuild(initial.hand, initial.shoe);
  assert.equal(equal.hand.status, "awaiting_double_decision");
  assert.equal(equal.hand.playerCollapsed, false);

  const doubled = applyDoubleDecision({
    hand: equal.hand,
    doubleValue: false,
    doubleHeight: false,
    availableBalanceCents: 10_000
  });
  const higher = playerBuild(doubled.hand, equal.shoe);
  assert.equal(higher.hand.status, "player_turn");
  assert.equal(higher.hand.playerCollapsed, false);
});

test("lower player BUILD collapses the tower and settles losses", () => {
  const initial = startTowerHand({
    shoe: shoeWith([card("K"), card("K", "clubs"), card("7"), card("6")]),
    valueWagerCents: 100,
    heightWagerCents: 100
  });
  const next = playerBuild(initial.hand, initial.shoe);
  assert.equal(next.hand.status, "settled");
  assert.equal(next.hand.playerCollapsed, true);
  assert.equal(next.hand.valueResult, "lost");
  assert.equal(next.hand.heightResult, "lost");
});

test("consecutive equal ranks create double opportunity across suits", () => {
  const cards = [
    { ...handEntry("6", 1, "hearts") },
    { ...handEntry("6", 2, "spades") }
  ];
  assert.equal(hasDoubleOpportunity(cards), true);
});

test("double increases wager amount but not payout multiplier", () => {
  const initial = startTowerHand({
    shoe: shoeWith([card("K"), card("K", "clubs"), card("6"), card("6", "diamonds")]),
    valueWagerCents: 500,
    heightWagerCents: 1_000
  });
  const built = playerBuild(initial.hand, initial.shoe);
  const doubled = applyDoubleDecision({
    hand: built.hand,
    doubleValue: true,
    doubleHeight: true,
    availableBalanceCents: 2_000
  });
  assert.equal(doubled.addedExposure, 1_500);
  assert.equal(doubled.hand.valueWagerCents, 1_000);
  assert.equal(doubled.hand.heightWagerCents, 2_000);

  const settlement = settleTowerWagers(standingHand({
    playerRanks: ["4", "5", "6"],
    dealerRanks: ["2", "3"],
    valueWagerCents: doubled.hand.valueWagerCents,
    heightWagerCents: doubled.hand.heightWagerCents
  }));
  assert.equal(settlement.valuePayoutCents, 2_000);
  assert.equal(settlement.heightPayoutCents, 12_000);
});

test("doubled Value wager pays 1:1 against the full doubled stake", () => {
  const settlement = settleTowerWagers(standingHand({
    playerRanks: ["9", "10"],
    dealerRanks: ["2", "3"],
    valueWagerCents: 400,
    heightWagerCents: 0
  }));
  assert.equal(settlement.valueResult, "won");
  assert.equal(settlement.valuePayoutCents, 800);
  assert.equal(settlement.valueProfitCents, 400);
});

test("insufficient balance prevents a double", () => {
  const initial = startTowerHand({
    shoe: shoeWith([card("K"), card("K", "clubs"), card("6"), card("6", "diamonds")]),
    valueWagerCents: 500,
    heightWagerCents: 0
  });
  const built = playerBuild(initial.hand, initial.shoe);
  assert.throws(() => applyDoubleDecision({
    hand: built.hand,
    doubleValue: true,
    doubleHeight: false,
    availableBalanceCents: 499
  }), /Insufficient balance/);
});

test("height qualification requires at least three cards", () => {
  assert.equal(isHeightQualified(standingHand({ playerRanks: ["2", "3"], dealerRanks: ["A", "2"] })), false);
  assert.equal(isHeightQualified(standingHand({ playerRanks: ["2", "3", "4"], dealerRanks: ["A", "2"] })), true);
});

test("two-card tower cannot win Height", () => {
  const settlement = settleTowerWagers(standingHand({
    playerRanks: ["K", "K"],
    dealerRanks: ["A"],
    valueWagerCents: 0,
    heightWagerCents: 100
  }));
  assert.equal(settlement.heightResult, "lost");
});

test("Height wins only when player exceeds dealer height and value", () => {
  const win = settleTowerWagers(standingHand({ playerRanks: ["4", "5", "6"], dealerRanks: ["2", "3"] }));
  assert.equal(win.heightResult, "won");

  const greaterHeightLowerValue = settleTowerWagers(standingHand({
    playerRanks: ["A", "2", "3", "4"],
    dealerRanks: ["K", "K"],
    valueWagerCents: 0,
    heightWagerCents: 100
  }));
  assert.equal(greaterHeightLowerValue.heightResult, "lost");

  const greaterValueEqualHeight = settleTowerWagers(standingHand({
    playerRanks: ["10", "J", "Q"],
    dealerRanks: ["2", "3", "4"],
    valueWagerCents: 0,
    heightWagerCents: 100
  }));
  assert.equal(greaterValueEqualHeight.heightResult, "lost");
});

test("Value ties push under default configuration", () => {
  const settlement = settleTowerWagers(standingHand({
    playerRanks: ["4", "5"],
    dealerRanks: ["3", "6"],
    valueWagerCents: 100,
    heightWagerCents: 0
  }));
  assert.equal(settlement.valueResult, "push");
  assert.equal(settlement.valuePayoutCents, 100);
});

test("dealer collapse pays Value and qualified Height only", () => {
  const qualified = settleTowerWagers(standingHand({
    playerRanks: ["2", "3", "4"],
    dealerRanks: ["10", "9"],
    dealerCollapsed: true
  }));
  assert.equal(qualified.valueResult, "won");
  assert.equal(qualified.heightResult, "won");

  const unqualified = settleTowerWagers(standingHand({
    playerRanks: ["2", "3"],
    dealerRanks: ["10", "9"],
    dealerCollapsed: true
  }));
  assert.equal(unqualified.valueResult, "won");
  assert.equal(unqualified.heightResult, "lost");
});

test("height payout bands are selected correctly", () => {
  assert.deepEqual(heightPayoutFor(3).payout, { numerator: 5, denominator: 1 });
  assert.deepEqual(heightPayoutFor(4).payout, { numerator: 10, denominator: 1 });
  assert.deepEqual(heightPayoutFor(5).payout, { numerator: 20, denominator: 1 });
  assert.deepEqual(heightPayoutFor(6).payout, { numerator: 40, denominator: 1 });
  assert.deepEqual(heightPayoutFor(7).payout, { numerator: 75, denominator: 1 });
  assert.deepEqual(heightPayoutFor(8).payout, { numerator: 150, denominator: 1 });
  assert.deepEqual(heightPayoutFor(12).payout, { numerator: 150, denominator: 1 });
});

test("dealer follows configured deterministic rule and collapses lower cards", () => {
  const lowTop = standingHand({ playerRanks: ["10"], dealerRanks: ["4", "7"] });
  assert.equal(shouldDealerBuild(lowTop), true);

  const highTop = standingHand({ playerRanks: ["10"], dealerRanks: ["4", "8"] });
  assert.equal(shouldDealerBuild(highTop), false);

  const initial = startTowerHand({
    shoe: shoeWith([card("10"), card("9"), card("5")]),
    valueWagerCents: 100,
    heightWagerCents: 100
  });
  assert.equal(initial.hand.dealerCollapsed, true);
  assert.equal(initial.hand.dealerCards.length, 2);
  assert.equal(initial.hand.status, "player_turn");
});

test("dealer tower is public before player decisions", () => {
  const initial = startTowerHand({
    shoe: shoeWith([card("K"), card("Q"), card("5")]),
    valueWagerCents: 100,
    heightWagerCents: 0
  });
  assert.deepEqual(publicCard(initial.hand.dealerCards[0]), {
    rank: "K",
    suit: "hearts",
    value: 13,
    id: "1-K-hearts",
    faceUp: true,
    causedCollapse: false
  });
  assert.equal(initial.hand.playerCards[0].card.rank, "5");
});

test("public counter decrements visible dealer cards immediately", () => {
  let shoe = shoeWith([card("K", "hearts"), card("K", "hearts", 1)]);
  const first = dealFromShoe(shoe);
  shoe = revealCard(first.shoe, first.card);
  const second = dealFromShoe(shoe);
  shoe = revealCard(second.shoe, second.card);

  const counter = publicShoeCounter(shoe, 0);
  const kingHearts = counter.exactCards.find((item) => item.rank === "K" && item.suit === "hearts");
  assert.equal(kingHearts?.remainingUnseen, 4);
  assert.equal(counter.hiddenCardsInPlay, 0);
});

test("player collapse after dealer collapse preserves Value win and loses Height", () => {
  const initial = startTowerHand({
    shoe: shoeWith([card("10"), card("9"), card("4"), card("3")]),
    valueWagerCents: 100,
    heightWagerCents: 100
  });
  assert.equal(initial.hand.dealerCollapsed, true);
  const collapsed = playerBuild(initial.hand, initial.shoe);
  assert.equal(collapsed.hand.status, "settled");
  assert.equal(collapsed.hand.playerCollapsed, true);
  assert.equal(collapsed.hand.valueResult, "won");
  assert.equal(collapsed.hand.valuePayoutCents, 200);
  assert.equal(collapsed.hand.heightResult, "lost");
});

test("new shoe threshold is checked before a hand only", () => {
  const shoe = createTowerShoe({ randomIndex: () => 0 });
  assert.equal(shouldReshuffleBeforeHand({ ...shoe, position: 233 }, defaultTowerConfig), false);
  assert.equal(shouldReshuffleBeforeHand({ ...shoe, position: 235 }, defaultTowerConfig), true);
});

test("configuration changes do not alter existing hand settlement", () => {
  const hand = standingHand({
    playerRanks: ["4", "5"],
    dealerRanks: ["3", "6"],
    valueWagerCents: 100,
    heightWagerCents: 0
  });
  const original = settleTowerWagers(hand, defaultTowerConfig);
  const changed = settleTowerWagers(hand, { ...defaultTowerConfig, valueTieRule: "dealer_wins" });
  assert.equal(original.valueResult, "push");
  assert.equal(changed.valueResult, "lost");
});
