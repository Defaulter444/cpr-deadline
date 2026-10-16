import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STATE, remainingMs } from "../scripts/timer-state.js";

// These mock only Foundry's settings boundary: writes become visible after acknowledgement.
const callbacks = new Map();
const registeredMenus = new Map();
let saved = structuredClone(DEFAULT_STATE);
let writeImpl;
const writes = [];
const NOW = 1760000000000;
globalThis.FormApplication = class { static get defaultOptions() { return {}; } };
globalThis.Hooks = {
  once: (name, callback) => callbacks.set(name, callback),
  on: () => {}
};
globalThis.game = {
  user: { isGM: true },
  time: { serverTime: NOW },
  settings: {
    get: () => structuredClone(saved),
    set: async (_module, _key, value) => {
      writes.push(structuredClone(value));
      await writeImpl?.(value);
      saved = structuredClone(value);
      return value;
    },
    register: () => {},
    registerMenu: (_module, key, value) => registeredMenus.set(key, value)
  },
  keybindings: { register: () => {} }
};
globalThis.foundry = { utils: { mergeObject: (base, patch) => ({ ...base, ...patch }) } };

const { command } = await import("../scripts/main.js");
callbacks.get("init")();
const Config = registeredMenus.get("configure").type;

function reset() {
  saved = structuredClone(DEFAULT_STATE);
  writes.length = 0;
  writeImpl = undefined;
  game.user.isGM = true;
  game.time.serverTime = NOW;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("a player cannot invoke GM commands or write authoritative timer settings", async () => {
  reset();
  game.user.isGM = false;
  await assert.rejects(command({ type: "start" }), /только ведущий/);
  await assert.rejects(new Config()._apply({ duration: "10:00", warningSeconds: 60 }), /только ведущий/);
  assert.equal(writes.length, 0);
  assert.deepEqual(saved, DEFAULT_STATE);
  // A denied command must not poison subsequent authorized work.
  game.user.isGM = true;
  await command({ type: "start" });
  assert.equal(saved.status, "running");
});

test("rapid commands wait for persisted state and both time adjustments are retained", async () => {
  reset();
  const firstWriteEntered = deferred();
  const releaseFirstWrite = deferred();
  writeImpl = async () => {
    if (writes.length === 1) {
      firstWriteEntered.resolve();
      await releaseFirstWrite.promise;
    }
  };
  const first = command({ type: "adjust", deltaMs: 60000 });
  const second = command({ type: "adjust", deltaMs: 60000 });
  await firstWriteEntered.promise;
  assert.equal(writes.length, 1, "the second write must wait for the first server acknowledgement");
  assert.equal(saved.remainingMs, 600000);
  releaseFirstWrite.resolve();
  await Promise.all([first, second]);
  assert.equal(saved.remainingMs, 720000, "the second action must use the newly persisted state");
  assert.equal(writes.length, 2);
});

test("network write failure rejects its command and does not block later commands", async () => {
  reset();
  writeImpl = async () => { throw new Error("Disconnected"); };
  await assert.rejects(command({ type: "start" }), /Disconnected/);
  assert.equal(saved.status, "idle");
  writeImpl = undefined;
  await command({ type: "start" });
  assert.equal(saved.status, "running");
  assert.equal(writes.length, 2);
});

test("repeated start does not write or shift a running deadline", async () => {
  reset();
  await command({ type: "start" });
  const deadline = saved.deadlineMs;
  game.time.serverTime += 2000;
  await command({ type: "start" });
  assert.equal(saved.deadlineMs, deadline);
  assert.equal(writes.length, 1);
});

test("form accepts both native and Foundry checkbox data and clears unchecked visibility", async () => {
  reset();
  const config = new Config();
  const fields = { label: "Evacuate", duration: "10:00", warningSeconds: "60" };
  await config._apply({ ...fields, visible: "on" });
  assert.equal(saved.visible, true);
  await config._apply(fields);
  assert.equal(saved.visible, false);
  await config._apply({ ...fields, visible: true });
  assert.equal(saved.visible, true);
  await config._apply({ ...fields, visible: false });
  assert.equal(saved.visible, false);
});

test("saving form metadata while running preserves elapsed time and deadline", async () => {
  reset();
  await command({ type: "start" });
  const deadline = saved.deadlineMs;
  const runId = saved.runId;
  game.time.serverTime += 25000;
  await new Config()._apply({ label: "New threat", duration: "10:00", warningSeconds: "30", visible: true });
  assert.equal(saved.label, "New threat");
  assert.equal(saved.status, "running");
  assert.equal(saved.deadlineMs, deadline);
  assert.equal(saved.runId, runId);
  assert.equal(remainingMs(saved, game.time.serverTime), 575000);
});

test("invalid form input is rejected before any persistent timer update", async () => {
  reset();
  const config = new Config();
  await assert.rejects(config._apply({ duration: "1:99", warningSeconds: "60" }), /Введите время/);
  await assert.rejects(config._apply({ duration: "01:00", warningSeconds: "1.5" }), /Порог предупреждения/);
  assert.equal(writes.length, 0);
});

test("form saves native and Foundry sound checkboxes, source, and percentage volume", async () => {
  reset();
  const config = new Config();
  const fields = { duration: "10:00", warningSeconds: "60", soundSrc: "  audio/end.ogg  ", soundPercent: "25" };
  for (const [soundEnabled, expected] of [["on", true], [true, true], [false, false], [undefined, false]]) {
    await config._apply({ ...fields, soundEnabled });
    assert.equal(saved.soundEnabled, expected);
    assert.equal(saved.soundSrc, "audio/end.ogg");
    assert.equal(saved.soundVolume, 0.25);
  }
  await config._apply({ ...fields, soundEnabled: true, soundSrc: "", soundPercent: "0" });
  assert.equal(saved.soundSrc, "");
  assert.equal(saved.soundVolume, 0, "zero is a valid, explicit mute");
  assert.equal(config.getData().soundPercent, 0);
});

test("changing sound in the form leaves the active countdown intact", async () => {
  reset();
  await command({ type: "start" });
  const deadline = saved.deadlineMs;
  const runId = saved.runId;
  game.time.serverTime += 25000;
  await new Config()._apply({ label: saved.label, duration: "10:00", warningSeconds: "60",
    soundEnabled: "on", soundSrc: "audio/end.wav", soundPercent: "35" });
  assert.equal(saved.soundVolume, 0.35);
  assert.equal(saved.soundEnabled, true);
  assert.equal(saved.soundSrc, "audio/end.wav");
  assert.equal(saved.status, "running");
  assert.equal(saved.deadlineMs, deadline);
  assert.equal(saved.runId, runId);
  assert.equal(remainingMs(saved, game.time.serverTime), 575000);
});

test("invalid sound form data cannot persist a partial timer update", async () => {
  reset();
  const config = new Config();
  const fields = { label: "Must not save", duration: "01:00", warningSeconds: "60", soundEnabled: "on" };
  for (const soundPercent of ["-1", "101", "not-a-number", "Infinity"]) {
    await assert.rejects(config._apply({ ...fields, soundPercent }), /Громкость/);
  }
  await assert.rejects(config._apply({ ...fields, soundPercent: "60", soundSrc: "javascript:alert(1)" }), /аудиофайл/);
  assert.equal(writes.length, 0);
  assert.deepEqual(saved, DEFAULT_STATE);
});
