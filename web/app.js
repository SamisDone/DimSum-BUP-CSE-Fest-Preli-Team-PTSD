/**
 * DimSum — operator-facing console for the GridWise pipeline.
 *
 * Every number rendered here comes from a live call to this same origin:
 *   GET  /health            service readiness
 *   POST /optimize-energy   the real pipeline — LLM, guardrails, LP, response
 *
 * samples.json holds only the INPUTS of the 10 published scenarios plus the
 * organizer's reference costs, so a reviewer can pick a scenario and compare.
 * No plan, directive or total on this page is ever invented, cached or mocked:
 * if the service is down, the page says so rather than showing stale numbers.
 */

import { energyChart, batteryChart, tariffChart } from "./charts.js";

const $ = (sel) => document.querySelector(sel);
const fmt = (n, d = 2) =>
  Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

const STAGES = [
  "Energy Data + Operator Notes",
  "LLM Interpreter",
  "Guardrail Validator",
  "Math Optimizer",
  "Final Validator",
  "API Response",
];

const state = {
  samples: [],
  current: null, // the selected sample
  notes: [], // editable copies of its operator notes
  response: null,
};

/* ---- theme -------------------------------------------------------------- */

const savedTheme = (() => {
  try {
    return localStorage.getItem("dimsum-theme");
  } catch {
    return null;
  }
})();
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

$("#theme").addEventListener("click", () => {
  const dark =
    document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("dimsum-theme", next);
  } catch {
    /* private mode — the toggle still works for this session */
  }
  if (state.response) draw();
});

/* ---- pipeline ----------------------------------------------------------- */

function buildPipeline() {
  const host = $("#pipeline");
  host.textContent = "";
  STAGES.forEach((name, i) => {
    const d = document.createElement("div");
    d.className = "stage";
    d.dataset.state = "idle";
    d.dataset.stage = String(i);
    d.innerHTML =
      `<span class="stage-n">${String(i + 1).padStart(2, "0")}</span>` +
      `<span class="stage-name"></span><span class="stage-out">—</span>`;
    d.querySelector(".stage-name").textContent = name;
    host.append(d);
  });
}

function stage(i, stateName, out) {
  const node = document.querySelector(`.stage[data-stage="${i}"]`);
  if (!node) return;
  node.dataset.state = stateName;
  if (out !== undefined) node.querySelector(".stage-out").textContent = out;
}

function resetPipeline() {
  for (let i = 0; i < STAGES.length; i++) stage(i, "idle", "—");
}

/* ---- health ------------------------------------------------------------- */

async function checkHealth() {
  const badge = $("#health");
  const label = $("#health-label");
  badge.dataset.state = "wait";
  label.textContent = "checking";

  const t0 = performance.now();
  try {
    const res = await fetch("/health", { cache: "no-store" });
    const ms = Math.round(performance.now() - t0);
    const body = await res.json();
    if (res.ok && body.status === "ok") {
      badge.dataset.state = "ok";
      label.textContent = `service ok · ${ms} ms`;
    } else {
      badge.dataset.state = "down";
      label.textContent = `unexpected ${res.status}`;
    }
  } catch {
    badge.dataset.state = "down";
    label.textContent = "unreachable";
  }
}

/* ---- scenario inputs ---------------------------------------------------- */

function renderNotes() {
  const host = $("#notes");
  host.textContent = "";
  state.notes.forEach((text, i) => {
    const row = document.createElement("div");
    row.className = "note-row";

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = `[${i}]`;

    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.value = text;
    ta.setAttribute("aria-label", `Operator note ${i}`);
    ta.addEventListener("input", () => {
      state.notes[i] = ta.value;
    });

    const del = document.createElement("button");
    del.className = "mini";
    del.type = "button";
    del.textContent = "remove";
    del.disabled = state.notes.length <= 1;
    del.addEventListener("click", () => {
      state.notes.splice(i, 1);
      renderNotes();
    });

    row.append(idx, ta, del);
    host.append(row);
  });
  $("#add-note").disabled = state.notes.length >= 3;
}

function selectSample(id) {
  const s = state.samples.find((c) => c.id === id);
  if (!s) return;
  state.current = s;
  state.notes = [...s.input.operator_notes];
  renderNotes();
  $("#scenario-meta").textContent =
    `${s.input.hours.length} hours · battery ${s.input.battery.capacity_kwh} kWh ` +
    `· starts at ${s.input.battery.initial_energy_kwh} kWh · base reserve ${s.input.battery.minimum_energy_kwh} kWh`;
}

/* ---- directives → readable ---------------------------------------------- */

function hoursPhrase(hours) {
  if (!Array.isArray(hours) || !hours.length) return "";
  const runs = [];
  let start = hours[0];
  let prev = hours[0];
  for (const h of hours.slice(1)) {
    if (h === prev + 1) {
      prev = h;
      continue;
    }
    runs.push([start, prev]);
    start = prev = h;
  }
  runs.push([start, prev]);
  const pad = (n) => `${String(n).padStart(2, "0")}:00`;
  return runs.map(([a, b]) => `${pad(a)}–${pad(b + 1)}`).join(", ");
}

function plainEnglish(d) {
  const a = d.structured_adjustment;
  if (!a) return "Does not affect today's energy schedule.";
  const when = hoursPhrase(a.hours);
  switch (d.directive_type) {
    case "solar_reduction":
      return `${when} — usable solar reduced to ${Math.round(Number(a.factor) * 100)}% of forecast`;
    case "minimum_battery_reserve":
      return `${when} — battery must stay at or above ${fmt(a.minimum_energy_kwh, 0)} kWh`;
    case "no_charge_window":
      return `${when} — battery charging unavailable`;
    case "no_discharge_window":
      return `${when} — battery discharging unavailable`;
    case "max_grid_window":
      return `${when} — grid import capped at ${fmt(a.max_grid_kwh, 0)} kWh per hour`;
    default:
      return when;
  }
}

/** Hours touched by any applied directive — used to tint the charts and table. */
function affectedHours(directives) {
  const set = new Set();
  for (const d of directives) {
    const h = d.structured_adjustment?.hours;
    if (Array.isArray(h)) for (const x of h) set.add(x);
  }
  return [...set].sort((a, b) => a - b);
}

/** Per-hour reserve floor implied by the returned directives. */
function reserveByHour(battery, directives) {
  const out = Array.from({ length: 24 }, () => battery.minimum_energy_kwh);
  for (const d of directives) {
    if (d.directive_type !== "minimum_battery_reserve") continue;
    const a = d.structured_adjustment;
    if (!a || !Array.isArray(a.hours)) continue;
    for (const h of a.hours) {
      if (h >= 0 && h < 24) out[h] = Math.max(out[h], Number(a.minimum_energy_kwh) || 0);
    }
  }
  return out;
}

/* ---- rendering ---------------------------------------------------------- */

function renderDirectives(directives, notes) {
  const host = $("#directives");
  host.textContent = "";
  directives.forEach((d, i) => {
    const card = document.createElement("div");
    card.className = "directive";

    const left = document.createElement("div");
    left.className = "directive-note";
    const qi = document.createElement("span");
    qi.className = "qi";
    qi.textContent = `Operator note [${i}]`;
    left.append(qi, document.createTextNode(notes[i] ?? ""));

    const right = document.createElement("div");
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.dataset.applies = String(d.applies);
    tag.textContent = d.applies ? d.directive_type : "no_op · distractor";
    const plain = document.createElement("div");
    plain.className = "plain";
    plain.textContent = plainEnglish(d);
    const expl = document.createElement("div");
    expl.className = "expl";
    expl.textContent = d.explanation ?? "";
    const adj = document.createElement("div");
    adj.className = "adj mono";
    adj.textContent = JSON.stringify(d.structured_adjustment);

    right.append(tag, plain, expl, adj);
    card.append(left, right);
    host.append(card);
  });
}

function renderStats(r) {
  const ref = state.current?.reference;
  const sameScenario =
    ref && state.notes.join(" ") === state.current.input.operator_notes.join(" ");

  const cells = [
    { k: "Total cost", v: fmt(r.total_cost_bdt), u: "BDT", ref: sameScenario ? ref.total_cost_bdt : null },
    { k: "Grid energy", v: fmt(r.total_grid_kwh), u: "kWh", ref: sameScenario ? ref.total_grid_kwh : null },
    { k: "Peak hour draw", v: fmt(r.peak_grid_kwh), u: "kWh", ref: null },
  ];

  const host = $("#stats");
  host.textContent = "";
  for (const c of cells) {
    const d = document.createElement("div");
    d.className = "stat";
    const k = document.createElement("div");
    k.className = "stat-k";
    k.textContent = c.k;
    const v = document.createElement("div");
    v.className = "stat-v";
    v.textContent = c.v;
    const u = document.createElement("span");
    u.className = "stat-u";
    u.textContent = c.u;
    v.append(u);
    d.append(k, v);

    const sub = document.createElement("div");
    sub.className = "stat-sub";
    if (c.ref != null) {
      const match = Math.abs(Number(c.v.replace(/,/g, "")) - c.ref) <= 0.01;
      sub.dataset.match = match ? "yes" : "no";
      sub.textContent = match
        ? `matches published reference ${fmt(c.ref)}`
        : `reference ${fmt(c.ref)} — differs`;
    } else if (c.k === "Peak hour draw") {
      sub.textContent = "not compared — equivalent optima may differ";
    } else {
      sub.textContent = "notes edited — no reference to compare";
    }
    d.append(sub);
    host.append(d);
  }

  $("#summary").textContent = r.plan_summary ?? "";
}

function renderTable(hours, plan, affected) {
  const byHour = new Map(hours.map((h) => [h.hour, h]));
  const tb = $("#plan-body");
  tb.textContent = "";
  const aff = new Set(affected);

  for (const p of plan) {
    const src = byHour.get(p.hour) ?? {};
    const tr = document.createElement("tr");
    if (aff.has(p.hour)) tr.dataset.affected = "true";
    const cells = [
      String(p.hour).padStart(2, "0"),
      fmt(src.demand_kwh ?? 0),
      fmt(src.solar_kwh ?? 0),
      fmt(p.solar_used_kwh),
      fmt(p.grid_kwh),
      null, // action
      fmt(p.battery_kwh),
      fmt(p.battery_energy_after_kwh),
      fmt(src.tariff_bdt_per_kwh ?? 0),
    ];
    cells.forEach((c, i) => {
      const td = document.createElement("td");
      if (i === 5) {
        const s = document.createElement("span");
        s.className = "act";
        s.dataset.a = p.battery_action;
        s.textContent = p.battery_action;
        td.append(s);
      } else {
        td.textContent = c;
      }
      tr.append(td);
    });
    tb.append(tr);
  }
}

function draw() {
  const r = state.response;
  if (!r) return;
  const hours = state.current.input.hours;
  const battery = state.current.input.battery;
  const affected = affectedHours(r.directive_interpretation);

  energyChart($("#chart-energy"), hours, r.hourly_plan, affected);
  batteryChart($("#chart-battery"), battery, r.hourly_plan, reserveByHour(battery, r.directive_interpretation), affected);
  tariffChart($("#chart-tariff"), hours, r.hourly_plan, affected);
}

/* ---- the run ------------------------------------------------------------ */

let running = false;

async function run() {
  if (running || !state.current) return;
  const notes = state.notes.map((n) => n.trim()).filter(Boolean);
  if (!notes.length) {
    showBanner("Add at least one operator note before running.", true);
    return;
  }

  running = true;
  $("#run").disabled = true;
  clearBanner();
  resetPipeline();

  const payload = {
    scenario_id: state.current.input.scenario_id,
    operator_notes: notes,
    hours: state.current.input.hours,
    battery: state.current.input.battery,
  };

  stage(0, "done", `${notes.length} note${notes.length > 1 ? "s" : ""} · 24 hours`);
  stage(1, "active", "calling the model…");
  $("#runstat").textContent = "waiting for the service…";

  // Render can cold-start; say so rather than showing a spinner that looks hung.
  const t0 = performance.now();
  const slow = setTimeout(() => {
    $("#runstat").textContent = "waking the service — a cold instance can take ~30 s…";
  }, 4000);

  try {
    const res = await fetch("/optimize-energy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    clearTimeout(slow);
    const ms = Math.round(performance.now() - t0);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      stage(1, "idle");
      showBanner(`Service returned ${res.status}. ${body.message ?? ""}`.trim(), true);
      $("#runstat").textContent = `failed after ${ms} ms`;
      return;
    }

    const r = await res.json();
    state.response = r;

    const dirs = r.directive_interpretation ?? [];
    const applied = dirs.filter((d) => d.applies).length;
    const noops = dirs.length - applied;

    stage(1, "done", `${dirs.length} entr${dirs.length === 1 ? "y" : "ies"} returned`);
    stage(2, "done", `${applied} applied · ${noops} no_op`);
    stage(3, "done", `${r.hourly_plan?.length ?? 0}-hour plan · ${fmt(r.total_cost_bdt)} BDT`);
    stage(4, "idle", "not yet implemented");
    stage(5, "done", `7 fields · ${ms} ms`);

    $("#runstat").textContent = `${ms} ms — this request, measured in your browser`;

    $("#results").hidden = false;
    renderStats(r);
    renderDirectives(dirs, notes);
    renderTable(state.current.input.hours, r.hourly_plan ?? [], affectedHours(dirs));
    draw();

    $("#raw-req").textContent = JSON.stringify(payload, null, 2);
    $("#raw-res").textContent = JSON.stringify(r, null, 2);
  } catch (err) {
    clearTimeout(slow);
    stage(1, "idle");
    showBanner(
      "Could not reach the service. It may be waking from cold start — try again in a moment.",
      true,
    );
    $("#runstat").textContent = "request failed";
  } finally {
    running = false;
    $("#run").disabled = false;
  }
}

function showBanner(text, isError) {
  const b = $("#banner");
  b.textContent = text;
  b.className = isError ? "banner err" : "banner";
  b.hidden = false;
}

function clearBanner() {
  $("#banner").hidden = true;
}

/* ---- boot --------------------------------------------------------------- */

async function boot() {
  buildPipeline();
  checkHealth();

  try {
    const res = await fetch("./samples.json");
    const data = await res.json();
    state.samples = data.cases;
  } catch {
    showBanner("Could not load the published sample scenarios.", true);
    return;
  }

  const sel = $("#scenario");
  sel.textContent = "";
  for (const c of state.samples) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = `${c.id} — ${c.label}`;
    sel.append(o);
  }
  sel.addEventListener("change", () => selectSample(sel.value));
  selectSample(state.samples[0].id);

  $("#run").addEventListener("click", run);
  $("#add-note").addEventListener("click", () => {
    if (state.notes.length >= 3) return;
    state.notes.push("");
    renderNotes();
  });
  $("#reset-notes").addEventListener("click", () => {
    if (!state.current) return;
    state.notes = [...state.current.input.operator_notes];
    renderNotes();
  });
  $("#recheck").addEventListener("click", checkHealth);
}

boot();
