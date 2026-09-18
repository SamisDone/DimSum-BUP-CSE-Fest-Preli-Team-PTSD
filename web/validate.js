/**
 * Client-side replay of the judge's own checks.
 *
 * The service runs its Final Validator internally and falls back to a baseline
 * plan if it finds violations, but the result never reaches the response — only
 * the seven scored fields do. So rather than claim a plan was validated, this
 * module re-derives the constraint model from the returned directives and
 * re-checks the returned plan here, in the browser, against Problem Statement
 * §09 and §11.3. What the page shows is therefore something a reviewer can
 * watch happen, not something it asserts.
 *
 * Written from the specification, deliberately not ported from validator.ts —
 * an independent implementation is what makes agreement meaningful.
 */

const TOL = 0.01;
const near = (a, b) => Math.abs(a - b) <= TOL;
const lte = (a, b) => a <= b + TOL;
const gte = (a, b) => a >= b - TOL;

const n2 = (v) => Number(v).toFixed(2);

/** Per-hour constraints implied by the directives the service returned. */
function constraintModel(hours, battery, directives) {
  const byHour = new Map(hours.map((h) => [h.hour, h]));
  const effSolar = Array.from({ length: 24 }, (_, h) => byHour.get(h)?.solar_kwh ?? 0);
  const reserve = Array.from({ length: 24 }, () => battery.minimum_energy_kwh);
  const cap = Array.from({ length: 24 }, () => Infinity);
  const noCharge = Array.from({ length: 24 }, () => false);
  const noDischarge = Array.from({ length: 24 }, () => false);

  for (const d of directives ?? []) {
    if (!d?.applies || !d.structured_adjustment) continue;
    const a = d.structured_adjustment;
    const hrs = Array.isArray(a.hours)
      ? a.hours.filter((h) => Number.isInteger(h) && h >= 0 && h < 24)
      : [];

    switch (d.directive_type) {
      case "solar_reduction":
        if (Number.isFinite(a.factor)) {
          // Most restrictive wins where directives overlap.
          for (const h of hrs) effSolar[h] = Math.min(effSolar[h], (byHour.get(h)?.solar_kwh ?? 0) * a.factor);
        }
        break;
      case "minimum_battery_reserve":
        if (Number.isFinite(a.minimum_energy_kwh)) {
          for (const h of hrs) reserve[h] = Math.max(reserve[h], a.minimum_energy_kwh);
        }
        break;
      case "max_grid_window":
        if (Number.isFinite(a.max_grid_kwh)) {
          for (const h of hrs) cap[h] = Math.min(cap[h], a.max_grid_kwh);
        }
        break;
      case "no_charge_window":
        for (const h of hrs) noCharge[h] = true;
        break;
      case "no_discharge_window":
        for (const h of hrs) noDischarge[h] = true;
        break;
    }
  }
  return { byHour, effSolar, reserve, cap, noCharge, noDischarge };
}

/**
 * Returns one entry per check group:
 *   { label, ok, detail }
 * `detail` names the first failing hour and both values, so a failure is
 * diagnosable without opening the console.
 */
export function validatePlan(hours, battery, directives, plan, reported) {
  const checks = [];
  const add = (label, failures, okDetail) =>
    checks.push({
      label,
      ok: failures.length === 0,
      detail: failures.length ? failures[0] : okDetail,
    });

  if (!Array.isArray(plan) || plan.length === 0) {
    return [{ label: "Plan returned", ok: false, detail: "no hourly plan in the response" }];
  }

  // -- structure ----------------------------------------------------------
  const seen = new Set(plan.map((p) => p.hour));
  const structure = [];
  if (plan.length !== 24) structure.push(`${plan.length} entries, expected 24`);
  if (seen.size !== plan.length) structure.push("duplicate hours present");
  for (let h = 0; h < 24; h++) if (!seen.has(h)) structure.push(`hour ${h} missing`);
  add("24 unique hours, 0 through 23", structure, "all 24 hours present exactly once");

  const finite = [];
  for (const p of plan) {
    for (const k of ["grid_kwh", "solar_used_kwh", "battery_kwh", "battery_energy_after_kwh"]) {
      if (!Number.isFinite(p[k])) finite.push(`hour ${p.hour}: ${k} is ${p[k]}`);
      else if (p[k] < -TOL) finite.push(`hour ${p.hour}: ${k} is negative (${n2(p[k])})`);
    }
    if (!["charge", "discharge", "idle"].includes(p.battery_action)) {
      finite.push(`hour ${p.hour}: battery_action "${p.battery_action}"`);
    }
  }
  add("Values finite, non-negative, action valid", finite, "every field well-formed");

  const { byHour, effSolar, reserve, cap, noCharge, noDischarge } = constraintModel(
    hours,
    battery,
    directives,
  );
  const ordered = [...plan].sort((a, b) => a.hour - b.hour);

  // -- per hour -----------------------------------------------------------
  const balance = [];
  const solar = [];
  const idle = [];
  const rates = [];
  const transition = [];
  const bounds = [];
  const windows = [];
  const caps = [];

  let before = battery.initial_energy_kwh;
  for (const p of ordered) {
    const h = p.hour;
    const demand = byHour.get(h)?.demand_kwh ?? 0;
    const charge = p.battery_action === "charge" ? p.battery_kwh : 0;
    const discharge = p.battery_action === "discharge" ? p.battery_kwh : 0;

    const lhs = p.grid_kwh + p.solar_used_kwh + discharge;
    const rhs = demand + charge;
    if (!near(lhs, rhs)) balance.push(`hour ${h}: ${n2(lhs)} supplied vs ${n2(rhs)} required`);

    if (!lte(p.solar_used_kwh, effSolar[h]))
      solar.push(`hour ${h}: used ${n2(p.solar_used_kwh)} of ${n2(effSolar[h])} available`);

    if (p.battery_action === "idle" && !near(p.battery_kwh, 0))
      idle.push(`hour ${h}: idle but battery_kwh is ${n2(p.battery_kwh)}`);

    if (!lte(charge, battery.max_charge_kwh_per_hour))
      rates.push(`hour ${h}: charge ${n2(charge)} over limit ${n2(battery.max_charge_kwh_per_hour)}`);
    if (!lte(discharge, battery.max_discharge_kwh_per_hour))
      rates.push(`hour ${h}: discharge ${n2(discharge)} over limit ${n2(battery.max_discharge_kwh_per_hour)}`);

    const expected = before + charge - discharge;
    if (!near(p.battery_energy_after_kwh, expected))
      transition.push(`hour ${h}: energy after ${n2(p.battery_energy_after_kwh)}, expected ${n2(expected)}`);

    if (!gte(p.battery_energy_after_kwh, reserve[h]))
      bounds.push(`hour ${h}: ${n2(p.battery_energy_after_kwh)} below reserve ${n2(reserve[h])}`);
    if (!lte(p.battery_energy_after_kwh, battery.capacity_kwh))
      bounds.push(`hour ${h}: ${n2(p.battery_energy_after_kwh)} over capacity ${n2(battery.capacity_kwh)}`);

    if (noCharge[h] && charge > TOL) windows.push(`hour ${h}: charged ${n2(charge)} in a no-charge window`);
    if (noDischarge[h] && discharge > TOL)
      windows.push(`hour ${h}: discharged ${n2(discharge)} in a no-discharge window`);

    if (!lte(p.grid_kwh, cap[h]))
      caps.push(`hour ${h}: drew ${n2(p.grid_kwh)} against a ${n2(cap[h])} cap`);

    before = p.battery_energy_after_kwh;
  }

  add("Energy balance holds every hour", balance, "supply equals demand in all 24 hours");
  add("Solar used never exceeds effective solar", solar, "within the post-directive limit");
  add("Battery idle implies zero movement", idle, "idle hours move no energy");
  add("Hourly charge and discharge rate limits", rates, "no hour exceeds its rate limit");
  add("Battery state transitions consistent", transition, "each hour follows from the last");
  add("Reserve and capacity respected", bounds, "energy stays inside every bound");

  const hasWindow = noCharge.some(Boolean) || noDischarge.some(Boolean);
  add(
    "Charge and discharge windows respected",
    windows,
    hasWindow ? "no movement inside a closed window" : "no window directives in this scenario",
  );

  const hasCap = cap.some((c) => Number.isFinite(c));
  add("Grid caps respected", caps, hasCap ? "every capped hour stays under" : "no grid cap in this scenario");

  // -- whole day ----------------------------------------------------------
  const neutral = near(before, battery.initial_energy_kwh) ? [] :
    [`ends at ${n2(before)}, started at ${n2(battery.initial_energy_kwh)}`];
  add(
    "Final battery energy equals the initial level",
    neutral,
    `returns to ${n2(battery.initial_energy_kwh)} kWh`,
  );

  // -- totals recomputed from the plan ------------------------------------
  let grid = 0;
  let cost = 0;
  let peak = 0;
  for (const p of ordered) {
    grid += p.grid_kwh;
    cost += p.grid_kwh * (byHour.get(p.hour)?.tariff_bdt_per_kwh ?? 0);
    peak = Math.max(peak, p.grid_kwh);
  }
  const totals = [];
  if (!near(grid, reported.total_grid_kwh))
    totals.push(`total_grid_kwh ${n2(reported.total_grid_kwh)} vs ${n2(grid)} recomputed`);
  if (!near(cost, reported.total_cost_bdt))
    totals.push(`total_cost_bdt ${n2(reported.total_cost_bdt)} vs ${n2(cost)} recomputed`);
  if (!near(peak, reported.peak_grid_kwh))
    totals.push(`peak_grid_kwh ${n2(reported.peak_grid_kwh)} vs ${n2(peak)} recomputed`);
  add("Reported totals match the hourly plan", totals, "all three agree within 0.01");

  return checks;
}
