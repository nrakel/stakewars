import assert from "node:assert/strict";
import test from "node:test";
import { ElevenLabsClient, ElevenLabsError } from "../src/server/elevenLabs.js";

test("ElevenLabs client sends configured voice, model, and output format", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new ElevenLabsClient({
    apiKey: "test-key",
    voiceId: "test-voice",
    modelId: "test-model",
    outputFormat: "mp3_44100_128",
    fetchImpl: (async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch
  });

  const result = await client.generateSpeech("  Hello StakeWars.  ");
  assert.equal(requestedUrl, "https://api.elevenlabs.io/v1/text-to-speech/test-voice?output_format=mp3_44100_128");
  assert.equal(requestedInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), { text: "Hello StakeWars.", model_id: "test-model" });
  assert.equal(result.audio.length, 3);
  assert.equal(result.characterCount, 16);
  assert.equal(result.contentType, "audio/mpeg");
});

test("ElevenLabs client rejects missing configuration before making a request", async () => {
  let called = false;
  const client = new ElevenLabsClient({
    apiKey: "",
    voiceId: "",
    fetchImpl: (async () => {
      called = true;
      return new Response();
    }) as typeof fetch
  });
  await assert.rejects(() => client.generateSpeech("Hello"), (error: unknown) => (
    error instanceof ElevenLabsError && error.statusCode === 503
  ));
  assert.equal(called, false);
});

test("ElevenLabs client sanitizes authentication errors", async () => {
  const client = new ElevenLabsClient({
    apiKey: "secret-key",
    voiceId: "private-voice-id",
    fetchImpl: (async () => new Response(JSON.stringify({
      detail: { message: "A voice with ID 'private-voice-id' was not found." }
    }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch
  });
  await assert.rejects(() => client.generateSpeech("Hello"), (error: unknown) => (
    error instanceof ElevenLabsError
    && error.message === "ElevenLabs authentication or voice access failed."
    && !error.message.includes("private-voice-id")
  ));
});

test("ElevenLabs client generates a reusable sports intro sound effect", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  const client = new ElevenLabsClient({
    apiKey: "test-key",
    voiceId: "test-voice",
    outputFormat: "mp3_44100_128",
    fetchImpl: (async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "audio/mpeg", "character-cost": "480" }
      });
    }) as typeof fetch
  });
  const result = await client.generateSoundEffect("Upbeat sports intro", 12);
  assert.equal(requestedUrl, "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128");
  assert.equal(requestedBody.duration_seconds, 12);
  assert.equal(requestedBody.model_id, "eleven_text_to_sound_v3");
  assert.equal(requestedBody.loop, false);
  assert.equal(result.characterCount, 480);
  assert.equal(result.audio.length, 3);
});
