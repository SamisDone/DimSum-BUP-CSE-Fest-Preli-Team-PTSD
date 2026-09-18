import { parseArgs } from "util";
import { solve, computeTotals } from "./src/optimizer/optimizer";
import { replay, checkTotals } from "./src/validator/validator";
import type { Battery, Directive, Hour, PlanHour } from "./src/types";

interface PublicCase {
  id: string;
  label: string;
  input: { scenario_id: string; operator_notes: string[]; battery: Battery; hours: Hour[] };
  expected_output: { directive_interpretation: Directive[]; hourly_plan: PlanHour[]; total_cost_bdt: number };
}

function deepEqualAdj(got: any, want: any): boolean {
  if (got === want) return true;
  if (!got || !want || typeof got !== "object" || typeof want !== "object") return false;

  const keys1 = Object.keys(got);
  const keys2 = Object.keys(want);
  if (keys1.length !== keys2.length) return false;

  for (const key of keys1) {
    const val1 = got[key];
    const val2 = want[key];
    if (Array.isArray(val1) && Array.isArray(val2)) {
      if (val1.length !== val2.length) return false;
      for (let i = 0; i < val1.length; i++) {
        if (val1[i] !== val2[i]) return false;
      }
    } else if (typeof val1 === "number" && typeof val2 === "number") {
      if (Math.abs(val1 - val2) > 0.01) return false;
    } else if (val1 !== val2) {
      return false;
    }
  }
  return true;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "directives-from-expected": { type: "boolean" },
      url: { type: "string", default: "http://localhost:3000" },
      case: { type: "string" },
    },
    strict: false,
  });

  const PACK = "./data/BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json";
  let cases: PublicCase[];
  try {
    const file = await Bun.file(PACK).json();
    cases = file.cases;
  } catch (err) {
    console.error("Failed to load public cases:", err);
    process.exit(1);
  }

  if (values.case) {
    cases = cases.filter((c) => c.id === values.case);
  }

  if (cases.length === 0) {
    console.error("No cases matched.");
    process.exit(1);
  }

  let interpretationOk = 0;
  let validityOk = 0;
  let costOk = 0;
  const latencies: number[] = [];

  const DELAY_MS = Number(Bun.env.EVAL_DELAY_MS ?? 4500);
  let first = true;

  for (const c of cases) {
    if (!first && DELAY_MS > 0 && !values["directives-from-expected"]) await Bun.sleep(DELAY_MS);
    first = false;
    const started = Date.now();
    let caseOk = true;

    if (values["directives-from-expected"]) {
      // Local Mode
      const expectedDirectives = c.expected_output.directive_interpretation;
      const expectedCost = c.expected_output.total_cost_bdt;

      const plan = solve(c.input.hours, c.input.battery, expectedDirectives);
      latencies.push(Date.now() - started);

      if (!plan) {
        console.log(`FAIL  ${c.id}  - solve() returned null`);
        continue;
      }

      const violations = replay(c.input.hours, c.input.battery, expectedDirectives, plan);
      if (violations.length === 0) {
        validityOk++;
      } else {
        caseOk = false;
        console.log(`    Validation FAIL: ${violations.join("; ")}`);
      }

      interpretationOk++;

      let actualCost = 0;
      let totalGrid = 0;
      let peakGrid = 0;
      for (const p of plan) {
        const hourData = c.input.hours.find(h => h.hour === p.hour);
        if (hourData && typeof hourData.tariff_bdt_per_kwh === 'number') {
           actualCost += p.grid_kwh * hourData.tariff_bdt_per_kwh;
        }
        totalGrid += p.grid_kwh;
        if (p.grid_kwh > peakGrid) peakGrid = p.grid_kwh;
      }
      
      const reported = {
         total_grid_kwh: totalGrid,
         total_cost_bdt: actualCost,
         peak_grid_kwh: peakGrid
      };

      const totalsViolations = checkTotals(c.input.hours, plan, reported);
      if (totalsViolations.length > 0) {
        console.log(`    Totals FAIL: ${totalsViolations.join("; ")}`);
        caseOk = false;
      }

      const costDiff = Math.abs(actualCost - expectedCost);
      if (costDiff <= 0.01) {
        costOk++;
      } else {
        caseOk = false;
        console.log(`    Cost FAIL: got ${actualCost}, want ${expectedCost}`);
      }
    } else {
      // HTTP Mode
      const urlStr = typeof values.url === "string" ? values.url : "http://localhost:3000";
      const targetUrl = urlStr.endsWith("/optimize-energy") ? urlStr : `${urlStr}/optimize-energy`;
      let res: Response;
      try {
        res = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(c.input)
        });
      } catch (err) {
        console.log(`FAIL  ${c.id}  - fetch failed: ${err}`);
        continue;
      }
      latencies.push(Date.now() - started);

      if (!res.ok) {
        console.log(`FAIL  ${c.id}  - HTTP ${res.status}`);
        continue;
      }

      const bodyData: unknown = await res.json();
      if (!bodyData || typeof bodyData !== "object") {
        console.log(`FAIL  ${c.id}  - Response body is not an object`);
        continue;
      }
      
      const body = bodyData as Record<string, unknown>;
      const returnedDirectives = Array.isArray(body.directive_interpretation) ? body.directive_interpretation : [];
      const returnedPlan = Array.isArray(body.hourly_plan) ? (body.hourly_plan as PlanHour[]) : undefined;
      const returnedTotals = {
        total_grid_kwh: typeof body.total_grid_kwh === "number" ? body.total_grid_kwh : undefined,
        total_cost_bdt: typeof body.total_cost_bdt === "number" ? body.total_cost_bdt : undefined,
        peak_grid_kwh: typeof body.peak_grid_kwh === "number" ? body.peak_grid_kwh : undefined
      };

      // Interpretation Check
      const expectedDirectives = c.expected_output.directive_interpretation;
      let interpOk = true;
      if (returnedDirectives.length !== expectedDirectives.length) {
         interpOk = false;
         console.log(`    Interpretation FAIL: length mismatch`);
      } else {
         for (let i = 0; i < expectedDirectives.length; i++) {
           const rawGot = returnedDirectives[i];
           const want = expectedDirectives[i];
           if (!want || !rawGot || typeof rawGot !== "object") {
             interpOk = false;
             break;
           }
           const got = rawGot as Record<string, unknown>;
           if (got.applies !== want.applies || got.directive_type !== want.directive_type) {
             interpOk = false;
             break;
           }
           if (!deepEqualAdj(got.structured_adjustment, want.structured_adjustment)) {
             interpOk = false;
             break;
           }
         }
      }
      if (interpOk) {
        interpretationOk++;
      } else {
        caseOk = false;
      }

      // Validity Check
      if (Array.isArray(returnedPlan)) {
        const violations = replay(c.input.hours, c.input.battery, returnedDirectives, returnedPlan);
        if (violations.length === 0) {
          validityOk++;
        } else {
          caseOk = false;
          console.log(`    Validation FAIL: ${violations.join("; ")}`);
        }
      } else {
        caseOk = false;
        console.log(`    Validation FAIL: missing hourly_plan`);
      }

      // Totals check
      if (Array.isArray(returnedPlan)) {
         if (
           typeof returnedTotals.total_grid_kwh === "number" && Number.isFinite(returnedTotals.total_grid_kwh) &&
           typeof returnedTotals.total_cost_bdt === "number" && Number.isFinite(returnedTotals.total_cost_bdt) &&
           typeof returnedTotals.peak_grid_kwh === "number" && Number.isFinite(returnedTotals.peak_grid_kwh)
         ) {
           const validTotals = {
             total_grid_kwh: returnedTotals.total_grid_kwh,
             total_cost_bdt: returnedTotals.total_cost_bdt,
             peak_grid_kwh: returnedTotals.peak_grid_kwh
           };
           const totalsViolations = checkTotals(c.input.hours, returnedPlan, validTotals);
           if (totalsViolations.length > 0) {
             console.log(`    Totals FAIL: ${totalsViolations.join("; ")}`);
             caseOk = false;
           }
         } else {
           console.log(`    Totals FAIL: missing or malformed returned totals`);
           caseOk = false;
         }
      }

      // Cost Check
      const expectedCost = c.expected_output.total_cost_bdt;
      if (typeof returnedTotals.total_cost_bdt === "number" && Math.abs(returnedTotals.total_cost_bdt - expectedCost) <= 0.01) {
        costOk++;
      } else {
        caseOk = false;
        console.log(`    Cost FAIL: got ${returnedTotals.total_cost_bdt}, want ${expectedCost}`);
      }
    }

    const ms = latencies[latencies.length - 1]!;
    console.log(`${caseOk ? "PASS" : "FAIL"}  ${c.id}  ${String(ms).padStart(6)}ms  ${c.label}`);
  }

  latencies.sort((a, b) => a - b);
  const at = (q: number): number => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;
  const median = at(0.5);
  const p90 = at(0.9);
  const slowest = latencies[latencies.length - 1] ?? 0;

  console.log(`\ninterpretation ${interpretationOk}/${cases.length}`);
  console.log(`validity ${validityOk}/${cases.length}`);
  console.log(`cost ${costOk}/${cases.length}`);
  console.log(`latency median ${median}ms / p90 ${p90}ms / slowest ${slowest}ms`);

  const success = (interpretationOk === cases.length) && (validityOk === cases.length) && (costOk === cases.length);
  if (!success) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal error in run-public.ts:", err);
  process.exit(1);
});
