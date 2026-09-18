/**
 * Smoke test for the Gemini credentials. Run: bun run check:key
 *
 * Verifies the key is loaded and makes one real call through the same stack the
 * interpreter uses. Run this before anything else — if it fails, nothing
 * downstream will work.
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";

const key =
  Bun.env.GEMINI_API_KEY ??
  Bun.env.GOOGLE_GENERATIVE_AI_API_KEY ??
  Bun.env.GOOGLE_API_KEY;

if (!key) {
  console.error("✗ No API key found.");
  console.error("  Add this to .env in the project root:");
  console.error("    GEMINI_API_KEY=your-key-here");
  console.error("  Get a key at https://aistudio.google.com/apikey");
  process.exit(1);
}
console.log(`✓ Key loaded (${key.slice(0, 6)}…${key.slice(-4)})`);

const model = Bun.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
const google = createGoogleGenerativeAI({ apiKey: key });

console.log(`Calling ${model} …`);
const started = Date.now();
try {
  const { text } = await generateText({
    model: google(model),
    prompt: "Reply with exactly the word: ok",
    abortSignal: AbortSignal.timeout(30000),
    maxRetries: 0,
    providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } },
  });
  console.log(`✓ Replied in ${Date.now() - started}ms: ${text.trim()}`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`✗ Call failed after ${Date.now() - started}ms`);
  console.error(`  ${message.slice(0, 300)}`);
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(message)) {
    console.error(
      "\n  This is a RATE LIMIT, not a bad key. The free tier allows only\n" +
        "  15 requests/minute for this model — see the note in README.",
    );
  }
  process.exit(1);
}
