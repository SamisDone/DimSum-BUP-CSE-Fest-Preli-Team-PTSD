/**
 * LLM Interpreter — stage 2 of the pipeline. Owned by role B.
 *
 * Turns natural-language operator notes into RAW, UNTRUSTED structured output.
 * This module is allowed to be wrong. `guardrails.ts` is the layer that is not.
 * Nothing here is ever fed straight to the optimizer.
 *
 * Uses the Vercel AI SDK (`ai` + `@ai-sdk/google`). generateObject validates
 * the model's JSON against the Zod schema before we ever see it — but that is a
 * convenience, not a guarantee, so guard() still re-checks everything.
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";
import type { Battery } from "./types";

const MODEL = Bun.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";
const TIMEOUT_MS = Number(Bun.env.LLM_TIMEOUT_MS ?? 20000);

// The AI SDK's own env var is GOOGLE_GENERATIVE_AI_API_KEY. We pass the key
// explicitly so the GEMINI_API_KEY already in .env keeps working, and accept
// either name.
const google = createGoogleGenerativeAI({
  apiKey:
    Bun.env.GEMINI_API_KEY ??
    Bun.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    Bun.env.GOOGLE_API_KEY ??
    "",
});

/**
 * One raw entry per note.
 *
 * Deliberately FLAT rather than a discriminated union on structured_adjustment:
 * a flat shape means the model can never emit a malformed adjustment object,
 * and guardrails.ts assembles the real structured_adjustment from these fields.
 *
 * Note there is no `applies` field. It is derived (`directive_type !== "no_op"`),
 * so the model cannot get it wrong — that closes off trap 4 entirely.
 *
 * Everything except note_index/directive_type is optional: a no_op has no hours,
 * and a no_charge_window has no numeric value.
 */
const EntrySchema = z.object({
  note_index: z.number().int().describe("0-based index of the operator note."),
  directive_type: z.enum([
    "solar_reduction",
    "minimum_battery_reserve",
    "no_charge_window",
    "no_discharge_window",
    "max_grid_window",
    "no_op",
  ]),
  hours: z
    .array(z.number().int())
    .optional()
    .describe("Affected hours 0-23, start-inclusive and end-exclusive. Omit for no_op."),
  factor: z
    .number()
    .optional()
    .describe("solar_reduction only. The fraction of solar that REMAINS, 0..1."),
  minimum_energy_kwh: z
    .number()
    .optional()
    .describe("minimum_battery_reserve only. Absolute kWh, percentages already resolved."),
  max_grid_kwh: z
    .number()
    .optional()
    .describe("max_grid_window only. Hourly grid import cap in kWh."),
  explanation: z.string().describe("One short sentence explaining the interpretation."),
});

const ResponseSchema = z.object({
  entries: z.array(EntrySchema),
});

/** What guard() consumes. Every field is re-validated there regardless. */
export interface RawEntry {
  note_index?: unknown;
  directive_type?: unknown;
  hours?: unknown;
  factor?: unknown;
  minimum_energy_kwh?: unknown;
  max_grid_kwh?: unknown;
  explanation?: unknown;
}

const SYSTEM_INSTRUCTION = `
You convert campus energy operator notes into structured scheduling directives.
Return one entry per note, in note_index order.

DIRECTIVE TYPES
- solar_reduction          solar output is reduced for some hours. Needs hours + factor.
- minimum_battery_reserve  battery must stay at or above an energy level. Needs hours + minimum_energy_kwh.
- no_charge_window         battery cannot charge. Needs hours.
- no_discharge_window      battery cannot discharge. Needs hours.
- max_grid_window          grid import is capped per hour. Needs hours + max_grid_kwh.
- no_op                    the note does not change the 24-hour energy schedule. Omit hours.

TIME WINDOWS ARE START-INCLUSIVE AND END-EXCLUSIVE
Convert to whole hours 0-23 on a 24-hour clock, ascending, no duplicates.
  "1 PM to 3 PM"              -> [13, 14]
  "from 6 PM until 9 PM"      -> [18, 19, 20]
  "from 6 PM until 10 PM"     -> [18, 19, 20, 21]
  "between 11 AM and 2 PM"    -> [11, 12, 13]
  "2 AM until 5 AM"           -> [2, 3, 4]
  "for three hours from 9 AM" -> [9, 10, 11]

FACTOR IS THE FRACTION THAT REMAINS, NOT THE FRACTION LOST
  "drop to about 20%"          -> factor 0.2
  "an 80% reduction"           -> factor 0.2
  "roughly half of forecast"   -> factor 0.5
  "about one-fifth of normal"  -> factor 0.2
  "a quarter of the forecast"  -> factor 0.25

RESERVES MAY BE EXPRESSED AS A PERCENTAGE OF CAPACITY
Resolve them against the battery capacity given in the request and return
absolute kWh. With a 200 kWh battery, "at least 50% of capacity" -> 100.

IRRELEVANT NOTES
Campus life that does not change electricity scheduling is no_op: menus,
registration deadlines, library hours, room bookings, notices, staffing.
When a note does not change the schedule, emit no_op. Do not invent a rule.

NEVER invent demand, solar, tariff or battery limits. Only report what the note
states. Every note gets exactly one entry, even if it is no_op.
`.trim();

/** In-process cache. Hidden suites repeat paraphrases; this is free latency. */
const cache = new Map<string, RawEntry[]>();

function cacheKey(notes: string[], battery: Battery): string {
  return JSON.stringify([notes, battery.capacity_kwh]);
}

function buildPrompt(notes: string[], battery: Battery): string {
  const listed = notes.map((n, i) => `[${i}] ${n}`).join("\n");
  return [
    `Battery capacity: ${battery.capacity_kwh} kWh`,
    `Battery base minimum reserve: ${battery.minimum_energy_kwh} kWh`,
    "",
    `Operator notes (${notes.length}):`,
    listed,
    "",
    `Return exactly ${notes.length} entries, one per note, note_index 0..${notes.length - 1}.`,
  ].join("\n");
}

/**
 * Raw model output. Returns [] rather than throwing, so a provider outage,
 * rate limit or malformed response degrades to "every note looks like no_op"
 * instead of a 500.
 *
 * NOTE: exactly ONE request per call. Do not add hedging or parallel retries —
 * the Gemini free tier allows 15 requests/minute for this model, and doubling
 * request volume turns a slow response into a 429 for every later case.
 */
export async function interpret(
  notes: string[],
  battery: Battery,
): Promise<RawEntry[]> {
  const key = cacheKey(notes, battery);
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    const { object } = await generateObject({
      model: google(MODEL),
      schema: ResponseSchema,
      system: SYSTEM_INSTRUCTION,
      prompt: buildPrompt(notes, battery),
      temperature: 0,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      // No retries. On the free tier a 429 needs ~50s to clear, so an
      // immediate retry is guaranteed to fail AND burns a second request from
      // the same 15/minute budget — making the next case fail too. Raise this
      // to 1-2 only once the key is on a paid tier.
      maxRetries: 0,
      providerOptions: {
        google: {
          // Lowest reasoning the provider exposes. This is extraction, not
          // reasoning, and thinking is what pushed latency past 18s.
          thinkingConfig: { thinkingLevel: "low" },
        },
      },
    });

    cache.set(key, object.entries);
    return object.entries;
  } catch (err) {
    // Never log the key or the raw error object — secret safety is scored.
    const message = err instanceof Error ? err.message : "unknown error";
    const rateLimited = message.includes("429") || /quota|RESOURCE_EXHAUSTED/i.test(message);
    console.error(
      `interpret failed${rateLimited ? " (RATE LIMITED)" : ""}, falling back to no_op: ` +
        message.slice(0, 200),
    );
    return [];
  }
}
