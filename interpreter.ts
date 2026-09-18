/**
 * LLM Interpreter — stage 2 of the pipeline. Owned by role B.
 *
 * Turns natural-language operator notes into RAW, UNTRUSTED structured output.
 * This module is allowed to be wrong. `guardrails.ts` is the layer that is not.
 * Nothing here is ever fed straight to the optimizer.
 */
import { GoogleGenAI, Type } from "@google/genai";
import type { Battery } from "./types";
import { createSlidingWindowLimiter, isQuotaError } from "./rate-limiter";
import { fallbackExtract } from "./interpreter-fallback";

const MODEL = Bun.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const TIMEOUT_MS = Number(Bun.env.LLM_TIMEOUT_MS ?? 8000);

// Free-tier keys are capped at a small requests-per-minute quota (observed:
// 15 RPM for gemini-3.1-flash-lite, returned as a RESOURCE_EXHAUSTED 429 with
// the model name in the quota id). We can't buy headroom, so we track a local
// sliding window and skip the network call once we're near the ceiling,
// going straight to the deterministic fallback below instead of paying an
// 8s timeout for a call that would just 429.
const RATE_LIMIT_PER_MINUTE = Number(Bun.env.GEMINI_RPM_LIMIT ?? 12);
const limiter = createSlidingWindowLimiter(RATE_LIMIT_PER_MINUTE);

// The SDK reads GEMINI_API_KEY / GOOGLE_API_KEY from the environment itself.
const ai = new GoogleGenAI({});

/**
 * One raw entry per note, exactly as the model emits it.
 *
 * Deliberately FLAT rather than a discriminated union on structured_adjustment:
 * Gemini's responseSchema is an OpenAPI subset with poor union support, and a
 * flat shape means the model can never emit a malformed adjustment object.
 * guardrails.ts assembles the real structured_adjustment from these fields.
 *
 * Note there is no `applies` field. It is derived (`directive_type !== "no_op"`),
 * so the model cannot get it wrong — that closes off trap 4 entirely.
 */
export interface RawEntry {
  note_index?: unknown;
  directive_type?: unknown;
  hours?: unknown;
  factor?: unknown;
  minimum_energy_kwh?: unknown;
  max_grid_kwh?: unknown;
  explanation?: unknown;
}

const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      note_index: {
        type: Type.INTEGER,
        description: "0-based index of the operator note this entry describes.",
      },
      directive_type: {
        type: Type.STRING,
        enum: [
          "solar_reduction",
          "minimum_battery_reserve",
          "no_charge_window",
          "no_discharge_window",
          "max_grid_window",
          "no_op",
        ],
      },
      hours: {
        type: Type.ARRAY,
        items: { type: Type.INTEGER },
        description:
          "Affected hours, 0-23, start-inclusive and end-exclusive. Empty for no_op.",
      },
      factor: {
        type: Type.NUMBER,
        description:
          "solar_reduction only. The fraction of solar that REMAINS, 0..1.",
      },
      minimum_energy_kwh: {
        type: Type.NUMBER,
        description:
          "minimum_battery_reserve only. Absolute kWh, already resolved from any percentage.",
      },
      max_grid_kwh: {
        type: Type.NUMBER,
        description: "max_grid_window only. Hourly grid import cap in kWh.",
      },
      explanation: {
        type: Type.STRING,
        description: "One short sentence explaining the interpretation.",
      },
    },
    required: ["note_index", "directive_type", "explanation"],
  },
};

const SYSTEM_INSTRUCTION = `
You convert campus energy operator notes into structured scheduling directives.
Return one entry per note, in note_index order. Emit JSON only.

DIRECTIVE TYPES
- solar_reduction        solar output is reduced for some hours. Needs hours + factor.
- minimum_battery_reserve  battery must stay at or above an energy level. Needs hours + minimum_energy_kwh.
- no_charge_window       battery cannot charge. Needs hours.
- no_discharge_window    battery cannot discharge. Needs hours.
- max_grid_window        grid import is capped per hour. Needs hours + max_grid_kwh.
- no_op                  the note does not change the 24-hour energy schedule. hours empty.

TIME WINDOWS ARE START-INCLUSIVE AND END-EXCLUSIVE
Convert to whole hours 0-23 on a 24-hour clock, ascending, no duplicates.
  "1 PM to 3 PM"            -> [13, 14]
  "from 6 PM until 9 PM"    -> [18, 19, 20]
  "from 6 PM until 10 PM"   -> [18, 19, 20, 21]
  "between 11 AM and 2 PM"  -> [11, 12, 13]
  "2 AM until 5 AM"         -> [2, 3, 4]
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

async function callModel(notes: string[], battery: Battery): Promise<RawEntry[]> {
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: buildPrompt(notes, battery),
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
      // 0 disables thinking. This is an extraction task, not a reasoning task,
      // and the p95 latency budget is 5s. Raise it only if accuracy needs it.
      thinkingConfig: { thinkingBudget: 0 },
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    },
  });

  const text = res.text;
  if (!text) throw new Error("empty model response");

  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("model did not return an array");
  return parsed as RawEntry[];
}

/**
 * Raw model output. May be malformed, short, long, or nonsense — that is the
 * guardrail layer's problem. Returns [] rather than throwing, so a provider
 * outage degrades to "all notes look like no_op" instead of a 500.
 */
export async function interpret(
  notes: string[],
  battery: Battery,
): Promise<RawEntry[]> {
  const key = cacheKey(notes, battery);
  const hit = cache.get(key);
  if (hit) return hit;

  if (!limiter.hasBudget()) {
    console.error("interpret: local rate budget exhausted, using fallback extractor");
    return fallbackExtract(notes, battery);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      limiter.recordCall();
      const entries = await callModel(notes, battery);
      cache.set(key, entries);
      return entries;
    } catch (err) {
      // Never log the key or the raw error object — secret safety is scored.
      console.error(
        `interpret attempt ${attempt + 1} failed:`,
        err instanceof Error ? err.message : "unknown error",
      );
      // A 429 will fail identically on immediate retry; don't pay for a
      // second doomed round trip when the fallback is right there.
      if (isQuotaError(err)) break;
    }
  }
  return fallbackExtract(notes, battery);
}
