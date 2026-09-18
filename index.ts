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

const PORT = Number(Bun.env.PORT ?? 3000);

// Must bind 0.0.0.0, not localhost: the Docker fallback image is scored on
// reaching /health from outside the container.
const HOSTNAME = Bun.env.HOSTNAME ?? "0.0.0.0";

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
            "POST /optimize-energy": "not implemented yet",
          },
        }),
    },

    // Contract: HTTP 200 with status "ok" once the service is ready.
    // Never calls the LLM — it has to answer even when the provider is down.
    "/health": {
      GET: () => Response.json({ status: "ok" }),
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
