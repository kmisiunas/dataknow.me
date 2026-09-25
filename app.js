"use strict";

/* ============================================================
 * dataknows.me — daily self-tracking, all data in localStorage
 * ============================================================ */

/* ---------- state ---------- */

// Storage, schema, migrations and day helpers live in common.js.
let state = loadState();

// Returns false (and tells the user) if the data could not be written.
function save() {
  if (saveState(state)) {
    requestPersistence();
    return true;
  }
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
  const day = selectedDay;
  const previous = state.entries[day]?.[metricId];
  delete selectedEntries()[metricId];
  if (!save()) return;
  render();
  if (previous !== undefined) {
    toast("Entry cleared.", 5000, {
      label: "Undo",
      run: () => {
        (state.entries[day] ??= {})[metricId] = previous;
        save();
        render();
      },
    });
  }
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
  renderBanner();

  const metrics = activeMetrics(state);
  if (metrics.length < 2) reordering = false;
  document.body.classList.toggle("reordering", reordering);
  addBtn.textContent = reordering ? "Done" : "+ Add metric";
  emptyEl.hidden = metrics.length > 0;
  listEl.replaceChildren(...metrics.map((m, i) =>
    reordering ? renderReorderRow(m, i, metrics.length) : renderMetricCard(m)));
}

/* Day strip: today on the right, going back in time to the left. Grey =
 * nothing entered, yellow = partially entered, green = every metric entered. */

function dayStatus(key) {
  const metrics = activeMetrics(state);
  if (metrics.length === 0) return "none";
  const day = state.entries[key] || {};
  const filled = metrics.filter((m) => coerceValue(m, day[m.id]) !== undefined).length;
  if (filled === 0) return "none";
  return filled === metrics.length ? "full" : "partial";
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

/* Reorder mode: compact rows with up/down buttons, toggled from the menu. */

let reordering = false;

function renderReorderRow(metric, index, count) {
  const row = el("div", "metric-card reorder-row");
  row.dataset.id = metric.id;
  row.append(el("span", "metric-name", metric.name));
  for (const [dir, symbol, label] of [[-1, "↑", "Move up"], [1, "↓", "Move down"]]) {
    const btn = el("button", "step-btn reorder-btn", symbol);
    btn.dataset.dir = dir;
    btn.setAttribute("aria-label", `${label}: ${metric.name}`);
    btn.disabled = dir < 0 ? index === 0 : index === count - 1;
    btn.addEventListener("click", () => moveMetric(metric.id, dir));
    row.append(btn);
  }
  return row;
}

// Swaps a metric with its visible neighbour; deleted metrics keep their slots.
function moveMetric(id, dir) {
  const visible = activeMetrics(state);
  const j = visible.findIndex((m) => m.id === id) + dir;
  if (j < 0 || j >= visible.length) return;
  const a = state.metrics.findIndex((m) => m.id === id);
  const b = state.metrics.indexOf(visible[j]);
  [state.metrics[a], state.metrics[b]] = [state.metrics[b], state.metrics[a]];
  save();
  render();
  // Keep focus on the moved metric's button so repeated taps/keys keep working.
  const btn = listEl.querySelector(`[data-id="${CSS.escape(id)}"] [data-dir="${dir}"]`);
  (btn && !btn.disabled ? btn : listEl.querySelector(`[data-id="${CSS.escape(id)}"] button:not(:disabled)`))?.focus();
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
    chip.setAttribute("aria-pressed", String(value === option));
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

/* ---------- keeping data safe: persistence, install hint, backups ---------- */

const DAY_MS = 24 * 3600 * 1000;
const BACKUP_REMIND_DAYS = 14;
const BACKUP_SNOOZE_DAYS = 3;
const INSTALL_HINT_SNOOZE_DAYS = 14;

// Ask the browser not to evict our storage under pressure. Chrome decides
// silently; Firefox may ask the user, so only ask once there is data.
let persistRequested = false;
function requestPersistence() {
  if (persistRequested || !navigator.storage?.persist || activeMetrics(state).length === 0) return;
  persistRequested = true;
  navigator.storage.persisted()
    .then((already) => already || navigator.storage.persist())
    .catch((e) => console.warn("Persistent storage unavailable", e));
}

// Safari deletes data of sites not opened for 7 days — except Home Screen apps.
function isIOSBrowserTab() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true ||
    matchMedia("(display-mode: standalone)").matches;
  return ios && !standalone;
}

function firstEntryDay() {
  return Object.keys(state.entries).filter((k) => Object.keys(state.entries[k]).length > 0).sort()[0];
}

function daysSince(ms) {
  return Math.floor((Date.now() - ms) / DAY_MS);
}

function markBackedUp() {
  updateMeta({ lastBackupAt: Date.now() });
  render();
}

function backupStatusText() {
  const last = loadMeta().lastBackupAt;
  if (!last) return "No backup yet.";
  const d = daysSince(last);
  return "Last backup: " + (d === 0 ? "today." : d === 1 ? "yesterday." : `${d} days ago.`);
}

function backupOverdue(meta) {
  const first = firstEntryDay();
  if (!first) return false;
  const since = meta.lastBackupAt ?? keyToDate(first).getTime();
  if (daysSince(since) < BACKUP_REMIND_DAYS) return false;
  return !meta.backupSnoozedAt || daysSince(meta.backupSnoozedAt) >= BACKUP_SNOOZE_DAYS;
}

const bannerEl = document.getElementById("banner");

function renderBanner() {
  const meta = loadMeta();
  let text = null, snooze = null;

  if (isIOSBrowserTab() && activeMetrics(state).length > 0 &&
      (!meta.installHintSnoozedAt || daysSince(meta.installHintSnoozedAt) >= INSTALL_HINT_SNOOZE_DAYS)) {
    text = "Safari clears data of sites you haven’t opened for 7 days. To keep your data safe, " +
      "tap Share → “Add to Home Screen”. The app there starts empty: download a backup here " +
      "first, then restore it in the app.";
    snooze = { installHintSnoozedAt: Date.now() };
  } else if (backupOverdue(meta)) {
    text = (meta.lastBackupAt ? backupStatusText() : "You haven’t backed up yet.") +
      " Your data lives only on this device — save a copy somewhere safe.";
    snooze = { backupSnoozedAt: Date.now() };
  }

  bannerEl.hidden = text === null;
  if (text === null) return;

  const backupBtn = el("button", "primary-btn banner-btn", "Back up");
  backupBtn.addEventListener("click", () => document.getElementById("menu-btn").click());
  const laterBtn = el("button", "ghost-btn banner-btn", "Later");
  laterBtn.addEventListener("click", () => {
    updateMeta(snooze);
    render();
  });
  const actions = el("div", "banner-actions");
  actions.append(backupBtn, laterBtn);
  bannerEl.replaceChildren(el("p", "banner-text", text), actions);
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

const addBtn = document.getElementById("add-metric-btn");
addBtn.addEventListener("click", () => {
  if (reordering) {
    reordering = false;
    render();
  } else {
    openMetricDialog(null);
  }
});

document.getElementById("reorder-btn").addEventListener("click", () => {
  reordering = true;
  menuDialog.close();
  render();
});

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
    // Re-adding a deleted metric's name brings it back with its history
    // (days while it was deleted simply stay empty).
    const i = state.metrics.findIndex((m) => m.deleted && sameName(m.name, name));
    if (i !== -1) {
      metric.id = state.metrics[i].id;
      state.metrics[i] = metric;
      toast(`“${name}” is back, with its earlier history.`, 5000);
    } else {
      state.metrics.push(metric);
    }
  }
  save();
  render();
});

function sameName(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function invalid(e, message) {
  // Shown inline: a toast would be hidden behind the dialog backdrop.
  e.preventDefault();
  const err = document.getElementById("form-error");
  err.textContent = message;
  err.hidden = false;
}

// Deleting only hides the metric: its recorded history is kept, and comes
// back if the deletion is undone or a metric with the same name is added.
deleteBtn.addEventListener("click", () => {
  const metric = state.metrics.find((m) => m.id === editingId);
  metric.deleted = true;
  metricDialog.close();
  if (!save()) {
    delete metric.deleted;
    return;
  }
  render();
  toast(`Deleted “${metric.name}”. Its history is kept.`, 6000, {
    label: "Undo",
    run: () => {
      delete metric.deleted;
      save();
      render();
    },
  });
});

/* ---------- menu: export / import ---------- */

const menuDialog = document.getElementById("menu-dialog");
document.getElementById("menu-btn").addEventListener("click", () => {
  document.getElementById("undo-restore-btn").hidden = !hasSnapshot();
  document.getElementById("reorder-btn").hidden = activeMetrics(state).length < 2;
  document.getElementById("backup-status").textContent = backupStatusText();
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
    markBackedUp();
  } catch (err) {
    if (err.name !== "AbortError") {
      toast("Sharing failed — use Download JSON backup instead.");
      console.error(err);
    }
  }
});

document.getElementById("export-json-btn").addEventListener("click", () => {
  markBackedUp();
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
  const metrics = activeMetrics(state);
  const days = Object.keys(state.entries)
    .filter((k) => metrics.some((m) => state.entries[k][m.id] !== undefined))
    .sort();
  if (days.length === 0) return null;

  const header = ["date", ...metrics.map((m) => csvEscape(m.name))].join(",");
  const rows = [header];

  const cursor = new Date(days[0] + "T12:00:00");
  const last = todayKey();
  for (let key = dateToKey(cursor); key <= last; cursor.setDate(cursor.getDate() + 1), key = dateToKey(cursor)) {
    const day = state.entries[key] || {};
    const cells = metrics.map((m) => {
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

/* ---------- other tabs ---------- */

// Fired only when another tab writes storage (no polling), so it costs nothing
// otherwise. Reload so this tab never saves over the other tab's changes.
window.addEventListener("storage", (e) => {
  if (e.key === STORAGE_KEY || e.key === null) state = loadState();
  if (e.key === STORAGE_KEY || e.key === META_KEY || e.key === null) render();
});

setInterval(checkRollover, 30 * 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkRollover();
});

render();
requestPersistence();
if (isSaveBlocked()) {
  toast("Your data was saved by a newer version of this app. Reload to update — nothing will be saved until then.", 8000);
}
