import test from "node:test";
import assert from "node:assert/strict";
import {
  MODULE_ID, MAX_DURATION_MS, DEFAULT_STATE, normalizeState, remainingMs,
  displayTime, statusOf, transition, parseDuration
} from "../scripts/timer-state.js";

const NOW = 1760000000000;
const start = (durationMs = 600000) => transition(
  transition(DEFAULT_STATE, { type: "configure", durationMs, visible: true }, NOW),
  { type: "start" }, NOW
);

test("defaults are stable and callers never mutate the shared default", () => {
  assert.equal(MODULE_ID, "cpr-deadline");
  assert.deepEqual(normalizeState(null), DEFAULT_STATE);
  assert.ok(Object.isFrozen(DEFAULT_STATE));
  const before = structuredClone(DEFAULT_STATE);
  transition(DEFAULT_STATE, { type: "configure", label: "Escape", durationMs: 5000 }, NOW);
  assert.deepEqual(DEFAULT_STATE, before);
});

test("elapsed real time survives reload and background-tab gaps without accumulated ticks", () => {
  const state = start();
  const reloaded = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.equal(remainingMs(reloaded, NOW + 180123), 419877);
  assert.equal(displayTime(remainingMs(reloaded, NOW + 180123)), "07:00");
  assert.equal(remainingMs(reloaded, NOW + 900000), 0);
  assert.equal(statusOf(reloaded, NOW + 900000), "expired");
  assert.equal(state.status, "running", "derived expiry does not mutate persisted state");
});

test("pause/resume freezes a precise remainder and retains the same run identifier", () => {
  const state = start(10000);
  const paused = transition(state, { type: "pause" }, NOW + 3456);
  assert.equal(paused.status, "paused");
  assert.equal(paused.remainingMs, 6544);
  assert.equal(paused.deadlineMs, null);
  assert.equal(remainingMs(paused, NOW + 100000), 6544);
  const resumed = transition(paused, { type: "start" }, NOW + 100000);
  assert.equal(resumed.deadlineMs, NOW + 106544);
  assert.equal(resumed.runId, state.runId);
  assert.equal(remainingMs(resumed, NOW + 101000), 5544);
});

test("active start is idempotent; starting expired timer creates a full new run", () => {
  const state = start(5000);
  assert.deepEqual(transition(state, { type: "start" }, NOW + 1000), state);
  const restarted = transition(state, { type: "start" }, NOW + 9000);
  assert.equal(restarted.deadlineMs, NOW + 14000);
  assert.equal(restarted.remainingMs, 5000);
  assert.notEqual(restarted.runId, state.runId);
  assert.deepEqual(transition(state, { type: "pause" }, NOW + 9000), state);
});

test("metadata changes while running preserve deadline, duration, remainder and runId", () => {
  const state = start(60000);
  const changed = transition(state, {
    type: "configure", label: "Extraction", warningSeconds: 15, visible: false
  }, NOW + 20000);
  assert.equal(changed.label, "Extraction");
  assert.equal(changed.warningSeconds, 15);
  assert.equal(changed.visible, false);
  for (const key of ["deadlineMs", "durationMs", "remainingMs", "status", "runId"]) {
    assert.equal(changed[key], state[key]);
  }
  assert.equal(remainingMs(changed, NOW + 20000), 40000);
});

test("explicit duration configure replaces the countdown; reset restores configured duration", () => {
  const state = start(10000);
  const configured = transition(state, { type: "configure", durationMs: 90000 }, NOW + 1000);
  assert.equal(configured.status, "idle");
  assert.equal(configured.durationMs, 90000);
  assert.equal(configured.remainingMs, 90000);
  assert.equal(configured.deadlineMs, null);
  assert.notEqual(configured.runId, state.runId);
  assert.equal(configured.visible, true);
  const adjusted = transition(state, { type: "adjust", deltaMs: 60000 }, NOW + 2000);
  const reset = transition(adjusted, { type: "reset" }, NOW + 3000);
  assert.equal(reset.status, "idle");
  assert.equal(reset.remainingMs, 10000);
  assert.equal(reset.durationMs, 10000);
  assert.equal(reset.visible, true);
  assert.notEqual(reset.runId, adjusted.runId);
});

test("adjust accounts for elapsed time, clamps bounds, and can revive an expired run", () => {
  const state = start(10000);
  const added = transition(state, { type: "adjust", deltaMs: 30000 }, NOW + 7500);
  assert.equal(added.deadlineMs, NOW + 40000);
  assert.equal(remainingMs(added, NOW + 7500), 32500);
  assert.equal(added.durationMs, 10000);
  assert.equal(added.runId, state.runId);
  const exhausted = transition(added, { type: "adjust", deltaMs: -100000 }, NOW + 8000);
  assert.equal(statusOf(exhausted, NOW + 8000), "expired");
  const revived = transition(exhausted, { type: "adjust", deltaMs: 1000 }, NOW + 9000);
  assert.equal(remainingMs(revived, NOW + 9000), 1000);
  assert.notEqual(revived.runId, exhausted.runId);
  assert.equal(remainingMs(transition(state, { type: "adjust", deltaMs: 1e15 }, NOW), NOW), MAX_DURATION_MS);
});

test("adjusting a paused or idle timer keeps it stopped; visibility never changes time", () => {
  const paused = transition(start(10000), { type: "pause" }, NOW + 2000);
  const adjusted = transition(paused, { type: "adjust", deltaMs: -3000 }, NOW + 9000);
  assert.equal(adjusted.status, "paused");
  assert.equal(adjusted.remainingMs, 5000);
  const idle = transition(DEFAULT_STATE, { type: "adjust", deltaMs: 1000 }, NOW);
  assert.equal(idle.status, "idle");
  assert.equal(idle.remainingMs, 601000);
  const hidden = transition(adjusted, { type: "visibility", visible: false }, NOW);
  assert.deepEqual({ ...hidden, visible: adjusted.visible }, adjusted);
});

test("normalization repairs corrupt state and clamps oversized input without NaN", () => {
  const state = normalizeState({
    schema: 999, label: "  \n" + "😀".repeat(200), durationMs: Infinity,
    remainingMs: NaN, deadlineMs: Infinity, status: "running", visible: "false",
    warningSeconds: -10, runId: null
  });
  assert.equal(state.schema, 1);
  assert.equal(Array.from(state.label).length, 160);
  assert.equal(state.durationMs, 600000);
  assert.equal(state.remainingMs, 600000);
  assert.equal(state.status, "paused");
  assert.equal(state.deadlineMs, null);
  assert.equal(state.visible, false);
  assert.equal(state.warningSeconds, 0);
  assert.equal(state.runId, "");
  assert.equal(normalizeState({ durationMs: -30 }).durationMs, 1000);
  assert.equal(normalizeState({ durationMs: 1e100 }).durationMs, MAX_DURATION_MS);
  assert.equal(normalizeState({ remainingMs: -5 }).remainingMs, 0);
  assert.equal(normalizeState({ remainingMs: 1e100 }).remainingMs, MAX_DURATION_MS);
  assert.equal(normalizeState({ status: "unknown", deadlineMs: NOW }).deadlineMs, null);
  assert.deepEqual(normalizeState([]), DEFAULT_STATE);
});

test("display rounds upward, stops at zero, and handles hour and maximum boundaries", () => {
  for (const [ms, output] of [
    [1, "00:01"], [999, "00:01"], [1000, "00:01"], [1001, "00:02"],
    [59000, "00:59"], [59999, "01:00"], [3599000, "59:59"],
    [3599001, "01:00:00"], [3600000, "01:00:00"],
    [MAX_DURATION_MS, "99:59:59"], [MAX_DURATION_MS + 1, "99:59:59"],
    [0, "00:00"], [-100, "00:00"], [NaN, "00:00"], [Infinity, "00:00"]
  ]) assert.equal(displayTime(ms), output);
});

test("duration parsing supports seconds, MM:SS and HH:MM:SS", () => {
  for (const [input, expected] of [
    ["1", 1000], [600, 600000], [" 90 ", 90000], ["01:30", 90000],
    ["1:5", 65000], ["59:59", 3599000], ["01:02:03", 3723000],
    ["99:59:59", MAX_DURATION_MS], ["359999", MAX_DURATION_MS]
  ]) assert.equal(parseDuration(input), expected);
});

test("duration parsing rejects invalid components, zero, fractions and unbounded values", () => {
  for (const input of [
    "", " ", "0", "00:00", "1.5", "-10", "+10", "1e3", "0x10", "1:60",
    "60:00", "100:00:00", "1:2:60", "1:2:3:4", "00:000", "abc", "3m",
    "1 :00", "360000", "99999999999999999999999", Infinity, NaN, null, {}, []
  ]) assert.throws(() => parseDuration(input), RangeError, String(input));
});

test("mutations reject invalid numeric inputs instead of persisting a damaged countdown", () => {
  for (const value of [NaN, Infinity, -Infinity, "1000", 0, 999, MAX_DURATION_MS + 1]) {
    assert.throws(() => transition(DEFAULT_STATE, { type: "configure", durationMs: value }, NOW), RangeError);
  }
  for (const value of [NaN, Infinity, "1000", undefined]) {
    assert.throws(() => transition(DEFAULT_STATE, { type: "adjust", deltaMs: value }, NOW), RangeError);
  }
  assert.throws(() => transition(DEFAULT_STATE, { type: "visibility", visible: "false" }, NOW), TypeError);
  assert.throws(() => transition(DEFAULT_STATE, { type: "unknown" }, NOW), RangeError);
  assert.throws(() => transition(DEFAULT_STATE, null, NOW), TypeError);
  for (const now of [NaN, Infinity, -1, undefined, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => transition(DEFAULT_STATE, { type: "start" }, now), RangeError);
    assert.throws(() => remainingMs(start(), now), RangeError);
  }
});
