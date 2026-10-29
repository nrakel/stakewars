import assert from "node:assert/strict";
import test from "node:test";
import { parseFootballTeamBoxScore } from "../src/server/nflPlayerProjections.js";
import { nflPlayerKey } from "../src/server/nflPlayerProps.js";

test("parses ESPN passing, rushing, and receiving lines into one player record", () => {
  const athlete = { athlete: { id: "qb-1", displayName: "Test Quarterback" } };
  const parsed = parseFootballTeamBoxScore({ statistics: [
    { name: "passing", athletes: [{ ...athlete, stats: ["22/31", "248", "8.0", "2"] }] },
    { name: "rushing", athletes: [{ ...athlete, stats: ["4", "19", "4.8", "1"] }] }
  ] });
  assert.deepEqual(parsed.players.get("qb-1"), {
    playerId: "qb-1", playerName: "Test Quarterback",
    completions: 22, passAttempts: 31, passYards: 248, passTds: 2,
    carries: 4, rushYards: 19, rushTds: 1,
    receptions: 0, receivingYards: 0, receivingTds: 0, targets: 0
  });
});

test("aggregates player box-score production into team totals", () => {
  const parsed = parseFootballTeamBoxScore({ statistics: [{ name: "rushing", athletes: [
    { athlete: { id: "rb-1", displayName: "RB One" }, stats: ["12", "61", "5.1", "1"] },
    { athlete: { id: "rb-2", displayName: "RB Two" }, stats: ["5", "24", "4.8", "0"] }
  ] }] });
  assert.equal(parsed.totals.carries, 17);
  assert.equal(parsed.totals.rushYards, 85);
  assert.equal(parsed.totals.rushTds, 1);
});

test("normalizes player names for projection-to-prop matching", () => {
  assert.equal(nflPlayerKey("D.J. Moore Jr."), "djmoorejr");
  assert.equal(nflPlayerKey("  Christian Watson  "), "christianwatson");
});
