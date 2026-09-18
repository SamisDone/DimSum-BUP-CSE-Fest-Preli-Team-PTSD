# GridWise Energy Optimizer

LLM-assisted campus energy optimization API for the BUP CSE Fest 2026 preliminary challenge.

## 1. Architecture

The pipeline processes operator notes and grid data into an optimal schedule using a strict six-stage architecture:

Energy Data + Operator Notes
→ LLM Interpreter
→ Guardrail Validator
→ Math Optimizer
→ Final Validator
→ API Response

## 2. Quickstart from clean clone

```bash
git clone <repository-url>
cd BUP-CSE-Fest-Preli-1
bun install
cp .env.example .env
# Edit .env to add your GEMINI_API_KEY
bun run start
```

## 3. Environment variables

- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `PORT`
- `LLM_TIMEOUT_MS`
- `LLM_RETRY_TIMEOUT_MS`
- `LLM_RETRY_DELAY_MS`

Please refer to `.env.example` for defaults. Never commit secret values.

## 4. Model and LLM role

The project uses `gemini-3.1-flash-lite` via the Vercel AI SDK (`ai` and `@ai-sdk/google`). 
The LLM serves as an intelligent interpreter, transforming human-written operator notes into a structured `directive_interpretation`. This structured array strictly governs the constraints passed to the Math Optimizer.

## 5. Guardrails

To ensure safe and deterministic behavior, the Guardrail Validator protects the pipeline:
- **Validation**: Strict schema checking is applied to the LLM's output.
- **Invalid Output Handling**: The model is retried if it fails to produce valid JSON. If it repeatedly fails, a deterministic fallback extractor isolates the safe pieces.
- **Unrepairable Entries**: Unrepairable notes are gracefully degraded to a `no_op` rather than being dropped. 
- **Array Integrity**: The directive count always remains equal to the input note count.
- The LLM remains the primary intelligence engine; guardrails ensure its output is always safely constrained.

## 6. Optimizer

The Math Optimizer produces the cheapest valid 24-hour plan using the industrial-grade **HiGHS** C++ solver (via the WebAssembly `highs` package). 
- **LP Formulation**: It constructs a rigorous Linear Program in CPLEX format.
- **Objective**: Minimize total cost (grid power × hourly tariff).
- **Variables**: `grid`, `solar`, `charge`, and `discharge` for each of the 24 hours.
- **Constraints**: Enforces strict hourly energy balance, bounded state transitions (including maximum charge/discharge rates), and respects all validated directives (windows, caps, reductions).
- **End-of-day Neutrality**: Mathematically forces the battery energy at hour 23 to exactly match the initial energy.

## 7. API endpoints

### GET /health
```bash
curl http://localhost:3000/health
```
Response:
```json
{"status":"ok"}
```

### POST /optimize-energy
```bash
curl -X POST http://localhost:3000/optimize-energy \
  -H "Content-Type: application/json" \
  -d '{
    "scenario_id": "test",
    "operator_notes": ["Never charge at hour 2"],
    "battery": {
      "capacity_kwh": 100,
      "initial_energy_kwh": 50,
      "max_charge_kwh_per_hour": 50,
      "max_discharge_kwh_per_hour": 50,
      "minimum_energy_kwh": 10
    },
    "hours": []
  }'
```

## 8. Running public pack

You can verify the API against the official public dataset using the test harness:

```bash
bun run public
```

Expected output includes:
```
interpretation 10/10
validity 10/10
cost 10/10
```

## 9. Docker

*(Docker tag to be provided by Role A)*

## 10. Dependencies / credits / limitations / secret handling

- **Dependencies**: Bun, Vercel AI SDK, HiGHS, Zod.
- **Limitations**: Provider load and network conditions can significantly affect p90 and p95 latency measurements since the LLM inference step is heavily network-bound.
- **Secret Handling**: Secrets are strictly read from the environment and never printed, logged, or included in any API response. 
