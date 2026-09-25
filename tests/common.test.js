// Run with: node --test tests/
"use strict";

// Fixed zone with DST so the day-cutoff tests are deterministic.
process.env.TZ = "Europe/London";

const test = require("node:test");
const assert = require("node:assert/strict");

// Minimal in-memory localStorage.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const c = require("../common.js");

test.beforeEach(() => {
  store.clear();
  c.loadState(); // resets the save block
});

/* ---------- days ---------- */

test("todayKey: before 3 a.m. counts as the previous day", () => {
  assert.equal(c.todayKey(new Date(2026, 4, 10, 2, 59)), "2026-05-09");
  assert.equal(c.todayKey(new Date(2026, 4, 10, 3, 0)), "2026-05-10");
  assert.equal(c.todayKey(new Date(2026, 4, 10, 23, 59)), "2026-05-10");
});

test("todayKey: crosses month and year boundaries", () => {
  assert.equal(c.todayKey(new Date(2026, 0, 1, 1, 0)), "2025-12-31");
  assert.equal(c.todayKey(new Date(2026, 2, 1, 0, 30)), "2026-02-28");
});

test("todayKey: cutoff stays at 3:00 on DST change days", () => {
  // UK clocks go forward 29 Mar 2026 and back 25 Oct 2026.
  assert.equal(c.todayKey(new Date(2026, 2, 29, 3, 30)), "2026-03-29");
  assert.equal(c.todayKey(new Date(2026, 2, 29, 2, 59)), "2026-03-28");
  assert.equal(c.todayKey(new Date(2026, 9, 25, 2, 30)), "2026-10-24");
  assert.equal(c.todayKey(new Date(2026, 9, 25, 3, 0)), "2026-10-25");
});

test("addDays handles month ends and DST", () => {
  assert.equal(c.addDays("2026-03-28", 1), "2026-03-29");
  assert.equal(c.addDays("2026-03-29", 1), "2026-03-30");
  assert.equal(c.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(c.addDays("2024-03-01", -1), "2024-02-29");
});

/* ---------- load / save / migrate ---------- */

test("loadState returns an empty state when nothing is stored", () => {
  assert.deepEqual(c.loadState(), c.emptyState());
});

test("loadState reads existing v1 data unchanged", () => {
  const data = {
    version: 1,
    metrics: [{ id: "a", name: "Coffee", type: "integer", min: 0, max: 20 }],
    entries: { "2026-01-01": { a: 2 } },
  };
  store.set(c.STORAGE_KEY, JSON.stringify(data));
  assert.deepEqual(c.loadState(), data);
});

test("loadState treats a missing version as v1", () => {
  store.set(c.STORAGE_KEY, JSON.stringify({ metrics: [], entries: {} }));
  assert.equal(c.loadState().version, 1);
});

test("loadState keeps corrupt data aside instead of losing it", () => {
  store.set(c.STORAGE_KEY, "{not json");
  assert.deepEqual(c.loadState(), c.emptyState());
  assert.equal(store.get(c.CORRUPT_KEY), "{not json");
});

test("loadState never lets newer-version data be overwritten", () => {
  const raw = JSON.stringify({ version: c.CURRENT_VERSION + 1, metrics: [], entries: {} });
  store.set(c.STORAGE_KEY, raw);
  c.loadState();
  assert.equal(c.isSaveBlocked(), true);
  assert.equal(c.saveState(c.emptyState()), false);
  assert.equal(store.get(c.STORAGE_KEY), raw);
});

test("migrate refuses data from a newer version", () => {
  assert.throws(() => c.migrate({ version: c.CURRENT_VERSION + 1, metrics: [], entries: {} }), /newer/);
});

test("saveState reports failure instead of throwing", () => {
  const orig = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  try {
    assert.equal(c.saveState(c.emptyState()), false);
  } finally {
    globalThis.localStorage.setItem = orig;
  }
  assert.equal(c.saveState(c.emptyState()), true);
});

/* ---------- values ---------- */

test("coerceValue fits stored values to the metric's type", () => {
  const int = { type: "integer" }, flt = { type: "float" }, cat = { type: "category" };
  assert.equal(c.coerceValue(int, 3), 3);
  assert.equal(c.coerceValue(int, "-1"), -1);
  assert.equal(c.coerceValue(int, "good"), undefined);
  assert.equal(c.coerceValue(int, null), undefined);
  assert.equal(c.coerceValue(flt, "0.5"), 0.5);
  assert.equal(c.coerceValue(flt, ""), undefined);
  assert.equal(c.coerceValue(cat, 2), "2");
  assert.equal(c.coerceValue(cat, "good"), "good");
  assert.equal(c.coerceValue(cat, undefined), undefined);
});
