import assert from "node:assert/strict";
import test from "node:test";
import { buildPodcastPromptData, podcastFeatureContext, podcastSpeechText, podcastSpokenText, podcastSystemPrompt, podcastWordCount } from "../src/server/podcast.js";
import { podcastEpisodePath, podcastMixArgs } from "../src/server/podcastAudio.js";

test("podcast speech text pronounces Chine as Sheen without changing embedded text", () => {
  assert.equal(
    podcastSpeechText("Chine studies the machine. CHINE agrees with chine."),
    "Sheen studies the machine. SHEEN agrees with sheen."
  );
});

test("podcast feature context keeps relevant facts and excludes unrelated internals", () => {
  assert.deepEqual(podcastFeatureContext({
    selectedStarterEra: 2.91,
    selectedRecentMargin: 1.833333333333,
    opponentRecentMargins: [-5.6666666667, 2],
    weatherSummary: "windy",
    selectedPointPct: 0.69,
    internalDebugValue: 42,
    selectedBullpenEra: null
  }), {
    selectedStarterEra: 2.9,
    selectedRecentMargin: 1.8,
    opponentRecentMargins: [-5.7, 2],
    weatherSummary: "windy",
    selectedPercentOfAvailableStandingsPointsEarned: "69 percent"
  });
});

test("podcast spoken text rounds long decimals to one place", () => {
  assert.equal(
    podcastSpokenText("Detroit 1.833333333333 and New England -5.6666666667."),
    "Detroit 1.8 and New England -5.7."
  );
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

test("podcast audio mix fades the reusable intro under delayed narration", () => {
  const args = podcastMixArgs("intro.mp3", "narration.mp3", "episode.mp3");
  assert.ok(args.includes("intro.mp3"));
  assert.ok(args.includes("narration.mp3"));
  assert.ok(args.includes("episode.mp3"));
  assert.match(args.join(" "), /afade=t=out/);
  assert.match(args.join(" "), /adelay=3000/);
  assert.match(args.join(" "), /amix=inputs=2/);
  assert.throws(() => podcastEpisodePath("../../etc/passwd"), /Invalid podcast episode date/);
});
