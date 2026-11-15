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
  verifiedGameContext?: Record<string, unknown> | null;
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

export const podcastSystemPrompt = `Write a single-host daily sports show for Chine Sheets, aimed at a casual sports fan who wants strong opinions and entertaining game stories—not an analytics lecture. Aim for 850 to 1150 words and never exceed 1300 words, producing roughly 5 to 10 minutes of speech. Focus on no more than the three supplied picks.

Open exactly with: "Welcome to today's StakeWars podcast. I am Chine, your host, and we have a lot of action to get to, so let's get started." Immediately follow with a lively cold-open tease that gives listeners a reason to stay for all three games.

For each game, follow a natural radio-show arc without announcing the structure: open with a hook or tension point; state Chine's pick and opinion clearly; use only the two or three most persuasive supplied statistics; explain what those facts mean on the field, court, rink, or diamond; identify the most plausible way the pick could go wrong; then close with a confident, memorable take. There is an absolute maximum of three supporting numerical facts per game beyond the betting line and confidence; omit every additional number, even if it is available. Use transitions that connect the games instead of saying "first," "next," and "finally" mechanically. Vary sentence length and rhythm. Add restrained wit, playful confidence, and occasional swagger, but do not force jokes or insult teams or fans.

When verified game context supplies player names, make the recognizable players and their matchup the center of the story. Mention the projected starting quarterbacks, and bring in a lead running back when the ground matchup matters. Player identity and the on-field conflict should lead; averages and rankings should support the opinion. Write like a knowledgeable friend making a direct case: start with the player or matchup that makes the pick compelling, explain why that advantage matters, acknowledge the opponent's best answer, and explain why the pick can withstand it. A defense rank in the input is only its rank among the teams in that week's modeled slate, not an official full-league rank, so qualify it that way if used. Use a ranking only when it genuinely supports the pick or clearly explains the opponent's best counterargument. Do not infer a player's style of play merely from the player's name or projection. Do not claim career awards, proven pedigree, injury status, roster status, or biographical facts unless the input explicitly supplies them.

Statistics are supporting evidence, never the story. Do not recite feature lists or comparison windows. Do not mention every available statistic. Never say phrases such as "the model shows," "the model lists," "the reasons include," "the selected team," "the opponent," "the inputs," "the context," "moneyline-to-spread energy," or "betting like you believe it." Name the actual teams. Mention confidence once per pick at most. Assume a casual sports fan already understands moneylines and point spreads; do not explain basic betting mechanics or tell the listener to place a real-money bet. Read betting lines exactly in the natural form supplied. Never call a favorite's spread "negative," and never pronounce a whole or half-point spread as "point-zero" or "point-five." Say "favored by three points" and "three-and-a-half points." Do not read internal feature names aloud. Translate analytics into ordinary sports language. If scoring margin is used, define it once on first use as the average amount by which a team outscores or is outscored by opponents, then move on. Express standings-point ratios as natural percentages and explain them as the share of available standings points earned. Round spoken figures naturally and avoid false precision.

Use only facts explicitly supplied in the input. Never invent injuries, weather, venue details, player names, rivalry context, playoff implications, or news. If an interesting note is not supplied, build interest from the matchup tension and the pick's strongest verified advantages rather than fabricating a storyline. Confidence is an estimate, never a guarantee.

End with a fast recap that does not repeat the supporting statistics, one confident challenge to the listener, and an invitation to compete at stakewars.ai. Return spoken prose only, in paragraphs, with no Markdown, headings, stage directions, bullet points, citations, or music instructions.`;

const smallNumbers = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const tensNumbers = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const spokenWholeNumber = (value: number): string => {
  const whole = Math.abs(Math.trunc(value));
  if (whole < 20) return smallNumbers[whole] ?? String(whole);
  if (whole < 100) {
    const tens = tensNumbers[Math.floor(whole / 10)] ?? "";
    const ones = whole % 10;
    return ones ? `${tens}-${smallNumbers[ones]}` : tens;
  }
  return String(whole);
};

export const spokenSpread = (value: number) => {
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute);
  const fraction = Math.round((absolute - whole) * 10);
  if (fraction === 0) return spokenWholeNumber(whole);
  if (fraction === 5) return `${spokenWholeNumber(whole)}-and-a-half`;
  return `${spokenWholeNumber(whole)}-point-${spokenWholeNumber(fraction)}`;
};

export const spokenAmericanOdds = (value: number) => {
  const absolute = Math.abs(value);
  const sign = value >= 0 ? "plus" : "minus";
  if (absolute >= 100 && absolute <= 999) {
    const lead = spokenWholeNumber(Math.floor(absolute / 100));
    const remainder = absolute % 100;
    if (remainder === 0) return `${sign} ${lead}-hundred`;
    if (remainder < 10) return `${sign} ${lead}-oh-${spokenWholeNumber(remainder)}`;
    return `${sign} ${lead}-${spokenWholeNumber(remainder)}`;
  }
  return `${sign} ${spokenWholeNumber(absolute)}`;
};

const lineText = (pick: PodcastScriptPick) => {
  if (pick.marketKey === "h2h") return `${pick.selectedTeam} to win at ${spokenAmericanOdds(pick.oddsAmerican)}`;
  const spread = Number(pick.spread);
  const odds = spokenAmericanOdds(pick.oddsAmerican);
  const unit = pick.sport === "MLB" ? "runs" : pick.sport === "NHL" ? "goals" : "points";
  if (!Number.isFinite(spread) || spread === 0) return `${pick.selectedTeam} at pick'em, ${odds}`;
  return spread < 0
    ? `The ${pick.selectedTeam} are favored by ${spokenSpread(spread)} ${unit} at ${odds}`
    : `The ${pick.selectedTeam} are getting ${spokenSpread(spread)} ${unit} at ${odds}`;
};

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
    verifiedModelContext: podcastFeatureContext(pick.features),
    verifiedGameContext: pick.verifiedGameContext ?? null
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
    if (wordCount < 750 || wordCount > 1350) {
      throw new Error(`Podcast script length was ${wordCount} words; expected approximately 850 to 1150.`);
    }
    if (!/stakewars\.ai/i.test(transcript)) {
      throw new Error("Podcast script generation returned an incomplete transcript.");
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
