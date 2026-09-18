/**
 * Role B's inner loop. Runs interpret() + guard() over the 10 public cases and
 * scores them against the published ground truth.
 *
 *   bun run eval-notes.ts            all cases
 *   bun run eval-notes.ts SAMPLE-03  one case, with full diff output
 *
 * No HTTP, no optimizer, no dependency on roles A/C/D. This is the number to
 * hill-climb: 10/10 notes correct means category 1 (25 pts) is covered.
 */
import { interpret } from "./src/interpreter/interpreter";
import { guard } from "./src/interpreter/guardrails";
import type { Battery, Directive } from "./src/types";

interface PublicCase {
  id: string;
  label: string;
  input: { scenario_id: string; operator_notes: string[]; battery: Battery };
  expected_output: { directive_interpretation: Directive[] };
}

const PACK = "./data/BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json";
const only = Bun.argv[2];

/** Compare everything the judge checks. Explanation wording is NOT compared. */
function diffEntry(got: Directive, want: Directive): string[] {
  const problems: string[] = [];
  if (got.applies !== want.applies)
    problems.push(`applies ${got.applies} != ${want.applies}`);
  if (got.directive_type !== want.directive_type)
    problems.push(`type ${got.directive_type} != ${want.directive_type}`);

  const g = got.structured_adjustment;
  const w = want.structured_adjustment;
  if (w === null || g === null) {
    if (g !== w) problems.push(`adjustment ${JSON.stringify(g)} != ${JSON.stringify(w)}`);
    return problems;
  }
  for (const key of new Set([...Object.keys(w), ...Object.keys(g)])) {
    const gv = g[key];
    const wv = w[key];
    const same = Array.isArray(wv)
      ? JSON.stringify(gv) === JSON.stringify(wv)
      : typeof wv === "number" && typeof gv === "number"
        ? Math.abs(gv - wv) <= 0.01 // judge tolerance
        : gv === wv;
    if (!same) problems.push(`${key} ${JSON.stringify(gv)} != ${JSON.stringify(wv)}`);
  }
  return problems;
}

const cases: PublicCase[] = (await Bun.file(PACK).json()).cases;
const selected = only ? cases.filter((c) => c.id === only) : cases;
if (selected.length === 0) {
  console.error(`No case matching "${only}". Available: ${cases.map((c) => c.id).join(", ")}`);
  process.exit(1);
}

let notesTotal = 0;
let notesOk = 0;
let casesOk = 0;
const latencies: number[] = [];

// The Gemini free tier allows 15 requests/minute for flash-lite. Ten cases
// back to back can trip it, and a 429 shows up as a false interpretation
// failure. Space them out; override with EVAL_DELAY_MS=0 on a paid tier.
const DELAY_MS = Number(Bun.env.EVAL_DELAY_MS ?? 4500);
let first = true;

for (const c of selected) {
  if (!first && DELAY_MS > 0) await Bun.sleep(DELAY_MS);
  first = false;
  const started = Date.now();
  const raw = await interpret(c.input.operator_notes, c.input.battery);
  const got = guard(raw, c.input.operator_notes.length, c.input.battery);
  latencies.push(Date.now() - started);

  const want = c.expected_output.directive_interpretation;
  let caseOk = true;

  const lines: string[] = [];
  for (let i = 0; i < want.length; i++) {
    notesTotal++;
    const problems = got[i] ? diffEntry(got[i]!, want[i]!) : ["missing entry"];
    if (problems.length === 0) {
      notesOk++;
      lines.push(`    [${i}] ok   ${want[i]!.directive_type}`);
    } else {
      caseOk = false;
      lines.push(`    [${i}] FAIL ${problems.join("; ")}`);
      lines.push(`         note: ${c.input.operator_notes[i]}`);
    }
  }
  if (caseOk) casesOk++;

  const ms = latencies[latencies.length - 1]!;
  console.log(
    `${caseOk ? "PASS" : "FAIL"}  ${c.id}  ${String(ms).padStart(6)}ms  ${c.label}`,
  );
  if (!caseOk || only) console.log(lines.join("\n"));
}

latencies.sort((a, b) => a - b);
const at = (q: number): number =>
  latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;
const median = at(0.5);
const p90 = at(0.9);
const slowest = latencies[latencies.length - 1] ?? 0;

console.log(`\ncases  ${casesOk}/${selected.length}`);
console.log(`notes  ${notesOk}/${notesTotal}`);
console.log(
  `latency  median ${median}ms  p90 ${p90}ms  slowest ${slowest}ms` +
    `  ${median <= 5000 ? "(typical call within the 5s budget)" : "(typical call OVER 5s)"}`,
);
// Over only 10 samples the 95th percentile IS the slowest sample, so quoting it
// as "p95" reads as a far worse number than the judge will measure across a
// large hidden suite. Median and p90 describe the distribution honestly; the
// slowest figure is the timeout ladder's worst case, not a typical response.
if (latencies.length < 20)
  console.log(`         (${latencies.length} samples — too few for a meaningful p95)`);
