/**
 * zod request/response schemas for POST /optimize-energy.
 * Owned by role A. Mirrors the shapes frozen in types.ts.
 * See ACTION_PLAN.md §"A — Service & Deployment".
 */

import { z } from "zod";

export const HourSchema = z.object({
  hour: z.number().int().min(0).max(23),
  demand_kwh: z.number().finite().nonnegative(),
  solar_kwh: z.number().finite().nonnegative(),
  tariff_bdt_per_kwh: z.number().finite().nonnegative(),
});

export const BatterySchema = z.object({
  capacity_kwh: z.number().finite().nonnegative(),
  initial_energy_kwh: z.number().finite().nonnegative(),
  minimum_energy_kwh: z.number().finite().nonnegative(),
  max_charge_kwh_per_hour: z.number().finite().nonnegative(),
  max_discharge_kwh_per_hour: z.number().finite().nonnegative(),
});

export const OptimizeEnergyRequestSchema = z.object({
  scenario_id: z.string().min(1),
  operator_notes: z.array(z.string().min(1)).min(1).max(3),
  hours: z.array(HourSchema).length(24),
  battery: BatterySchema,
});

export const DirectiveTypeSchema = z.enum([
  "solar_reduction",
  "minimum_battery_reserve",
  "no_charge_window",
  "no_discharge_window",
  "max_grid_window",
  "no_op",
]);

export const DirectiveSchema = z.object({
  note_index: z.number().int().nonnegative(),
  applies: z.boolean(),
  directive_type: DirectiveTypeSchema,
  structured_adjustment: z.record(z.string(), z.unknown()).nullable(),
  explanation: z.string(),
});

export const PlanHourSchema = z.object({
  hour: z.number().int().min(0).max(23),
  grid_kwh: z.number().finite().nonnegative(),
  solar_used_kwh: z.number().finite().nonnegative(),
  battery_action: z.enum(["charge", "discharge", "idle"]),
  battery_kwh: z.number().finite().nonnegative(),
  battery_energy_after_kwh: z.number().finite().nonnegative(),
});

export const OptimizeEnergyResponseSchema = z.object({
  scenario_id: z.string(),
  directive_interpretation: z.array(DirectiveSchema),
  hourly_plan: z.array(PlanHourSchema),
  total_grid_kwh: z.number().finite().nonnegative(),
  total_cost_bdt: z.number().finite().nonnegative(),
  peak_grid_kwh: z.number().finite().nonnegative(),
  plan_summary: z.string(),
});
