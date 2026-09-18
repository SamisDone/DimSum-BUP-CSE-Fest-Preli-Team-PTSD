/**
 * GridWise Operator Console — static server + API proxy.
 *
 *   bun run frontend.ts
 *   FRONTEND_PORT=3500 API_BASE=http://localhost:3000 bun run frontend.ts
 *
 * Deliberately a SEPARATE process from the judged service. The Participant
 * Guide requires that the judging endpoint sit behind no dashboard, login or
 * manual step, so nothing here is wired into index.ts and the scored API keeps
 * zero UI surface.
 *
 * The browser talks only to this server, which forwards /api/* to the real
 * service. That keeps the page same-origin, so the API needs no CORS headers
 * and index.ts stays untouched.
 *
 * Routes
 *   GET  /                    the console
 *   GET  /api/config          the API base this server proxies to
 *   GET  /api/samples         the 10 public sample cases
 *   GET  /api/health          proxied -> <API_BASE>/health
 *   POST /api/optimize-energy proxied -> <API_BASE>/optimize-energy
 *   POST /api/proxy           same, but against a base URL chosen in the UI
 */

const PORT = Number(Bun.env.FRONTEND_PORT ?? 3500);
const HOSTNAME = Bun.env.FRONTEND_HOSTNAME ?? "0.0.0.0";
const DEFAULT_API_BASE = Bun.env.API_BASE ?? "http://localhost:3000";

const SAMPLES_PATH = "data/BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json";
const PAGE_PATH = "public/index.html";

/** Strip a trailing slash so base + path never doubles up. */
function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/** Forward a request to the target service, preserving status and body. */
async function forward(
  base: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const target = `${normalizeBase(base)}${path}`;
  const started = performance.now();

  try {
    const upstream = await fetch(target, {
      ...init,
      signal: AbortSignal.timeout(60_000),
    });
    const body = await upstream.text();
    const elapsed = Math.round(performance.now() - started);

    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
        // Lets the page show server-side latency without trusting the clock
        // of a browser that may have been throttled in a background tab.
        "X-Upstream-Ms": String(elapsed),
        "X-Upstream-Url": target,
      },
    });
  } catch (err) {
    // A dead or unreachable API is an expected condition here, not a crash:
    // report it as JSON the page can render.
    return Response.json(
      {
        error: "upstream_unreachable",
        message: err instanceof Error ? err.message : String(err),
        target,
      },
      { status: 502, headers: { "X-Upstream-Ms": String(Math.round(performance.now() - started)) } },
    );
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  idleTimeout: 120,

  routes: {
    "/": {
      GET: async () => {
        const page = Bun.file(PAGE_PATH);
        if (!(await page.exists())) {
          return new Response(
            `Console page not found at ${PAGE_PATH}. Run this from the repository root.`,
            { status: 500, headers: { "Content-Type": "text/plain" } },
          );
        }
        return new Response(page, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
          },
        });
      },
    },

    "/api/config": {
      GET: () => Response.json({ api_base: normalizeBase(DEFAULT_API_BASE) }),
    },

    "/api/samples": {
      GET: async () => {
        const file = Bun.file(SAMPLES_PATH);
        if (!(await file.exists())) {
          return Response.json(
            { error: "samples_missing", message: `Not found: ${SAMPLES_PATH}` },
            { status: 404 },
          );
        }
        return new Response(file, {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      },
    },

    "/api/health": {
      GET: (req) => {
        const base = new URL(req.url).searchParams.get("base") ?? DEFAULT_API_BASE;
        return forward(base, "/health", { method: "GET" });
      },
    },

    "/api/optimize-energy": {
      POST: async (req) => {
        const base = new URL(req.url).searchParams.get("base") ?? DEFAULT_API_BASE;
        // Pass the body through verbatim, including deliberately malformed
        // JSON: fault injection from the UI must reach the real service
        // unchanged so the 400 comes from the service, not from this proxy.
        const body = await req.text();
        return forward(base, "/optimize-energy", {
          method: "POST",
          headers: { "Content-Type": req.headers.get("Content-Type") ?? "application/json" },
          body,
        });
      },
    },
  },

  fetch(req) {
    const { pathname } = new URL(req.url);
    return Response.json(
      { error: "not_found", message: `No route for ${req.method} ${pathname}` },
      { status: 404 },
    );
  },

  error(err) {
    console.error("console error:", err?.message ?? err);
    return Response.json(
      { error: "internal_error", message: "An internal error occurred." },
      { status: 500 },
    );
  },
});

console.log(`GridWise console on http://localhost:${server.port}`);
console.log(`  proxying /api/* -> ${normalizeBase(DEFAULT_API_BASE)}`);
