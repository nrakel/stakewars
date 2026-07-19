import {
  applyDoubleDecision,
  createTowerShoe,
  defaultTowerConfig,
  heightPayoutFor,
  nextHeightPayoutFor,
  playerBuild,
  playerCap,
  startTowerHand,
  towerHeight,
  towerValue,
  type TowerConfig,
  type TowerHandState
} from "../src/server/tower/engine.js";

type Strategy = "random" | "threshold" | "height-seeking" | "value-only" | "both";

type SimulationOptions = {
  hands: number;
  strategy: Strategy;
  buildThreshold: number;
  valueWagerCents: number;
  heightWagerCents: number;
};

type SimulationStats = {
  hands: number;
  playerCollapses: number;
  dealerCollapses: number;
  valueStakeCents: number;
  heightStakeCents: number;
  valueReturnedCents: number;
  heightReturnedCents: number;
  combinedStakeCents: number;
  combinedReturnedCents: number;
  totalCards: number;
  largestSingleHandPayoutCents: number;
  heightDistribution: Map<number, number>;
  thresholdResults: Map<number, { hands: number; returnedCents: number; stakedCents: number }>;
};

const parseArgs = (): SimulationOptions => {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    args.set(key, value ?? "true");
  }
  const strategy = (args.get("strategy") ?? "threshold") as Strategy;
  return {
    hands: Number(args.get("hands") ?? 10_000),
    strategy,
    buildThreshold: Number(args.get("build-threshold") ?? 8),
    valueWagerCents: Number(args.get("value-cents") ?? (strategy === "height-seeking" ? 0 : 500)),
    heightWagerCents: Number(args.get("height-cents") ?? (strategy === "value-only" ? 0 : 500))
  };
};

const shouldBuild = ({
  hand,
  options,
  config
}: {
  hand: TowerHandState;
  options: SimulationOptions;
  config: TowerConfig;
}) => {
  const topCard = hand.playerCards[hand.playerCards.length - 1]?.card;
  if (!topCard) return false;

  if (options.strategy === "random") return Math.random() < 0.5;
  if (options.strategy === "height-seeking") {
    const nextBand = nextHeightPayoutFor(towerHeight(hand.playerCards), config);
    return Boolean(nextBand) && towerHeight(hand.playerCards) < 7 && topCard.value <= 10;
  }
  if (options.strategy === "value-only") return topCard.value <= options.buildThreshold && towerValue(hand.playerCards) < 18;
  return topCard.value <= options.buildThreshold;
};

const percent = (numerator: number, denominator: number) =>
  denominator === 0 ? "0.00%" : `${((numerator / denominator) * 100).toFixed(2)}%`;

const credits = (cents: number) => (cents / 100).toFixed(2);

const simulate = (options: SimulationOptions, config = defaultTowerConfig) => {
  let shoe = createTowerShoe({ config, reason: "simulation_start" });
  const stats: SimulationStats = {
    hands: 0,
    playerCollapses: 0,
    dealerCollapses: 0,
    valueStakeCents: 0,
    heightStakeCents: 0,
    valueReturnedCents: 0,
    heightReturnedCents: 0,
    combinedStakeCents: 0,
    combinedReturnedCents: 0,
    totalCards: 0,
    largestSingleHandPayoutCents: 0,
    heightDistribution: new Map(),
    thresholdResults: new Map()
  };

  for (let index = 0; index < options.hands; index += 1) {
    if (shoe.cards.length - shoe.position < config.shufflePenetrationRemainingCards) {
      shoe = createTowerShoe({ config, reason: "simulation_threshold" });
    }

    const started = startTowerHand({
      shoe,
      valueWagerCents: options.valueWagerCents,
      heightWagerCents: options.heightWagerCents,
      config
    });
    let hand = started.hand;
    shoe = started.shoe;

    while (hand.status === "player_turn" || hand.status === "awaiting_double_decision") {
      if (hand.status === "awaiting_double_decision") {
        const previousValueWager = hand.valueWagerCents;
        const previousHeightWager = hand.heightWagerCents;
        const acceptDouble = options.strategy === "height-seeking" || (
          options.strategy !== "random" && towerHeight(hand.playerCards) >= config.heightQualificationMinCards
        );
        const doubled = applyDoubleDecision({
          hand,
          doubleValue: acceptDouble,
          doubleHeight: acceptDouble,
          availableBalanceCents: 1_000_000_000,
          config
        });
        hand = doubled.hand;
        stats.valueStakeCents += hand.valueWagerCents - previousValueWager;
        stats.heightStakeCents += hand.heightWagerCents - previousHeightWager;
      }

      if (hand.status !== "player_turn") continue;
      if (!shouldBuild({ hand, options, config })) break;
      const built = playerBuild(hand, shoe);
      hand = built.hand;
      shoe = built.shoe;
    }

    if (hand.status === "player_turn") {
      const capped = playerCap(hand, shoe, config);
      hand = capped.hand;
      shoe = capped.shoe;
    }

    stats.hands += 1;
    stats.playerCollapses += hand.playerCollapsed ? 1 : 0;
    stats.dealerCollapses += hand.dealerCollapsed ? 1 : 0;
    stats.valueStakeCents += hand.originalValueWagerCents;
    stats.heightStakeCents += hand.originalHeightWagerCents;
    stats.valueReturnedCents += hand.valuePayoutCents;
    stats.heightReturnedCents += hand.heightPayoutCents;
    stats.combinedStakeCents += hand.valueWagerCents + hand.heightWagerCents;
    stats.combinedReturnedCents += hand.valuePayoutCents + hand.heightPayoutCents;
    stats.totalCards += towerHeight(hand.playerCards) + towerHeight(hand.dealerCards);
    stats.largestSingleHandPayoutCents = Math.max(
      stats.largestSingleHandPayoutCents,
      hand.valuePayoutCents + hand.heightPayoutCents
    );
    stats.heightDistribution.set(towerHeight(hand.playerCards), (stats.heightDistribution.get(towerHeight(hand.playerCards)) ?? 0) + 1);

    const thresholdBucket = stats.thresholdResults.get(options.buildThreshold) ?? { hands: 0, returnedCents: 0, stakedCents: 0 };
    thresholdBucket.hands += 1;
    thresholdBucket.returnedCents += hand.valuePayoutCents + hand.heightPayoutCents;
    thresholdBucket.stakedCents += hand.valueWagerCents + hand.heightWagerCents;
    stats.thresholdResults.set(options.buildThreshold, thresholdBucket);
  }

  return stats;
};

const print = (options: SimulationOptions, stats: SimulationStats) => {
  console.log("Tower simulation");
  console.log(`Hands: ${stats.hands}`);
  console.log(`Strategy: ${options.strategy}`);
  console.log(`Build threshold: ${options.buildThreshold}`);
  console.log(`Player collapse rate: ${percent(stats.playerCollapses, stats.hands)}`);
  console.log(`Dealer collapse rate: ${percent(stats.dealerCollapses, stats.hands)}`);
  console.log(`Value RTP: ${percent(stats.valueReturnedCents, stats.valueStakeCents)}`);
  console.log(`Height RTP: ${percent(stats.heightReturnedCents, stats.heightStakeCents)}`);
  console.log(`Combined RTP: ${percent(stats.combinedReturnedCents, stats.combinedStakeCents)}`);
  console.log(`Observed value house edge: ${percent(stats.valueStakeCents - stats.valueReturnedCents, stats.valueStakeCents)}`);
  console.log(`Observed height house edge: ${percent(stats.heightStakeCents - stats.heightReturnedCents, stats.heightStakeCents)}`);
  console.log(`Average cards per hand: ${(stats.totalCards / stats.hands).toFixed(2)}`);
  console.log(`Largest single-hand payout: ${credits(stats.largestSingleHandPayoutCents)} credits`);
  console.log("Height frequency:");
  for (const [height, count] of [...stats.heightDistribution.entries()].sort((a, b) => a[0] - b[0])) {
    const band = height >= defaultTowerConfig.heightQualificationMinCards
      ? heightPayoutFor(height, defaultTowerConfig).payout
      : null;
    console.log(`  ${height}: ${count} (${percent(count, stats.hands)})${band ? ` pays ${band.numerator}:${band.denominator}` : ""}`);
  }
};

const options = parseArgs();
print(options, simulate(options));
