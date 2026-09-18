# GridWise — Smart Campus Energy Optimization

LLM-assisted operator directive interpretation and 24-hour energy scheduling.
**BUP CSE Fest 2026 · Hackathon · Online Preliminary.**

> **Status: skeleton.** `/` and `/health` are live. `POST /optimize-energy` is not implemented yet.
> Build plan and the four-way work split live in [ACTION_PLAN.md](ACTION_PLAN.md).

## Quickstart

```bash
bun install
bun run start          # or: bun run dev   (watch mode)
```

The service listens on `0.0.0.0:3000`. Override with `PORT`.

## Endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/` | Service description and endpoint list |
| `GET` | `/health` | `{"status":"ok"}` — readiness probe for the judge harness |
| `POST` | `/optimize-energy` | *Not implemented yet* |

```bash
curl http://localhost:3000/
curl http://localhost:3000/health
# {"status":"ok"}
```

Unmatched routes return JSON `404`; unhandled errors return a controlled JSON `500`
with no stack trace and no secrets.

## Architecture

The target pipeline, using the organizer's own stage names (Problem Statement §03):

```
Energy Data + Operator Notes → LLM Interpreter → Guardrail Validator
    → Math Optimizer → Final Validator → API Response
```

## Layout

| File | Purpose |
|---|---|
| `index.ts` | `Bun.serve()` — routes, wiring, error handlers |
| `ACTION_PLAN.md` | Build plan, role split, frozen interfaces, timeline |
| `BUP_CSE_FEST_2026_*.md` / `.pdf` | Official problem statement and participant guide |
| `BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json` | 10 worked public cases |

## Stack

Bun 1.3 · TypeScript. Built with `bun init`.
