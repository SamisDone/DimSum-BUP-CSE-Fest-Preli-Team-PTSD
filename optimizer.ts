/**
 * Math Optimizer — owned by role C.
 * Returns a valid 24-entry plan, or null if infeasible. Never throws.
 * See ACTION_PLAN.md §3, §C.
 *
 * STUB: solar first, battery idle all 24 hours, grid covers the rest.
 * Always feasible, always neutral. Replace with the real LP (highs-js).
 */

import type { Battery, Directive, Hour, PlanHour } from "./types";

export function solve(hours: Hour[], battery: Battery, directives: Directive[]): PlanHour[] | null {
  return hours.map((h) => {
    const solar_used_kwh = Math.min(h.demand_kwh, h.solar_kwh);
    const grid_kwh = h.demand_kwh - solar_used_kwh;
    return {
      hour: h.hour,
      grid_kwh,
      solar_used_kwh,
      battery_action: "idle",
      battery_kwh: 0,
      battery_energy_after_kwh: battery.initial_energy_kwh,
    };
  });
}
