import assert from "node:assert/strict";
import test from "node:test";
import { eventKey, scoreLine } from "../src/server/ai.js";
import { nflSeasonWeek } from "../src/server/betting.js";
import { footballEventIdentity, isExpectedSportEvent } from "../src/server/odds.js";
import { settlementStartTimeDifferenceMinutes } from "../src/server/settlement.js";

const baseEvent = {
  id: "event-1",
  sport_key: "americanfootball_ncaaf",
  sport_title: "NCAA Football",
  commence_time: "2026-09-03T22:00:00.000Z",
  home_team: "Rutgers",
  away_team: "Massachusetts"
};

test("NFL season week advances from the configured Monday start", () => {
  assert.equal(nflSeasonWeek("2026-09-07", new Date("2026-09-10T18:00:00Z")), 1);
  assert.equal(nflSeasonWeek("2026-09-07", new Date("2026-09-17T18:00:00Z")), 2);
});

test("settlement start matching tolerates a kickoff change across UTC midnight", () => {
  assert.equal(
    settlementStartTimeDifferenceMinutes("2026-10-10T23:30:00Z", "2026-10-11T00:10:00Z"),
    40
  );
});

test("football event keys use the provider match id instead of collapsing the slate", () => {
  const line = {
    id: "line-1",
    provider_event_id: "americanfootball_nfl|6275929b4056e14c|2026-10-11T133000000Z|philadelphia eagles|jacksonville jaguars:bovada:spreads:Philadelphia Eagles",
    sport: "NFL" as const,
    starts_at: new Date("2026-10-11T13:30:00Z"),
    away_team: "Philadelphia Eagles",
    home_team: "Jacksonville Jaguars",
    selected_team: "Philadelphia Eagles",
    spread: "-3.5",
    odds_american: -110,
    market_key: "spreads" as const
  };

  assert.equal(eventKey(line), "6275929b4056e14c");
});

test("football event keys preserve ESPN-prefixed match ids", () => {
  const line = {
    id: "line-2",
    provider_event_id: "americanfootball_ncaaf|espn:401869950|2026-10-15T233000000Z|georgia southern|old dominion monarchs:fanduel:spreads:Old Dominion Monarchs",
    sport: "NCAAF" as const,
    starts_at: new Date("2026-10-15T23:30:00Z"),
    away_team: "Georgia Southern",
    home_team: "Old Dominion Monarchs",
    selected_team: "Old Dominion Monarchs",
    spread: "-5.5",
    odds_american: -110,
    market_key: "spreads" as const
  };

  assert.equal(eventKey(line), "espn:401869950");
});

test("NCAAF aliases resolve to the same football event identity", () => {
  const shortNameEvent = {
    ...baseEvent,
    id: "short",
    home_team: "Rutgers",
    away_team: "Massachusetts"
  };
  const mascotNameEvent = {
    ...baseEvent,
    id: "mascot",
    home_team: "Rutgers Scarlet Knights",
    away_team: "UMass Minutemen"
  };

  assert.equal(
    footballEventIdentity("NCAAF", shortNameEvent),
    footballEventIdentity("NCAAF", mascotNameEvent)
  );
});

test("NCAAF mascot suffixes resolve Florida State duplicates without batch aliases", () => {
  const shortNameEvent = {
    ...baseEvent,
    id: "short",
    commence_time: "2026-09-07T23:30:00.000Z",
    home_team: "Florida State",
    away_team: "SMU"
  };
  const mascotNameEvent = {
    ...shortNameEvent,
    id: "mascot",
    home_team: "Florida State Seminoles",
    away_team: "SMU Mustangs"
  };

  assert.equal(
    footballEventIdentity("NCAAF", shortNameEvent),
    footballEventIdentity("NCAAF", mascotNameEvent)
  );
});

test("NCAAF refresh batch aliases collapse short and mascot team names", () => {
  const batchAliases = new Map([
    ["akron zips", "akron"],
    ["wake forest demon deacons", "wake forest"]
  ]);
  const shortNameEvent = {
    ...baseEvent,
    id: "short",
    commence_time: "2026-09-03T23:00:00.000Z",
    home_team: "Wake Forest",
    away_team: "Akron"
  };
  const mascotNameEvent = {
    ...shortNameEvent,
    id: "mascot",
    home_team: "Wake Forest Demon Deacons",
    away_team: "Akron Zips"
  };

  assert.equal(
    footballEventIdentity("NCAAF", shortNameEvent, batchAliases),
    footballEventIdentity("NCAAF", mascotNameEvent, batchAliases)
  );
});

test("NCAAF aliases do not collapse distinct state schools into base schools", () => {
  assert.notEqual(
    footballEventIdentity("NCAAF", {
      ...baseEvent,
      id: "oregon",
      commence_time: "2026-09-12T16:00:00.000Z",
      away_team: "Oregon Ducks",
      home_team: "Oklahoma Sooners"
    }),
    footballEventIdentity("NCAAF", {
      ...baseEvent,
      id: "oregon-state",
      commence_time: "2026-09-12T16:00:00.000Z",
      away_team: "Oregon State Beavers",
      home_team: "Oklahoma State Cowboys"
    })
  );

  assert.notEqual(
    footballEventIdentity("NCAAF", {
      ...baseEvent,
      id: "texas",
      commence_time: "2026-09-12T23:30:00.000Z",
      away_team: "Texas Longhorns",
      home_team: "Oregon Ducks"
    }),
    footballEventIdentity("NCAAF", {
      ...baseEvent,
      id: "texas-state",
      commence_time: "2026-09-12T23:30:00.000Z",
      away_team: "Texas State Bobcats",
      home_team: "Oregon State Beavers"
    })
  );
});

test("NFL odds reject mixed college and NFL matchups", () => {
  assert.equal(
    isExpectedSportEvent("NFL", {
      ...baseEvent,
      sport_key: "americanfootball_nfl",
      sport_title: "NFL",
      away_team: "UAlbany",
      home_team: "Buffalo Bills"
    }),
    false
  );
});

test("NFL odds accept real NFL matchups", () => {
  assert.equal(
    isExpectedSportEvent("NFL", {
      ...baseEvent,
      sport_key: "americanfootball_nfl",
      sport_title: "NFL",
      away_team: "New England Patriots",
      home_team: "Seattle Seahawks"
    }),
    true
  );
});

test("NCAAF Chine model rejects moneyline candidates", () => {
  const scored = scoreLine({
    id: "line-1",
    provider_event_id: "event-1:bovada:h2h:Rutgers",
    sport: "NCAAF",
    starts_at: new Date("2026-09-05T18:00:00.000Z"),
    home_team: "Rutgers",
    away_team: "UMass",
    selected_team: "Rutgers",
    spread: "0.0",
    odds_american: -250,
    market_key: "h2h"
  }, new Map(), null);

  assert.equal(scored.confidence, 0.1);
  assert.equal(scored.features.rejectedReason, "NCAAF Chine model is spread-only");
});

test("NCAAF Chine model scores against projected margin versus spread", () => {
  const scored = scoreLine({
    id: "line-2",
    provider_event_id: "event-2:bovada:spreads:Rutgers",
    sport: "NCAAF",
    starts_at: new Date("2026-09-05T18:00:00.000Z"),
    home_team: "Rutgers",
    away_team: "UMass",
    selected_team: "Rutgers",
    spread: "-7.5",
    odds_american: -110,
    market_key: "spreads"
  }, new Map([["event-2", 2]]), {
    selectedPointsForPerGame3: 35,
    opponentPointsForPerGame3: 20,
    pointsForPerGameDiff3: 15,
    selectedPointsAgainstPerGame3: 14,
    opponentPointsAgainstPerGame3: 31,
    pointsAgainstPerGameDiff3: -17,
    selectedMarginPerGame3: 21,
    opponentMarginPerGame3: -11,
    marginPerGameDiff3: 32,
    selectedPointsForPerGame6: 31,
    opponentPointsForPerGame6: 20,
    pointsForPerGameDiff6: 11,
    selectedPointsAgainstPerGame6: 17,
    opponentPointsAgainstPerGame6: 29,
    pointsAgainstPerGameDiff6: -12,
    selectedMarginPerGame6: 14,
    opponentMarginPerGame6: -9,
    marginPerGameDiff6: 23,
    selectedVenueMarginPerGame: 18,
    opponentVenueMarginPerGame: -8,
    venueMarginPerGameDiff: 26,
    selectedRestDays: 7,
    opponentRestDays: 6,
    restDaysDiff: 1,
    selectedPreviousMargin: 24,
    opponentPreviousMargin: -10,
    previousMarginDiff: 34,
    isHome: true,
    isRoad: false,
    isFavorite: true,
    isLargeFavorite: false,
    earlySeasonRosterUncertainty: false,
    projectedMargin: 13,
    listedSpread: -7.5,
    projectedMarginVsSpread: 5.5,
    qbContinuity: null,
    offensiveLineContinuity: null,
    returningProduction: null,
    coachingContinuity: null,
    coordinatorContinuity: null,
    trenchMismatch: 32,
    passingMismatch: null,
    rushingMismatch: null,
    explosivePlayMismatch: null,
    strengthOfSchedule: null,
    homeFieldAdvantage: 2.5,
    restAdvantage: 0.35,
    travelDisadvantage: 0,
    shortWeekDisadvantage: 0,
    lookAheadSpot: null,
    letdownSpot: 0,
    keyInjuries: null,
    turnoverRegression: null,
    specialTeamsAdvantage: null,
    paceTempoMismatch: null,
    recentPerformance: 32,
    marketLineMovement: 1,
    reverseLineMovement: null,
    largeSpreadFavoriteBehavior: 0,
    backupDepthAdvantage: null,
    motivationGameImportance: null,
    dataCompleteness: 1,
    openingOddsAmerican: -110,
    previousOddsAmerican: -110,
    lineMovementAmerican: 0,
    lineMovementImplied: 0,
    openingSpread: -6.5,
    previousSpread: -6.5,
    lineMovementSpread: 1,
    lineSnapshotCount: 3
  });

  assert.equal(scored.market_key, "spreads");
  assert.ok(scored.edge > 0);
  assert.ok(scored.confidence >= 0.7);
  assert.equal(scored.features.modelProfile, "football-spread-v1");
});
