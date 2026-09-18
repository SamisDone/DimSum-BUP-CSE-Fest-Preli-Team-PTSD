import { parseArgs } from "util";

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      url: { type: "string", default: "http://localhost:3000" }
    },
    strict: false,
  });

  const urlStr = typeof values.url === "string" ? values.url : "http://localhost:3000";
  const baseUrl = urlStr.endsWith("/optimize-energy") ? urlStr : `${urlStr}/optimize-energy`;
  const apiKey = Bun.env.GEMINI_API_KEY || "";
  let failed = false;

  async function check(name: string, body: any, expectedStatus: number | number[], expectedCheck?: (res: Response, text: string) => boolean) {
    let res: Response;
    let text = "";
    try {
      res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body)
      });
      text = await res.text();
    } catch (e) {
      console.log(`[FAIL] ${name}: fetch error ${e}`);
      failed = true;
      return;
    }

    if (apiKey && text.includes(apiKey)) {
       console.log(`[FAIL] ${name}: SECRET LEAK DETECTED`);
       failed = true;
       return;
    }

    const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!statuses.includes(res.status)) {
       console.log(`[FAIL] ${name}: expected status ${statuses.join(" or ")}, got ${res.status}`);
       failed = true;
       return;
    }

    if (expectedCheck && !expectedCheck(res, text)) {
       console.log(`[FAIL] ${name}: custom check failed`);
       failed = true;
       return;
    }

    console.log(`[PASS] ${name}`);
  }

  const validBattery = {
    capacity_kwh: 100,
    initial_energy_kwh: 50,
    max_charge_kwh_per_hour: 50,
    max_discharge_kwh_per_hour: 50,
    minimum_energy_kwh: 10
  };
  const validHours = Array.from({ length: 24 }).map((_, i) => ({
    hour: i,
    demand_kwh: 100,
    solar_kwh: 50,
    tariff_bdt_per_kwh: 10
  }));

  const validBody = {
    scenario_id: "fault-inject",
    operator_notes: ["charge"],
    battery: validBattery,
    hours: validHours
  };

  // 1. malformed JSON body
  await check("malformed JSON body", "{ bad json", 400, (res, text) => {
    return !text.toLowerCase().includes("trace") && !text.includes("    at ");
  });

  // 2. hours with 23 entries
  const body23 = { ...validBody, hours: validHours.slice(0, 23) };
  await check("hours with 23 entries", body23, 400);

  // 3. operator_notes: []
  const bodyEmptyNotes = { ...validBody, operator_notes: [] };
  await check("operator_notes: []", bodyEmptyNotes, 400);

  // 4. operator_notes: [""]
  const bodyBlankNote = { ...validBody, operator_notes: [""] };
  await check("operator_notes: [\"\"]", bodyBlankNote, 400);

  // 5. 4 operator notes
  const body4Notes = { ...validBody, operator_notes: ["A", "B", "C", "D"] };
  await check("4 operator notes", body4Notes, [400, 200], (res, text) => {
    if (res.status === 200) {
      try {
         const json = JSON.parse(text);
         return Array.isArray(json.directive_interpretation) && json.directive_interpretation.length === 4;
      } catch {
         return false;
      }
    }
    return true;
  });

  // 6. valid request with API key unset
  // We can't really unset the API key for the server from here, but we can assume the server might be running without it.
  // We will just run a valid request and expect 200 with a valid plan.
  await check("valid request (assumed API key unset or present)", validBody, 200, (res, text) => {
    try {
      const json = JSON.parse(text);
      return Array.isArray(json.hourly_plan) && json.hourly_plan.length === 24;
    } catch {
      return false;
    }
  });

  // 7. 20 rapid sequential valid requests
  const latencies: number[] = [];
  let rapidOk = true;
  for (let i = 0; i < 20; i++) {
    const started = Date.now();
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody)
      });
      const text = await res.text();
      latencies.push(Date.now() - started);
      if (res.status !== 200) {
        rapidOk = false;
        console.log(`[FAIL] rapid request ${i + 1} returned ${res.status}`);
      }
      if (apiKey && text.includes(apiKey)) {
        console.log(`[FAIL] rapid request ${i + 1}: SECRET LEAK DETECTED`);
        rapidOk = false;
      }
    } catch (e) {
      rapidOk = false;
      console.log(`[FAIL] rapid request ${i + 1} fetch error: ${e}`);
    }
  }

  if (rapidOk) {
    latencies.sort((a, b) => a - b);
    const at = (q: number): number => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;
    const median = at(0.5);
    const p90 = at(0.9);
    const slowest = latencies[latencies.length - 1] ?? 0;
    console.log(`[PASS] 20 rapid sequential requests (median ${median}ms, p90 ${p90}ms, slowest ${slowest}ms)`);
  } else {
    failed = true;
  }

  if (failed) process.exit(1);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
