import { config } from "./config.js";

type ElevenLabsClientOptions = {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class ElevenLabsError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

export class ElevenLabsClient {
  private readonly apiKey?: string;
  private readonly voiceId?: string;
  private readonly modelId: string;
  private readonly outputFormat: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ElevenLabsClientOptions = {}) {
    this.apiKey = options.apiKey ?? config.elevenLabsApiKey;
    this.voiceId = options.voiceId ?? config.elevenLabsVoiceId;
    this.modelId = options.modelId ?? config.elevenLabsModelId;
    this.outputFormat = options.outputFormat ?? config.elevenLabsOutputFormat;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async generateSpeech(text: string) {
    const normalizedText = text.trim();
    if (!this.apiKey || !this.voiceId) {
      throw new ElevenLabsError("ElevenLabs is not configured.", 503);
    }
    if (!normalizedText || normalizedText.length > 10_000) {
      throw new ElevenLabsError("Speech text must contain between 1 and 10,000 characters.", 400);
    }

    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}`);
    url.searchParams.set("output_format", this.outputFormat);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "xi-api-key": this.apiKey
        },
        body: JSON.stringify({ text: normalizedText, model_id: this.modelId }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ElevenLabsError(timedOut ? "ElevenLabs generation timed out." : "ElevenLabs could not be reached.");
    }

    if (!response.ok) {
      const details = await response.json().catch(() => ({})) as { detail?: { message?: string } | string };
      const providerMessage = typeof details.detail === "string" ? details.detail : details.detail?.message;
      const safeMessage = response.status === 401 || response.status === 403
        ? "ElevenLabs authentication or voice access failed."
        : providerMessage?.slice(0, 240) || `ElevenLabs generation failed with status ${response.status}.`;
      throw new ElevenLabsError(safeMessage, response.status >= 400 && response.status < 500 ? 400 : 502);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) throw new ElevenLabsError("ElevenLabs returned empty audio.");
    return {
      audio,
      contentType: response.headers.get("content-type") ?? "audio/mpeg",
      characterCount: normalizedText.length,
      modelId: this.modelId,
      outputFormat: this.outputFormat
    };
  }

  async generateSoundEffect(text: string, durationSeconds = 12) {
    const normalizedText = text.trim();
    if (!this.apiKey) throw new ElevenLabsError("ElevenLabs is not configured.", 503);
    if (!normalizedText || normalizedText.length > 450) {
      throw new ElevenLabsError("Sound-effect prompt must contain between 1 and 450 characters.", 400);
    }
    if (durationSeconds < 0.5 || durationSeconds > 30) {
      throw new ElevenLabsError("Sound-effect duration must be between 0.5 and 30 seconds.", 400);
    }

    const url = new URL("https://api.elevenlabs.io/v1/sound-generation");
    url.searchParams.set("output_format", this.outputFormat);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "xi-api-key": this.apiKey
        },
        body: JSON.stringify({
          text: normalizedText,
          duration_seconds: durationSeconds,
          prompt_influence: 0.6,
          model_id: "eleven_text_to_sound_v3",
          loop: false
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ElevenLabsError(timedOut ? "ElevenLabs intro generation timed out." : "ElevenLabs could not be reached.");
    }

    if (!response.ok) {
      const details = await response.json().catch(() => ({})) as { detail?: { message?: string } | string };
      const providerMessage = typeof details.detail === "string" ? details.detail : details.detail?.message;
      const safeMessage = response.status === 401 || response.status === 403
        ? "ElevenLabs authentication or sound-generation access failed."
        : providerMessage?.slice(0, 240) || `ElevenLabs intro generation failed with status ${response.status}.`;
      throw new ElevenLabsError(safeMessage, response.status >= 400 && response.status < 500 ? 400 : 502);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) throw new ElevenLabsError("ElevenLabs returned empty intro audio.");
    return {
      audio,
      contentType: response.headers.get("content-type") ?? "audio/mpeg",
      characterCount: Number(response.headers.get("character-cost") ?? 0) || null,
      durationSeconds,
      modelId: "eleven_text_to_sound_v3",
      outputFormat: this.outputFormat
    };
  }
}

export const elevenLabsClient = new ElevenLabsClient();
