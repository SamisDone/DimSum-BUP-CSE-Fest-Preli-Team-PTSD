/**
 * Deterministic fallback extractor for operator notes.
 *
 * Used only when the LLM call fails (timeout, provider error, unparseable
 * output) or the rate limiter says a call would just be rejected — never as
 * the primary path. Regex/keyword based, so it is necessarily weaker than the
 * model on unseen paraphrases; guard() still validates and bounds whatever
 * this returns, so an imperfect match degrades to no_op rather than a bad
 * constraint reaching the optimizer.
 */
import type { Battery, DirectiveType } from "./types";
import type { RawEntry } from "./interpreter";

const WORD_NUMBER: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
};

const FRACTION_WORD: Record<string, number> = {
  half: 0.5,
  quarter: 0.25,
  "one-fourth": 0.25,
  "a fourth": 0.25,
  third: 1 / 3,
  "one-third": 1 / 3,
  "a third": 1 / 3,
  fifth: 0.2,
  "one-fifth": 0.2,
  "a fifth": 0.2,
};

const LOSS_WORDS = /\b(reduction|reduce|cut|decrease|decline)\b/;
const NEGATION_WORDS = /\b(not|cannot|can't|don't|do not|no|avoid|disabled|isolated|unavailable|offline)\b/;
const TIME = "(\\d{1,2})\\s*(am|pm)";

function to24Hour(hourStr: string, meridiem: string): number {
  const h = parseInt(hourStr, 10) % 12;
  return /pm/i.test(meridiem) ? h + 12 : h;
}

/** Start-inclusive, end-exclusive, wrapping at 24. */
function hourRange(start: number, end: number): number[] {
  const hours: number[] = [];
  for (let h = start; h !== end; h = (h + 1) % 24) hours.push(h);
  return hours;
}

function normalizeClockWords(note: string): string {
  return note.replace(/\bnoon\b/gi, "12 pm").replace(/\bmidnight\b/gi, "12 am");
}

function extractHours(note: string): number[] | null {
  const lower = normalizeClockWords(note).toLowerCase();

  let m = lower.match(new RegExp(`(?:from|between)\\s+${TIME}\\s+(?:to|until|and)\\s+${TIME}`));
  if (m) return hourRange(to24Hour(m[1]!, m[2]!), to24Hour(m[3]!, m[4]!));

  m = lower.match(new RegExp(`${TIME}\\s+(?:to|until)\\s+${TIME}`));
  if (m) return hourRange(to24Hour(m[1]!, m[2]!), to24Hour(m[3]!, m[4]!));

  m = lower.match(new RegExp(`for\\s+(\\w+)\\s+hours?\\s+(?:starting at|from)\\s+${TIME}`));
  if (m) {
    const n = /^\d+$/.test(m[1]!) ? parseInt(m[1]!, 10) : WORD_NUMBER[m[1]!];
    if (n) {
      const start = to24Hour(m[2]!, m[3]!);
      return Array.from({ length: n }, (_, i) => (start + i) % 24);
    }
  }

  return null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function extractFactor(note: string): number | null {
  const lower = note.toLowerCase();
  const isLoss = LOSS_WORDS.test(lower);

  const pct = lower.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (pct) {
    const frac = parseFloat(pct[1]!) / 100;
    return clamp01(isLoss ? 1 - frac : frac);
  }
  for (const [word, frac] of Object.entries(FRACTION_WORD)) {
    if (lower.includes(word)) return clamp01(isLoss ? 1 - frac : frac);
  }
  return null;
}

function extractMinimumEnergy(note: string, battery: Battery): number | null {
  const lower = note.toLowerCase();

  const pct = lower.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:of\s+)?(?:the\s+)?(?:battery\s+)?capacity/);
  if (pct) return (parseFloat(pct[1]!) / 100) * battery.capacity_kwh;

  const kwh = lower.match(/(\d+(?:\.\d+)?)\s*kwh/);
  if (kwh) return parseFloat(kwh[1]!);

  return null;
}

function extractMaxGrid(note: string): number | null {
  const kwh = note.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(?:kwh|units)/);
  return kwh ? parseFloat(kwh[1]!) : null;
}

function classify(note: string): Exclude<DirectiveType, "no_op"> | null {
  const lower = note.toLowerCase();

  if (/discharg/.test(lower) && NEGATION_WORDS.test(lower)) return "no_discharge_window";
  if (/charg/.test(lower) && NEGATION_WORDS.test(lower)) return "no_charge_window";
  if (/\bgrid\b/.test(lower) && /(no more than|at most|up to|cap|limit|exceed|at or below)/.test(lower)) {
    return "max_grid_window";
  }
  if (/batter/.test(lower) && /(at least|reserve|minimum|remain in|stored in|stay above)/.test(lower)) {
    return "minimum_battery_reserve";
  }
  if (/solar/.test(lower)) return "solar_reduction";
  return null;
}

function fallbackNoOp(noteIndex: number, explanation: string): RawEntry {
  return { note_index: noteIndex, directive_type: "no_op", hours: [], explanation };
}

export function fallbackExtract(notes: string[], battery: Battery): RawEntry[] {
  return notes.map((note, note_index) => {
    const type = classify(note);
    if (!type) return fallbackNoOp(note_index, "fallback: no directive keywords matched");

    const hours = extractHours(note);
    if (!hours) return fallbackNoOp(note_index, "fallback: no parseable time window");

    const base = { note_index, directive_type: type, hours, explanation: "fallback extractor match" };

    switch (type) {
      case "solar_reduction": {
        const factor = extractFactor(note);
        return factor === null
          ? fallbackNoOp(note_index, "fallback: solar note without a parseable factor")
          : { ...base, factor };
      }
      case "minimum_battery_reserve": {
        const minimum_energy_kwh = extractMinimumEnergy(note, battery);
        return minimum_energy_kwh === null
          ? fallbackNoOp(note_index, "fallback: reserve note without a parseable value")
          : { ...base, minimum_energy_kwh };
      }
      case "max_grid_window": {
        const max_grid_kwh = extractMaxGrid(note);
        return max_grid_kwh === null
          ? fallbackNoOp(note_index, "fallback: grid cap note without a parseable value")
          : { ...base, max_grid_kwh };
      }
      case "no_charge_window":
      case "no_discharge_window":
        return base;
    }
  });
}
