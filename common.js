"use strict";

/* ============================================================
 * dataknows.me — shared storage, schema and date helpers.
 * Loaded before app.js / analysis.js, and by the Node tests.
 * ============================================================ */

// Never rename this key: existing users' data lives under it.
const STORAGE_KEY = "dataknowsme.v1";
// Copy of the data taken just before a backup restore replaces it.
const SNAPSHOT_KEY = "dataknowsme.v1.pre-restore";
// Unparseable saved data is moved here instead of being overwritten.
const CORRUPT_KEY = "dataknowsme.v1.corrupt";
// Device-local settings (backup reminders etc.); not part of backups.
const META_KEY = "dataknowsme.meta";

const CURRENT_VERSION = 1;
const DAY_ROLLOVER_HOUR = 3; // day resets at 3:00 local time
const METRIC_TYPES = ["integer", "category", "float"];

/* ---------- schema ----------
 * state = {
 *   version,
 *   metrics: [{ id, name, type, deleted?, ...type fields }],
 *   entries: { "YYYY-MM-DD": { metricId: value } },
 * }
 * Deleted metrics keep their id and history; they are only hidden.
 */

// Each step upgrades a state from version N to N + 1. Add new steps here and
// bump CURRENT_VERSION; never remove old ones — old backups still need them.
const MIGRATIONS = {
  // 1: (s) => { ...; s.version = 2; return s; },
};

function emptyState() {
  return { version: CURRENT_VERSION, metrics: [], entries: {} };
}

function hasStateShape(s) {
  return !!s && typeof s === "object" && Array.isArray(s.metrics) &&
    !!s.entries && typeof s.entries === "object" && !Array.isArray(s.entries);
}

function migrate(s) {
  if (typeof s.version !== "number") s.version = 1;
  if (s.version > CURRENT_VERSION) {
    throw new Error("This data was made by a newer version of dataknows.me.");
  }
  while (s.version < CURRENT_VERSION) {
    const step = MIGRATIONS[s.version];
    if (!step) throw new Error(`No migration from version ${s.version}.`);
    s = step(s);
  }
  return s;
}

/* ---------- persistence ---------- */

// Set when the stored data can't be used by this version of the code (it was
// written by a newer version). Saving is then refused so it can't be clobbered.
let saveBlocked = false;

function loadState() {
  saveBlocked = false;
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    console.error("Storage unavailable", e);
    return emptyState();
  }
  if (raw === null) return emptyState();

  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!hasStateShape(parsed)) throw new Error("unexpected shape");
  } catch (e) {
    // Keep the unreadable data aside so the next save can't destroy it.
    console.error("Could not read saved state", e);
    try {
      const key = localStorage.getItem(CORRUPT_KEY) === null ? CORRUPT_KEY : `${CORRUPT_KEY}.${Date.now()}`;
      localStorage.setItem(key, raw);
    } catch (_) { /* nothing more we can do */ }
    return emptyState();
  }

  try {
    return migrate(parsed);
  } catch (e) {
    console.error(e);
    saveBlocked = true;
    return emptyState();
  }
}

function isSaveBlocked() {
  return saveBlocked;
}

// Returns false if the write failed (storage full, private mode, …).
function saveState(s) {
  if (saveBlocked) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    return true;
  } catch (e) {
    console.error("Could not save", e);
    return false;
  }
}

function loadMeta() {
  try {
    const m = JSON.parse(localStorage.getItem(META_KEY) || "{}");
    return m && typeof m === "object" ? m : {};
  } catch (e) {
    return {};
  }
}

function updateMeta(changes) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify({ ...loadMeta(), ...changes }));
  } catch (e) {
    console.error("Could not save settings", e);
  }
}

/* ---------- backup validation ---------- */

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Checks an imported backup and returns a clean, migrated state. Throws with a
// user-readable message if the metric definitions are unusable; individual
// entry values that aren't numbers or strings are dropped.
function validateBackup(parsed) {
  if (!hasStateShape(parsed)) throw new Error("Not a dataknows.me backup.");
  const s = migrate({ ...parsed });

  const ids = new Set();
  const metrics = s.metrics.map((m, i) => {
    const where = `Metric ${i + 1}`;
    if (!m || typeof m !== "object") throw new Error(`${where} is not valid.`);
    if (typeof m.id !== "string" || !m.id) throw new Error(`${where} has no id.`);
    if (ids.has(m.id)) throw new Error(`${where} repeats an id.`);
    ids.add(m.id);
    if (typeof m.name !== "string") throw new Error(`${where} has no name.`);
    if (!METRIC_TYPES.includes(m.type)) throw new Error(`“${m.name}” has an unknown type.`);

    if (m.type === "category") {
      if (!Array.isArray(m.categories) || m.categories.length === 0 ||
          !m.categories.every((c) => typeof c === "string")) {
        throw new Error(`“${m.name}” has invalid options.`);
      }
    } else {
      if (!Number.isFinite(m.min) || !Number.isFinite(m.max) || !(m.max > m.min)) {
        throw new Error(`“${m.name}” has an invalid range.`);
      }
      if (m.type === "float" && !(Number.isFinite(m.step) && m.step > 0)) {
        throw new Error(`“${m.name}” has an invalid step.`);
      }
    }
    return { ...m, deleted: m.deleted === true || undefined };
  });

  const entries = {};
  for (const [key, day] of Object.entries(s.entries)) {
    if (!DAY_KEY_RE.test(key) || !day || typeof day !== "object") continue;
    const clean = {};
    for (const [id, v] of Object.entries(day)) {
      if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "string") clean[id] = v;
    }
    if (Object.keys(clean).length) entries[key] = clean;
  }

  return { ...s, metrics, entries };
}

/* ---------- metrics & values ---------- */

function activeMetrics(s) {
  return s.metrics.filter((m) => !m.deleted);
}

// A number from a stored value, or null. Numeric category options ("-1")
// count; empty strings don't.
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// The stored value as the metric's current type expects it, or undefined when
// it doesn't fit (e.g. the metric changed type after it was recorded). The
// stored value itself is never modified.
function coerceValue(metric, v) {
  if (v === undefined || v === null) return undefined;
  if (metric.type === "category") {
    return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
  }
  const n = toNumber(v);
  return n === null ? undefined : n;
}

/* ---------- days (3 a.m. cutoff) ---------- */

function dateToKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function keyToDate(key) {
  return new Date(key + "T12:00:00");
}

function addDays(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dateToKey(d);
}

// Before 3 a.m. local time, entries still count for the previous day. Uses
// the local clock hour rather than "now minus 3 h" so DST changes don't shift
// the cutoff.
function todayKey(now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < DAY_ROLLOVER_HOUR) d.setDate(d.getDate() - 1);
  return dateToKey(d);
}

/* ---------- DOM helpers ---------- */

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    STORAGE_KEY, SNAPSHOT_KEY, CORRUPT_KEY, META_KEY, CURRENT_VERSION, MIGRATIONS,
    emptyState, migrate, loadState, saveState, isSaveBlocked, loadMeta, updateMeta, validateBackup,
    activeMetrics, toNumber, coerceValue, dateToKey, keyToDate, addDays, todayKey, esc,
  };
}
