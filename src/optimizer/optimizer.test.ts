/**
 * Math Optimizer proof suite — role C.
 *
 *   bun test optimizer.test.ts
 *
 * Three layers:
 *   1. the 10 public cases, fed the EXPECTED directives, must reproduce the
 *      organizer reference cost and pass every GridWise invariant;
 *   2. degenerate scenarios the public pack does not cover;
 *   3. garbage input — solve() must never throw and never return a bad plan.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  baselinePlan,
  buildModelInputs,
  computeTotals,
  solve,
  solverInfo,
} from "./optimizer";
import type { Battery, Directive, Hour, PlanHour } from "../types";

const TOL = 0.01;
const H = 24;

// ---------------------------------------------------------------------------
// Public sample pack
// ---------------------------------------------------------------------------

interface PublicCase {
  id: string;
  label: string;
  input: { scenario_id: string; operator_notes: string[]; hours: Hour[]; battery: Battery };
  expected_output: {
    directive_interpretation: Directive[];
    total_grid_kwh: number;
    total_cost_bdt: number;
    peak_grid_kwh: number;
  };
}

const pack: { cases: PublicCase[] } = JSON.parse(
  readFileSync("data/BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json", "utf8"),
);

// ---------------------------------------------------------------------------
// Independent invariant checker
//
// Written from Problem Statement 09 / 11.3 only. Returns violation strings so a
// failure names the broken rule instead of just "expected true".
// ---------------------------------------------------------------------------

function violations(
  plan: PlanHour[] | null,
  hours: Hour[],
  battery: Battery,
  directives: Directive[],
): string[] {
  const out: string[] = [];
  if (plan === null) return ["plan is null"];
  if (plan.length !== H) return [`expected 24 entries, got ${plan.length}`];

  const m = buildModelInputs(hours, battery, directives);
  const seen = new Set<number>();
  let energy = battery.initial_energy_kwh;

  for (const p of plan) {
    if (!Number.isInteger(p.hour) || p.hour < 0 || p.hour > 23) {
      out.push(`bad hour ${p.hour}`);
      continue;
    }
    if (seen.has(p.hour)) out.push(`duplicate hour ${p.hour}`);
    seen.add(p.hour);

    const h = p.hour;
    for (const [k, v] of [
      ["grid_kwh", p.grid_kwh],
      ["solar_used_kwh", p.solar_used_kwh],
      ["battery_kwh", p.battery_kwh],
      ["battery_energy_after_kwh", p.battery_energy_after_kwh],
    ] as const) {
      if (!Number.isFinite(v)) out.push(`h${h}: ${k} not finite (${v})`);
      if (v < 0) out.push(`h${h}: ${k} negative (${v})`);
    }

    if (!["charge", "discharge", "idle"].includes(p.battery_action)) {
      out.push(`h${h}: bad battery_action ${p.battery_action}`);
    }
    if (p.battery_action === "idle" && p.battery_kwh !== 0) {
      out.push(`h${h}: idle with battery_kwh ${p.battery_kwh}`);
    }

    const charge = p.battery_action === "charge" ? p.battery_kwh : 0;
    const discharge = p.battery_action === "discharge" ? p.battery_kwh : 0;

    if (charge > battery.max_charge_kwh_per_hour + TOL) {
      out.push(`h${h}: charge ${charge} over rate limit`);
    }
    if (discharge > battery.max_discharge_kwh_per_hour + TOL) {
      out.push(`h${h}: discharge ${discharge} over rate limit`);
    }
    if (p.solar_used_kwh > m.effSolar[h]! + TOL) {
      out.push(`h${h}: solar_used ${p.solar_used_kwh} > effective ${m.effSolar[h]}`);
    }
    if (m.noCharge[h] && charge > TOL) out.push(`h${h}: charged in no_charge_window`);
    if (m.noDischarge[h] && discharge > TOL) {
      out.push(`h${h}: discharged in no_discharge_window`);
    }
    if (m.gridCap[h]! < 1e30 && p.grid_kwh > m.gridCap[h]! + TOL) {
      out.push(`h${h}: grid ${p.grid_kwh} over cap ${m.gridCap[h]}`);
    }

    // energy balance (9.5)
    const lhs = p.grid_kwh + p.solar_used_kwh + discharge;
    const rhs = m.demand[h]! + charge;
    if (Math.abs(lhs - rhs) > TOL) {
      out.push(`h${h}: balance ${lhs.toFixed(4)} != ${rhs.toFixed(4)}`);
    }

    // battery transition and bounds (9.1, 9.2)
    energy = energy + charge - discharge;
    if (Math.abs(energy - p.battery_energy_after_kwh) > TOL) {
      out.push(`h${h}: E_after ${p.battery_energy_after_kwh} != replayed ${energy.toFixed(4)}`);
    }
    if (p.battery_energy_after_kwh < m.reserve[h]! - TOL) {
      out.push(`h${h}: E_after ${p.battery_energy_after_kwh} below reserve ${m.reserve[h]}`);
    }
    if (p.battery_energy_after_kwh > battery.capacity_kwh + TOL) {
      out.push(`h${h}: E_after ${p.battery_energy_after_kwh} over capacity`);
    }
  }

  if (seen.size !== H) out.push(`expected 24 unique hours, got ${seen.size}`);

  // end-of-day neutrality (9.6)
  const last = plan.find((p) => p.hour === 23);
  if (!last) out.push("no hour 23");
  else if (Math.abs(last.battery_energy_after_kwh - battery.initial_energy_kwh) > TOL) {
    out.push(
      `neutrality: E_after[23] ${last.battery_energy_after_kwh} != initial ${battery.initial_energy_kwh}`,
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// 0. Solver bootstrap
// ---------------------------------------------------------------------------

test("HiGHS loaded", () => {
  const info = solverInfo();
  expect(info.error).toBeNull();
  expect(info.ready).toBe(true);
});

// ---------------------------------------------------------------------------
// 1. The public sample pack
// ---------------------------------------------------------------------------

test("SAMPLE-01 reproduces the reference cost exactly (38365)", () => {
  const c = pack.cases.find((x) => x.id === "SAMPLE-01")!;
  const plan = solve(c.input.hours, c.input.battery, c.expected_output.directive_interpretation);
  expect(plan).not.toBeNull();
  const totals = computeTotals(plan!, c.input.hours);
  expect(totals.total_cost_bdt).toBe(38365);
});

describe("public sample pack", () => {
  for (const c of pack.cases) {
    test(`${c.id} (${c.label})`, () => {
      const { hours, battery } = c.input;
      const dirs = c.expected_output.directive_interpretation;

      const plan = solve(hours, battery, dirs);
      expect(plan).not.toBeNull();

      // zero GridWise / directive violations
      expect(violations(plan, hours, battery, dirs)).toEqual([]);

      // cost matches the organizer reference within tolerance -> quality_ratio 1
      const totals = computeTotals(plan!, hours);
      expect(Math.abs(totals.total_cost_bdt - c.expected_output.total_cost_bdt)).toBeLessThan(TOL);

      // reported totals are internally consistent with hourly_plan (11.3)
      const grid = plan!.reduce((a, p) => a + p.grid_kwh, 0);
      const peak = Math.max(...plan!.map((p) => p.grid_kwh));
      expect(Math.abs(totals.total_grid_kwh - grid)).toBeLessThan(TOL);
      expect(Math.abs(totals.peak_grid_kwh - peak)).toBeLessThan(TOL);

      // end-of-day neutrality is EXACT, not merely within tolerance
      expect(plan![23]!.battery_energy_after_kwh).toBe(battery.initial_energy_kwh);
    });
  }
});

test("every public case is solved well inside the latency budget", () => {
  const t0 = performance.now();
  for (const c of pack.cases) {
    solve(c.input.hours, c.input.battery, c.expected_output.directive_interpretation);
  }
  const perCase = (performance.now() - t0) / pack.cases.length;
  expect(perCase).toBeLessThan(250); // p95 budget is 5s for the whole request
});

// ---------------------------------------------------------------------------
// 2. Degenerate scenarios the public pack does not cover
// ---------------------------------------------------------------------------

const battery: Battery = {
  capacity_kwh: 200,
  initial_energy_kwh: 100,
  minimum_energy_kwh: 40,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

function makeHours(over: Partial<Hour>[] = []): Hour[] {
  return Array.from({ length: H }, (_, h) => ({
    hour: h,
    demand_kwh: 100,
    solar_kwh: h >= 8 && h <= 16 ? 80 : 0,
    tariff_bdt_per_kwh: h >= 18 && h <= 21 ? 12 : 6,
    ...(over[h] ?? {}),
  }));
}

function directive(
  type: Directive["directive_type"],
  adjustment: Record<string, unknown> | null,
  note_index = 0,
): Directive {
  return {
    note_index,
    applies: type !== "no_op",
    directive_type: type,
    structured_adjustment: adjustment,
    explanation: "test",
  };
}

describe("degenerate scenarios", () => {
  test("solar covers all demand -> cost is exactly 0 (the zero-cost trap)", () => {
    // quality_ratio gives NO partial credit when the optimum is 0, so any grid
    // purchase at all collapses such a case to zero.
    const hours = makeHours(
      Array.from({ length: H }, () => ({ demand_kwh: 50, solar_kwh: 500 })),
    );
    const plan = solve(hours, battery, []);
    expect(violations(plan, hours, battery, [])).toEqual([]);
    expect(computeTotals(plan!, hours).total_cost_bdt).toBe(0);
  });

  test("max_grid_kwh of 0 for all 24 hours", () => {
    const hours = makeHours(
      Array.from({ length: H }, () => ({ demand_kwh: 40, solar_kwh: 200 })),
    );
    const dirs = [
      directive("max_grid_window", { hours: Array.from({ length: H }, (_, h) => h), max_grid_kwh: 0 }),
    ];
    const plan = solve(hours, battery, dirs);
    expect(violations(plan, hours, battery, dirs)).toEqual([]);
    expect(computeTotals(plan!, hours).total_grid_kwh).toBe(0);
  });

  test("reserve equal to capacity", () => {
    const hours = makeHours();
    const dirs = [
      directive("minimum_battery_reserve", { hours: [18, 19, 20], minimum_energy_kwh: 200 }),
    ];
    const plan = solve(hours, battery, dirs);
    expect(violations(plan, hours, battery, dirs)).toEqual([]);
    for (const h of [18, 19, 20]) {
      expect(plan![h]!.battery_energy_after_kwh).toBeGreaterThanOrEqual(200 - TOL);
    }
  });

  test("factor of exactly 0 zeroes out usable solar", () => {
    const hours = makeHours();
    const dirs = [directive("solar_reduction", { hours: [10, 11, 12], factor: 0 })];
    const plan = solve(hours, battery, dirs);
    expect(violations(plan, hours, battery, dirs)).toEqual([]);
    for (const h of [10, 11, 12]) expect(plan![h]!.solar_used_kwh).toBe(0);
  });

  test("all 24 hours in a no_discharge_window", () => {
    const hours = makeHours();
    const all = Array.from({ length: H }, (_, h) => h);
    const dirs = [directive("no_discharge_window", { hours: all })];
    const plan = solve(hours, battery, dirs);
    expect(violations(plan, hours, battery, dirs)).toEqual([]);
    expect(plan!.every((p) => p.battery_action !== "discharge")).toBe(true);
  });

  test("all 24 hours in a no_charge_window", () => {
    const hours = makeHours();
    const all = Array.from({ length: H }, (_, h) => h);
    const dirs = [directive("no_charge_window", { hours: all })];
    const plan = solve(hours, battery, dirs);
    expect(violations(plan, hours, battery, dirs)).toEqual([]);
    expect(plan!.every((p) => p.battery_action !== "charge")).toBe(true);
  });

  test("initial energy equal to the minimum reserve", () => {
    const tight: Battery = { ...battery, initial_energy_kwh: 40 };
    const hours = makeHours();
    const plan = solve(hours, tight, []);
    expect(violations(plan, hours, tight, [])).toEqual([]);
  });

  test("zero-capacity battery", () => {
    const dead: Battery = {
      capacity_kwh: 0,
      initial_energy_kwh: 0,
      minimum_energy_kwh: 0,
      max_charge_kwh_per_hour: 0,
      max_discharge_kwh_per_hour: 0,
    };
    const hours = makeHours();
    const plan = solve(hours, dead, []);
    expect(violations(plan, hours, dead, [])).toEqual([]);
    expect(plan!.every((p) => p.battery_action === "idle")).toBe(true);
  });

  test("fractional demand and tariffs keep the balance within tolerance", () => {
    const hours = makeHours(
      Array.from({ length: H }, (_, h) => ({
        demand_kwh: 97.3333 + h / 7,
        solar_kwh: h % 3 === 0 ? 41.6667 : 0,
        tariff_bdt_per_kwh: 6.75 + (h % 5) / 3,
      })),
    );
    const dirs = [directive("solar_reduction", { hours: [9, 12, 15], factor: 1 / 3 })];
    const plan = solve(hours, battery, dirs);
    expect(violations(plan, hours, battery, dirs)).toEqual([]);
  });

  test("all five directive types stacked on one scenario", () => {
    const hours = makeHours();
    const dirs = [
      directive("solar_reduction", { hours: [10, 11], factor: 0.5 }, 0),
      directive("no_charge_window", { hours: [2, 3] }, 1),
      directive("no_discharge_window", { hours: [17, 18] }, 2),
      directive("minimum_battery_reserve", { hours: [19, 20], minimum_energy_kwh: 90 }, 3),
      directive("max_grid_window", { hours: [19, 20, 21], max_grid_kwh: 130 }, 4),
    ];
    const plan = solve(hours, battery, dirs);
    expect(violations(plan, hours, battery, dirs)).toEqual([]);
  });

  test("contradictory hard directives still yield a valid plan, never a throw", () => {
    // Grid capped at 0 all day with no solar and an empty battery is genuinely
    // impossible; the ladder must relax and still hand back a valid schedule.
    const hours = makeHours(
      Array.from({ length: H }, () => ({ demand_kwh: 300, solar_kwh: 0 })),
    );
    const all = Array.from({ length: H }, (_, h) => h);
    const dirs = [
      directive("max_grid_window", { hours: all, max_grid_kwh: 0 }, 0),
      directive("no_discharge_window", { hours: all }, 1),
    ];
    const plan = solve(hours, battery, dirs);
    expect(plan).not.toBeNull();
    // Directive caps had to be dropped, but GridWise physics must still hold.
    expect(violations(plan, hours, battery, [])).toEqual([]);
  });

  test("hours supplied out of order are indexed by hour value", () => {
    const hours = makeHours().reverse();
    const plan = solve(hours, battery, []);
    expect(violations(plan, hours, battery, [])).toEqual([]);
    expect(plan!.map((p) => p.hour)).toEqual(Array.from({ length: H }, (_, h) => h));
  });

  test("a cheaper plan than baseline is actually found", () => {
    const hours = makeHours();
    const optimal = computeTotals(solve(hours, battery, [])!, hours).total_cost_bdt;
    const naive = computeTotals(baselinePlan(hours, battery, []), hours).total_cost_bdt;
    expect(optimal).toBeLessThan(naive);
  });
});

// ---------------------------------------------------------------------------
// 3. Garbage input — solve() never throws
// ---------------------------------------------------------------------------

describe("malformed input is survived, not thrown on", () => {
  const hours = makeHours();

  test("23 hour entries -> null", () => {
    expect(solve(hours.slice(0, 23), battery, [])).toBeNull();
  });

  test("duplicate hour -> null", () => {
    const dup = makeHours();
    dup[5] = { ...dup[4]! };
    expect(solve(dup, battery, [])).toBeNull();
  });

  test("non-array hours -> null", () => {
    expect(solve(null as never, battery, [])).toBeNull();
    expect(solve({} as never, battery, [])).toBeNull();
    expect(solve("nope" as never, battery, [])).toBeNull();
  });

  test("missing or non-numeric battery -> null", () => {
    expect(solve(hours, null as never, [])).toBeNull();
    expect(solve(hours, { ...battery, capacity_kwh: NaN }, [])).toBeNull();
    expect(solve(hours, { ...battery, initial_energy_kwh: "x" as never }, [])).toBeNull();
  });

  test("malformed directives are ignored, never trusted", () => {
    const junk = [
      { note_index: 0 } as never,
      null as never,
      "solar_reduction" as never,
      directive("solar_reduction", { hours: "13,14" as never, factor: 0.2 }),
      directive("solar_reduction", { hours: [13], factor: NaN }),
      directive("solar_reduction", { hours: [13], factor: 1.4 }),
      directive("minimum_battery_reserve", { hours: [18], minimum_energy_kwh: 1e9 }),
      directive("max_grid_window", { hours: [19], max_grid_kwh: -5 }),
      directive("no_charge_window", { hours: [99, -1, 3.5] }),
      directive("no_op", { hours: [1, 2] }),
      directive("bogus_type" as never, { hours: [1] }),
    ];
    const plan = solve(hours, battery, junk);
    expect(plan).not.toBeNull();
    // Out-of-range and unparseable pieces are dropped; the rest still applies.
    expect(violations(plan, hours, battery, junk)).toEqual([]);
  });

  test("non-array directives -> still a valid plan", () => {
    for (const bad of [null, undefined, "x", 42, {}] as never[]) {
      const plan = solve(hours, battery, bad);
      expect(violations(plan, hours, battery, [])).toEqual([]);
    }
  });

  test("baselinePlan survives garbage too", () => {
    expect(baselinePlan(hours, battery, null as never)).toHaveLength(H);
    expect(computeTotals([] as PlanHour[], hours).total_cost_bdt).toBe(0);
    expect(computeTotals(null as never, hours).total_cost_bdt).toBe(0);
  });
});
