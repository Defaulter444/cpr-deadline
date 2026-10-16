import test from "node:test";
import assert from "node:assert/strict";
import { DeadlineHUD } from "../scripts/hud.js";
import { DEFAULT_STATE, transition, remainingMs } from "../scripts/timer-state.js";

const NOW = 1760000000000;

// Only the DOM boundary is stubbed: update(), view sync, countdown derivation,
// collapse persistence, and positioning all run through the actual HUD methods.
function element() {
  const classes = new Set();
  return {
    textContent: "", hidden: false, dataset: {}, attributes: {}, firstElementChild: {},
    style: { setProperty(name, value) { this[name] = value; } },
    classList: {
      contains: (name) => classes.has(name),
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    getBoundingClientRect() {
      return { left: parseFloat(this.style.left) || 0, top: parseFloat(this.style.top) || 0,
        width: 300, height: classes.has("cprd-collapsed") ? 36 : 180 };
    },
  };
}

globalThis.window = { innerWidth: 1600, innerHeight: 1000 };
globalThis.document = { querySelector: () => null };

function fixture({ gm = true, state = DEFAULT_STATE, time = NOW, view = { collapsed: false, x: 320, y: 90 } } = {}) {
  let savedView = structuredClone(view);
  let currentState = state;
  let currentTime = time;
  let writes = 0;
  const hud = new DeadlineHUD({
    getState: () => currentState, now: () => currentTime, isGM: () => gm,
    command: () => assert.fail("HUD updates must not write authoritative countdown state"),
    configure: () => {}, getView: () => savedView,
    saveView: async (value) => { writes += 1; savedView = structuredClone(value); },
  });
  hud.element = element();
  hud._refs = Object.fromEntries(["header", "dot", "compactLabel", "compactTime", "collapse", "playback",
    "settings", "caption", "time", "body", "status", "visibility", "progressFill"].map((name) => [name, element()]));
  return {
    hud,
    update(nextState = currentState, nextTime = currentTime) {
      currentState = nextState;
      currentTime = nextTime;
      hud.update();
    },
    view: () => savedView,
    writes: () => writes,
  };
}

for (const gm of [false, true]) {
  for (const visible of [false, true]) {
    const idle = { ...DEFAULT_STATE, visible, durationMs: 10000, remainingMs: 10000 };
    const running = transition(idle, { type: "start" }, NOW);
    const paused = transition(running, { type: "pause" }, NOW + 2000);
    for (const [status, state, time] of [
      ["idle", idle, NOW], ["running", running, NOW + 2000],
      ["paused", paused, NOW + 3000], ["expired", running, NOW + 10000],
    ]) {
      test(`${gm ? "GM" : "player"}: ${status}, show players=${visible}`, () => {
        const frozenState = Object.freeze(structuredClone(state));
        const h = fixture({ gm, state: frozenState, time });
        h.update();
        assert.equal(h.hud.element.dataset.status, status);
        assert.equal(h.hud.element.hidden, status !== "running" || (!gm && !visible));
        assert.deepEqual(frozenState, state, "rendering must not change the countdown");
        assert.equal(h.writes(), 0, "rendering must not rewrite local preferences");
      });
    }
  }
}

test("deadline alone hides the HUD at zero without needing a GM state update", () => {
  const running = Object.freeze(transition({ ...DEFAULT_STATE, visible: true }, { type: "start" }, NOW));
  const h = fixture({ state: running, time: running.deadlineMs - 1 });
  h.update();
  assert.equal(h.hud.element.hidden, false);
  assert.equal(h.hud._refs.time.textContent, "00:01");
  h.update(running, running.deadlineMs);
  assert.equal(h.hud.element.hidden, true);
  assert.equal(h.hud.element.dataset.status, "expired");
  assert.equal(running.status, "running", "expiry remains derived from the unchanged server deadline");
});

test("player visibility changes and a fresh HUD retain the running countdown", () => {
  const running = transition(DEFAULT_STATE, { type: "start" }, NOW);
  const snapshot = structuredClone(running);
  const h = fixture({ gm: false, state: running });
  h.update(running, NOW + 25000);
  assert.equal(h.hud.element.hidden, true);
  assert.equal(h.hud._refs.time.textContent, "09:35");
  const shown = transition(running, { type: "visibility", visible: true }, NOW + 30000);
  h.update(shown, NOW + 30000);
  assert.equal(h.hud.element.hidden, false);
  assert.equal(h.hud._refs.time.textContent, "09:30");
  assert.equal(shown.deadlineMs, snapshot.deadlineMs);
  assert.equal(shown.runId, snapshot.runId);
  assert.deepEqual(running, snapshot);
  const reloaded = fixture({ gm: false, state: shown, time: NOW + 45000 });
  reloaded.update();
  assert.equal(reloaded.hud._refs.time.textContent, "09:15");
  assert.equal(reloaded.hud.element.hidden, false);
});

test("pause/resume, reset and expiry preserve collapse and dragged position", async () => {
  let state = transition({ ...DEFAULT_STATE, visible: true }, { type: "start" }, NOW);
  const h = fixture({ state });
  h.update();
  await h.hud.toggleCollapsed();
  const savedView = structuredClone(h.view());
  assert.equal(savedView.collapsed, true);
  assert.equal(h.writes(), 1);
  state = transition(state, { type: "pause" }, NOW + 12000);
  h.update(state, NOW + 12000);
  assert.equal(h.hud.element.hidden, true);
  state = transition(state, { type: "start" }, NOW + 32000);
  h.update(state, NOW + 32000);
  assert.equal(h.hud.element.hidden, false);
  assert.equal(remainingMs(state, NOW + 32000), 588000);
  assert.equal(h.hud.element.classList.contains("cprd-collapsed"), true);
  assert.equal(h.hud._refs.body.hidden, true);
  assert.equal(h.hud.element.style.left, "320px");
  assert.equal(h.hud.element.style.top, "90px");
  h.update(state, state.deadlineMs);
  assert.equal(h.hud.element.hidden, true);
  state = transition(state, { type: "reset" }, state.deadlineMs);
  h.update(state);
  assert.equal(h.hud.element.hidden, true);
  assert.deepEqual(h.view(), savedView);
  assert.equal(h.writes(), 1, "automatic visibility changes do not reset client preferences");
});
