import assert from "node:assert/strict";
import test from "node:test";
import { parseNbaSummaryMetrics } from "../src/server/nba-context.js";

test("NBA box scores produce possession-based efficiency and pace", () => {
  const summary = {
    header: { competitions: [{ competitors: [
      { homeAway: "away", score: "110", team: { displayName: "Away" } },
      { homeAway: "home", score: "100", team: { displayName: "Home" } }
    ] }] },
    boxscore: {
      teams: [
        { team: { displayName: "Away" }, statistics: [
          { name: "fieldGoalsMade-fieldGoalsAttempted", displayValue: "40-90" },
          { name: "freeThrowsMade-freeThrowsAttempted", displayValue: "20-25" },
          { name: "offensiveRebounds", displayValue: "10" },
          { name: "totalTurnovers", displayValue: "12" }
        ] },
        { team: { displayName: "Home" }, statistics: [
          { name: "fieldGoalsMade-fieldGoalsAttempted", displayValue: "38-85" },
          { name: "freeThrowsMade-freeThrowsAttempted", displayValue: "18-20" },
          { name: "offensiveRebounds", displayValue: "8" },
          { name: "totalTurnovers", displayValue: "14" }
        ] }
      ],
      players: []
    }
  };
  const metrics = parseNbaSummaryMetrics(summary);
  assert.equal(metrics.length, 2);
  assert.equal(metrics[0].team, "Away");
  assert.equal(metrics[0].isHome, false);
  assert.ok(metrics[0].pace > 101 && metrics[0].pace < 102);
  assert.ok(metrics[0].offensiveRating > metrics[0].defensiveRating);
  assert.equal(metrics[1].offensiveRating, metrics[0].defensiveRating);
});

test("NBA context parser rejects incomplete box scores", () => {
  assert.deepEqual(parseNbaSummaryMetrics({ boxscore: { teams: [] } }), []);
});
