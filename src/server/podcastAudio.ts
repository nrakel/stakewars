import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { elevenLabsClient } from "./elevenLabs.js";

const execFileAsync = promisify(execFile);
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;
export const podcastAudioDirectory = path.resolve("data/podcast");
export const podcastIntroPath = path.join(podcastAudioDirectory, "chine-sheets-intro-v1.mp3");

const introPrompt = "Upbeat modern sports podcast intro music with energetic drums and bright brass, a live stadium crowd cheering underneath, instrumental only, polished broadcast sound, strong opening and a clean gradual fade near the end.";

export const podcastEpisodePath = (date: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid podcast episode date.");
  return path.join(podcastAudioDirectory, `chine-sheets-${date}.mp3`);
};

export const podcastMixArgs = (intro: string, narration: string, output: string) => [
  "-y",
  "-i", intro,
  "-i", narration,
  "-filter_complex",
  "[0:a]afade=t=out:st=4:d=6,volume=0.62[intro];[1:a]adelay=3000|3000,volume=1.0[narration];[intro][narration]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[out]",
  "-map", "[out]",
  "-codec:a", "libmp3lame",
  "-b:a", "128k",
  output
];

const ensureIntro = async () => {
  await mkdir(podcastAudioDirectory, { recursive: true });
  try {
    const { access } = await import("node:fs/promises");
    await access(podcastIntroPath);
    return false;
  } catch {
    const intro = await elevenLabsClient.generateSoundEffect(introPrompt, 12);
    const temporary = `${podcastIntroPath}.${process.pid}.tmp`;
    await writeFile(temporary, intro.audio, { mode: 0o640 });
    await rename(temporary, podcastIntroPath);
    return true;
  }
};

export const generatePodcastEpisodeAudio = async (date: string, speechText: string) => {
  if (!ffmpegPath) throw new Error("Podcast audio mixer is unavailable.");
  await mkdir(podcastAudioDirectory, { recursive: true });
  const introCreated = await ensureIntro();
  const narration = await elevenLabsClient.generateSpeech(speechText);
  const narrationPath = path.join(podcastAudioDirectory, `.narration-${date}-${process.pid}.mp3`);
  const outputPath = podcastEpisodePath(date);
  const temporaryOutput = `${outputPath}.${process.pid}.tmp.mp3`;
  try {
    await writeFile(narrationPath, narration.audio, { mode: 0o640 });
    await execFileAsync(ffmpegPath, podcastMixArgs(podcastIntroPath, narrationPath, temporaryOutput), {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024
    });
    await rename(temporaryOutput, outputPath);
    await chmod(outputPath, 0o640);
  } finally {
    await rm(narrationPath, { force: true });
    await rm(temporaryOutput, { force: true });
  }
  return {
    outputPath,
    characterCount: narration.characterCount,
    introCreated,
    modelId: narration.modelId,
    outputFormat: narration.outputFormat
  };
};
