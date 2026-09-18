/**
 * Guardrail Validator — stage 3 of the pipeline. Owned by role B.
 *
 * Takes raw, untrusted model output and returns exactly one valid Directive per
 * operator note. Never throws. Anything it cannot repair becomes no_op rather
 * than reaching the optimizer as a bad constraint.
 *
 * If the model claims the same note_index twice (a real failure mode — see
 * the "duplicate index" fault-injection case), and both claims agree on a
 * real directive type, the two are merged rather than the second one being
 * silently dropped: union the hours, and tighten the numeric bound (min
 * factor, max reserve, min grid cap). This never reduces the entry count —
 * the contract is still exactly one Directive per note, in note_index order.
 * It does NOT merge across different notes that happen to share a directive
 * type; combining constraint effects across separate notes belongs to the
 * optimizer when it builds its model.
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

/** Builds the Directive for a single raw entry, independent of any others. */
function buildDirective(
  idx: number,
  entry: RawEntry,
  explanation: string,
  battery: Battery,
): Directive {
  // Unsupported or missing type collapses to no_op — never invented.
  const type = entry.directive_type;
  if (typeof type !== "string" || !TYPE_SET.has(type)) return noOp(idx, explanation);
  if (type === "no_op") return noOp(idx, explanation);

  const adjustment = buildAdjustment(type as Exclude<DirectiveType, "no_op">, entry, battery);
  if (!adjustment) return noOp(idx, explanation);

  return {
    note_index: idx,
    applies: true,
    directive_type: type as DirectiveType,
    structured_adjustment: adjustment,
    explanation,
  };
}

/**
 * Combines two Directives that were both mapped to the same note_index and
 * share the same real directive type: union the hours, tighten the numeric
 * bound. Assumes both were already built by buildDirective(), so their
 * structured_adjustment shapes are already valid for `type`.
 */
function mergeDirectives(a: Directive, b: Directive): Directive {
  const type = a.directive_type;
  const adjA = a.structured_adjustment as Record<string, unknown>;
  const adjB = b.structured_adjustment as Record<string, unknown>;

  const hours = [...new Set([...(adjA.hours as number[]), ...(adjB.hours as number[])])].sort(
    (x, y) => x - y,
  );

  let rest: Record<string, unknown> = {};
  switch (type) {
    case "solar_reduction":
      rest = { factor: Math.min(adjA.factor as number, adjB.factor as number) };
      break;
    case "minimum_battery_reserve":
      rest = {
        minimum_energy_kwh: Math.max(
          adjA.minimum_energy_kwh as number,
          adjB.minimum_energy_kwh as number,
        ),
      };
      break;
    case "max_grid_window":
      rest = { max_grid_kwh: Math.min(adjA.max_grid_kwh as number, adjB.max_grid_kwh as number) };
      break;
    case "no_charge_window":
    case "no_discharge_window":
      break;
  }

  return {
    note_index: a.note_index,
    applies: true,
    directive_type: type,
    structured_adjustment: { hours, ...rest },
    explanation: a.explanation,
  };
}

/**
 * Always returns exactly `nNotes` directives, indexed 0..nNotes-1 in order.
 * Unmapped, out-of-range and unrepairable entries become no_op. A note_index
 * claimed more than once is merged (see mergeDirectives) when both claims
 * agree on a real type, otherwise the first valid mapping wins.
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

    // Note mapping: must identify a real note.
    if (!isFiniteNumber(entry.note_index)) continue;
    const idx = Math.trunc(entry.note_index);
    if (idx < 0 || idx >= nNotes) continue;

    const explanation = cleanText(entry.explanation, "Interpreted from the operator note.");
    const candidate = buildDirective(idx, entry, explanation, battery);

    if (!filled.has(idx)) {
      out[idx] = candidate;
      filled.add(idx);
      continue;
    }

    const existing = out[idx]!;
    if (existing.directive_type === candidate.directive_type && existing.directive_type !== "no_op") {
      out[idx] = mergeDirectives(existing, candidate);
    }
    // Conflicting types for the same note_index: keep the first valid mapping.
  }

  return out;
}
