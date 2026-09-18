import { expect, test, describe } from "bun:test";
import { replay, checkTotals } from "./validator";
import { solve } from "./optimizer";
import type { Battery, Directive, Hour, PlanHour } from "./types";

const battery: Battery = {
  capacity_kwh: 100,
  initial_energy_kwh: 50,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
  minimum_energy_kwh: 10
};

const hours: Hour[] = Array.from({ length: 24 }).map((_, i) => ({
  hour: i,
  demand_kwh: 100,
  solar_kwh: 50,
  tariff_bdt_per_kwh: 10
}));

function makeValidPlan(): PlanHour[] {
  return Array.from({ length: 24 }).map((_, i) => ({
    hour: i,
    grid_kwh: 50,
    solar_used_kwh: 50,
    battery_action: "idle",
    battery_kwh: 0,
    battery_energy_after_kwh: 50
  }));
}

describe("Validator Replay Tests", () => {
  test("valid plan", () => {
    const plan = makeValidPlan();
    expect(replay(hours, battery, [], plan)).toEqual([]);
  });

  test("invalid energy balance", () => {
    const plan = makeValidPlan();
    plan[0]!.grid_kwh = 10; // 10 + 50 + 0 != 100 + 0
    expect(replay(hours, battery, [], plan)).not.toBeEmpty();
  });

  test("invalid SoC (out of bounds)", () => {
    const plan = makeValidPlan();
    plan[0]!.battery_energy_after_kwh = 101; // > capacity
    expect(replay(hours, battery, [], plan)).not.toBeEmpty();
    
    plan[0]!.battery_energy_after_kwh = 5; // < min reserve (10)
    expect(replay(hours, battery, [], plan)).not.toBeEmpty();
  });

  test("invalid charge rate", () => {
    const plan = makeValidPlan();
    plan[0]!.battery_action = "charge";
    plan[0]!.battery_kwh = 60; // > max charge (50)
    // Need to balance
    plan[0]!.grid_kwh += 60;
    plan[0]!.battery_energy_after_kwh += 60;
    expect(replay(hours, battery, [], plan)).not.toBeEmpty();
  });

  test("invalid discharge rate", () => {
    const plan = makeValidPlan();
    plan[0]!.battery_action = "discharge";
    plan[0]!.battery_kwh = 60; // > max discharge (50)
    plan[0]!.grid_kwh -= 60;
    plan[0]!.battery_energy_after_kwh -= 60;
    expect(replay(hours, battery, [], plan)).not.toBeEmpty();
  });

  test("invalid grid cap", () => {
    const plan = makeValidPlan();
    const dirs: Directive[] = [
      { applies: true, directive_type: "max_grid_window", structured_adjustment: { hours: [0], max_grid_kwh: 40 }, note_index: 0, explanation: "" }
    ];
    // plan[0] uses 50
    expect(replay(hours, battery, dirs, plan)).not.toBeEmpty();
  });

  test("violated no-charge directive", () => {
    const plan = makeValidPlan();
    plan[0]!.battery_action = "charge";
    plan[0]!.battery_kwh = 10;
    plan[0]!.grid_kwh += 10;
    plan[0]!.battery_energy_after_kwh += 10;
    plan[1]!.battery_energy_after_kwh += 10; // to keep neutrality? Let's just test hour 0 violation
    const dirs: Directive[] = [
      { applies: true, directive_type: "no_charge_window", structured_adjustment: { hours: [0] }, note_index: 0, explanation: "" }
    ];
    expect(replay(hours, battery, dirs, plan)).not.toBeEmpty();
  });

  test("violated no-discharge directive", () => {
    const plan = makeValidPlan();
    plan[0]!.battery_action = "discharge";
    plan[0]!.battery_kwh = 10;
    plan[0]!.grid_kwh -= 10;
    plan[0]!.battery_energy_after_kwh -= 10;
    const dirs: Directive[] = [
      { applies: true, directive_type: "no_discharge_window", structured_adjustment: { hours: [0] }, note_index: 0, explanation: "" }
    ];
    expect(replay(hours, battery, dirs, plan)).not.toBeEmpty();
  });

  test("incorrect battery transition", () => {
    const plan = makeValidPlan();
    plan[1]!.battery_energy_after_kwh = 60; // idle but energy jumped
    expect(replay(hours, battery, [], plan)).not.toBeEmpty();
  });

  test("incorrect solar limit", () => {
    const plan = makeValidPlan();
    plan[0]!.solar_used_kwh = 51; // base is 50
    plan[0]!.grid_kwh -= 1;
    expect(replay(hours, battery, [], plan)).not.toBeEmpty();

    const dirs: Directive[] = [
      { applies: true, directive_type: "solar_reduction", structured_adjustment: { hours: [1], factor: 0.5 }, note_index: 0, explanation: "" }
    ];
    // hour 1 uses 50, but cap is 25
    expect(replay(hours, battery, dirs, plan)).not.toBeEmpty();
  });

  test("incorrect final neutrality", () => {
    const plan = makeValidPlan();
    for (let i = 23; i < 24; i++) plan[i]!.battery_energy_after_kwh = 40; // expected 50
    expect(replay(hours, battery, [], plan)).not.toBeEmpty();
  });

  test("malformed plan", () => {
    expect(replay(hours, battery, [], {} as any)).not.toBeEmpty(); // non-array
    expect(replay(hours, battery, [], null as any)).not.toBeEmpty(); // null
    expect(replay(hours, battery, [], [null] as any)).not.toBeEmpty(); // array with null
  });

  test("duplicate hours", () => {
    const plan = makeValidPlan();
    plan[1]!.hour = 0; // two 0s
    expect(replay(hours, battery, [], plan)).not.toBeEmpty();
  });

  test("missing hours", () => {
    const plan = makeValidPlan();
    plan.pop(); // 23 hours
    expect(replay(hours, battery, [], plan)).not.toBeEmpty();
  });

  test("NaN fields", () => {
    const plan = makeValidPlan();
    plan[0]!.grid_kwh = NaN;
    expect(replay(hours, battery, [], plan)).not.toBeEmpty();
  });

  test("null structured_adjustment", () => {
    const plan = makeValidPlan();
    const dirs: Directive[] = [
      { applies: true, directive_type: "no_charge_window", structured_adjustment: null as any, note_index: 0, explanation: "" }
    ];
    expect(replay(hours, battery, dirs, plan)).toEqual([]); // ignored safely
  });

  test("malformed structured_adjustment", () => {
    const plan = makeValidPlan();
    const dirs: Directive[] = [
      { applies: true, directive_type: "no_charge_window", structured_adjustment: { hours: "all" } as any, note_index: 0, explanation: "" }
    ];
    expect(replay(hours, battery, dirs, plan)).toEqual([]); // ignored safely
  });

  test("checkTotals mismatch", () => {
    const plan = makeValidPlan();
    // actual grid: 50 * 24 = 1200
    // actual cost: 1200 * 10 = 12000
    // actual peak: 50
    const reported = {
       total_grid_kwh: 1200,
       total_cost_bdt: 12000,
       peak_grid_kwh: 999 // mismatch
    };
    expect(checkTotals(hours, plan, reported)).not.toBeEmpty();
  });
});

describe("Public JSON validation", () => {
  test("Validates 10 public expected/reference plans", async () => {
    const file = await Bun.file("./data/BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json").json();
    for (const c of file.cases) {
      const plan = c.expected_output.hourly_plan;
      const dirs = c.expected_output.directive_interpretation;
      expect(replay(c.input.hours, c.input.battery, dirs, plan)).toEqual([]);
    }
  });

  test("Validates 10 optimizer-generated public plans", async () => {
    const file = await Bun.file("./data/BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json").json();
    for (const c of file.cases) {
      const dirs = c.expected_output.directive_interpretation;
      const plan = solve(c.input.hours, c.input.battery, dirs);
      expect(plan).not.toBeNull();
      expect(replay(c.input.hours, c.input.battery, dirs, plan!)).toEqual([]);
    }
  });
});
