"use strict";

/* ============================================================
 * dataknows.me — analysis page. Strictly read-only: this file
 * never writes to localStorage.
 * ============================================================ */

// Storage and day helpers live in common.js.
let state = loadState();
// Deleted metrics keep their history but are not shown anywhere.
let metrics = activeMetrics(state);

// Follow edits made in another tab (the event fires only on changes).
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY && e.key !== null) return;
  state = loadState();
  metrics = activeMetrics(state);
  render();
});

/* ---------- day helpers (same 3 a.m. cutoff as the entry page) ---------- */

function lastNDayKeys(n) {
  const base = keyToDate(todayKey());
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    keys.push(dateToKey(d));
  }
  return keys; // oldest → newest
}

/* ---------- value & stats helpers ---------- */

function rawValue(metric, key) {
  return state.entries[key]?.[metric.id];
}

// Categories like "-2, -1, 0, 1, 2" are numeric in spirit; average them too.
function isNumericMetric(metric) {
  if (metric.type !== "category") return true;
  return metric.categories.every((c) => toNumber(c) !== null);
}

function numericValue(metric, key) {
  return toNumber(rawValue(metric, key));
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function sampleStd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function modeOf(metric, keys) {
  const counts = new Map();
  for (const k of keys) {
    const v = rawValue(metric, k);
    if (v !== undefined) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
  }
  let best = null;
  for (const [v, c] of counts) if (best === null || c > best[1]) best = [v, c];
  return best; // [value, count] or null
}

function fmt(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const d = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return n.toFixed(d).replace(/\.0+$|(\.\d*?)0+$/, "$1");
}

/* ---------- series bucketing: day / week / month ---------- */

function dailySeries(metric, nDays) {
  return lastNDayKeys(nDays).map((k) => ({ label: k.slice(5), value: numericValue(metric, k) }));
}

function currentMonday() {
  const t = keyToDate(todayKey());
  const d = new Date(t);
  d.setDate(t.getDate() - ((t.getDay() + 6) % 7)); // Monday-start weeks
  return d;
}

function weeklySeries(metric, nWeeks) {
  const thisMonday = currentMonday();
  const today = todayKey();
  const out = [];
  for (let w = nWeeks - 1; w >= 0; w--) {
    const start = new Date(thisMonday);
    start.setDate(thisMonday.getDate() - 7 * w);
    const vals = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = dateToKey(d);
      if (key > today) break;
      const v = numericValue(metric, key);
      if (v !== null) vals.push(v);
    }
    out.push({ label: dateToKey(start).slice(5), value: mean(vals) });
  }
  return out;
}

function monthlySeries(metric, nMonths) {
  const t = keyToDate(todayKey());
  const today = todayKey();
  const out = [];
  for (let m = nMonths - 1; m >= 0; m--) {
    const first = new Date(t.getFullYear(), t.getMonth() - m, 1, 12);
    const vals = [];
    const d = new Date(first);
    while (d.getMonth() === first.getMonth() && dateToKey(d) <= today) {
      const v = numericValue(metric, dateToKey(d));
      if (v !== null) vals.push(v);
      d.setDate(d.getDate() + 1);
    }
    out.push({ label: first.toLocaleDateString(undefined, { month: "short" }), value: mean(vals) });
  }
  return out;
}

const SERIES_MODES = {
  day: { label: "Day", build: (m) => dailySeries(m, 30) },
  week: { label: "Week", build: (m) => weeklySeries(m, 12) },
  month: { label: "Month", build: (m) => monthlySeries(m, 12) },
};

/* ---------- line chart (inline SVG, no dependencies) ---------- */

function lineChartSVG(points) {
  const present = points.filter((p) => p.value !== null);
  if (present.length === 0) return `<p class="no-data">No entries in this range yet.</p>`;

  const W = 640, H = 210, T = 14, R = 12, B = 28, L = 46;
  let lo = Math.min(...present.map((p) => p.value));
  let hi = Math.max(...present.map((p) => p.value));
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;

  const iw = W - L - R, ih = H - T - B;
  const x = (i) => L + (points.length === 1 ? iw / 2 : (i * iw) / (points.length - 1));
  const y = (v) => T + ((hi - v) / (hi - lo)) * ih;

  let grid = "";
  for (const v of [hi, (hi + lo) / 2, lo]) {
    const gy = y(v).toFixed(1);
    grid += `<line x1="${L}" y1="${gy}" x2="${W - R}" y2="${gy}" class="gridline"/>` +
      `<text x="${L - 6}" y="${+gy + 3.5}" text-anchor="end" class="ax">${fmt(v)}</text>`;
  }
  if (lo < 0 && hi > 0) {
    const zy = y(0).toFixed(1);
    grid += `<line x1="${L}" y1="${zy}" x2="${W - R}" y2="${zy}" class="gridline" stroke-dasharray="4 3"/>`;
  }

  // Draw runs of consecutive non-null points; gaps stay gaps (never fake zeros).
  let paths = "", dots = "", run = [];
  const flush = () => {
    if (run.length > 1) {
      paths += `<path d="M${run.join("L")}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    run = [];
  };
  points.forEach((p, i) => {
    if (p.value === null) { flush(); return; }
    const px = x(i).toFixed(1), py = y(p.value).toFixed(1);
    run.push(`${px},${py}`);
    dots += `<circle cx="${px}" cy="${py}" r="3" fill="var(--accent)"><title>${esc(p.label)}: ${fmt(p.value)}</title></circle>`;
  });
  flush();

  let xlabels = "";
  const nLabels = Math.min(4, points.length);
  for (let j = 0; j < nLabels; j++) {
    const i = Math.round((j * (points.length - 1)) / Math.max(nLabels - 1, 1));
    xlabels += `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="ax">${esc(points[i].label)}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}${paths}${dots}${xlabels}</svg>`;
}

/* ---------- categorical bubble calendar (last 3 months) ---------- */

const PALETTE = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7", "#ec4899", "#84cc16", "#f97316", "#64748b"];

function categoryColor(metric, value) {
  const i = metric.categories.indexOf(String(value));
  return i === -1 ? "#94a3b8" : PALETTE[i % PALETTE.length];
}

function bubbleCalendarHTML(metric) {
  const weeks = 13, cell = 18, r = 6.5, top = 20, left = 30;
  const W = left + weeks * cell + 4, H = top + 7 * cell + 4;
  const today = todayKey();
  const thisMonday = currentMonday();

  let cells = "", monthLabels = "", prevMonth = -1;
  const counts = new Map();
  for (let w = 0; w < weeks; w++) {
    const monday = new Date(thisMonday);
    monday.setDate(thisMonday.getDate() - (weeks - 1 - w) * 7);
    if (monday.getMonth() !== prevMonth) {
      monthLabels += `<text x="${left + w * cell}" y="11" class="ax">${monday.toLocaleDateString(undefined, { month: "short" })}</text>`;
      prevMonth = monday.getMonth();
    }
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + dow);
      const key = dateToKey(d);
      if (key > today) continue;
      const cx = left + w * cell + cell / 2, cy = top + dow * cell + cell / 2;
      const v = rawValue(metric, key);
      if (v === undefined) {
        cells += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--border)" opacity="0.5"><title>${key} · no entry</title></circle>`;
      } else {
        counts.set(String(v), (counts.get(String(v)) || 0) + 1);
        cells += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${categoryColor(metric, v)}"><title>${key} · ${esc(String(v))}</title></circle>`;
      }
    }
  }

  let dayLabels = "";
  [["Mon", 0], ["Wed", 2], ["Fri", 4]].forEach(([name, row]) => {
    dayLabels += `<text x="2" y="${top + row * cell + cell / 2 + 3.5}" class="ax">${name}</text>`;
  });

  const legend = metric.categories.map((c, i) => {
    const n = counts.get(c) || 0;
    return `<span><i class="legend-dot" style="background:${PALETTE[i % PALETTE.length]}"></i>${esc(c)}${n ? ` · ${n}` : ""}</span>`;
  }).join("");

  return `<div class="cal-wrap"><svg viewBox="0 0 ${W} ${H}" width="${W}" role="img">${monthLabels}${dayLabels}${cells}</svg></div>` +
    `<div class="cal-legend">${legend}</div>`;
}

/* ---------- day-of-week pattern (numeric metrics, last 12 weeks) ---------- */

const WEEKDAY_WEEKS = 12;
const WEEKDAY_MIN_DAYS = 2; // entries needed before a weekday gets a bar

// Monday-first short names in the user's locale (1 Jan 2024 was a Monday).
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6].map((i) =>
  new Date(2024, 0, 1 + i, 12).toLocaleDateString(undefined, { weekday: "short" }));

function weekdayStats(metric) {
  const buckets = WEEKDAYS.map(() => []);
  const all = [];
  for (const key of lastNDayKeys(WEEKDAY_WEEKS * 7)) {
    const v = numericValue(metric, key);
    if (v === null) continue;
    buckets[(keyToDate(key).getDay() + 6) % 7].push(v);
    all.push(v);
  }
  return {
    overall: mean(all),
    days: buckets.map((vals, i) => ({
      name: WEEKDAYS[i],
      n: vals.length,
      avg: vals.length >= WEEKDAY_MIN_DAYS ? mean(vals) : null,
    })),
  };
}

// A bar from the baseline at y0 to y1, with only the far end rounded.
function barPath(x, w, y0, y1, r = 4) {
  const h = Math.abs(y1 - y0);
  r = Math.min(r, h, w / 2);
  if (h < 0.5) return "";
  const up = y1 < y0, s = up ? 1 : -1;
  return `M${x},${y0}V${y1 + s * r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + s * r}V${y0}Z`;
}

function weekdayHTML(metric) {
  const { overall, days } = weekdayStats(metric);
  const shown = days.filter((d) => d.avg !== null);
  const head = `<div class="section-label">By weekday <span>· vs your ${WEEKDAY_WEEKS}-week average</span></div>`;
  if (shown.length < 3) {
    return head + `<p class="no-data">Needs a few more weeks of entries.</p>`;
  }

  const W = 640, H = 150, T = 12, B = 26, L = 46, R = 12;
  const mid = T + (H - T - B) / 2, half = (H - T - B) / 2;
  const maxDev = Math.max(...shown.map((d) => Math.abs(d.avg - overall))) || 1;
  const slot = (W - L - R) / 7, bw = Math.min(44, slot - 2 * 8);

  let bars = "", labels = "";
  days.forEach((d, i) => {
    const cx = L + slot * i + slot / 2;
    labels += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" class="ax">${esc(d.name)}</text>`;
    const tip = d.avg === null
      ? `${d.name}: not enough entries (${d.n})`
      : `${d.name}: ${fmt(d.avg)} avg (${d.avg >= overall ? "+" : "−"}${fmt(Math.abs(d.avg - overall))} vs avg, ${d.n} days)`;
    // Full-height invisible hit target, larger than the bar.
    bars += `<g><title>${esc(tip)}</title><rect x="${(cx - slot / 2).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${H - T - B}" fill="transparent"/>`;
    if (d.avg !== null) {
      const y1 = mid - ((d.avg - overall) / maxDev) * half;
      const path = barPath(+(cx - bw / 2).toFixed(1), bw, mid, +y1.toFixed(1));
      bars += path ? `<path d="${path}" fill="var(--accent)"/>`
        : `<line x1="${(cx - bw / 2).toFixed(1)}" x2="${(cx + bw / 2).toFixed(1)}" y1="${mid}" y2="${mid}" stroke="var(--accent)" stroke-width="2"/>`;
    }
    bars += `</g>`;
  });

  const axis = `<line x1="${L}" y1="${mid}" x2="${W - R}" y2="${mid}" class="gridline"/>` +
    `<text x="${L - 6}" y="${mid + 3.5}" text-anchor="end" class="ax">${fmt(overall)}</text>`;

  const hi = shown.reduce((a, b) => (b.avg > a.avg ? b : a));
  const lo = shown.reduce((a, b) => (b.avg < a.avg ? b : a));
  const note = hi.avg === lo.avg
    ? "About the same every day."
    : `Highest on ${esc(hi.name)} (${fmt(hi.avg)}), lowest on ${esc(lo.name)} (${fmt(lo.avg)}).`;

  return head +
    `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average by weekday. ${note}">` +
    `${axis}${bars}${labels}</svg></div><p class="chart-note">${note}</p>`;
}

/* ---------- relationships between metrics (same-day correlation) ---------- */

const CORR_DAYS = 90;
const CORR_MIN_PAIRS = 10;
const CORR_MAX_ROWS = 8;

function correlations() {
  const numeric = metrics.filter(isNumericMetric);
  const keys = lastNDayKeys(CORR_DAYS);
  const out = [];
  for (let i = 0; i < numeric.length; i++) {
    for (let j = i + 1; j < numeric.length; j++) {
      const a = numeric[i], b = numeric[j], xs = [], ys = [];
      for (const k of keys) {
        const x = numericValue(a, k), y = numericValue(b, k);
        if (x !== null && y !== null) { xs.push(x); ys.push(y); }
      }
      const r = xs.length >= CORR_MIN_PAIRS ? pearson(xs, ys) : null;
      if (r !== null) out.push({ a, b, r, n: xs.length });
    }
  }
  return { numericCount: numeric.length, pairs: out.sort((p, q) => Math.abs(q.r) - Math.abs(p.r)) };
}

function strengthText(r) {
  const a = Math.abs(r);
  if (a < 0.2) return "No clear link";
  const word = a < 0.4 ? "Weak" : a < 0.7 ? "Moderate" : "Strong";
  return `${word}: ${r > 0 ? "tend to rise together" : "one up, the other down"}`;
}

function corrBarSVG(r) {
  const W = 80, H = 12, mid = W / 2, w = Math.abs(r) * (mid - 1);
  const x = r >= 0 ? mid : mid - w;
  return `<svg class="corr-bar" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">` +
    `<rect x="0" y="${H / 2 - 1}" width="${W}" height="2" rx="1" fill="var(--border)"/>` +
    `<rect x="${x.toFixed(1)}" y="1" width="${Math.max(w, 1.5).toFixed(1)}" height="${H - 2}" rx="3" fill="var(--accent)"/>` +
    `<line x1="${mid}" x2="${mid}" y1="0" y2="${H}" stroke="var(--text-dim)" stroke-width="1"/></svg>`;
}

function renderRelationships() {
  const section = document.getElementById("relationships");
  const { numericCount, pairs } = correlations();
  section.hidden = numericCount < 2;
  if (section.hidden) return;

  const rows = pairs.slice(0, CORR_MAX_ROWS).map((p) =>
    `<li class="corr-row"><div class="corr-names">${esc(p.a.name)} <span>&amp;</span> ${esc(p.b.name)}` +
    `<small>${strengthText(p.r)} · ${p.n} days</small></div>` +
    `${corrBarSVG(p.r)}<span class="corr-r">${p.r >= 0 ? "+" : "−"}${Math.abs(p.r).toFixed(2)}</span></li>`).join("");

  section.innerHTML =
    `<div class="metric-head"><span class="metric-name">Relationships</span>` +
    `<span class="status-pill">last ${CORR_DAYS} days</span></div>` +
    (rows ? `<ul class="corr-list">${rows}</ul>`
      : `<p class="no-data">Needs at least ${CORR_MIN_PAIRS} days where two number metrics were both recorded.</p>`) +
    `<p class="chart-note">Same-day correlation (r from −1 to +1) between number metrics, using days where both ` +
    `were recorded. A link isn’t proof that one causes the other.</p>`;
}

/* ---------- per-metric stats ---------- */

function statsHTML(metric) {
  const keys7 = lastNDayKeys(7), keys30 = lastNDayKeys(30);
  const filled30 = keys30.filter((k) => rawValue(metric, k) !== undefined).length;

  if (isNumericMetric(metric)) {
    const nums7 = keys7.map((k) => numericValue(metric, k)).filter((v) => v !== null);
    const nums30 = keys30.map((k) => numericValue(metric, k)).filter((v) => v !== null);
    const avg7 = mean(nums7), avg30 = mean(nums30);

    let trend = "";
    if (avg7 !== null && avg30 !== null) {
      const diff = avg7 - avg30;
      const arrow = Math.abs(diff) < 0.005 ? "→" : diff > 0 ? "↑" : "↓";
      trend = `<span class="stat-trend">${arrow} ${fmt(Math.abs(diff))} vs 30d</span>`;
    }

    return stat("7d avg", fmt(avg7), trend) +
      stat("30d avg", fmt(avg30)) +
      stat("30d std", avg30 === null ? "—" : "± " + fmt(sampleStd(nums30))) +
      stat("30d filled", `${filled30}<small>/30</small>`);
  }

  // Non-numeric categories: averages are meaningless, show what dominates.
  const top7 = modeOf(metric, keys7), top30 = modeOf(metric, keys30);
  return stat("7d top", top7 ? esc(top7[0]) : "—") +
    stat("30d top", top30 ? esc(top30[0]) : "—") +
    stat("30d top share", top30 ? fmt((100 * top30[1]) / filled30) + "%" : "—") +
    stat("30d filled", `${filled30}<small>/30</small>`);
}

function stat(label, value, extra = "") {
  return `<div class="stat"><div class="stat-value">${value}</div><div class="stat-label">${label}</div>${extra}</div>`;
}

/* ---------- overview summary ---------- */

function hasAnyEntry(key) {
  const day = state.entries[key];
  return !!day && metrics.some((m) => day[m.id] !== undefined);
}

function currentStreak() {
  const d = keyToDate(todayKey());
  if (!hasAnyEntry(dateToKey(d))) d.setDate(d.getDate() - 1); // today isn't over yet
  let s = 0;
  while (hasAnyEntry(dateToKey(d))) {
    s++;
    d.setDate(d.getDate() - 1);
  }
  return s;
}

function renderSummary() {
  const summaryEl = document.getElementById("summary");
  const trackedDays = Object.keys(state.entries).filter(hasAnyEntry).sort();
  if (trackedDays.length === 0) return;

  const keys30 = lastNDayKeys(30);
  const cells = 30 * metrics.length;
  let filledCells = 0;
  for (const k of keys30) {
    for (const m of metrics) if (rawValue(m, k) !== undefined) filledCells++;
  }

  summaryEl.hidden = false;
  summaryEl.innerHTML = `<div class="stat-grid">` +
    stat("Streak", `${currentStreak()}<small> d</small>`) +
    stat("Days tracked", String(trackedDays.length)) +
    stat("30d completion", cells ? fmt((100 * filledCells) / cells) + "%" : "—") +
    stat("Since", trackedDays[0].slice(5)) +
    `</div>`;
}

/* ---------- page render ---------- */

function renderMetricCard(metric) {
  const card = document.createElement("div");
  card.className = "metric-card analysis-card";

  const typeName = { integer: "number", category: "choice", float: "slider" }[metric.type] || metric.type;
  card.innerHTML =
    `<div class="metric-head"><span class="metric-name">${esc(metric.name)}</span>` +
    `<span class="status-pill">${esc(typeName)}</span></div>` +
    `<div class="stat-grid">${statsHTML(metric)}</div>`;

  if (metric.type === "category") {
    const cal = document.createElement("div");
    cal.innerHTML = bubbleCalendarHTML(metric);
    card.append(cal);
  } else {
    const toggle = document.createElement("div");
    toggle.className = "avg-toggle";
    toggle.setAttribute("role", "group");
    toggle.setAttribute("aria-label", "Averaging period");

    const chartWrap = document.createElement("div");
    chartWrap.className = "chart-wrap";

    let mode = "day";
    const draw = () => {
      chartWrap.innerHTML = lineChartSVG(SERIES_MODES[mode].build(metric));
      toggle.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("selected", b.dataset.mode === mode);
        b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
      });
    };
    for (const [key, m] of Object.entries(SERIES_MODES)) {
      const btn = document.createElement("button");
      btn.className = "avg-btn";
      btn.dataset.mode = key;
      btn.textContent = m.label;
      btn.addEventListener("click", () => { mode = key; draw(); });
      toggle.append(btn);
    }
    card.append(toggle, chartWrap);
    draw();
  }

  if (isNumericMetric(metric)) {
    const weekday = document.createElement("div");
    weekday.className = "weekday";
    weekday.innerHTML = weekdayHTML(metric);
    card.append(weekday);
  }
  return card;
}

function render() {
  const dayDate = keyToDate(todayKey());
  document.getElementById("range-label").textContent =
    "As of " + dayDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  const hasData = metrics.length > 0 && Object.keys(state.entries).some(hasAnyEntry);
  document.getElementById("empty-state").hidden = hasData;
  if (!hasData) {
    document.getElementById("summary").hidden = true;
    document.getElementById("relationships").hidden = true;
    document.getElementById("analysis-list").replaceChildren();
    return;
  }

  renderSummary();
  document.getElementById("analysis-list")
    .replaceChildren(...metrics.map(renderMetricCard));
  renderRelationships();
}

render();
