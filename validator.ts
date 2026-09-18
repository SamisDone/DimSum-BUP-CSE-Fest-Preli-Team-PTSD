/**
 * Final Validator — owned by role D.
 * Re-runs the judge's own checks against our output. Returns violation
 * strings; empty array === valid. Never throws. See ACTION_PLAN.md §3, §D.
 *
 * STUB: no checks performed yet. Replace with an independent implementation
 * written from the Problem Statement §11 text directly.
 */

import type { Battery, Directive, Hour, PlanHour } from "./types";

export function replay(
  hours: Hour[],
  battery: Battery,
  directives: Directive[],
  plan: PlanHour[],
): string[] {
  return [];
}
