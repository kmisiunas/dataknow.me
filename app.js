"use strict";

/* ============================================================
 * dataknows.me — daily self-tracking, all data in localStorage
 * ============================================================ */

/* ---------- state ---------- */

// Storage, schema, migrations and day helpers live in common.js.
let state = loadState();

// Returns false (and tells the user) if the data could not be written.
function save() {
  if (saveState(state)) return true;
  toast(isSaveBlocked()
    ? "Not saved: your data is from a newer version of this app. Reload to update."
    : "Not saved: this browser's storage is full or unavailable.", 6000);
  return false;
}

// The stored value for a metric on a day, as its current type expects it.
function valueFor(metric, day) {
  return coerceValue(metric, state.entries[day]?.[metric.id]);
}

// The day whose entries are being viewed/edited; defaults to today and can
// be moved back up to 6 days via the day strip.
let selectedDay = todayKey();

function selectedEntries() {
  if (!state.entries[selectedDay]) state.entries[selectedDay] = {};
  return state.entries[selectedDay];
}

function setEntry(metricId, value) {
  selectedEntries()[metricId] = value;
  save();
  render();
}

function clearEntry(metricId) {
  delete selectedEntries()[metricId];
  save();
  render();
}

/* ---------- rendering ---------- */

const listEl = document.getElementById("metric-list");
const emptyEl = document.getElementById("empty-state");
const todayLabelEl = document.getElementById("today-label");
const dayStripEl = document.getElementById("day-strip");

let renderedDay = null;

function render() {
  renderedDay = todayKey();
  if (selectedDay > renderedDay) selectedDay = renderedDay;

  const isToday = selectedDay === renderedDay;
  const dayDate = new Date(selectedDay + "T12:00:00");
  todayLabelEl.textContent = (isToday ? "Today" : "Editing") + " · " +
    dayDate.toLocaleDateString(undefined, {
      weekday: "short", month: "short", day: "numeric",
    });

  renderDayStrip();

  emptyEl.hidden = state.metrics.length > 0;
  listEl.replaceChildren(...state.metrics.map(renderMetricCard));
}

/* Day strip: today on the right, going back in time to the left. Grey =
 * nothing entered, yellow = partially entered, green = every metric entered. */

function dayStatus(key) {
  if (state.metrics.length === 0) return "none";
  const day = state.entries[key] || {};
  const filled = state.metrics.filter((m) => coerceValue(m, day[m.id]) !== undefined).length;
  if (filled === 0) return "none";
  return filled === state.metrics.length ? "full" : "partial";
}

function renderDayStrip() {
  const base = new Date(renderedDay + "T12:00:00");
  const dots = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    const key = dateToKey(d);
    const selected = key === selectedDay;

    const dot = el("button", `day-dot s-${dayStatus(key)}` + (selected ? " selected" : ""));
    if (selected) dot.textContent = key.slice(5); // "MM-DD"
    dot.setAttribute("aria-label", (i === 0 ? "Today, " : "") +
      d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }));
    dot.setAttribute("aria-pressed", String(selected));
    dot.addEventListener("click", () => {
      selectedDay = key;
      render();
    });
    dots.push(dot);
  }
  dayStripEl.replaceChildren(...dots);
}

function renderMetricCard(metric) {
  const value = valueFor(metric, selectedDay);
  const entered = value !== undefined;

  const card = el("div", "metric-card" + (entered ? " entered" : ""));

  const head = el("div", "metric-head");
  head.append(
    el("span", "metric-name", metric.name),
    el("span", "status-pill", entered ? "Entered ✓" : "Not entered"),
  );
  const editBtn = el("button", "edit-metric-btn", "✎");
  editBtn.setAttribute("aria-label", `Edit ${metric.name}`);
  editBtn.addEventListener("click", () => openMetricDialog(metric));
  head.append(editBtn);
  card.append(head);

  if (metric.type === "integer") card.append(renderInteger(metric, value));
  else if (metric.type === "category") card.append(renderCategory(metric, value));
  else if (metric.type === "float") card.append(renderFloat(metric, value));

  if (entered) {
    const clear = el("button", "clear-btn",
      selectedDay === renderedDay ? "Clear today’s entry" : "Clear this day’s entry");
    clear.addEventListener("click", () => clearEntry(metric.id));
    card.append(clear);
  }
  return card;
}

function renderInteger(metric, value) {
  const wrap = el("div", "stepper");

  const minus = el("button", "step-btn", "−");
  const plus = el("button", "step-btn", "+");
  const input = el("input", "stepper-value");
  input.type = "number";
  input.inputMode = "numeric";
  input.step = "1";
  input.min = metric.min;
  input.max = metric.max;
  input.placeholder = "—";
  if (value !== undefined) input.value = value;

  minus.disabled = value !== undefined && value <= metric.min;
  plus.disabled = value !== undefined && value >= metric.max;

  const nudge = (dir) => {
    // First tap starts the entry at the minimum (so 0 can be recorded explicitly).
    const next = value === undefined ? metric.min : clamp(value + dir, metric.min, metric.max);
    setEntry(metric.id, next);
  };
  minus.addEventListener("click", () => nudge(-1));
  plus.addEventListener("click", () => nudge(1));

  input.addEventListener("change", () => {
    if (input.value === "") {
      clearEntry(metric.id);
    } else {
      const n = clamp(Math.round(Number(input.value)), metric.min, metric.max);
      if (Number.isFinite(n)) setEntry(metric.id, n);
      else render();
    }
  });

  wrap.append(minus, input, plus);
  return wrap;
}

function renderCategory(metric, value) {
  const wrap = el("div", "chips");
  for (const option of metric.categories) {
    const chip = el("button", "chip" + (value === option ? " selected" : ""), option);
    chip.addEventListener("click", () => {
      if (value === option) clearEntry(metric.id);
      else setEntry(metric.id, option);
    });
    wrap.append(chip);
  }
  return wrap;
}

function renderFloat(metric, value) {
  const wrap = el("div");
  const row = el("div", "slider-row");

  const decimals = stepDecimals(metric.step);
  const label = el("span", "slider-value", value !== undefined ? value.toFixed(decimals) : "—");

  const slider = el("input");
  slider.type = "range";
  slider.min = metric.min;
  slider.max = metric.max;
  slider.step = metric.step;
  // An untouched slider still needs a thumb position; show midpoint, dimmed via CSS.
  slider.value = value !== undefined ? value : (metric.min + metric.max) / 2;

  slider.addEventListener("input", () => {
    label.textContent = Number(slider.value).toFixed(decimals);
  });
  slider.addEventListener("change", () => {
    setEntry(metric.id, Number(slider.value));
  });

  row.append(label, slider);
  wrap.append(row);

  const bounds = el("div", "slider-bounds");
  bounds.append(el("span", "", String(metric.min)), el("span", "", String(metric.max)));
  wrap.append(bounds);
  return wrap;
}

/* ---------- metric add / edit dialog ---------- */

const metricDialog = document.getElementById("metric-dialog");
const metricForm = document.getElementById("metric-form");
const deleteBtn = document.getElementById("delete-metric-btn");
let editingId = null;

const typeFields = {
  integer: document.getElementById("fields-integer"),
  category: document.getElementById("fields-category"),
  float: document.getElementById("fields-float"),
};

function selectedType() {
  return metricForm.querySelector('input[name="m-type"]:checked').value;
}

function showTypeFields() {
  const type = selectedType();
  for (const [name, elBox] of Object.entries(typeFields)) elBox.hidden = name !== type;
  // Only the visible type's inputs may be required, or a hidden empty field
  // would silently block submission.
  document.getElementById("m-categories").required = type === "category";
  document.getElementById("m-int-min").required = type === "integer";
  document.getElementById("m-int-max").required = type === "integer";
}

metricForm.querySelectorAll('input[name="m-type"]').forEach((r) => {
  r.addEventListener("change", showTypeFields);
});

document.getElementById("add-metric-btn").addEventListener("click", () => openMetricDialog(null));

function openMetricDialog(metric) {
  editingId = metric ? metric.id : null;
  document.getElementById("metric-dialog-title").textContent = metric ? "Edit metric" : "New metric";
  document.getElementById("metric-save-btn").textContent = metric ? "Save" : "Add";
  deleteBtn.hidden = !metric;

  document.getElementById("m-name").value = metric?.name ?? "";
  const type = metric?.type ?? "integer";
  metricForm.querySelector(`input[name="m-type"][value="${type}"]`).checked = true;

  document.getElementById("m-int-min").value = metric?.type === "integer" ? metric.min : 0;
  document.getElementById("m-int-max").value = metric?.type === "integer" ? metric.max : 20;
  document.getElementById("m-categories").value = metric?.type === "category" ? metric.categories.join(", ") : "";
  document.getElementById("m-float-min").value = metric?.type === "float" ? metric.min : 0;
  document.getElementById("m-float-max").value = metric?.type === "float" ? metric.max : 1;
  document.getElementById("m-float-step").value = metric?.type === "float" ? metric.step : 0.05;

  const err = document.getElementById("form-error");
  err.hidden = true;
  delete err.dataset.confirmed;
  showTypeFields();
  metricDialog.showModal();
}

metricForm.addEventListener("submit", (e) => {
  const name = document.getElementById("m-name").value.trim();
  const type = selectedType();
  const metric = { id: editingId ?? newId(), name, type };

  if (type === "integer") {
    metric.min = Math.round(Number(document.getElementById("m-int-min").value));
    metric.max = Math.round(Number(document.getElementById("m-int-max").value));
    if (!(metric.max > metric.min)) return invalid(e, "Max must be greater than min.");
  } else if (type === "category") {
    metric.categories = document.getElementById("m-categories").value
      .split(",").map((s) => s.trim()).filter(Boolean);
    if (metric.categories.length < 2) return invalid(e, "Give at least two options.");
  } else {
    metric.min = Number(document.getElementById("m-float-min").value);
    metric.max = Number(document.getElementById("m-float-max").value);
    metric.step = Number(document.getElementById("m-float-step").value) || 0.01;
    if (!(metric.max > metric.min)) return invalid(e, "Max must be greater than min.");
  }

  if (editingId) {
    const old = state.metrics.find((m) => m.id === editingId);
    if (old.type !== metric.type) {
      // Entries that don't fit the new type are kept but hidden; say so once.
      const misfits = Object.values(state.entries).filter((day) =>
        day[metric.id] !== undefined && coerceValue(metric, day[metric.id]) === undefined).length;
      const warning = `${misfits} recorded ${misfits === 1 ? "entry doesn’t" : "entries don’t"} fit the new type and will be hidden (they stay in backups, and reappear if you switch back). Tap Save again to confirm.`;
      const err = document.getElementById("form-error");
      if (misfits > 0 && !(err.dataset.confirmed === metric.type && !err.hidden)) {
        err.dataset.confirmed = metric.type;
        return invalid(e, warning);
      }
    }
    const i = state.metrics.findIndex((m) => m.id === editingId);
    state.metrics[i] = metric;
  } else {
    state.metrics.push(metric);
  }
  save();
  render();
});

function invalid(e, message) {
  // Shown inline: a toast would be hidden behind the dialog backdrop.
  e.preventDefault();
  const err = document.getElementById("form-error");
  err.textContent = message;
  err.hidden = false;
}

deleteBtn.addEventListener("click", () => {
  const metric = state.metrics.find((m) => m.id === editingId);
  if (!confirm(`Delete “${metric.name}” and all its recorded history?`)) return;
  state.metrics = state.metrics.filter((m) => m.id !== editingId);
  for (const day of Object.values(state.entries)) delete day[editingId];
  save();
  render();
  metricDialog.close();
});

/* ---------- menu: export / import ---------- */

const menuDialog = document.getElementById("menu-dialog");
document.getElementById("menu-btn").addEventListener("click", () => {
  document.getElementById("undo-restore-btn").hidden = !hasSnapshot();
  menuDialog.showModal();
});

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => btn.closest("dialog").close());
});

// Web Share with files needs canShare support (iOS 15+, Safari/Chrome on
// macOS); the button stays hidden elsewhere and downloads remain the fallback.
const shareBtn = document.getElementById("share-json-btn");

function backupFile() {
  return new File(
    [JSON.stringify(state, null, 2)],
    `dataknowsme-backup-${todayKey()}.json`,
    { type: "application/json" },
  );
}

if (navigator.canShare && navigator.canShare({ files: [backupFile()] })) {
  shareBtn.hidden = false;
}

shareBtn.addEventListener("click", async () => {
  menuDialog.close();
  try {
    await navigator.share({ files: [backupFile()], title: "dataknows.me backup" });
  } catch (err) {
    if (err.name !== "AbortError") {
      toast("Sharing failed — use Download JSON backup instead.");
      console.error(err);
    }
  }
});

document.getElementById("export-json-btn").addEventListener("click", () => {
  download(
    JSON.stringify(state, null, 2),
    `dataknowsme-backup-${todayKey()}.json`,
    "application/json",
  );
  menuDialog.close();
});

document.getElementById("export-csv-btn").addEventListener("click", () => {
  const csv = buildCsv();
  menuDialog.close();
  if (csv === null) {
    toast("No entries to export yet.");
    return;
  }
  download(csv, `dataknowsme-${todayKey()}.csv`, "text/csv");
});

document.getElementById("import-json-btn").addEventListener("click", () => {
  document.getElementById("import-file").click();
});

document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  let restored;
  try {
    restored = validateBackup(JSON.parse(await file.text()));
  } catch (err) {
    console.error(err);
    toast(err instanceof SyntaxError
      ? "Could not read that file — is it a dataknows.me backup?"
      : `Can’t restore: ${err.message}`, 6000);
    return;
  }

  const days = Object.keys(restored.entries).length;
  const shown = activeMetrics(restored).length;
  if (!confirm(`Replace everything on this device with this backup ` +
    `(${shown} metric${shown === 1 ? "" : "s"}, ${days} day${days === 1 ? "" : "s"})?\n\n` +
    `Your current data is kept so the restore can be undone.`)) return;

  // Keep a copy of the current data first; never restore without one.
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(state));
  } catch (err) {
    console.error(err);
    toast("Can’t restore: no room to keep a copy of your current data.", 6000);
    return;
  }

  const previous = state;
  state = restored;
  if (!save()) {
    state = previous;
    return;
  }
  render();
  menuDialog.close();
  toast("Backup restored.", 8000, { label: "Undo", run: undoRestore });
});

function hasSnapshot() {
  try {
    return localStorage.getItem(SNAPSHOT_KEY) !== null;
  } catch (e) {
    return false;
  }
}

function undoRestore() {
  let snapshot;
  try {
    snapshot = migrate(JSON.parse(localStorage.getItem(SNAPSHOT_KEY)));
  } catch (err) {
    console.error(err);
    toast("Could not read the saved copy.");
    return;
  }
  const previous = state;
  state = snapshot;
  if (!save()) {
    state = previous;
    return;
  }
  localStorage.removeItem(SNAPSHOT_KEY);
  render();
  menuDialog.close();
  toast("Restore undone — your previous data is back.");
}

document.getElementById("undo-restore-btn").addEventListener("click", undoRestore);

/* ---------- CSV ---------- */

function buildCsv() {
  // Rows cover every day from the first entry to today; a blank cell means
  // nothing was entered for that metric on that day (never assume zero).
  const days = Object.keys(state.entries)
    .filter((k) => Object.keys(state.entries[k]).length > 0)
    .sort();
  if (days.length === 0 || state.metrics.length === 0) return null;

  const header = ["date", ...state.metrics.map((m) => csvEscape(m.name))].join(",");
  const rows = [header];

  const cursor = new Date(days[0] + "T12:00:00");
  const last = todayKey();
  for (let key = dateToKey(cursor); key <= last; cursor.setDate(cursor.getDate() + 1), key = dateToKey(cursor)) {
    const day = state.entries[key] || {};
    const cells = state.metrics.map((m) => {
      const v = day[m.id];
      return v === undefined ? "" : csvEscape(String(v));
    });
    rows.push([key, ...cells].join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

function csvEscape(s) {
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ---------- helpers ---------- */

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function stepDecimals(step) {
  const s = String(step);
  return s.includes(".") ? Math.min(s.split(".")[1].length, 4) : 0;
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : "m" + Date.now() + Math.random().toString(36).slice(2);
}

function download(content, filename, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let toastTimer = null;
// action = { label, run } adds a button (e.g. Undo) to the toast.
function toast(message, ms = 3000, action = null) {
  const t = document.getElementById("toast");
  t.replaceChildren(el("span", "", message));
  if (action) {
    const btn = el("button", "toast-action", action.label);
    btn.addEventListener("click", () => {
      t.hidden = true;
      action.run();
    });
    t.append(btn);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------- day rollover while the page stays open ---------- */

function checkRollover() {
  if (renderedDay !== null && renderedDay !== todayKey()) {
    // Follow the new day unless the user had deliberately gone back in time.
    if (selectedDay === renderedDay) selectedDay = todayKey();
    render();
  }
}

setInterval(checkRollover, 30 * 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkRollover();
});

render();
if (isSaveBlocked()) {
  toast("Your data was saved by a newer version of this app. Reload to update — nothing will be saved until then.", 8000);
}
