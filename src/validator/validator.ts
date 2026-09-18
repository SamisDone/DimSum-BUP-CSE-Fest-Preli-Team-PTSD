/**
 * Final Validator — owned by role D.
 * Re-runs the judge's own checks against our output. Returns violation
 * strings; empty array === valid. Never throws. See ACTION_PLAN.md §3, §D.
 */

import type { Battery, Directive, Hour, PlanHour } from "../types";

const TOL = 0.01;

const near = (a: number, b: number) => Math.abs(a - b) <= TOL;
const lte = (a: number, b: number) => a <= b + TOL;
const gte = (a: number, b: number) => a >= b - TOL;

export function checkTotals(
  hours: Hour[],
  plan: PlanHour[],
  reported: {
    total_grid_kwh: number;
    total_cost_bdt: number;
    peak_grid_kwh: number;
  },
): string[] {
  const violations: string[] = [];

  let total_grid_kwh = 0;
  let total_cost_bdt = 0;
  let peak_grid_kwh = 0;

  const tariffMap = new Map<number, number>();
  for (const h of hours) {
    if (h && typeof h.hour === "number" && typeof h.tariff_bdt_per_kwh === "number") {
      tariffMap.set(h.hour, h.tariff_bdt_per_kwh);
    }
  }

  for (const p of plan) {
    if (p && typeof p.grid_kwh === "number") {
      total_grid_kwh += p.grid_kwh;
      if (p.grid_kwh > peak_grid_kwh) {
        peak_grid_kwh = p.grid_kwh;
      }
      const tariff = tariffMap.get(p.hour) ?? 0;
      total_cost_bdt += p.grid_kwh * tariff;
    }
  }

  if (!near(total_grid_kwh, reported.total_grid_kwh)) {
    violations.push(`total_grid_kwh: expected ${total_grid_kwh}, got ${reported.total_grid_kwh}`);
  }
  if (!near(total_cost_bdt, reported.total_cost_bdt)) {
    violations.push(`total_cost_bdt: expected ${total_cost_bdt}, got ${reported.total_cost_bdt}`);
  }
  if (!near(peak_grid_kwh, reported.peak_grid_kwh)) {
    violations.push(`peak_grid_kwh: expected ${peak_grid_kwh}, got ${reported.peak_grid_kwh}`);
  }

  return violations;
}

export function replay(
  hours: Hour[],
  battery: Battery,
  directives: Directive[],
  plan: PlanHour[],
): string[] {
  const violations: string[] = [];

  try {
    if (!Array.isArray(plan) || plan.length !== 24) {
      violations.push(`plan length: expected 24, got ${Array.isArray(plan) ? plan.length : typeof plan}`);
      return violations; // Can't proceed safely
    }

    const seenHours = new Set<number>();
    for (const p of plan) {
      if (!p || typeof p !== "object") {
         violations.push(`malformed plan entry`);
         return violations;
      }
      if (typeof p.hour !== "number" || p.hour < 0 || p.hour > 23 || !Number.isInteger(p.hour)) {
         violations.push(`invalid hour: ${p.hour}`);
      } else {
         if (seenHours.has(p.hour)) {
           violations.push(`duplicate hour: ${p.hour}`);
         }
         seenHours.add(p.hour);
      }

      if (!Number.isFinite(p.grid_kwh) || p.grid_kwh < 0) {
        violations.push(`hour ${p.hour} grid_kwh invalid: ${p.grid_kwh}`);
      }
      if (!Number.isFinite(p.solar_used_kwh) || p.solar_used_kwh < 0) {
        violations.push(`hour ${p.hour} solar_used_kwh invalid: ${p.solar_used_kwh}`);
      }
      if (!Number.isFinite(p.battery_kwh) || p.battery_kwh < 0) {
        violations.push(`hour ${p.hour} battery_kwh invalid: ${p.battery_kwh}`);
      }
      if (!Number.isFinite(p.battery_energy_after_kwh) || p.battery_energy_after_kwh < 0) {
        violations.push(`hour ${p.hour} battery_energy_after_kwh invalid: ${p.battery_energy_after_kwh}`);
      }
      if (p.battery_action !== "charge" && p.battery_action !== "discharge" && p.battery_action !== "idle") {
        violations.push(`hour ${p.hour} battery_action invalid: ${p.battery_action}`);
      }
    }

    if (violations.length > 0) return violations;

    const hourMap = new Map<number, Hour>();
    if (Array.isArray(hours)) {
      for (const h of hours) {
        if (h && typeof h.hour === "number") {
          hourMap.set(h.hour, h);
        }
      }
    }

    const effective_solar = new Array(24).fill(0);
    const reserve = new Array(24).fill(battery?.minimum_energy_kwh ?? 0);
    const grid_cap = new Array(24).fill(Infinity);
    const no_charge = new Array(24).fill(false);
    const no_discharge = new Array(24).fill(false);

    for (let i = 0; i < 24; i++) {
       const hd = hourMap.get(i);
       if (hd && typeof hd.solar_kwh === "number") {
          effective_solar[i] = hd.solar_kwh;
       }
    }

    if (Array.isArray(directives)) {
      for (const d of directives) {
        if (d && d.applies === true && d.structured_adjustment && typeof d.structured_adjustment === "object") {
          const adj = d.structured_adjustment as Record<string, any>;
          if (d.directive_type === "no_op") continue;

          let targetHours: number[] = [];
          if (Array.isArray(adj.hours)) {
             targetHours = adj.hours.filter(h => typeof h === "number" && h >= 0 && h < 24 && Number.isInteger(h));
          }

          if (d.directive_type === "solar_reduction" && typeof adj.factor === "number") {
            const factor = adj.factor;
            for (const h of targetHours) {
               effective_solar[h] = Math.min(effective_solar[h], (hourMap.get(h)?.solar_kwh || 0) * factor);
            }
          } else if (d.directive_type === "minimum_battery_reserve" && typeof adj.minimum_energy_kwh === "number") {
            const val = adj.minimum_energy_kwh;
            for (const h of targetHours) {
               reserve[h] = Math.max(reserve[h], val);
            }
          } else if (d.directive_type === "max_grid_window" && typeof adj.max_grid_kwh === "number") {
            const val = adj.max_grid_kwh;
            for (const h of targetHours) {
               grid_cap[h] = Math.min(grid_cap[h], val);
            }
          } else if (d.directive_type === "no_charge_window") {
            for (const h of targetHours) {
               no_charge[h] = true;
            }
          } else if (d.directive_type === "no_discharge_window") {
            for (const h of targetHours) {
               no_discharge[h] = true;
            }
          }
        }
      }
    }

    const sortedPlan = [...plan].sort((a, b) => a.hour - b.hour);
    let E_before = battery?.initial_energy_kwh ?? 0;

    for (const p of sortedPlan) {
       const h = p.hour;
       const hd = hourMap.get(h);
       const demand = hd && typeof hd.demand_kwh === "number" ? hd.demand_kwh : 0;

       const charge = p.battery_action === "charge" ? p.battery_kwh : 0;
       const discharge = p.battery_action === "discharge" ? p.battery_kwh : 0;

       // 1. Energy balance
       const lhs = p.grid_kwh + p.solar_used_kwh + discharge;
       const rhs = demand + charge;
       if (!near(lhs, rhs)) {
         violations.push(`hour ${h} balance mismatch: ${lhs} != ${rhs}`);
       }

       // 2. Solar
       if (!lte(p.solar_used_kwh, effective_solar[h])) {
         violations.push(`hour ${h} solar limit exceeded: ${p.solar_used_kwh} > ${effective_solar[h]}`);
       }

       // 3. Idle
       if (p.battery_action === "idle" && p.battery_kwh !== 0) {
         violations.push(`hour ${h} idle but battery_kwh != 0: ${p.battery_kwh}`);
       }

       // 4. Rate limits
       const max_charge = battery?.max_charge_kwh_per_hour ?? 0;
       const max_discharge = battery?.max_discharge_kwh_per_hour ?? 0;
       if (!lte(charge, max_charge)) {
         violations.push(`hour ${h} charge limit exceeded: ${charge} > ${max_charge}`);
       }
       if (!lte(discharge, max_discharge)) {
         violations.push(`hour ${h} discharge limit exceeded: ${discharge} > ${max_discharge}`);
       }

       // 5. Battery state transition
       let expected_E_after = E_before;
       if (p.battery_action === "charge") {
         expected_E_after = E_before + charge;
       } else if (p.battery_action === "discharge") {
         expected_E_after = E_before - discharge;
       }
       if (!near(p.battery_energy_after_kwh, expected_E_after)) {
         violations.push(`hour ${h} E_after mismatch: got ${p.battery_energy_after_kwh}, expected ${expected_E_after}`);
       }

       // 6. Battery bounds
       const cap = battery?.capacity_kwh ?? 0;
       if (!gte(p.battery_energy_after_kwh, reserve[h])) {
         violations.push(`hour ${h} E_after < reserve: ${p.battery_energy_after_kwh} < ${reserve[h]}`);
       }
       if (!lte(p.battery_energy_after_kwh, cap)) {
         violations.push(`hour ${h} E_after > capacity: ${p.battery_energy_after_kwh} > ${cap}`);
       }

       // 7. no-charge
       if (no_charge[h] && charge > TOL) {
         violations.push(`hour ${h} charge in no-charge window: ${charge}`);
       }

       // 8. no-discharge
       if (no_discharge[h] && discharge > TOL) {
         violations.push(`hour ${h} discharge in no-discharge window: ${discharge}`);
       }

       // 9. grid cap
       if (!lte(p.grid_kwh, grid_cap[h])) {
         violations.push(`hour ${h} grid_kwh exceeded cap: ${p.grid_kwh} > ${grid_cap[h]}`);
       }

       E_before = p.battery_energy_after_kwh;
    }

    const initEnergy = battery?.initial_energy_kwh ?? 0;
    if (!near(E_before, initEnergy)) {
      violations.push(`end-of-day neutrality failed: got ${E_before}, expected ${initEnergy}`);
    }
  } catch (err) {
    violations.push(`fatal error during validation: ${err instanceof Error ? err.message : String(err)}`);
  }

  return violations;
}
