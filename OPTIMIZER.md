# Math Optimizer — `solve()`

Role C. Fourth stage of the pipeline: takes validated directives and returns the
cheapest valid 24-hour plan. Fully deterministic — no LLM, no network.

## Solver

[`highs`](https://www.npmjs.com/package/highs) v1.15.3 — the WebAssembly build of
the HiGHS C++ solver.

> The package name in the build plan (`highs-js`) does not exist on npm. `highs`
> is the published name of that same project (`lovasoa/highs-js`).

The WASM binary is loaded in module scope with a top-level `await`, so `solve()`
keeps its synchronous signature and the solver is already warm before the first
request. If the binary fails to load, `solve()` degrades to the baseline plan
instead of taking the service down.

## Formulation

Per hour `h ∈ 0..23`, continuous and `≥ 0`: `g` grid, `s` solar used,
`c` charge, `d` discharge, `E` energy after.

```
minimize   Σ tariff[h] · g[h]

s.t.  g[h] + s[h] + d[h] − c[h]  = demand[h]        energy balance
      E[0] − c[0] + d[0]         = initial_energy
      E[h] − E[h−1] − c[h] + d[h] = 0               h ≥ 1
      0 ≤ s[h] ≤ eff_solar[h]                       curtailment allowed
      0 ≤ c[h] ≤ max_charge        (0 in no-charge hours)
      0 ≤ d[h] ≤ max_discharge     (0 in no-discharge hours)
      0 ≤ g[h] ≤ max_grid_kwh      (only where capped)
      reserve[h] ≤ E[h] ≤ capacity
      E[23] = initial_energy                        end-of-day neutrality
```

`reserve[h] = max(base minimum_energy_kwh, directive reserve)`.

Where directives of one type overlap on an hour: **min** factor, **max** reserve,
**min** grid cap — the most restrictive, matching how `guard()` merges duplicates,
so the optimizer and the Final Validator cannot disagree about the constraint.

## Plan construction

The LP solution is not reported directly. Four steps in between:

1. **Net the battery.** The LP may return simultaneous charge and discharge;
   `net = c − d` gives one action per hour, and `battery_kwh` is exactly `0`
   when idle.
2. **Exact neutrality.** The rounded nets are forced to sum to zero, so
   `battery_energy_after_kwh[23] == initial_energy_kwh` exactly rather than
   within rounding error.
3. **Grid derived from the balance.** `solar_used` is clamped down into
   `[0, eff_solar]` (never up — overusing effective solar invalidates the case),
   then `grid = demand + charge − solar_used − discharge`. Rounding it separately
   would accumulate three independent errors.
4. **Energy re-derived from the netted actions**, so the reported state of charge
   matches the action reported alongside it.

`total_grid_kwh`, `total_cost_bdt` and `peak_grid_kwh` are computed from the
final rounded plan only, since the judge recomputes them from `hourly_plan`.

## Infeasibility

Organizer scoring scenarios are guaranteed feasible, so an infeasible LP means a
note was misread upstream — not that the scenario is impossible. Rather than
returning nothing, the softest directive family is dropped and the LP re-solved:

1. full model
2. drop `max_grid_window` caps
3. also drop `minimum_battery_reserve` raises
4. also drop `no_charge_window` / `no_discharge_window`
5. baseline — solar first, battery idle, grid covers the rest

Every stage is checked against the full directive set before being accepted.
`solve()` never throws; it returns `null` only if even a baseline cannot be built.

## Exports

| Export | Purpose |
|---|---|
| `solve(hours, battery, directives)` | The plan. `PlanHour[]`, or `null`. |
| `baselinePlan(hours, battery, directives)` | Always-feasible fallback. |
| `computeTotals(plan, hours)` | The three aggregates, from the rounded plan. |
| `solverInfo()` | Solver name, version, ready state. |
| `buildModelInputs(...)` | Per-hour effective solar / reserve / caps / windows. |

## Tests

```bash
bun test optimizer.test.ts
```

33 tests: the 10 public cases fed their expected directives, 13 degenerate
scenarios (solar covering all demand, `max_grid_kwh: 0`, reserve equal to
capacity, `factor: 0`, all-day no-discharge, zero-capacity battery, fractional
inputs, all five directive types stacked, contradictory directives, unordered
hours), and 8 malformed-input tests.

Current result on the public pack — all 10 costs, worst deviation `0.000000` BDT,
zero constraint violations, ~9 ms per solve:

| Case | Cost | Reference |
|---|---|---|
| SAMPLE-01 | 38365 | 38365 |
| SAMPLE-02 | 42885 | 42885 |
| SAMPLE-03 | 35480 | 35480 |
| SAMPLE-04 | 40495 | 40495 |
| SAMPLE-05 | 33950 | 33950 |
| SAMPLE-06 | 34090 | 34090 |
| SAMPLE-07 | 38550 | 38550 |
| SAMPLE-08 | 37665 | 37665 |
| SAMPLE-09 | 34873 | 34873 |
| SAMPLE-10 | 41620 | 41620 |

`peak_grid_kwh` may differ from the reference schedule — equivalent optimal
schedules are accepted, and the judge recomputes peak from our own `hourly_plan`.

## Still open

The plans pass the invariant checker inside `optimizer.test.ts`, but that was
written by the same person as the optimizer. They have not yet been checked
against `validator.ts` (`replay()`), which is still a stub. That independent
agreement is what actually proves directive application.
