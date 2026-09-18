/**
 * DimSum charts — hand-built inline SVG. No library, no CDN.
 *
 * Every chart uses the same three series colours, which are read from CSS
 * custom properties so light/dark and the theme toggle work without a redraw
 * path of their own. Series are labelled directly rather than through a legend
 * the eye has to travel to, and reference lines carry inline labels.
 */

const NS = "http://www.w3.org/2000/svg";

/** Create an SVG element with attributes in one call. */
function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

const fmt = (n, d = 0) =>
  n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

/** A nice round axis maximum, so ticks land on readable numbers. */
function niceMax(value) {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const norm = value / pow;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * pow;
}

/**
 * A visually hidden table carrying the same numbers as the chart, so the data
 * is reachable by a screen reader and by anyone who cannot read the graphic.
 */
function dataTable(caption, headers, rows) {
  const wrap = document.createElement("div");
  wrap.className = "vh";
  const t = document.createElement("table");
  const cap = document.createElement("caption");
  cap.textContent = caption;
  t.append(cap);
  const thead = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    thead.append(th);
  }
  t.append(thead);
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const c of r) {
      const td = document.createElement("td");
      td.textContent = String(c);
      tr.append(td);
    }
    t.append(tr);
  }
  wrap.append(t);
  return wrap;
}

/** Shared frame: hour axis along the bottom, value axis on the left. */
function frame(svg, { W, H, pad, yMax, yUnit, ticks = 4 }) {
  const plotH = H - pad.t - pad.b;
  const plotW = W - pad.l - pad.r;

  for (let i = 0; i <= ticks; i++) {
    const v = (yMax / ticks) * i;
    const y = pad.t + plotH - (v / yMax) * plotH;
    if (i > 0) {
      svg.append(
        el("line", {
          x1: pad.l, x2: pad.l + plotW, y1: y, y2: y,
          stroke: "var(--rule)", "stroke-width": 1,
        }),
      );
    }
    svg.append(
      el("text", {
        x: pad.l - 7, y: y + 4, "text-anchor": "end",
        fill: "var(--ink-muted)", "font-size": 11,
      }, fmt(v)),
    );
  }

  svg.append(
    el("line", {
      x1: pad.l, x2: pad.l + plotW, y1: pad.t + plotH, y2: pad.t + plotH,
      stroke: "var(--ink-muted)", "stroke-width": 1,
    }),
  );

  for (let h = 0; h < 24; h += 3) {
    const x = pad.l + (plotW / 24) * (h + 0.5);
    svg.append(
      el("text", {
        x, y: pad.t + plotH + 15, "text-anchor": "middle",
        fill: "var(--ink-muted)", "font-size": 11,
      }, String(h).padStart(2, "0")),
    );
  }

  svg.append(
    el("text", {
      x: pad.l - 7, y: pad.t - 9, "text-anchor": "end",
      fill: "var(--ink-muted)", "font-size": 11,
    }, yUnit),
  );

  return { plotW, plotH };
}

/** Tint the hours a directive touches, behind everything else. */
function bands(svg, affected, pad, plotW, plotH) {
  for (const h of affected) {
    svg.append(
      el("rect", {
        x: pad.l + (plotW / 24) * h, y: pad.t,
        width: plotW / 24, height: plotH, fill: "var(--band)",
      }),
    );
  }
}

/**
 * Chart 1 — where each hour's energy comes from.
 * Stacked bars: grid + solar used + battery discharge. Demand as a step line.
 */
export function energyChart(host, hours, plan, affected) {
  host.textContent = "";
  const W = 860;
  const H = 300;
  const pad = { t: 22, r: 14, b: 26, l: 46 };

  const byHour = new Map(hours.map((h) => [h.hour, h]));
  const rows = plan.map((p) => {
    const src = byHour.get(p.hour) ?? { demand_kwh: 0 };
    const dis = p.battery_action === "discharge" ? p.battery_kwh : 0;
    const chg = p.battery_action === "charge" ? p.battery_kwh : 0;
    return { hour: p.hour, grid: p.grid_kwh, solar: p.solar_used_kwh, dis, chg, demand: src.demand_kwh };
  });

  const yMax = niceMax(Math.max(...rows.map((r) => Math.max(r.grid + r.solar + r.dis, r.demand))) * 1.08);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label":
    "Stacked hourly energy by source, with campus demand overlaid" });

  const { plotW, plotH } = frame(svg, { W, H, pad, yMax, yUnit: "kWh" });
  bands(svg, affected, pad, plotW, plotH);

  const bw = (plotW / 24) * 0.68;
  const off = (plotW / 24 - bw) / 2;
  const y = (v) => pad.t + plotH - (v / yMax) * plotH;

  for (const r of rows) {
    const x = pad.l + (plotW / 24) * r.hour + off;
    let acc = 0;
    for (const [v, colour] of [[r.grid, "var(--grid)"], [r.solar, "var(--solar)"], [r.dis, "var(--battery)"]]) {
      if (v <= 0) continue;
      svg.append(
        el("rect", {
          x, y: y(acc + v), width: bw, height: Math.max(0, (v / yMax) * plotH), fill: colour,
        }),
      );
      acc += v;
    }
  }

  // Demand as a step line — it is a target, not a quantity that stacks.
  let d = "";
  for (const r of rows) {
    const x0 = pad.l + (plotW / 24) * r.hour;
    const x1 = x0 + plotW / 24;
    d += `${d ? "L" : "M"}${x0} ${y(r.demand)} L${x1} ${y(r.demand)} `;
  }
  svg.append(el("path", { d, fill: "none", stroke: "var(--demand)", "stroke-width": 1.5, "stroke-dasharray": "3 2" }));

  host.append(svg);
  host.append(
    dataTable(
      "Hourly energy by source",
      ["Hour", "Grid kWh", "Solar used kWh", "Battery discharge kWh", "Demand kWh"],
      rows.map((r) => [r.hour, fmt(r.grid, 2), fmt(r.solar, 2), fmt(r.dis, 2), fmt(r.demand, 2)]),
    ),
  );
}

/**
 * Chart 2 — battery state of charge, with the bounds it must respect.
 * The point of this chart is that the line ends exactly where it began.
 */
export function batteryChart(host, battery, plan, reserveByHour, affected) {
  host.textContent = "";
  const W = 860;
  const H = 250;
  const pad = { t: 22, r: 62, b: 26, l: 46 };

  const yMax = niceMax(battery.capacity_kwh * 1.12);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label":
    "Battery state of charge across the day against capacity and reserve limits" });

  const { plotW, plotH } = frame(svg, { W, H, pad, yMax, yUnit: "kWh" });
  bands(svg, affected, pad, plotW, plotH);

  const y = (v) => pad.t + plotH - (v / yMax) * plotH;

  const refLine = (value, label, dash) => {
    svg.append(
      el("line", {
        x1: pad.l, x2: pad.l + plotW, y1: y(value), y2: y(value),
        stroke: "var(--ink-muted)", "stroke-width": 1, "stroke-dasharray": dash,
      }),
    );
    svg.append(
      el("text", {
        x: pad.l + plotW + 6, y: y(value) + 4, fill: "var(--ink-muted)", "font-size": 11,
      }, label),
    );
  };

  refLine(battery.capacity_kwh, "capacity", "4 3");
  refLine(battery.minimum_energy_kwh, "min", "4 3");

  // A directive reserve only covers some hours, so draw it as a segment.
  const raised = reserveByHour
    .map((r, h) => ({ h, r }))
    .filter((x) => x.r > battery.minimum_energy_kwh + 1e-9);
  if (raised.length) {
    const lvl = Math.max(...raised.map((x) => x.r));
    const from = Math.min(...raised.map((x) => x.h));
    const to = Math.max(...raised.map((x) => x.h)) + 1;
    svg.append(
      el("line", {
        x1: pad.l + (plotW / 24) * from, x2: pad.l + (plotW / 24) * to,
        y1: y(lvl), y2: y(lvl), stroke: "var(--battery)", "stroke-width": 1.5, "stroke-dasharray": "2 2",
      }),
    );
    svg.append(
      el("text", {
        x: pad.l + (plotW / 24) * to + 5, y: y(lvl) + 4,
        fill: "var(--battery)", "font-size": 11,
      }, `reserve ${fmt(lvl)}`),
    );
  }

  // Start at the initial level so hour 0's transition is visible.
  let d = `M${pad.l} ${y(battery.initial_energy_kwh)} `;
  for (const p of plan) {
    d += `L${pad.l + (plotW / 24) * (p.hour + 1)} ${y(p.battery_energy_after_kwh)} `;
  }
  svg.append(el("path", { d, fill: "none", stroke: "var(--grid)", "stroke-width": 2, "stroke-linejoin": "round" }));

  const last = plan[plan.length - 1];
  if (last) {
    svg.append(el("circle", { cx: pad.l + plotW, cy: y(last.battery_energy_after_kwh), r: 3.5, fill: "var(--grid)" }));
    svg.append(el("circle", { cx: pad.l, cy: y(battery.initial_energy_kwh), r: 3.5, fill: "var(--grid)" }));
  }

  host.append(svg);
  host.append(
    dataTable(
      "Battery energy after each hour",
      ["Hour", "Energy after kWh", "Action", "Amount kWh"],
      plan.map((p) => [p.hour, fmt(p.battery_energy_after_kwh, 2), p.battery_action, fmt(p.battery_kwh, 2)]),
    ),
  );
}

/**
 * Chart 3 — the optimizer's whole argument in one picture: grid draw as bars,
 * tariff as a line. Cheap hours should be tall, expensive hours short.
 */
export function tariffChart(host, hours, plan, affected) {
  host.textContent = "";
  const W = 860;
  const H = 250;
  const pad = { t: 22, r: 52, b: 26, l: 46 };

  const byHour = new Map(hours.map((h) => [h.hour, h]));
  const rows = plan.map((p) => ({
    hour: p.hour,
    grid: p.grid_kwh,
    tariff: byHour.get(p.hour)?.tariff_bdt_per_kwh ?? 0,
  }));

  const yMax = niceMax(Math.max(...rows.map((r) => r.grid)) * 1.1);
  const tMax = niceMax(Math.max(...rows.map((r) => r.tariff)) * 1.15);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label":
    "Grid purchase per hour against the hourly tariff" });

  const { plotW, plotH } = frame(svg, { W, H, pad, yMax, yUnit: "kWh" });
  bands(svg, affected, pad, plotW, plotH);

  const y = (v) => pad.t + plotH - (v / yMax) * plotH;
  const yt = (v) => pad.t + plotH - (v / tMax) * plotH;

  const bw = (plotW / 24) * 0.68;
  const off = (plotW / 24 - bw) / 2;
  for (const r of rows) {
    if (r.grid <= 0) continue;
    svg.append(
      el("rect", {
        x: pad.l + (plotW / 24) * r.hour + off, y: y(r.grid),
        width: bw, height: Math.max(0, (r.grid / yMax) * plotH), fill: "var(--grid)", opacity: 0.85,
      }),
    );
  }

  let d = "";
  for (const r of rows) {
    const x = pad.l + (plotW / 24) * (r.hour + 0.5);
    d += `${d ? "L" : "M"}${x} ${yt(r.tariff)} `;
  }
  svg.append(el("path", { d, fill: "none", stroke: "var(--solar)", "stroke-width": 2 }));

  svg.append(
    el("text", {
      x: pad.l + plotW + 6, y: yt(rows[rows.length - 1]?.tariff ?? 0) + 4,
      fill: "var(--solar)", "font-size": 11,
    }, "tariff"),
  );
  svg.append(
    el("text", {
      x: pad.l + plotW + 6, y: pad.t - 9, fill: "var(--ink-muted)", "font-size": 11,
    }, "BDT/kWh"),
  );

  host.append(svg);
  host.append(
    dataTable(
      "Grid purchase against tariff",
      ["Hour", "Grid kWh", "Tariff BDT/kWh"],
      rows.map((r) => [r.hour, fmt(r.grid, 2), fmt(r.tariff, 2)]),
    ),
  );
}
