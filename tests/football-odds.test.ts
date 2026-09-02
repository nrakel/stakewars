import assert from "node:assert/strict";
import test from "node:test";
import { footballEventIdentity, isExpectedSportEvent } from "../src/server/odds.js";

const baseEvent = {
  id: "event-1",
  sport_key: "americanfootball_ncaaf",
  sport_title: "NCAA Football",
  commence_time: "2026-09-03T22:00:00.000Z",
  home_team: "Rutgers",
  away_team: "Massachusetts"
};

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
