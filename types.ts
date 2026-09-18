/**
 * Shared types for the GridWise pipeline.
 * Owned by role A — frozen at T+0:15, changed only by group agreement.
 * See ACTION_PLAN.md §3.
 */

// ---- Request shapes (Problem Statement §7.4) ------------------------------

export interface Hour {
  hour: number;
  demand_kwh: number;
  solar_kwh: number;
  tariff_bdt_per_kwh: number;
}

export interface Battery {
  capacity_kwh: number;
  initial_energy_kwh: number;
  minimum_energy_kwh: number;
  max_charge_kwh_per_hour: number;
  max_discharge_kwh_per_hour: number;
}

export interface OptimizeEnergyRequest {
  scenario_id: string;
  operator_notes: string[];
  hours: Hour[];
  battery: Battery;
}

// ---- Directive interpretation ---------------------------------------------

export type DirectiveType =
  | "solar_reduction"
  | "minimum_battery_reserve"
  | "no_charge_window"
  | "no_discharge_window"
  | "max_grid_window"
  | "no_op";

export interface Directive {
  note_index: number; // 0-based, ascending, one per note
  applies: boolean; // false only for no_op
  directive_type: DirectiveType;
  structured_adjustment: Record<string, unknown> | null; // null only for no_op
  explanation: string;
}

// ---- Optimizer output -------------------------------------------------------

export interface PlanHour {
  hour: number;
  grid_kwh: number;
  solar_used_kwh: number;
  battery_action: "charge" | "discharge" | "idle";
  battery_kwh: number;
  battery_energy_after_kwh: number;
}

// ---- Response shape (Problem Statement / ACTION_PLAN.md §"Response assembly") --

export interface OptimizeEnergyResponse {
  scenario_id: string;
  directive_interpretation: Directive[];
  hourly_plan: PlanHour[];
  total_grid_kwh: number;
  total_cost_bdt: number;
  peak_grid_kwh: number;
  plan_summary: string;
}
