/**
 * Guardrail Validator — stage 3 of the pipeline. Owned by role B.
 *
 * Takes raw, untrusted model output and returns exactly one valid Directive per
 * operator note. Never throws. Anything it cannot repair becomes no_op rather
 * than reaching the optimizer as a bad constraint.
 *
 * Deliberately does NOT merge entries. The contract is one entry per note, in
 * note_index order — merging two notes that happen to share a directive type
 * would break that. Combining overlapping constraints (max of two reserves,
 * min of two grid caps) belongs in the optimizer when it builds its model.
 */
import type { Battery, Directive, DirectiveType } from "./types";
import type { RawEntry } from "./interpreter";

/**
 * Runtime copy of the DirectiveType union. types.ts is role A's file and
 * exports types only, so the runtime list lives here. The satisfies clause
 * makes TypeScript fail the build if the two ever drift apart.
 */
const DIRECTIVE_TYPES = [
  "solar_reduction",
  "minimum_battery_reserve",
  "no_charge_window",
  "no_discharge_window",
  "max_grid_window",
  "no_op",
] as const satisfies readonly DirectiveType[];

const TYPE_SET = new Set<string>(DIRECTIVE_TYPES);

function noOp(noteIndex: number, explanation: string): Directive {
  return {
    note_index: noteIndex,
    applies: false,
    directive_type: "no_op",
    structured_adjustment: null,
    explanation,
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Unique integers 0-23, ascending. Returns null if nothing usable survives. */
function cleanHours(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const seen = new Set<number>();
  for (const raw of v) {
    if (!isFiniteNumber(raw)) continue;
    const h = Math.trunc(raw);
    if (h >= 0 && h <= 23) seen.add(h);
  }
  if (seen.size === 0) return null;
  return [...seen].sort((a, b) => a - b);
}

function cleanText(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/**
 * Build the structured_adjustment for one entry, or null if the entry is not
 * salvageable as the claimed directive type.
 */
function buildAdjustment(
  type: Exclude<DirectiveType, "no_op">,
  raw: RawEntry,
  battery: Battery,
): Record<string, unknown> | null {
  const hours = cleanHours(raw.hours);
  if (!hours) return null; // every real directive needs at least one hour

  switch (type) {
    case "solar_reduction": {
      if (!isFiniteNumber(raw.factor)) return null;
      // factor is the fraction REMAINING and must sit in [0, 1].
      if (raw.factor < 0 || raw.factor > 1) return null;
      return { hours, factor: raw.factor };
    }
    case "minimum_battery_reserve": {
      if (!isFiniteNumber(raw.minimum_energy_kwh)) return null;
      if (raw.minimum_energy_kwh < 0) return null;
      // A reserve above capacity is unsatisfiable; clamp rather than discard,
      // since the intent ("keep it full") is still meaningful.
      const reserve = Math.min(raw.minimum_energy_kwh, battery.capacity_kwh);
      return { hours, minimum_energy_kwh: reserve };
    }
    case "no_charge_window":
    case "no_discharge_window":
      return { hours };
    case "max_grid_window": {
      if (!isFiniteNumber(raw.max_grid_kwh)) return null;
      if (raw.max_grid_kwh < 0) return null;
      return { hours, max_grid_kwh: raw.max_grid_kwh };
    }
  }
}

/**
 * Always returns exactly `nNotes` directives, indexed 0..nNotes-1 in order.
 * Unmapped, duplicate, out-of-range and unrepairable entries become no_op.
 */
export function guard(
  raw: unknown,
  nNotes: number,
  battery: Battery,
): Directive[] {
  const out: Directive[] = Array.from({ length: nNotes }, (_, i) =>
    noOp(i, "No applicable directive was extracted for this note."),
  );
  const filled = new Set<number>();

  if (!Array.isArray(raw)) return out;

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as RawEntry;

    // Note mapping: must identify a real note, exactly once.
    if (!isFiniteNumber(entry.note_index)) continue;
    const idx = Math.trunc(entry.note_index);
    if (idx < 0 || idx >= nNotes) continue;
    if (filled.has(idx)) continue; // first mapping wins; duplicates dropped
    filled.add(idx);

    const explanation = cleanText(
      entry.explanation,
      "Interpreted from the operator note.",
    );

    // Unsupported or missing type collapses to no_op — never invented.
    const type = entry.directive_type;
    if (typeof type !== "string" || !TYPE_SET.has(type)) {
      out[idx] = noOp(idx, explanation);
      continue;
    }
    if (type === "no_op") {
      out[idx] = noOp(idx, explanation);
      continue;
    }

    const adjustment = buildAdjustment(
      type as Exclude<DirectiveType, "no_op">,
      entry,
      battery,
    );
    if (!adjustment) {
      out[idx] = noOp(idx, explanation);
      continue;
    }

    out[idx] = {
      note_index: idx,
      applies: true,
      directive_type: type as DirectiveType,
      structured_adjustment: adjustment,
      explanation,
    };
  }

  return out;
}
