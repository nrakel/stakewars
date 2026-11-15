import assert from "node:assert/strict";
import test from "node:test";
import { buildPodcastPromptData, podcastFeatureContext, podcastSpeechText, podcastSystemPrompt, podcastWordCount } from "../src/server/podcast.js";

test("podcast speech text pronounces Chine as Sheen without changing embedded text", () => {
  assert.equal(
    podcastSpeechText("Chine studies the machine. CHINE agrees with chine."),
    "Sheen studies the machine. SHEEN agrees with sheen."
  );
});

test("podcast feature context keeps relevant facts and excludes unrelated internals", () => {
  assert.deepEqual(podcastFeatureContext({
    selectedStarterEra: 2.91,
    weatherSummary: "windy",
    selectedPointPct: 0.69,
    internalDebugValue: 42,
    selectedBullpenEra: null
  }), {
    selectedStarterEra: 2.91,
    weatherSummary: "windy",
    selectedPercentOfAvailableStandingsPointsEarned: "69 percent"
  });
});

test("podcast prompt uses no more than three picks", () => {
  const pick = (id: string) => ({
    id, selectedTeam: "Home", confidence: 0.72, reasons: [], features: {}, explanation: "Stored fact.",
    sport: "MLB", league: "MLB", startsAt: "2026-11-15T18:00:00Z", homeTeam: "Home",
    awayTeam: "Away", spread: "0", oddsAmerican: -120, marketKey: "h2h"
  });
  const data = buildPodcastPromptData("2026-11-15", [pick("1"), pick("2"), pick("3"), pick("4")]);
  assert.equal(data.picks.length, 3);
  assert.equal(data.picks[0]?.confidencePercent, 72);
  assert.equal(podcastWordCount("one two\nthree"), 3);
});

test("podcast prompt requires casual-language explanations for analytics", () => {
  assert.match(podcastSystemPrompt, /casual sports listener/i);
  assert.match(podcastSystemPrompt, /share of available standings points/i);
  assert.match(podcastSystemPrompt, /Convert ratios/i);
  assert.match(podcastSystemPrompt, /first time scoring margin appears/i);
  assert.match(podcastSystemPrompt, /outscores or is outscored/i);
});
