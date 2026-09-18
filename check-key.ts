/**
 * Smoke test for the Gemini credentials. Run: bun run check-key.ts
 *
 * Verifies the key is loaded, lists the models it can reach, and makes one
 * real call. Run this before writing any interpreter code — if this fails,
 * nothing downstream will work.
 */
import { GoogleGenAI } from "@google/genai";

const key = Bun.env.GEMINI_API_KEY ?? Bun.env.GOOGLE_API_KEY;
if (!key) {
  console.error("✗ No GEMINI_API_KEY found.");
  console.error("  Create a .env file in the project root containing:");
  console.error("    GEMINI_API_KEY=your-key-here");
  console.error("  Get a key at https://aistudio.google.com/apikey");
  process.exit(1);
}
console.log(`✓ Key loaded (${key.slice(0, 6)}…${key.slice(-4)})`);

// The SDK reads GEMINI_API_KEY / GOOGLE_API_KEY from the environment itself.
const ai = new GoogleGenAI({});

console.log("\nModels available to this key that support generateContent:");
const usable: string[] = [];
for await (const m of await ai.models.list()) {
  if (m.supportedActions?.includes("generateContent") && m.name) {
    usable.push(m.name.replace(/^models\//, ""));
  }
}
for (const name of usable.sort()) console.log(`  ${name}`);

const model = Bun.env.GEMINI_MODEL ?? "gemini-2.5-flash";
console.log(`\nCalling ${model} …`);
const started = Date.now();
const res = await ai.models.generateContent({
  model,
  contents: "Reply with exactly the word: ok",
});
console.log(`✓ Replied in ${Date.now() - started}ms: ${res.text?.trim()}`);

if (!usable.includes(model)) {
  console.warn(
    `\n⚠ GEMINI_MODEL="${model}" was not in the list above. ` +
      `Pick one that is and set it in .env.`,
  );
}
