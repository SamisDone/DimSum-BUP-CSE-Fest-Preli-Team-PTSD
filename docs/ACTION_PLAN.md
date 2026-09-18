# GridWise LLM Preliminary — Team Build Plan

**BUP CSE Fest 2026 · Online Preliminary · 4-hour window (7:00–11:00 PM) · 4 members**

| Role | Owns | Name |
|---|---|---|
| **A — Service & Deployment** | API transport, schemas, hosting, Docker | _______ |
| **B — Interpretation** | LLM Interpreter + Guardrail Validator | _______ |
| **C — Optimizer** | Math Optimizer + plan construction | _______ |
| **D — Verification & Docs** | Final Validator, test harness, README, video | _______ |

Source of truth: the **Problem Statement** (canonical for behaviour/schemas), the **Participant Guide & Evaluation Rubric** (canonical for deployment/scoring), and `BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json` (10 worked cases). Where the two documents disagree, the Problem Statement wins.

> **On the `.md` vs `.pdf` copies:** verified word-for-word identical in content. The Markdown conversions drop only the section numbers `00 / 03 / 06 / 08` and — the one that matters — the **architecture diagram on page 3**, reproduced in §1 below. Work from the Markdown; nothing else is missing.

---

# PART I — What everyone reads first (10 minutes, together)

## 1. The pipeline

This is the organizer's own architecture diagram (§03 of the Problem Statement). **Our four roles map directly onto its six boxes** — that is why the split works:

```
Energy Data + Operator Notes → LLM Interpreter → Guardrail Validator
    → Math Optimizer → Final Validator → API Response
        [A]                 [B]              [B]
                            [C]              [D]              [A]
```

Use these six stage names verbatim in the README and the video — architecture clarity is exactly what the tie-break reviewers compare.

The judge scores the **whole pipeline**, not the cost number. 50 of 100 points are interpretation (25) + directive application (25). Only 10 points are cost. A cheap plan built on a misread note scores **zero** for that case: directive application, optimization credit, and often validity all collapse together.

**Verified finding:** a plain LP with the constraints in C's brief reproduces the organizer's `total_cost_bdt` **exactly on all 10 public cases** (diff 0.000 on every one). Optimization Quality (10 pts) is effectively free *provided the directives are right*. This is why B's role is weighted as heavily as C's.

## 2. Where the marks are

| # | Category | Pts | Owner |
|---|---|---|---|
| 1 | LLM Directive Interpretation | 25 | **B** |
| 2 | Directive Application & Constraint Correctness | 25 | **C** (built) + **D** (proven) |
| 3 | Optimization Quality | 10 | **C** |
| 4 | API Contract & Schema | 10 | **A** |
| 5 | Performance & Reliability | 10 | **A** + **B** (latency) |
| 6 | Deployment & Docker Fallback | 10 | **A** |
| 7 | Documentation & Local Reproducibility | 10 | **D** |

**20 points (categories 6 & 7) are pure preparation** — Docker image and README — and do not depend on model quality at all. They are the reason D and A exist as dedicated roles rather than afterthoughts.

Video = **0 base points**, tie-break only. D records it, ≤ 3:00, unpolished.

### Zero-cost edge case

`quality_ratio = min(1, organizer_optimal_cost / recalculated_team_cost)`. Both within tolerance of 0 ⇒ `quality_ratio = 1`. The next clause — *"If organizer_optimal_cost is within tolerance of 0 but team cost is above tolerance, quality_ratio…"* — **is cut off mid-sentence in the source PDF itself**, so there is no published value. Assume `0`.

Consequence for **C**: if a hidden scenario has solar plus battery covering all demand, optimal cost is 0 and *any* grid purchase collapses that case to zero with no partial credit. Near-optimal is not good enough. Use the exact LP, never a greedy scheduler.

## 3. Frozen interfaces — agree on these before anyone writes code

**This is the single most important 10 minutes of the night.** Once these signatures are frozen, all four members write against stubs and never block each other.

```ts
// types.ts — owned by A, frozen at T+0:15, changed only by group agreement

export type DirectiveType =
  | "solar_reduction" | "minimum_battery_reserve" | "no_charge_window"
  | "no_discharge_window" | "max_grid_window" | "no_op";

export interface Directive {
  note_index: number;                  // 0-based, ascending, one per note
  applies: boolean;                    // false only for no_op
  directive_type: DirectiveType;
  structured_adjustment: Record<string, unknown> | null;  // null only for no_op
  explanation: string;
}

export interface PlanHour {
  hour: number;
  grid_kwh: number;
  solar_used_kwh: number;
  battery_action: "charge" | "discharge" | "idle";
  battery_kwh: number;
  battery_energy_after_kwh: number;
}
```

```ts
// The four module boundaries. Each is owned by exactly one person.

// B owns both of these:
//   Raw, UNTRUSTED model output. May be malformed. Never called directly by index.ts.
export function interpret(notes: string[], battery: Battery): Promise<unknown[]>;
//   Always returns exactly nNotes valid Directives. Never throws.
export function guard(raw: unknown[], nNotes: number, battery: Battery): Directive[];

// C owns this — returns a valid 24-entry plan, or null if infeasible. Never throws.
export function solve(hours: Hour[], battery: Battery, directives: Directive[]): PlanHour[] | null;

// D owns this — returns violation strings. Empty array === valid.
export function replay(hours: Hour[], battery: Battery,
                       directives: Directive[], plan: PlanHour[]): string[];

// A owns index.ts, which wires exactly this and nothing else:
//   raw = await interpret(...)  ->  dirs = guard(raw, ...)  ->  plan = solve(..., dirs)
//   ->  errs = replay(..., dirs, plan)  ->  response
```

**Rules that make parallel work possible:**

1. **One person per file.** Nobody edits a file they do not own. This eliminates merge conflicts entirely.
2. **A pushes a skeleton with working stubs at T+0:15.** Every function above exists and returns a hard-coded valid value, so the service runs end to end from minute 15.
3. **Everyone works on `main`**, commits small and often, and pulls before every push. With one owner per file this is safe and faster than branches.
4. **`guard()` and `solve()` never raise and never return garbage.** Failure modes are `no_op` and `null` respectively — the service always answers 200 with a valid plan.

### Stack decision (made, don't re-litigate)

**Bun + TypeScript.** `Bun.serve()` with the native `routes` option, `zod` for request validation, `bun test` for the harness, Docker via the official `oven/bun` image. The skeleton is already committed and running (`bun run index.ts` → `/` and `/health`).

> **⚠️ C read this:** the LP was verified against the 10 public cases using SciPy's `linprog(method="highs")`. There is no SciPy here. Use **`highs-js`** — a WASM build of the *same* HiGHS solver — so the verified result carries over exactly. `glpk.js` is the fallback. **Do not use `javascript-lp-solver`**: it is a pure-JS simplex with weaker numerics, and §2's zero-cost edge case gives no partial credit for a near-optimal answer. Prove the solver choice on all 10 public costs before building anything on top of it — that is C's first hour.

### File ownership map

Source lives under `src/`, organized by pipeline stage rather than as flat
files at the repo root — one directory per stage, matching the six-box
architecture in §1:

```
src/index.ts                    A     Bun.serve, routes, wiring, error handlers
src/types.ts                    A     shared types above, frozen
src/schemas.ts                  A     zod request/response schemas
src/interpreter/interpreter.ts  B     prompt, model call, JSON parse, cache, fallback extractor
src/interpreter/guardrails.ts   B     guard() — validate and repair
src/optimizer/optimizer.ts      C     solve() — LP model, netting, rounding
src/optimizer/optimizer.test.ts C     proof suite (not shipped in the Docker image — see .dockerignore)
src/validator/validator.ts      D     replay() — the Final Validator stage
run-public.ts                   D     harness that runs all 10 public cases
README.md                       D
Dockerfile                      A
```

Dev/debug scripts (`eval-notes.ts`, `check-key.ts`, `verify.ts`) stay at the
repo root — they're tooling, not pipeline source, and aren't copied into the
Docker image either way.

---

# PART II — Individual briefs

Each brief is self-contained. Read yours, then start. Do not wait for anyone else.

---

## 👤 A — Service & Deployment

**Mission:** a public URL that is up before anyone else has written real logic, and stays up all night. You own the two boxes at the ends of the diagram.

**Scores:** Category 4 (10), Category 6 (10), and the operational half of Category 5 (10). **30 points, almost all of it independent of the model.**

### Your first 15 minutes (everyone is blocked on you — do this first)

1. Create the GitHub repo **after question reveal**, private. Add the other three as collaborators.
2. Commit `types.ts`, `schemas.ts`, `interpreter.ts`, `guardrails.ts`, `optimizer.ts`, `validator.ts` alongside the existing `index.ts` — every one a **working stub**:
   - `interpret()` returns `[]`
   - `guard()` returns one `no_op` per note
   - `solve()` returns a trivially valid plan: solar first, battery idle all 24 hours, grid covers the rest (always feasible, always neutral)
   - `replay()` returns `[]`
3. Push. Tell the others: *"skeleton is up, stubs work, go."*
4. Deploy that skeleton to a public URL immediately.

**A live URL in the first 20 minutes is the single highest-value thing anyone does tonight.** A late deploy failure is the most common way to lose 10–20 points.

### Then, in order

- **`GET /health`** → `200 {"status": "ok"}`. Must be ready within 60s of start. **Must not call the LLM** — it has to answer while the model is down.
- **Request validation.** `scenario_id` string; `operator_notes` 1–3 non-empty strings; `hours` exactly 24 entries with `hour`/`demand_kwh`/`solar_kwh`/`tariff_bdt_per_kwh`; `battery` with all five fields. Malformed JSON or structurally invalid ⇒ `400`. Well-formed but semantically invalid ⇒ `422` (optional). Controlled internal error ⇒ `500` with **no stack trace and no secret**.
- **Response assembly.** All seven top-level fields, every time:

```json
{
  "scenario_id": "<echo the request value exactly>",
  "directive_interpretation": [ { "note_index": 0, "applies": true,
      "directive_type": "solar_reduction",
      "structured_adjustment": {"hours": [13,14], "factor": 0.2},
      "explanation": "..." } ],
  "hourly_plan": [ { "hour": 0, "grid_kwh": 0, "solar_used_kwh": 0,
      "battery_action": "idle", "battery_kwh": 0,
      "battery_energy_after_kwh": 200 } ],
  "total_grid_kwh": 0, "total_cost_bdt": 0, "peak_grid_kwh": 0,
  "plan_summary": "..."
}
```

- **The wiring, exactly as frozen in §3.** If `solve()` returns `null` or `replay()` returns violations, fall back to the baseline plan and still return **200**. Never 500 on a valid request.
- **Global exception handler** so nothing escapes as a stack trace.
- **Dockerfile.** Bind `0.0.0.0`, expose the documented port, **no baked-in secrets** (env vars only). Push to Docker Hub or GHCR with an **exact tag or digest**.
- **Verify the image from a machine that never built it:** `docker pull <exact tag>` → `docker run` → `/health` responds. This is worth 4 points on its own and is only provable by actually doing it.

### Done when

- [ ] Public URL, no auth, `/health` returns `{"status":"ok"}` from outside your network
- [ ] `POST /optimize-energy` accepts the exact schema and returns all seven fields
- [ ] Malformed JSON → 400; missing `hours` entry → 400; no stack traces anywhere
- [ ] `docker pull` on a clean machine → `/health` ok
- [ ] `git log` contains no `.env`, key, or token — check history, not just the working tree

### If you finish early

Take over latency work with B: response caching, connection pooling, warm start. Then help D verify the README on a genuinely clean machine.

---

## 👤 B — Interpretation (LLM + Guardrails)

**Mission:** turn 1–3 natural-language notes into exactly N validated directives. You own the two boxes the whole challenge is named after.

**Scores:** Category 1 (25) outright, plus the latency half of Category 5. **The largest single block of points.**

### Your two layers — keep them strictly separate

`interpret()` is allowed to be wrong. `guard()` is not allowed to pass anything wrong through. Never merge them.

### Layer 1 — `interpret()`

- **One call for all notes**, returning a JSON array indexed by note. Faster and cheaper than N calls, and keeps ordering trivially correct.
- Force JSON: structured output / JSON mode / `response_format`. **Temperature 0.**
- **Put the battery block and the hour indices in the prompt.** SAMPLE-03 says *"at least 50% of the battery capacity"* and the ground truth is `100` kWh — because capacity is 200. Without capacity in context, percentage reserves are unanswerable.
- Spell out the two normalisation traps in the system prompt, with examples:
  - **Windows are start-inclusive, end-exclusive.** "1 PM to 3 PM" → `[13,14]`. "from 6 PM until 10 PM" → `[18,19,20,21]`. "between 11 AM and 2 PM" → `[11,12,13]`.
  - **`factor` is the fraction that REMAINS.** "drop to 20%" → `0.2`. "an 80% reduction" → `0.2`. "roughly half" → `0.5`. "one-fifth of normal" → `0.2`.
- 4–6 few-shot examples covering all five directive types **plus a distractor → `no_op`**. **Paraphrase them yourself — do not copy public wording verbatim** (see §5 trap 6).
- State explicitly: *never invent demand, solar, tariff or battery limits; if the note does not change the 24-hour energy schedule, emit `no_op`.*

**Latency — 3 of the 10 reliability points.** p95 ≤ 5s = 3/3; >5–15s = 2/3; >15–30s = 1/3; >30s = failure. One fast model call (Haiku-class) plus C's LP (~1.5 ms) sits comfortably under 5s. Hard client timeout ~8s. **Cache by hash of `operator_notes`** — hidden suites repeat paraphrases.

**Fallback, which does not replace the LLM:** on timeout, provider error, or unparseable output — retry once, then fall back to a deterministic regex/keyword extractor and still return a valid result. The LLM stays the **primary** path. Hard-coded matching as the *sole* interpreter is explicitly non-compliant and risks disqualification.

### Layer 2 — `guard()`

Runs on every model output. Reject-and-repair, never trust:

- [ ] Exactly one entry per note; `note_index` = 0..N−1, ascending, no gaps, no duplicates
- [ ] `directive_type` ∈ the six allowed values — anything else ⇒ coerce to `no_op`
- [ ] `no_op` ⇒ `applies = false` **and** `structured_adjustment = null`
- [ ] Every other type ⇒ `applies = true` **and** the adjustment matches the exact required shape
- [ ] `hours`: unique ints 0–23, **sorted ascending**, non-empty (dedupe and sort defensively)
- [ ] `solar_reduction.factor` finite, `0 ≤ f ≤ 1`
- [ ] `minimum_energy_kwh` finite, `0 ≤ r ≤ capacity_kwh`
- [ ] `max_grid_kwh` finite, `≥ 0`
- [ ] No mutation of demand / solar / tariff / battery parameters
- [ ] Do **not** merge entries. One entry per note is the contract — merging two notes that share a directive type breaks `note_index` ordering. Combining overlapping constraints (max of two reserves, min of two grid caps) is the optimizer's job when it builds its model, not the guardrail's

Anything unrepairable → downgrade **that entry** to `no_op` rather than crashing. **Return the repaired entries to A**, so the interpretation in the response is exactly what C optimized against.

### Done when

- [ ] All 10 public cases: your directives match `expected_output.directive_interpretation` (ignore `explanation` wording) — run D's harness
- [ ] Feed `guard()` deliberate garbage: wrong type, unsorted hours, `factor: 1.4`, missing index, duplicate index, `null` adjustment on a real directive, reserve above capacity. It never raises and always returns N valid entries
- [ ] Unset the API key → the service still answers 200 with a valid plan
- [ ] p95 over 20 consecutive calls ≤ 5s

### If you finish early

Write extra paraphrases of all five directive types and test them — paraphrase robustness is 5 of your 25 points and is measured on wordings you have never seen. Try: 24-hour clock, "midnight to 3", "for three hours starting at 6 PM", fractions, "a third of normal output", "no more than 150 units from the grid".

---

## 👤 C — Optimizer

**Mission:** given validated directives, produce the cheapest valid 24-hour plan. Your work is fully deterministic and fully testable without the LLM — you are the least blocked person on the team.

**Scores:** Category 3 (10) and the construction half of Category 2 (25).

### Directives → math

| Type | `structured_adjustment` | Effect |
|---|---|---|
| `solar_reduction` | `{"hours":[...], "factor": f}` | `eff_solar[h] = solar[h] * f` |
| `minimum_battery_reserve` | `{"hours":[...], "minimum_energy_kwh": r}` | `E_after[h] ≥ max(base_min, r)` |
| `no_charge_window` | `{"hours":[...]}` | `charge[h] = 0` |
| `no_discharge_window` | `{"hours":[...]}` | `discharge[h] = 0` |
| `max_grid_window` | `{"hours":[...], "max_grid_kwh": m}` | `grid[h] ≤ m` |
| `no_op` | `null` | nothing |

### The LP — verified to reproduce all 10 public optima exactly

Variables per hour `h ∈ 0..23`, all continuous and ≥ 0: `g[h]` grid, `s[h]` solar used, `c[h]` charge, `d[h]` discharge.

```
minimize   Σ tariff[h] · g[h]

s.t.  g[h] + s[h] + d[h] − c[h] = demand[h]          (energy balance, every h)
      0 ≤ s[h] ≤ eff_solar[h]                        (curtailment allowed)
      0 ≤ c[h] ≤ max_charge    (= 0 in no_charge hours)
      0 ≤ d[h] ≤ max_discharge (= 0 in no_discharge hours)
      0 ≤ g[h] ≤ max_grid_kwh  (only where capped)
      E[h] = E0 + Σ_{k≤h} (c[k] − d[k])
      reserve[h] ≤ E[h] ≤ capacity   (reserve[h] = max(base_min, directive))
      E[23] = E0                     (end-of-day neutrality)
```

Solve it with **`highs-js`** (`bun add highs-js`) — the WASM build of HiGHS, the same solver that produced the verified reference costs. Sub-millisecond. See the warning in §3 before picking anything else.

### The three details that break plans

1. **Net the battery.** The LP can return tiny simultaneous `c[h]` and `d[h]`. Compute `net = c[h] − d[h]`; `net > tol` ⇒ `charge`, `net < −tol` ⇒ `discharge`, else `idle` with `battery_kwh = 0`. Then **re-derive every `E[h]` from the netted actions** so `battery_energy_after_kwh` is internally consistent.
2. **Round, then total.** Round hourly values to 4 dp, then compute `total_grid_kwh`, `total_cost_bdt`, `peak_grid_kwh` **from the rounded plan**. The judge recomputes totals from `hourly_plan` and compares within 0.01. Clamp `−1e-9`-style negatives to exactly `0`.
3. **Infeasibility means misinterpretation, not impossibility.** Organizer scoring scenarios are guaranteed feasible, so an infeasible LP means B misread a note. Relax in this order and re-solve: (1) drop `max_grid_window` caps, (2) drop `minimum_battery_reserve` raises, (3) drop charge/discharge windows, (4) baseline plan — solar first, battery idle all day, grid covers the rest. Always hand A a valid plan. **Never return `null` to the caller without A having a baseline to fall back on.**

### Your first hour — you can go end to end without B

D's harness feeds you `expected_output.directive_interpretation` straight from the public JSON. You do not need the LLM at all to finish and prove your entire module.

### Done when

- [ ] SAMPLE-01 with hard-coded directives → cost exactly `38365`
- [ ] All 10 public cases, fed the expected directives → all 10 costs match the reference within 0.01
- [ ] All 10 plans pass D's `replay()` with zero violations
- [ ] `E_after[23] == initial_energy_kwh` on every case
- [ ] Deliberately over-constrained input (e.g. grid cap of 0 all day) → returns a plan or `null`, never throws

### If you finish early

Build the degenerate cases the public pack does not cover and check them: solar covering 100% of demand (the zero-cost trap in §2), a `max_grid_window` of 0, a reserve equal to capacity, a `factor` of exactly 0, all 24 hours in a no-discharge window, `initial_energy == minimum_energy`.

---

## 👤 D — Verification & Documentation

**Mission:** be the judge before the judge is. You own the Final Validator box and the 10 documentation points, and you are the only person whose job is to try to break the other three.

**Scores:** Category 7 (10) outright, and you are how Category 2 (25) is actually proven.

### Build first: `run-public.ts` (the team's shared instrument)

Everyone else is blocked on measurement. **Have this running by T+0:45.** It should:

1. Load all 10 cases from the public JSON
2. POST each `case.input` to a target URL (default localhost, switchable to the deployed URL with one flag)
3. Compare `directive_interpretation` against `expected_output.directive_interpretation`, **ignoring `explanation` wording**
4. Run `replay()` on the returned plan
5. Compare `total_cost_bdt` to the reference
6. Print one line per case and a `PASS n/10` summary for each of the three checks

Add a `--directives-from-expected` flag that bypasses the LLM and feeds C the ground-truth directives. **That flag is what unblocks C in hour one.**

### Then: `replay()` — the Final Validator

Re-run the judge's own checks on our own output:

- 24 unique hours 0–23 in `hourly_plan`
- every hour: `grid + solar_used + discharge == demand + charge` (tol 0.01)
- `0 ≤ solar_used ≤ eff_solar[h]`
- `battery_kwh ≥ 0`, `== 0` when `idle`, ≤ the rate limit for the action
- `E_after` consistent hour to hour; `reserve[h] ≤ E_after[h] ≤ capacity`
- charge = 0 in no-charge hours; discharge = 0 in no-discharge hours; `grid ≤ cap` in capped hours
- `E_after[23] == initial_energy_kwh` (tol 0.01)
- reported totals == totals recomputed from `hourly_plan` (tol 0.01)
- all values finite and non-negative

Write it from the Problem Statement §11 text directly — **do not read C's optimizer while writing it.** An independent implementation is what makes it a real check.

### Then: fault injection (worth 2 points, and it protects all the others)

Fire these at the deployed service and confirm a controlled response every time:

| Input | Expected |
|---|---|
| Malformed JSON body | 400, no stack trace |
| `hours` with 23 entries | 400 |
| `operator_notes: []` or `[""]` | 400 |
| 4 operator notes | 400 or handled cleanly |
| API key unset / provider down | **200 with a valid plan** |
| 20 rapid sequential requests | all 200, p95 ≤ 5s |
| grep responses and logs for the key | never appears |

### Then: README (10 points — write it deliberately, not at 10:50 PM)

1. One-paragraph architecture using the organizer's six stage names: Energy Data + Operator Notes → LLM Interpreter → Guardrail Validator → Math Optimizer → Final Validator → API Response
2. Exact run command from a clean clone: install → env vars → start
3. **Environment variable names only — never values**
4. Model/provider identifier and the LLM's precise role in the interpretation path
5. The guardrail list, and what happens when model output is invalid
6. Optimizer/solver used and the formulation
7. `curl` for `/health` and `curl` for `/optimize-energy` with a real sample request and expected response
8. The command to run the public sample pack, and the expected result
9. `docker pull` + `docker run` fallback, and the exposed port
10. Dependencies with credits, known limitations, secret-handling note

**Then hand your laptop to A and have them follow the README literally, from a fresh clone, asking you nothing.** Every question they have to ask is a point lost. This is the actual test for 3 of your 10 points.

### Last: the video (≤ 3:00, tie-break only, 0 base points)

Problem → the six-stage architecture → how the LLM feeds guardrails feeds the optimizer → a live run of `/health` and one public case. Screen recording is fine. **Do not spend more than 20 minutes on it.**

### Done when

- [ ] `run-public.ts` reports 10/10 interpretation, 10/10 valid, 10/10 cost — **against the deployed URL, not localhost**
- [ ] Every fault-injection row behaves
- [ ] A followed the README on a clean machine and asked zero questions
- [ ] Video is uploaded, accessible, and ≤ 3:00

---

# PART III — Timeline & sync points

Four swimlanes. The only hard dependency is A's skeleton at T+0:15.

| Time | A — Service | B — Interpretation | C — Optimizer | D — Verification |
|---|---|---|---|---|
| **0:00–0:15** | **ALL FOUR TOGETHER: freeze §3 interfaces** | | | |
| 0:15–0:45 | Repo + stubs pushed, deploy pipeline live | Prompt v1, provider wired | LP model from C's brief | `run-public.ts` skeleton |
| 0:45–1:00 | `/health` public, schemas + 400s | JSON parse + retry | SAMPLE-01 == 38365 | Harness + `--directives-from-expected` |
| **1:00** | **SYNC 1** — public URL up · C hits 38365 · harness runs | | | |
| 1:00–2:00 | Response assembly, wiring, Dockerfile | `guard()` + all 6 types | All 10 costs match | `replay()` written independently |
| **2:00** | **SYNC 2** — first real end-to-end on the deployed URL | | | |
| 2:00–2:50 | Error handlers, no-secret audit | Paraphrase hardening, cache | Degenerate cases, netting/rounding | Fault injection, README draft |
| **2:50** | **FEATURE FREEZE** — deploy final, publish image with exact tag | | | |
| 2:50–3:20 | Docker verified pull-and-run on a clean machine | Latency tuning only | Support C↔D on failures | Full run against deployed URL |
| 3:20–3:45 | Repo hygiene, collaborators, visibility | Help D | Help D | README walkthrough with A, record video |
| **3:45–4:00** | **ALL FOUR: submit 5 items, re-verify public URL live** | | | |

### The three sync points — 5 minutes each, standing up

- **SYNC 1 (T+1:00)** — *Is the skeleton real?* Public URL answers `/health`. C hits 38365. D's harness runs. If the URL is not up, **everyone stops and fixes deployment.**
- **SYNC 2 (T+2:00)** — *Does it work end to end?* One public case through the deployed URL, LLM included. From here on, every change is verified against the deployed URL, never localhost.
- **FEATURE FREEZE (T+2:50)** — no new features. Only deployment, Docker, docs, video, and fixing things D's harness reports as broken.

### If you are blocked

Nobody waits. Each brief has an **"If you finish early"** section — do that instead. If you are blocked for more than 10 minutes on someone else's module, say so out loud immediately; a stub is always available.

---

# PART IV — Shared reference

## 4. Deliverables checklist (all five, due by 11:00 PM)

- [ ] **A** — Public HTTPS base URL, no auth, `GET /health` + `POST /optimize-energy`
- [ ] **A** — GitHub repo created **after question reveal**, private during the event, public after the deadline
- [ ] **D** — Self-contained `README.md`
- [ ] **A** — Pullable Docker image with an **exact tag or digest**, binds `0.0.0.0`, no baked-in secrets
- [ ] **D** — ≤ 3-minute architecture video, judge-accessible link
- [ ] **All** — No keys, tokens, or `.env` anywhere in the repo **history**

## 5. Traps that cost points

Everyone should be able to recite these. The owner listed is who it bites first.

1. **End-exclusive hours.** "6 PM until 9 PM" is `[18,19,20]` — not `[18,19,20,21]`. Every public case confirms this. *(B)*
2. **`factor` is what remains,** not what is lost. "80% reduction" ⇒ `0.2`. *(B)*
3. **Percentage reserves need capacity in the prompt.** "50% of capacity" with a 200 kWh battery ⇒ `100`. *(B)*
4. **`applies` semantics are rigid.** `no_op` is the *only* type allowed `applies = false`. *(B)*
5. **Distractors are deliberate.** Cafeteria menus, library hours, seminar bookings → `no_op`. Marking one as a directive loses relevance marks *and* corrupts the schedule. *(B)*
6. **Never hard-code public wording, case IDs, or reference schedules.** Hidden notes are paraphrases; phrase-matching as the sole interpreter is a disqualifying violation. *(B)*
7. **End-of-day neutrality is a hard constraint.** Forgetting `E[23] = E0` invalidates every case — 25 + 10 points gone. *(C)*
8. **Totals are recomputed from `hourly_plan`.** Derive them from the final rounded plan, never from LP internals. *(C)*
9. **`battery_kwh` must be 0 when `idle`,** and the action must match the sign of the net flow. *(C)*
10. **The service must survive the entire evaluation window** under repeated LLM-backed calls — watch provider quota and rate limits. *(A)*

## 6. Definition of done — run this together before submitting

Against the **deployed public URL**, not localhost:

- [ ] 10/10 directive interpretations match the expected set (ignoring `explanation` wording)
- [ ] 10/10 plans pass `replay()` with zero violations
- [ ] 10/10 `total_cost_bdt` within 0.01 of the reference — `quality_ratio = 1.0` across the board
- [ ] Malformed JSON → 400; LLM key removed → still 200 with a valid plan
- [ ] p95 over 20 consecutive calls ≤ 5s
- [ ] `docker pull <exact tag>` on a machine that never built it → `/health` ok
- [ ] README followed literally on a clean machine by someone who did not write it
- [ ] All five submission items sent, and the public URL re-verified after submitting
