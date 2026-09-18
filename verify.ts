/**
 * Offline verification for role B. Zero API calls, zero network, ~1 second.
 *
 *   bun run verify
 *
 * Three checks:
 *   1. guard() survives malformed model output and always returns N valid entries
 *   2. the deterministic extractor reproduces the 10 public cases
 *   3. the extractor handles paraphrases it was never tuned on, including the
 *      three published in Problem Statement §11.4
 *
 * `eval-notes.ts` is the companion to this: it exercises the real LLM path and
 * needs a key and ~60s. This one is safe to run on every edit.
 */
import { guard } from "./guardrails";
import { extractDirectives } from "./interpreter";
import type { Battery, Directive } from "./types";

const battery: Battery = {
  capacity_kwh: 200,
  initial_energy_kwh: 120,
  minimum_energy_kwh: 40,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

let failures = 0;
function report(label: string, ok: number, total: number, problems: string[]): void {
  if (ok !== total) failures++;
  console.log(`${ok === total ? "PASS" : "FAIL"}  ${label}  ${ok}/${total}`);
  for (const p of problems) console.log(`      ${p}`);
}

// ---- 1. guard() against deliberately malformed model output ----------------

const GARBAGE: [string, unknown, number][] = [
  ["null", null, 2],
  ["undefined", undefined, 1],
  ["string instead of array", "nope", 1],
  ["object instead of array", { entries: [] }, 2],
  ["empty array", [], 3],
  ["nulls and scalars inside", [null, undefined, 5, "x"], 2],
  ["unsupported directive_type", [{ note_index: 0, directive_type: "explode", hours: [1] }], 1],
  ["unsorted hours with duplicates", [{ note_index: 0, directive_type: "no_charge_window", hours: [5, 2, 2, 9, 2] }], 1],
  ["hours out of range", [{ note_index: 0, directive_type: "no_charge_window", hours: [-3, 27, 99] }], 1],
  ["factor above 1", [{ note_index: 0, directive_type: "solar_reduction", hours: [1], factor: 1.4 }], 1],
  ["factor NaN", [{ note_index: 0, directive_type: "solar_reduction", hours: [1], factor: NaN }], 1],
  ["missing note_index", [{ directive_type: "no_op" }], 2],
  ["duplicate note_index", [
    { note_index: 0, directive_type: "no_charge_window", hours: [1] },
    { note_index: 0, directive_type: "max_grid_window", hours: [2], max_grid_kwh: 5 },
  ], 2],
  ["note_index out of range", [{ note_index: 7, directive_type: "no_op" }], 2],
  ["null hours on a real directive", [{ note_index: 0, directive_type: "solar_reduction", hours: null, factor: 0.5 }], 1],
  ["reserve above capacity", [{ note_index: 0, directive_type: "minimum_battery_reserve", hours: [3], minimum_energy_kwh: 9999 }], 1],
  ["negative grid cap", [{ note_index: 0, directive_type: "max_grid_window", hours: [3], max_grid_kwh: -5 }], 1],
  ["fractional index and hours", [{ note_index: 0.9, directive_type: "no_charge_window", hours: [2.7, 3.2] }], 1],
  ["Infinity as a cap", [{ note_index: 0, directive_type: "max_grid_window", hours: [1], max_grid_kwh: Infinity }], 1],
  ["zero notes", [{ note_index: 0, directive_type: "no_op" }], 0],
  ["applies smuggled onto a no_op", [{ note_index: 0, directive_type: "no_op", applies: true, hours: [1] }], 1],
  ["far more entries than notes", Array.from({ length: 50 }, (_, i) => ({ note_index: i, directive_type: "no_op" })), 2],
];

/** Everything Problem Statement §08 requires of a returned directive set. */
function invalid(out: Directive[], n: number): string[] {
  const p: string[] = [];
  if (out.length !== n) p.push(`length ${out.length} != ${n}`);
  out.forEach((d, i) => {
    if (d.note_index !== i) p.push(`[${i}] note_index ${d.note_index}`);
    if (typeof d.explanation !== "string" || !d.explanation) p.push(`[${i}] empty explanation`);
    if (d.directive_type === "no_op") {
      if (d.applies !== false) p.push(`[${i}] no_op with applies=${d.applies}`);
      if (d.structured_adjustment !== null) p.push(`[${i}] no_op with non-null adjustment`);
      return;
    }
    if (d.applies !== true) p.push(`[${i}] applies=${d.applies} on a real directive`);
    const a = d.structured_adjustment as Record<string, any> | null;
    if (!a) return void p.push(`[${i}] null adjustment on a real directive`);
    const hours = a.hours;
    if (!Array.isArray(hours) || hours.length === 0) p.push(`[${i}] missing hours`);
    else {
      for (const h of hours)
        if (!Number.isInteger(h) || h < 0 || h > 23) p.push(`[${i}] hour ${h} out of range`);
      for (let k = 1; k < hours.length; k++)
        if (hours[k] <= hours[k - 1]) p.push(`[${i}] hours not ascending/unique`);
    }
    if ("factor" in a && !(Number.isFinite(a.factor) && a.factor >= 0 && a.factor <= 1))
      p.push(`[${i}] factor ${a.factor}`);
    if ("minimum_energy_kwh" in a &&
        !(Number.isFinite(a.minimum_energy_kwh) && a.minimum_energy_kwh >= 0 &&
          a.minimum_energy_kwh <= battery.capacity_kwh))
      p.push(`[${i}] reserve ${a.minimum_energy_kwh}`);
    if ("max_grid_kwh" in a && !(Number.isFinite(a.max_grid_kwh) && a.max_grid_kwh >= 0))
      p.push(`[${i}] cap ${a.max_grid_kwh}`);
  });
  return p;
}

{
  let ok = 0;
  const problems: string[] = [];
  for (const [label, input, n] of GARBAGE) {
    try {
      const p = invalid(guard(input, n, battery), n);
      if (p.length) problems.push(`${label}: ${p.join("; ")}`);
      else ok++;
    } catch (err) {
      problems.push(`${label}: THREW ${(err as Error).message}`);
    }
  }
  report("guard() vs malformed model output", ok, GARBAGE.length, problems);
}

// ---- 2. extractor vs the 10 public cases -----------------------------------

interface PublicCase {
  id: string;
  input: { operator_notes: string[]; battery: Battery };
  expected_output: { directive_interpretation: Directive[] };
}

function diff(got: Directive, want: Directive): string | null {
  if (got.directive_type !== want.directive_type)
    return `${got.directive_type} != ${want.directive_type}`;
  const g = got.structured_adjustment as Record<string, any> | null;
  const w = want.structured_adjustment as Record<string, any> | null;
  if (w === null || g === null) return g === w ? null : "adjustment mismatch";
  for (const k of Object.keys(w)) {
    const same = Array.isArray(w[k])
      ? JSON.stringify(g[k]) === JSON.stringify(w[k])
      : Math.abs(g[k] - w[k]) <= 0.01; // PS §11.5 tolerance
    if (!same) return `${k} ${JSON.stringify(g[k])} != ${JSON.stringify(w[k])}`;
  }
  return null;
}

{
  const pack = await Bun.file("./data/BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json").json();
  let ok = 0;
  let total = 0;
  const problems: string[] = [];
  for (const c of pack.cases as PublicCase[]) {
    const got = guard(
      extractDirectives(c.input.operator_notes, c.input.battery),
      c.input.operator_notes.length,
      c.input.battery,
    );
    c.expected_output.directive_interpretation.forEach((w, i) => {
      total++;
      const d = diff(got[i]!, w);
      if (d) problems.push(`${c.id}[${i}] ${d}`);
      else ok++;
    });
  }
  report("extractor vs 10 public cases", ok, total, problems);
}

// ---- 3. extractor vs paraphrases it was never tuned on ---------------------

const ALL_DAY = Array.from({ length: 24 }, (_, h) => h);

const TRIALS: [string, string, number[] | null, number | null][] = [
  // Problem Statement §11.4 publishes these three as examples of hidden wording.
  ["PV production will drop to about 20% between 13:00 and 15:00.", "solar_reduction", [13, 14], 0.2],
  ["Panel washing from one until three will leave roughly one-fifth of normal solar output.", "solar_reduction", [13, 14], 0.2],
  ["Expect an 80% reduction in rooftop solar during the 1-3 PM maintenance window.", "solar_reduction", [13, 14], 0.2],
  ["Do not charge the battery from midnight to 3.", "no_charge_window", [0, 1, 2], null],
  ["Hold at least a third of the battery capacity in reserve from 6 PM until 9 PM.", "minimum_battery_reserve", [18, 19, 20], 66.67],
  ["Take no more than 150 units from the grid for three hours starting at 6 PM.", "max_grid_window", [18, 19, 20], 150],
  ["Battery discharge is locked out for the two hours following 5 PM.", "no_discharge_window", [17, 18], null],
  ["Solar will be halved from 10:00 to 12:00.", "solar_reduction", [10, 11], 0.5],
  ["Do not charge the battery from 10 PM until midnight.", "no_charge_window", [22, 23], null],
  ["Keep at least 60 kWh in the battery from 22:00 until 24:00.", "minimum_battery_reserve", [22, 23], 60],
  ["Grid import must not exceed 120 kWh from 11 PM to midnight.", "max_grid_window", [23], 120],
  ["The IT department will migrate the campus email server overnight.", "no_op", null, null],
  ["The sports office moved next month's registration deadline.", "no_op", null, null],
  ["The cafeteria menu changes tomorrow.", "no_op", null, null],

  // Windows that wrap past midnight. guard() sorts them ascending, as PS §05.1
  // requires, so 11 PM-2 AM is [0, 1, 23] rather than [23, 0, 1].
  ["Battery must not discharge from 11 PM until 2 AM.", "no_discharge_window", [0, 1, 23], null],
  ["Charging is unavailable from 10 PM until 1 AM.", "no_charge_window", [0, 22, 23], null],
  ["Do not discharge between 23:00 and 01:00.", "no_discharge_window", [0, 23], null],

  // A directive with no window at all covers the whole day.
  ["Do not charge the battery.", "no_charge_window", ALL_DAY, null],
  ["Grid import capped at 150 kWh all day.", "max_grid_window", ALL_DAY, 150],
  ["Keep at least 50% of the battery capacity stored at all times.", "minimum_battery_reserve", ALL_DAY, 100],

  // An explicit quantity beats an unrelated percentage in the same sentence.
  ["Grid import must not exceed 190 kWh from 7 PM until 10 PM, a 20% cut from the normal feeder rating.", "max_grid_window", [19, 20, 21], 190],
  ["Keep at least 90 kWh in the battery from 6 PM until 10 PM; that is 45% of nameplate.", "minimum_battery_reserve", [18, 19, 20, 21], 90],

  // A window with no stated magnitude is not a directive — inventing a factor
  // is exactly what PS §05.1 forbids.
  ["Panel cleaning from 1 PM to 3 PM.", "no_op", null, null],
  ["Solar output is unaffected today.", "no_op", null, null],
];

{
  let ok = 0;
  const problems: string[] = [];
  for (const [note, type, hours, num] of TRIALS) {
    const d = guard(extractDirectives([note], battery), 1, battery)[0]!;
    const a = d.structured_adjustment as Record<string, any> | null;
    const p: string[] = [];
    if (d.directive_type !== type) p.push(`${d.directive_type} != ${type}`);
    else if (hours) {
      if (JSON.stringify(a?.hours) !== JSON.stringify(hours))
        p.push(`hours ${JSON.stringify(a?.hours)} != ${JSON.stringify(hours)}`);
      if (num !== null) {
        const v = a?.factor ?? a?.minimum_energy_kwh ?? a?.max_grid_kwh;
        if (!(Math.abs(v - num) <= 0.01)) p.push(`value ${v} != ${num}`);
      }
    }
    if (p.length) problems.push(`"${note.slice(0, 54)}…" ${p.join("; ")}`);
    else ok++;
  }
  report("extractor vs unseen paraphrases", ok, TRIALS.length, problems);
}

console.log(failures === 0 ? "\nall offline checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
