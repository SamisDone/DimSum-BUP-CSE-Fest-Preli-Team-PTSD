/**
 * GridWise — Smart Campus Energy Optimization Challenge
 * BUP CSE Fest 2026 · Online Preliminary
 *
 * Service skeleton. Owned by role A (Service & Deployment) — see ACTION_PLAN.md.
 *
 * Pipeline (organizer architecture, Problem Statement §03):
 *   Energy Data + Operator Notes -> LLM Interpreter -> Guardrail Validator
 *     -> Math Optimizer -> Final Validator -> API Response
 */

import { OptimizeEnergyRequestSchema } from "./schemas";
import { interpret } from "./interpreter/interpreter";
import { guard } from "./interpreter/guardrails";
import { solve } from "./optimizer/optimizer";
import { replay } from "./validator/validator";
import type { Battery, Directive, Hour, OptimizeEnergyResponse, PlanHour } from "./types";

const PORT = Number(Bun.env.PORT ?? 3000);

// Must bind 0.0.0.0, not localhost: the Docker fallback image is scored on
// reaching /health from outside the container.
const HOSTNAME = Bun.env.HOSTNAME ?? "0.0.0.0";

// Always-feasible fallback used when solve() returns null or replay() finds
// violations: solar first, battery idle all day, grid covers the rest.
function baselinePlan(hours: Hour[], battery: Battery): PlanHour[] {
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

function summarize(
  usedBaseline: boolean,
  directives: Directive[],
  total_cost_bdt: number,
  total_grid_kwh: number,
  peak_grid_kwh: number,
): string {
  const applied = directives.filter((d) => d.applies).length;
  const directiveText =
    applied === 0
      ? "no operator directives applied"
      : `${applied} operator directive${applied === 1 ? "" : "s"} applied`;
  const source = usedBaseline
    ? "baseline plan (solar first, battery idle, grid covers the rest) — the optimizer returned no feasible plan or failed validation"
    : "optimized plan";
  return (
    `${source} with ${directiveText}: ` +
    `${total_grid_kwh.toFixed(2)} kWh from the grid, ` +
    `peak ${peak_grid_kwh.toFixed(2)} kWh/hour, ` +
    `total cost ${total_cost_bdt.toFixed(2)} BDT.`
  );
}

function assembleResponse(
  scenario_id: string,
  hours: Hour[],
  directives: Directive[],
  plan: PlanHour[],
  usedBaseline: boolean,
): OptimizeEnergyResponse {
  const tariffByHour = new Map(hours.map((h) => [h.hour, h.tariff_bdt_per_kwh]));
  const total_grid_kwh = plan.reduce((sum, p) => sum + p.grid_kwh, 0);
  const total_cost_bdt = plan.reduce(
    (sum, p) => sum + p.grid_kwh * (tariffByHour.get(p.hour) ?? 0),
    0,
  );
  const peak_grid_kwh = plan.reduce((max, p) => Math.max(max, p.grid_kwh), 0);
  return {
    scenario_id,
    directive_interpretation: directives,
    hourly_plan: plan,
    total_grid_kwh,
    total_cost_bdt,
    peak_grid_kwh,
    plan_summary: summarize(usedBaseline, directives, total_cost_bdt, total_grid_kwh, peak_grid_kwh),
  };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,

  routes: {
    "/": {
      GET: () =>
        Response.json({
          service: "gridwise-energy-optimizer",
          event: "BUP CSE Fest 2026 · Online Preliminary",
          status: "running",
          endpoints: {
            "GET /": "this service description",
            "GET /health": "readiness probe for the judge harness",
            "POST /optimize-energy": "energy plan for a 24h scenario",
          },
        }),
    },

    // Contract: HTTP 200 with status "ok" once the service is ready.
    // Never calls the LLM — it has to answer even when the provider is down.
    "/health": {
      GET: () => Response.json({ status: "ok" }),
    },

    "/optimize-energy": {
      POST: async (req) => {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json(
            { error: "bad_request", message: "Request body must be valid JSON." },
            { status: 400 },
          );
        }

        const parsed = OptimizeEnergyRequestSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "bad_request", message: "Request does not match the expected schema." },
            { status: 400 },
          );
        }

        const { scenario_id, operator_notes, hours, battery } = parsed.data;

        const raw = await interpret(operator_notes, battery);
        const directives = guard(raw, operator_notes.length, battery);

        let plan = solve(hours, battery, directives);
        let usedBaseline = plan === null;
        if (plan === null) {
          plan = baselinePlan(hours, battery);
        } else {
          const violations = replay(hours, battery, directives, plan);
          if (violations.length > 0) {
            plan = baselinePlan(hours, battery);
            usedBaseline = true;
          }
        }

        const response: OptimizeEnergyResponse = assembleResponse(
          scenario_id,
          hours,
          directives,
          plan,
          usedBaseline,
        );
        return Response.json(response);
      },
    },
  },

  // Unmatched path or method. JSON, never an HTML error page.
  fetch(req) {
    const { pathname } = new URL(req.url);
    return Response.json(
      { error: "not_found", message: `No route for ${req.method} ${pathname}` },
      { status: 404 },
    );
  },

  // Controlled failure: no stack traces, no secrets in the response body.
  error(err) {
    console.error("unhandled error:", err?.message ?? err);
    return Response.json(
      { error: "internal_error", message: "An internal error occurred." },
      { status: 500 },
    );
  },
});

console.log(`GridWise service listening on http://${server.hostname}:${server.port}`);
