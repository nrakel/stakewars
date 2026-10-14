import assert from "node:assert/strict";
import test from "node:test";
import { isRegularSeasonWindow } from "../src/server/odds.js";
import { outcomeForSelection } from "../src/server/settlement.js";
import { scoreNhlMoneyline, type CandidateLine } from "../src/server/ai.js";

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

test("NHL Chine model rejects non-moneyline candidates", () => {
  const scored = scoreNhlMoneyline(nhlLine("spreads"), new Map(), null);
  assert.equal(scored.confidence, 0.1);
  assert.match(String(scored.features.rejectedReason), /moneyline-only/);
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
