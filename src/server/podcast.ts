import { config } from "./config.js";

export type PodcastScriptPick = {
  id: string;
  selectedTeam: string;
  confidence: number | string | null;
  reasons: string[] | null;
  features: Record<string, unknown> | null;
  explanation: string | null;
  sport: string;
  league: string;
  startsAt: string;
  homeTeam: string;
  awayTeam: string;
  spread: string;
  oddsAmerican: number;
  marketKey: string;
};

const outputText = (body: unknown) => {
  if (!body || typeof body !== "object") return null;
  const direct = (body as { output_text?: unknown }).output_text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || !Array.isArray((item as { content?: unknown }).content)) continue;
    for (const content of (item as { content: unknown[] }).content) {
      if (!content || typeof content !== "object") continue;
      const text = (content as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("").trim() || null;
};

const usefulFeature = /injur|weather|travel|rest|venue|division|playoff|margin|starter|bullpen|offense|defense|point|goal|run|pace|tempo|strength|schedule|lineMovement|projected|recent|availability|home|road|pitch|quarterback|passing|rushing|scoring/i;

const podcastFeatureKey = (key: string) => key
  .replace(/RecentPointPct/g, "RecentPercentOfAvailableStandingsPointsEarned")
  .replace(/VenuePointPct/g, "VenuePercentOfAvailableStandingsPointsEarned")
  .replace(/PointPct/g, "PercentOfAvailableStandingsPointsEarned")
  .replace(/recentPointPct/g, "recentPercentOfAvailableStandingsPointsEarned")
  .replace(/venuePointPct/g, "venuePercentOfAvailableStandingsPointsEarned")
  .replace(/pointPct/g, "percentOfAvailableStandingsPointsEarned");

const spokenNumber = (value: number) => Number.isInteger(value) ? value : Number(value.toFixed(1));

export const podcastSpokenText = (value: string) => value.replace(
  /-?\d+\.\d{2,}/g,
  (match) => spokenNumber(Number(match)).toFixed(1)
);

const podcastFeatureValue = (key: string, value: unknown): unknown => {
  if (/pointPct/i.test(key) && typeof value === "number" && Math.abs(value) <= 1) {
    return `${Math.round(value * 100)} percent`;
  }
  if (typeof value === "number") return spokenNumber(value);
  if (typeof value === "string") return podcastSpokenText(value);
  if (Array.isArray(value)) return value.map((item) => podcastFeatureValue(key, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, podcastFeatureValue(childKey, item)]));
  }
  return value;
};

export const podcastFeatureContext = (features: Record<string, unknown> | null) => Object.fromEntries(
  Object.entries(features ?? {})
    .filter(([key, value]) => usefulFeature.test(key) && value != null && value !== "")
    .map(([key, value]) => [podcastFeatureKey(key), podcastFeatureValue(key, value)])
    .slice(0, 60)
);

export const podcastSpeechText = (transcript: string) => transcript
  .replace(/\bCHINE\b/g, "SHEEN")
  .replace(/\bChine\b/g, "Sheen")
  .replace(/\bchine\b/g, "sheen");

export const podcastWordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

export const podcastSystemPrompt = `Write a single-host daily sports podcast script for Chine Sheets. Aim for 950 words and never exceed 1200 words, producing roughly 5 to 10 minutes of speech. Focus on no more than the three supplied picks. Sound like a natural sports host, not a stat dump: establish the matchup, explain why Chine made each pick, connect statistics conversationally, and use transitions between games. Use only facts explicitly supplied in the input. Never invent injuries, weather, venue details, player names, rivalry context, playoff implications, or news. If an interesting contextual note is not supplied, omit it. Confidence is a model estimate, never a guarantee. Translate every model feature into language a casual sports listener will understand. Never read an internal feature name or unexplained analytics term aloud. Lead with what a metric means, then use the number as support. Define any necessary technical statistic immediately in the same sentence. The first time scoring margin appears, explain that it is the average amount by which the team outscores or is outscored by opponents, using points, runs, or goals as appropriate for that sport. Later references may say scoring margin without repeating the definition. Convert ratios such as 0.69 to natural percentages such as 69 percent when that is clearer. For example, describe NHL season points percentage as the share of available standings points a team has earned, rather than calling it simply "season points percentage." Start exactly with: "Welcome to today's StakeWars podcast. I am Chine, your host, and we have a lot of action to get to, so let's get started." End with a concise recap and an invitation to compete at stakewars.ai. Return spoken prose only, in paragraphs, with no Markdown, headings, stage directions, bullet points, citations, or music instructions.`;

const lineText = (pick: PodcastScriptPick) => pick.marketKey === "h2h"
  ? `moneyline ${pick.oddsAmerican > 0 ? "+" : ""}${pick.oddsAmerican}`
  : `spread ${pick.spread}, ${pick.oddsAmerican > 0 ? "+" : ""}${pick.oddsAmerican}`;

export const buildPodcastPromptData = (date: string, picks: PodcastScriptPick[]) => ({
  episodeDate: date,
  show: "Chine Sheets",
  picks: picks.slice(0, 3).map((pick) => ({
    id: pick.id,
    game: `${pick.awayTeam} at ${pick.homeTeam}`,
    sport: pick.sport,
    league: pick.league,
    startsAt: pick.startsAt,
    selection: pick.selectedTeam,
    line: lineText(pick),
    confidencePercent: pick.confidence == null ? null : Math.round(Number(pick.confidence) * 100),
    modelReasons: (pick.reasons ?? []).map(podcastSpokenText),
    verifiedModelContext: podcastFeatureContext(pick.features)
  }))
});

export const generateChineSheetsScript = async (date: string, picks: PodcastScriptPick[]) => {
  if (!config.openAiApiKey) throw new Error("OPENAI_API_KEY is not configured.");
  if (picks.length === 0) throw new Error("No Chine picks are available for this date.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openAiApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.openAiModel,
        max_output_tokens: 1900,
        input: [
          {
            role: "system",
            content: podcastSystemPrompt
          },
          {
            role: "user",
            content: JSON.stringify(buildPodcastPromptData(date, picks))
          }
        ]
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Podcast script generation failed with status ${response.status}.`);
    const transcript = outputText(body);
    if (!transcript) throw new Error("Podcast script generation returned no text.");
    const wordCount = podcastWordCount(transcript);
    if (wordCount < 750 || wordCount > 1500) {
      throw new Error(`Podcast script length was ${wordCount} words; expected approximately 900 to 1300.`);
    }
    return {
      title: `Chine Sheets - ${date}`,
      transcript,
      speechText: podcastSpeechText(transcript),
      wordCount,
      modelId: config.openAiModel,
      pickIds: picks.slice(0, 3).map((pick) => pick.id)
    };
  } finally {
    clearTimeout(timeout);
  }
};
