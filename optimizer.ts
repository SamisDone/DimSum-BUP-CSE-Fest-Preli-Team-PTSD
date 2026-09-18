/**
 * Math Optimizer — the fourth box of the organizer pipeline.
 *
 *   Energy Data + Operator Notes -> LLM Interpreter -> Guardrail Validator
 *     -> [Math Optimizer] -> Final Validator -> API Response
 *
 * Owned by role C (see ACTION_PLAN.md). Fully deterministic: no LLM, no network.
 *
 * Given VALIDATED directives, produce the cheapest 24-hour plan that satisfies
 * every GridWise rule (Problem Statement section 09) and every applicable
 * directive (section 5.3). Solved as a linear program with HiGHS (WASM build).
 *
 * Contract: never throws. Returns a valid 24-entry plan, or null only if even
 * a baseline plan could not be built.
 */

import highsLoader from "highs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Battery, Directive, Hour, PlanHour } from "./types";

/** Narrowed from PlanHour so the netting logic reads clearly. */
type BatteryAction = PlanHour["battery_action"];

/**
 * The three aggregates the judge recomputes from hourly_plan (§11.3). Declared
 * here rather than in types.ts, which is A's frozen file.
 */
export interface PlanTotals {
  total_grid_kwh: number;
  total_cost_bdt: number;
  peak_grid_kwh: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const H = 24;

/** Judge tolerance for kWh and BDT comparisons (Problem Statement 11.5). */
const JUDGE_TOL = 0.01;

/** Decimal places reported in hourly_plan. Totals are derived from these. */
const DP = 4;
const DP_SCALE = 10 ** DP;

/** Below this a flow is treated as numerically zero (LP degeneracy dust). */
const ZERO_TOL = 1e-7;

/** HiGHS treats |bound| >= 1e30 as infinite. */
const LP_INF = 1e30;

// ---------------------------------------------------------------------------
// Solver bootstrap
//
// Loaded with a module-scope top-level await so that solve() can keep the
// frozen SYNCHRONOUS signature from ACTION_PLAN section 3: by the time
// index.ts has finished importing this module the WASM is compiled and warm,
// so the first judge request pays no cold-start cost.
//
// A load failure is swallowed on purpose. A dead solver must degrade to the
// baseline plan and a 200 response, never take the service down at import.
// ---------------------------------------------------------------------------

type HighsInstance = {
  solve: (lp: string, options?: Record<string, unknown>) => any;
};

let highs: HighsInstance | null = null;
let solverError: string | null = null;

/** Locate build/highs.wasm without depending on the process cwd (Docker-safe). */
function readWasmBinary(): Uint8Array | null {
  const candidates: string[] = [];
  try {
    // Resolves through node_modules regardless of where the process started.
    candidates.push(fileURLToPath(import.meta.resolve("highs/runtime")));
  } catch {
    /* exports map unavailable — fall through to path guesses */
  }
  candidates.push("node_modules/highs/build/highs.wasm");
  candidates.push("/app/node_modules/highs/build/highs.wasm");

  for (const path of candidates) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      continue;
    }
  }
  return null;
}

try {
  const wasmBinary = readWasmBinary();
  highs = wasmBinary
    ? await highsLoader({ wasmBinary } as never)
    : await highsLoader();
} catch (err) {
  highs = null;
  solverError = err instanceof Error ? err.message : String(err);
  console.error(
    "optimizer: HiGHS unavailable, falling back to baseline plans:",
    solverError,
  );
}

/** Solver identity for the README and the verification harness. */
export function solverInfo(): {
  solver: string;
  version: string;
  ready: boolean;
  error: string | null;
} {
  return {
    solver: "HiGHS (npm `highs` — WebAssembly build of the HiGHS C++ solver)",
    version: "1.15.3",
    ready: highs !== null,
    error: solverError,
  };
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Round to DP places, mapping -0 and tiny negatives to exactly 0. */
function r4(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const rounded = Math.round(v * DP_SCALE) / DP_SCALE;
  return rounded === 0 ? 0 : rounded;
}

/** Round and clamp from below: reported energy values are never negative. */
function r4nonneg(v: number): number {
  const rounded = r4(v);
  return rounded < 0 ? 0 : rounded;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Directives -> model coefficients (Problem Statement 5.3)
//
// Overlap policy, chosen deliberately to match the merge rule guard() uses in
// ACTION_PLAN (B, layer 2), so the optimizer and the Final Validator can never
// disagree about what the constraint was:
//   solar_reduction         -> MIN factor   (most restrictive)
//   minimum_battery_reserve -> MAX reserve  (most restrictive)
//   max_grid_window         -> MIN cap      (most restrictive)
// ---------------------------------------------------------------------------

export interface ModelInputs {
  demand: number[];
  tariff: number[];
  /** Base solar after solar_reduction has been applied. */
  effSolar: number[];
  /** max(base minimum_energy_kwh, directive reserve) per hour. */
  reserve: number[];
  /** Grid cap per hour, LP_INF where uncapped. */
  gridCap: number[];
  noCharge: boolean[];
  noDischarge: boolean[];
}

/** Which directive families to honour. Used by the relaxation ladder. */
export interface Relaxation {
  gridCaps: boolean;
  reserves: boolean;
  windows: boolean;
}

const FULL: Relaxation = { gridCaps: true, reserves: true, windows: true };
const NONE: Relaxation = { gridCaps: false, reserves: false, windows: false };

/**
 * Index hour entries by their declared `hour` value rather than by array
 * position, so that an unordered `hours` array is handled identically. Falls
 * back to positional order if the declared hours are not a clean 0..23 set.
 */
function orderHours(hours: Hour[]): (Hour | undefined)[] {
  const list = Array.isArray(hours) ? hours : [];
  const byValue = new Array<Hour | undefined>(H);
  let clean = list.length === H;

  for (const entry of list) {
    const h = entry?.hour;
    if (Number.isInteger(h) && (h as number) >= 0 && (h as number) < H && !byValue[h as number]) {
      byValue[h as number] = entry;
    } else {
      clean = false;
      break;
    }
  }

  if (clean) return byValue;
  return Array.from({ length: H }, (_, h) => list[h]);
}

/**
 * Build the per-hour coefficient arrays. Defensive throughout: a directive with
 * a malformed structured_adjustment is skipped rather than trusted, because
 * guard() is supposed to have repaired it and a surprise here must not crash.
 */
export function buildModelInputs(
  hours: Hour[],
  battery: Battery,
  directives: Directive[],
  relax: Relaxation = FULL,
): ModelInputs {
  const demand = new Array<number>(H).fill(0);
  const tariff = new Array<number>(H).fill(0);
  const effSolar = new Array<number>(H).fill(0);

  const ordered = orderHours(hours);

  for (let h = 0; h < H; h++) {
    const entry = ordered[h];
    demand[h] = isNum(entry?.demand_kwh) ? Math.max(0, entry.demand_kwh) : 0;
    tariff[h] = isNum(entry?.tariff_bdt_per_kwh) ? entry.tariff_bdt_per_kwh : 0;
    effSolar[h] = isNum(entry?.solar_kwh) ? Math.max(0, entry.solar_kwh) : 0;
  }

  const baseMin = isNum(battery?.minimum_energy_kwh)
    ? Math.max(0, battery.minimum_energy_kwh)
    : 0;
  const capacity = isNum(battery?.capacity_kwh)
    ? Math.max(0, battery.capacity_kwh)
    : 0;

  const reserve = new Array<number>(H).fill(Math.min(baseMin, capacity));
  const gridCap = new Array<number>(H).fill(LP_INF);
  const noCharge = new Array<boolean>(H).fill(false);
  const noDischarge = new Array<boolean>(H).fill(false);

  for (const d of Array.isArray(directives) ? directives : []) {
    const type = d?.directive_type;
    const adj = d?.structured_adjustment;
    if (type === "no_op" || !adj || typeof adj !== "object") continue;

    const rawHours = (adj as { hours?: unknown }).hours;
    if (!Array.isArray(rawHours)) continue;

    // Dedupe and keep only in-range integer hours. guard() should already have
    // done this; doing it again costs nothing and removes a crash surface.
    const hrs: number[] = [];
    for (const v of rawHours) {
      if (
        Number.isInteger(v) &&
        (v as number) >= 0 &&
        (v as number) < H &&
        !hrs.includes(v as number)
      ) {
        hrs.push(v as number);
      }
    }
    if (hrs.length === 0) continue;

    switch (type) {
      case "solar_reduction": {
        const f = (adj as { factor?: unknown }).factor;
        if (!isNum(f)) break;
        const factor = clamp(f, 0, 1);
        for (const h of hrs) {
          effSolar[h] = Math.min(effSolar[h]!, effSolar[h]! * factor);
        }
        break;
      }
      case "minimum_battery_reserve": {
        if (!relax.reserves) break;
        const rv = (adj as { minimum_energy_kwh?: unknown }).minimum_energy_kwh;
        if (!isNum(rv) || rv < 0) break; // negative reserve is malformed
        // A reserve above capacity is unsatisfiable; guard() clamps it and so
        // do we, rather than forcing the whole case down the relaxation ladder.
        const level = clamp(rv, 0, capacity);
        for (const h of hrs) reserve[h] = Math.max(reserve[h]!, level);
        break;
      }
      case "max_grid_window": {
        if (!relax.gridCaps) break;
        const cap = (adj as { max_grid_kwh?: unknown }).max_grid_kwh;
        // A cap of exactly 0 is legitimate and must be honoured. A NEGATIVE cap
        // is malformed input that guard() should have downgraded to no_op, so it
        // is skipped rather than clamped to 0 — clamping would silently invent
        // an unsatisfiable "no grid at all" constraint.
        if (!isNum(cap) || cap < 0) break;
        for (const h of hrs) gridCap[h] = Math.min(gridCap[h]!, cap);
        break;
      }
      case "no_charge_window":
        if (!relax.windows) break;
        for (const h of hrs) noCharge[h] = true;
        break;
      case "no_discharge_window":
        if (!relax.windows) break;
        for (const h of hrs) noDischarge[h] = true;
        break;
    }
  }

  return { demand, tariff, effSolar, reserve, gridCap, noCharge, noDischarge };
}

// ---------------------------------------------------------------------------
// LP construction (CPLEX LP format)
//
//   minimise  SUM tariff[h] * g[h]
//   bal[h]    g[h] + s[h] + d[h] - c[h]   = demand[h]
//   soc[0]    E0 - c0 + d0                = initial_energy
//   soc[h]    E[h] - E[h-1] - c[h] + d[h] = 0                       h >= 1
//   bounds    0 <= s[h] <= effSolar[h]                (curtailment allowed)
//             0 <= c[h] <= max_charge     (0 in no-charge hours)
//             0 <= d[h] <= max_discharge  (0 in no-discharge hours)
//             0 <= g[h] <= gridCap[h]
//             reserve[h] <= E[h] <= capacity
//             E23 = initial_energy                   (9.6 neutrality)
// ---------------------------------------------------------------------------

function buildLP(m: ModelInputs, battery: Battery): string {
  const capacity = Math.max(0, battery.capacity_kwh);
  const initial = clamp(battery.initial_energy_kwh, 0, capacity);
  const maxCharge = Math.max(0, battery.max_charge_kwh_per_hour);
  const maxDischarge = Math.max(0, battery.max_discharge_kwh_per_hour);

  const L: string[] = [];

  L.push("Minimize");
  const obj: string[] = [];
  for (let h = 0; h < H; h++) obj.push(`${m.tariff[h]} g${h}`);
  L.push(` obj: ${obj.join(" + ")}`);

  L.push("Subject To");
  for (let h = 0; h < H; h++) {
    L.push(` bal${h}: g${h} + s${h} + d${h} - c${h} = ${m.demand[h]}`);
  }
  L.push(` soc0: E0 - c0 + d0 = ${initial}`);
  for (let h = 1; h < H; h++) {
    L.push(` soc${h}: E${h} - E${h - 1} - c${h} + d${h} = 0`);
  }

  L.push("Bounds");
  for (let h = 0; h < H; h++) {
    if (m.gridCap[h]! < LP_INF) L.push(` 0 <= g${h} <= ${m.gridCap[h]}`);
    L.push(` 0 <= s${h} <= ${m.effSolar[h]}`);
    L.push(` 0 <= c${h} <= ${m.noCharge[h] ? 0 : maxCharge}`);
    L.push(` 0 <= d${h} <= ${m.noDischarge[h] ? 0 : maxDischarge}`);
    if (h === H - 1) {
      // End-of-day neutrality as a fixed bound: exact, and cheaper than a row.
      L.push(` E${h} = ${initial}`);
    } else {
      L.push(` ${Math.min(m.reserve[h]!, capacity)} <= E${h} <= ${capacity}`);
    }
  }
  L.push("End");

  return L.join("\n");
}

interface LpSolution {
  g: number[];
  s: number[];
  c: number[];
  d: number[];
}

function solveLP(m: ModelInputs, battery: Battery): LpSolution | null {
  if (!highs) return null;

  let raw: any;
  try {
    raw = highs.solve(buildLP(m, battery), { presolve: "on" });
  } catch {
    return null; // native read/option/run error — treat as infeasible
  }

  if (!raw || raw.Status !== "Optimal" || !raw.Columns) return null;

  const pick = (name: string): number => {
    const v = raw.Columns[name]?.Primal;
    return isNum(v) ? v : 0;
  };

  const g: number[] = [];
  const s: number[] = [];
  const c: number[] = [];
  const d: number[] = [];
  for (let h = 0; h < H; h++) {
    g.push(pick(`g${h}`));
    s.push(pick(`s${h}`));
    c.push(pick(`c${h}`));
    d.push(pick(`d${h}`));
  }
  return { g, s, c, d };
}

// ---------------------------------------------------------------------------
// LP solution -> reportable plan
//
// Three things break plans here, all of them handled below:
//   1. the LP may return simultaneous charge and discharge -> net them
//   2. independent rounding breaks the energy balance      -> derive grid last
//   3. rounding drift breaks end-of-day neutrality         -> fix the residual
// ---------------------------------------------------------------------------

/**
 * Force the rounded net battery flows to sum to exactly zero, so that
 * E_after[23] equals initial_energy_kwh exactly rather than within rounding
 * dust. The residual is pushed onto whichever hours can absorb it without
 * breaking a rate limit or a charge/discharge window.
 */
function fixNeutrality(net: number[], m: ModelInputs, battery: Battery): void {
  const maxCharge = Math.max(0, battery.max_charge_kwh_per_hour);
  const maxDischarge = Math.max(0, battery.max_discharge_kwh_per_hour);

  let residual = r4(net.reduce((a, b) => a + b, 0));
  if (residual === 0) return;

  // residual > 0 means the day ends with surplus charge: shave charge (or add
  // discharge). residual < 0 is the mirror image.
  for (let h = H - 1; h >= 0 && residual !== 0; h--) {
    const cur = net[h]!;
    const lo = m.noDischarge[h] ? 0 : -maxDischarge; // most negative allowed
    const hi = m.noCharge[h] ? 0 : maxCharge; // most positive allowed
    const room = residual > 0 ? cur - lo : hi - cur;
    if (room <= 0) continue;
    const step = Math.min(Math.abs(residual), room);
    const delta = residual > 0 ? -step : step;
    net[h] = r4(cur + delta);
    residual = r4(residual + delta);
  }
}

function assemblePlan(
  lp: LpSolution,
  m: ModelInputs,
  battery: Battery,
): PlanHour[] {
  const capacity = Math.max(0, battery.capacity_kwh);
  const initial = clamp(battery.initial_energy_kwh, 0, capacity);

  // 1. Net the battery, then round. A netted flow is one action per hour, which
  //    is what the response schema allows (10.3).
  const net: number[] = [];
  for (let h = 0; h < H; h++) {
    const raw = lp.c[h]! - lp.d[h]!;
    net.push(Math.abs(raw) < ZERO_TOL ? 0 : r4(raw));
  }

  // 2. Make end-of-day neutrality exact.
  fixNeutrality(net, m, battery);

  const plan: PlanHour[] = [];
  let energy = initial;

  for (let h = 0; h < H; h++) {
    const n = net[h]!;
    const action: BatteryAction =
      n > 0 ? "charge" : n < 0 ? "discharge" : "idle";
    const batteryKwh = r4nonneg(Math.abs(n)); // exactly 0 when idle (trap 9)

    // 3. Solar is clamped DOWN into [0, effSolar]: overusing effective solar
    //    invalidates the case, so rounding must never push it up.
    const solarUsed = clamp(r4nonneg(lp.s[h]!), 0, r4(m.effSolar[h]!));

    const charge = action === "charge" ? batteryKwh : 0;
    const discharge = action === "discharge" ? batteryKwh : 0;

    // 4. Derive grid from the balance equation rather than rounding it
    //    separately, so 9.5 holds to float precision instead of accumulating
    //    three independent rounding errors.
    const gridKwh = r4nonneg(m.demand[h]! + charge - solarUsed - discharge);

    // 5. Re-derive the state of charge from the NETTED actions, so that
    //    battery_energy_after_kwh is consistent with the reported action.
    energy = r4(clamp(energy + charge - discharge, 0, capacity));

    plan.push({
      hour: h,
      grid_kwh: gridKwh,
      solar_used_kwh: solarUsed,
      battery_action: action,
      battery_kwh: batteryKwh,
      battery_energy_after_kwh: energy,
    });
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Internal audit
//
// A private invariant check over the assembled plan. Deliberately NOT the
// Final Validator replay(): keeping the two implementations independent is what
// makes replay() a real check rather than a mirror. This one only decides
// whether to drop to the next relaxation stage.
// ---------------------------------------------------------------------------

function auditPlan(
  plan: PlanHour[],
  m: ModelInputs,
  battery: Battery,
): boolean {
  if (!Array.isArray(plan) || plan.length !== H) return false;

  const capacity = Math.max(0, battery.capacity_kwh);
  const initial = clamp(battery.initial_energy_kwh, 0, capacity);
  const maxCharge = Math.max(0, battery.max_charge_kwh_per_hour);
  const maxDischarge = Math.max(0, battery.max_discharge_kwh_per_hour);

  let energy = initial;

  for (let h = 0; h < H; h++) {
    const p = plan[h]!;
    if (p.hour !== h) return false;
    if (!isNum(p.grid_kwh) || !isNum(p.solar_used_kwh) || !isNum(p.battery_kwh)) {
      return false;
    }
    if (!isNum(p.battery_energy_after_kwh)) return false;
    if (p.grid_kwh < 0 || p.solar_used_kwh < 0 || p.battery_kwh < 0) return false;

    // solar never exceeds effective solar
    if (p.solar_used_kwh > m.effSolar[h]! + JUDGE_TOL) return false;

    // action / magnitude consistency and hourly rate limits
    const charge = p.battery_action === "charge" ? p.battery_kwh : 0;
    const discharge = p.battery_action === "discharge" ? p.battery_kwh : 0;
    if (p.battery_action === "idle" && p.battery_kwh !== 0) return false;
    if (!["charge", "discharge", "idle"].includes(p.battery_action)) return false;
    if (charge > maxCharge + JUDGE_TOL) return false;
    if (discharge > maxDischarge + JUDGE_TOL) return false;

    // directive windows and caps
    if (m.noCharge[h] && charge > JUDGE_TOL) return false;
    if (m.noDischarge[h] && discharge > JUDGE_TOL) return false;
    if (m.gridCap[h]! < LP_INF && p.grid_kwh > m.gridCap[h]! + JUDGE_TOL) {
      return false;
    }

    // energy balance (9.5)
    const lhs = p.grid_kwh + p.solar_used_kwh + discharge;
    const rhs = m.demand[h]! + charge;
    if (Math.abs(lhs - rhs) > JUDGE_TOL) return false;

    // battery transition and bounds (9.1, 9.2)
    energy = energy + charge - discharge;
    if (Math.abs(energy - p.battery_energy_after_kwh) > JUDGE_TOL) return false;
    if (p.battery_energy_after_kwh < m.reserve[h]! - JUDGE_TOL) return false;
    if (p.battery_energy_after_kwh > capacity + JUDGE_TOL) return false;
  }

  // end-of-day neutrality (9.6)
  if (Math.abs(plan[H - 1]!.battery_energy_after_kwh - initial) > JUDGE_TOL) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Baseline plan — the always-available fallback
//
// Solar first, battery idle for all 24 hours, grid covers the remainder.
// Feasible by construction: the battery never moves, so transitions, bounds,
// rate limits and end-of-day neutrality are all trivially satisfied. It ignores
// grid caps and raised reserves, which is why it is the LAST resort.
// ---------------------------------------------------------------------------

export function baselinePlan(
  hours: Hour[],
  battery: Battery,
  directives: Directive[] = [],
): PlanHour[] {
  const m = buildModelInputs(hours, battery, directives);
  const capacity = isNum(battery?.capacity_kwh)
    ? Math.max(0, battery.capacity_kwh)
    : 0;
  const energy = r4(
    clamp(isNum(battery?.initial_energy_kwh) ? battery.initial_energy_kwh : 0, 0, capacity),
  );

  const plan: PlanHour[] = [];
  for (let h = 0; h < H; h++) {
    const solarUsed = clamp(
      r4nonneg(Math.min(m.effSolar[h]!, m.demand[h]!)),
      0,
      r4(m.effSolar[h]!),
    );
    plan.push({
      hour: h,
      grid_kwh: r4nonneg(m.demand[h]! - solarUsed),
      solar_used_kwh: solarUsed,
      battery_action: "idle",
      battery_kwh: 0,
      battery_energy_after_kwh: energy,
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Totals — recomputed from the FINAL ROUNDED plan (11.3, trap 8)
// ---------------------------------------------------------------------------

export function computeTotals(plan: PlanHour[], hours: Hour[]): PlanTotals {
  // Index tariffs by declared hour value: hours may arrive unordered.
  const tariffByHour = new Array<number>(H).fill(0);
  for (const entry of Array.isArray(hours) ? hours : []) {
    const h = entry?.hour;
    if (Number.isInteger(h) && (h as number) >= 0 && (h as number) < H) {
      tariffByHour[h as number] = isNum(entry.tariff_bdt_per_kwh)
        ? entry.tariff_bdt_per_kwh
        : 0;
    }
  }

  let totalGrid = 0;
  let totalCost = 0;
  let peak = 0;

  for (const p of Array.isArray(plan) ? plan : []) {
    const grid = isNum(p?.grid_kwh) ? p.grid_kwh : 0;
    const h = isNum(p?.hour) ? p.hour : -1;
    const tariff = h >= 0 && h < H ? tariffByHour[h]! : 0;
    totalGrid += grid;
    totalCost += grid * tariff;
    if (grid > peak) peak = grid;
  }

  return {
    total_grid_kwh: r4nonneg(totalGrid),
    total_cost_bdt: r4nonneg(totalCost),
    peak_grid_kwh: r4nonneg(peak),
  };
}

// ---------------------------------------------------------------------------
// solve() — the frozen entry point
// ---------------------------------------------------------------------------

/**
 * Relaxation ladder. Organizer scoring scenarios are guaranteed feasible
 * (5.1), so an infeasible LP means a note was misread upstream, not that the
 * scenario is impossible. Relaxing the softest directive family and re-solving
 * always beats returning nothing.
 */
const LADDER: Relaxation[] = [
  { gridCaps: true, reserves: true, windows: true }, // everything applied
  { gridCaps: false, reserves: true, windows: true }, // drop max_grid_window
  { gridCaps: false, reserves: false, windows: true }, // also drop reserve raises
  { gridCaps: false, reserves: false, windows: false }, // also drop the windows
];

/**
 * Produce the cheapest valid 24-hour plan for the given validated directives.
 *
 * Never throws. Returns null only if the scenario is so malformed that even a
 * baseline plan cannot be built (index.ts keeps its own baseline fallback).
 */
export function solve(
  hours: Hour[],
  battery: Battery,
  directives: Directive[],
): PlanHour[] | null {
  try {
    if (!Array.isArray(hours) || hours.length !== H) return null;
    if (!battery || typeof battery !== "object") return null;
    if (!isNum(battery.capacity_kwh) || !isNum(battery.initial_energy_kwh)) {
      return null;
    }

    // hours may arrive in any order; index by the declared hour value.
    const ordered = new Array<Hour>(H);
    for (const entry of hours) {
      const h = entry?.hour;
      if (!Number.isInteger(h) || (h as number) < 0 || (h as number) >= H) {
        return null;
      }
      if (ordered[h as number]) return null; // duplicate hour
      ordered[h as number] = entry;
    }
    for (let h = 0; h < H; h++) if (!ordered[h]) return null; // missing hour

    const dirs = Array.isArray(directives) ? directives : [];

    // The audit always runs against the FULL directive set, even when the LP
    // itself was relaxed: a relaxed plan that happens to satisfy everything is
    // still the best answer available.
    const strict = buildModelInputs(ordered, battery, dirs, FULL);

    let best: PlanHour[] | null = null;

    for (const relax of LADDER) {
      const m = buildModelInputs(ordered, battery, dirs, relax);
      const lp = solveLP(m, battery);
      if (!lp) continue;

      const plan = assemblePlan(lp, m, battery);

      if (auditPlan(plan, strict, battery)) return plan; // fully valid — done
      if (!best && auditPlan(plan, m, battery)) best = plan; // valid when relaxed
    }

    if (best) return best;

    const fallback = baselinePlan(ordered, battery, dirs);
    const loose = buildModelInputs(ordered, battery, dirs, NONE);
    return auditPlan(fallback, loose, battery) ? fallback : null;
  } catch (err) {
    // solve() is contractually non-throwing: a bug here must not 500 the service.
    console.error(
      "optimizer: unexpected failure, returning null:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
