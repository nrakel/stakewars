import assert from "node:assert/strict";
import test from "node:test";
import { footballLiveEvents } from "../src/server/liveNotifications.js";

type LiveState = NonNullable<Parameters<typeof footballLiveEvents>[1]>;

const state = (bases: Record<string, unknown>, lastPlay = "Pass complete") => ({
  matchId: "espn:nfl:1",
  provider: "espn-scoreboard",
  sport: "NFL",
  eventKey: "event-1",
  startsAt: new Date("2026-10-04T17:00:00Z"),
  awayTeam: "Away",
  homeTeam: "Home",
  awayScore: 0,
  homeScore: 0,
  period: "1st 10:00",
  gameStatus: "In Progress",
  description: null,
  lastPlay,
  inPlay: true,
  bases
}) satisfies LiveState;

test("football events identify a new play over 20 yards", () => {
  const previous = state({ lastPlayId: "1", lastPlayYards: 4, isRedZone: false });
  const current = state({ lastPlayId: "2", lastPlayYards: 21, lastPlayTeam: "Away", isRedZone: false }, "21 yard pass");
  assert.deepEqual(footballLiveEvents(previous, current).map((event) => event.type), ["big_play"]);
});

test("football events do not classify exactly 20 yards as a big play", () => {
  const previous = state({ lastPlayId: "1", isRedZone: false });
  const current = state({ lastPlayId: "2", lastPlayYards: 20, isRedZone: false }, "20 yard run");
  assert.equal(footballLiveEvents(previous, current).length, 0);
});

test("football events identify turnovers and simultaneous red-zone entry", () => {
  const previous = state({ lastPlayId: "1", possessionTeam: "Away", isRedZone: false });
  const current = state({
    lastPlayId: "2",
    lastPlayType: "Interception Return",
    lastPlayYards: 35,
    possessionTeam: "Home",
    downDistance: "1st & 10",
    fieldPosition: "AWAY 15",
    isRedZone: true
  }, "Pass intercepted and returned to the 15");
  assert.deepEqual(footballLiveEvents(previous, current).map((event) => event.type), ["turnover", "red_zone"]);
});

test("football events do not repeat an unchanged play or red-zone state", () => {
  const previous = state({ lastPlayId: "2", possessionTeam: "Home", isRedZone: true });
  const current = state({ lastPlayId: "2", lastPlayYards: 30, possessionTeam: "Home", isRedZone: true }, "30 yard pass");
  assert.equal(footballLiveEvents(previous, current).length, 0);
});
