import assert from "node:assert/strict";
import test from "node:test";
import { isRegularSeasonWindow } from "../src/server/odds.js";
import { outcomeForSelection } from "../src/server/settlement.js";
import { scoreNbaSpreadLine, scoreNhlMoneyline, type CandidateLine } from "../src/server/ai.js";

test("NHL availability includes preseason through the Stanley Cup window", () => {
  assert.equal(isRegularSeasonWindow("NHL", new Date("2026-09-15T12:00:00Z")), true);
  assert.equal(isRegularSeasonWindow("NHL", new Date("2027-04-20T12:00:00Z")), true);
  assert.equal(isRegularSeasonWindow("NHL", new Date("2027-06-01T12:00:00Z")), false);
});

test("MLB availability includes the postseason", () => {
  assert.equal(isRegularSeasonWindow("MLB", new Date("2026-10-01T12:00:00Z")), true);
  assert.equal(isRegularSeasonWindow("MLB", new Date("2026-11-15T12:00:00Z")), true);
  assert.equal(isRegularSeasonWindow("MLB", new Date("2026-11-16T12:00:00Z")), false);
});

test("NHL puck lines and totals settle through the shared engine", () => {
  const game = { startsOn: "2026-09-29", awayTeam: "Boston Bruins", homeTeam: "New York Rangers", awayScore: 4, homeScore: 2 };
  assert.equal(outcomeForSelection({ selectedTeam: "Boston Bruins", awayTeam: game.awayTeam, homeTeam: game.homeTeam, marketKey: "spreads", spread: -1.5, game, sport: "NHL" }), "won");
  assert.equal(outcomeForSelection({ selectedTeam: "Over", awayTeam: game.awayTeam, homeTeam: game.homeTeam, marketKey: "totals", spread: 5.5, game, sport: "NHL" }), "won");
});

test("NHL favorite covers a minus-1.5 puck line by winning by two", () => {
  const game = {
    startsOn: "2026-10-13",
    awayTeam: "Washington Capitals",
    homeTeam: "Carolina Hurricanes",
    awayScore: 2,
    homeScore: 4
  };

  assert.equal(outcomeForSelection({
    selectedTeam: "Carolina Hurricanes",
    awayTeam: game.awayTeam,
    homeTeam: game.homeTeam,
    marketKey: "spreads",
    spread: -1.5,
    game,
    sport: "NHL"
  }), "won");
});

test("NBA spreads, totals, and moneylines settle through the shared engine", () => {
  const game = { startsOn: "2026-10-21", awayTeam: "Boston Celtics", homeTeam: "New York Knicks", awayScore: 116, homeScore: 110 };
  assert.equal(outcomeForSelection({ selectedTeam: "Boston Celtics", awayTeam: game.awayTeam, homeTeam: game.homeTeam, marketKey: "h2h", spread: 0, game, sport: "NBA" }), "won");
  assert.equal(outcomeForSelection({ selectedTeam: "New York Knicks", awayTeam: game.awayTeam, homeTeam: game.homeTeam, marketKey: "spreads", spread: 5.5, game, sport: "NBA" }), "lost");
  assert.equal(outcomeForSelection({ selectedTeam: "Over", awayTeam: game.awayTeam, homeTeam: game.homeTeam, marketKey: "totals", spread: 225.5, game, sport: "NBA" }), "won");
});

const nbaLine = (marketKey: "h2h" | "spreads" = "spreads"): CandidateLine => ({
  id: "nba-line", provider_event_id: "nba-game", sport: "NBA",
  starts_at: new Date("2026-10-22T23:00:00Z"), away_team: "Cleveland Cavaliers",
  home_team: "Philadelphia 76ers", selected_team: "Cleveland Cavaliers",
  spread: marketKey === "spreads" ? "+2.5" : "0", odds_american: -110, market_key: marketKey
});

test("NBA Chine model rejects moneylines", () => {
  const scored = scoreNbaSpreadLine(nbaLine("h2h"), new Map(), null);
  assert.equal(scored.confidence, 0.1);
  assert.match(String(scored.features.rejectedReason), /spread-only/);
});

test("NBA Chine model converts a projected margin advantage into cover confidence", () => {
  const context = {
    selectedGamesPlayed: 20, opponentGamesPlayed: 20,
    selectedMarginPerGame10: 7, opponentMarginPerGame10: -3, marginPerGameDiff10: 10,
    selectedMarginPerGame20: 5, opponentMarginPerGame20: -2, marginPerGameDiff20: 7,
    selectedPointsForPerGame10: 118, opponentPointsForPerGame10: 109, pointsForPerGameDiff10: 9,
    selectedPointsAgainstPerGame10: 108, opponentPointsAgainstPerGame10: 115, pointsAgainstPerGameDiff10: -7,
    selectedVenueMarginPerGame: 4, opponentVenueMarginPerGame: -2, venueMarginPerGameDiff: 6,
    selectedRestDays: 2, opponentRestDays: 0, restDaysDiff: 2,
    selectedBackToBack: false, opponentBackToBack: true,
    projectedMargin: 6, listedSpread: 2.5, projectedMarginVsSpread: 8.5, dataCompleteness: 1,
    openingOddsAmerican: -110, previousOddsAmerican: -110, lineMovementAmerican: 0,
    lineMovementImplied: 0, openingSpread: 1.5, previousSpread: 2,
    lineMovementSpread: 1, lineSnapshotCount: 3
  };
  const scored = scoreNbaSpreadLine(nbaLine(), new Map(), context);
  assert.ok(scored.confidence > 0.65);
  assert.ok(scored.edge > 0);
  assert.equal(scored.features.modelProfile, "nba-spread-v1");
});

const nhlLine = (marketKey: "h2h" | "spreads" = "h2h"): CandidateLine => ({
  id: "nhl-line",
  provider_event_id: "nhl-game",
  sport: "NHL",
  starts_at: new Date("2026-10-15T00:00:00Z"),
  away_team: "Boston Bruins",
  home_team: "New York Rangers",
  selected_team: "New York Rangers",
  spread: marketKey === "h2h" ? "0" : "-1.5",
  odds_american: -110,
  market_key: marketKey
});

test("NHL Chine model rejects markets other than moneyline and puck line", () => {
  const scored = scoreNhlMoneyline({ ...nhlLine("spreads"), market_key: "totals" } as unknown as CandidateLine, new Map(), null);
  assert.equal(scored.confidence, 0.1);
  assert.match(String(scored.features.rejectedReason), /moneyline and puck-line/);
});

test("NHL Chine model evaluates puck lines with a distinct expected value", () => {
  const scored = scoreNhlMoneyline(nhlLine("spreads"), new Map(), null);
  assert.equal(scored.features.modelProfile, "nhl-puckline-v1");
  assert.equal(typeof scored.features.expectedValue, "number");
  assert.ok(scored.reasons.some((reason) => reason.includes("puck-line")));
});

test("NHL Chine model rewards team strength, recent form, venue, and rest", () => {
  const context = {
    selectedGamesPlayed: 12, opponentGamesPlayed: 12,
    selectedWinPct: 0.75, opponentWinPct: 0.42, winPctDiff: 0.33,
    selectedPointPct: 0.79, opponentPointPct: 0.46, pointPctDiff: 0.33,
    selectedRegulationWinPct: 0.67, opponentRegulationWinPct: 0.33, regulationWinPctDiff: 0.34,
    selectedGoalsForPerGame: 3.8, opponentGoalsForPerGame: 2.7, goalsForPerGameDiff: 1.1,
    selectedGoalsAgainstPerGame: 2.3, opponentGoalsAgainstPerGame: 3.4, goalsAgainstPerGameDiff: -1.1,
    selectedGoalDiffPerGame: 1.5, opponentGoalDiffPerGame: -0.7, goalDiffPerGameDiff: 2.2,
    selectedRecentPointPct: 0.8, opponentRecentPointPct: 0.4, recentPointPctDiff: 0.4,
    selectedRecentGoalDiffPerGame: 1.2, opponentRecentGoalDiffPerGame: -0.8, recentGoalDiffPerGameDiff: 2,
    selectedVenuePointPct: 0.83, opponentVenuePointPct: 0.42, venuePointPctDiff: 0.41,
    selectedVenueGoalDiffPerGame: 1.4, opponentVenueGoalDiffPerGame: -0.5, venueGoalDiffPerGameDiff: 1.9,
    selectedRestDays: 2, opponentRestDays: 0, restDaysDiff: 2,
    selectedBackToBack: false, opponentBackToBack: true,
    selectedStreak: 4, opponentStreak: -2, dataCompleteness: 1,
    openingOddsAmerican: -105, previousOddsAmerican: -108, lineMovementAmerican: -5,
    lineMovementImplied: 0.012, openingSpread: 0, previousSpread: 0,
    lineMovementSpread: 0, lineSnapshotCount: 3
  };
  const scored = scoreNhlMoneyline(nhlLine(), new Map(), context);
  assert.ok(scored.edge > 0.1);
  assert.ok(scored.confidence > 0.65);
  assert.ok(scored.reasons.includes("Rest advantage against back-to-back opponent"));
});
