import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ExpirySignal, playSignal } from "../scripts/sound.js";
import { DEFAULT_SOUND, DEFAULT_STATE, cleanSoundSource, normalizeState, remainingMs, transition } from "../scripts/timer-state.js";

const NOW = 1760000000000;
function countdown(overrides = {}) {
  return { ...DEFAULT_STATE, durationMs: 5000, remainingMs: 5000,
    status: "running", deadlineMs: NOW + 5000, runId: "run-one", visible: true, ...overrides };
}
function observer(play) {
  const calls = [];
  const errors = [];
  const signal = new ExpirySignal({ play: play ?? (state => calls.push(state)), onError: error => errors.push(error) });
  return { signal, calls, errors };
}

for (const isGM of [false, true]) {
  test(`${isGM ? "GM" : "player"}: an observed running timer signals exactly once at expiry`, () => {
    const state = Object.freeze(countdown());
    const { signal, calls } = observer();
    signal.update(state, NOW, isGM);
    signal.update(state, NOW + 4999, isGM);
    assert.equal(calls.length, 0);
    signal.update(state, NOW + 5000, isGM);
    signal.update(state, NOW + 5200, isGM);
    signal.update({ ...state, label: "Changed after expiry" }, NOW + 6000, isGM);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].runId, state.runId);
    assert.equal(state.deadlineMs, NOW + 5000, "sound must not rewrite or extend the countdown");
  });
}

test("opening a page on an already expired timer stays silent", () => {
  for (const isGM of [false, true]) {
    const { signal, calls } = observer();
    signal.update(countdown(), NOW + 5000, isGM);
    signal.update(countdown(), NOW + 20000, isGM);
    assert.equal(calls.length, 0);
  }
});

test("idle, pause, and reset never signal, including after the former deadline", () => {
  for (const type of ["pause", "reset"]) {
    const { signal, calls } = observer();
    const state = countdown();
    signal.update(DEFAULT_STATE, NOW, true);
    signal.update(state, NOW, true);
    const stopped = transition(state, { type }, NOW + 2000);
    signal.update(stopped, NOW + 2000, true);
    signal.update(stopped, NOW + 50000, true);
    assert.equal(calls.length, 0, type);
  }
});

test("pausing and resuming the same run signals once at its new deadline", () => {
  const { signal, calls } = observer();
  let state = countdown();
  signal.update(state, NOW, true);
  state = transition(state, { type: "pause" }, NOW + 2000);
  signal.update(state, NOW + 2000, true);
  state = transition(state, { type: "start" }, NOW + 10000);
  assert.equal(state.runId, "run-one");
  assert.equal(state.deadlineMs, NOW + 13000);
  signal.update(state, NOW + 10000, true);
  signal.update(state, NOW + 12999, true);
  assert.equal(calls.length, 0);
  signal.update(state, NOW + 13000, true);
  signal.update(state, NOW + 50000, true);
  assert.equal(calls.length, 1);
});

test("a fresh page observing a paused timer can arm when that timer resumes", () => {
  const { signal, calls } = observer();
  const paused = transition(countdown(), { type: "pause" }, NOW + 2000);
  signal.update(paused, NOW + 10000, false);
  const resumed = transition(paused, { type: "start" }, NOW + 20000);
  signal.update(resumed, NOW + 20000, false);
  signal.update(resumed, resumed.deadlineMs, false);
  assert.equal(calls.length, 1);
});

test("adding time to an expired countdown creates a new audible run", () => {
  const { signal, calls } = observer();
  const first = countdown();
  signal.update(first, NOW, true);
  signal.update(first, first.deadlineMs, true);
  const revived = transition(first, { type: "adjust", deltaMs: 1000 }, NOW + 8000);
  assert.notEqual(revived.runId, first.runId);
  signal.update(revived, NOW + 8000, true);
  signal.update(revived, NOW + 9000, true);
  signal.update(revived, NOW + 10000, true);
  assert.equal(calls.length, 2);
});

test("extending an active deadline does not sound at its old deadline", () => {
  const { signal, calls } = observer();
  const first = countdown();
  signal.update(first, NOW, true);
  const extended = transition(first, { type: "adjust", deltaMs: 5000 }, NOW + 1000);
  signal.update(extended, NOW + 5000, true);
  assert.equal(calls.length, 0);
  signal.update(extended, NOW + 10000, true);
  assert.equal(calls.length, 1);
});

test("hidden timers are silent for players and audible for the GM", () => {
  const state = countdown({ visible: false });
  for (const isGM of [false, true]) {
    const { signal, calls } = observer();
    signal.update(state, NOW, isGM);
    signal.update(state, state.deadlineMs, isGM);
    assert.equal(calls.length, isGM ? 1 : 0);
  }
});

test("hiding an observed timer before expiry disarms the player signal", () => {
  const { signal, calls } = observer();
  signal.update(countdown(), NOW, false);
  signal.update(countdown({ visible: false }), NOW + 2000, false);
  signal.update(countdown({ visible: false }), NOW + 5000, false);
  signal.update(countdown(), NOW + 6000, false);
  assert.equal(calls.length, 0, "showing an expired timer must not reveal a delayed signal");
});

test("a background-tab time jump still signals once for the observed run", () => {
  const { signal, calls } = observer();
  signal.update(countdown(), NOW, false);
  signal.update(countdown(), NOW + 60000, false);
  signal.update(countdown(), NOW + 60100, false);
  assert.equal(calls.length, 1);
});

for (const settings of [{ soundEnabled: false }, { soundVolume: 0 }]) {
  test(`silent expiry is consumed when ${JSON.stringify(settings)}`, () => {
    const { signal, calls } = observer();
    signal.update(countdown(settings), NOW, true);
    signal.update(countdown(settings), NOW + 5000, true);
    signal.update(countdown(), NOW + 6000, true);
    assert.equal(calls.length, 0);
  });
}

for (const asynchronous of [false, true]) {
  test(`${asynchronous ? "async" : "sync"} playback failure is reported once without retries`, async () => {
    const failure = new Error("Missing audio file");
    let attempts = 0;
    const { signal, errors } = observer(() => {
      attempts++;
      if (asynchronous) return Promise.reject(failure);
      throw failure;
    });
    signal.update(countdown(), NOW, true);
    signal.update(countdown(), NOW + 5000, true);
    signal.update(countdown(), NOW + 5200, true);
    await new Promise(resolve => setImmediate(resolve));
    signal.update(countdown(), NOW + 5400, true);
    assert.equal(attempts, 1);
    assert.deepEqual(errors, [failure]);
  });
}

test("an unresolved audio load cannot be started a second time by subsequent ticks", async () => {
  let finish;
  let attempts = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const { signal } = observer(() => { attempts++; return pending; });
  signal.update(countdown(), NOW, true);
  signal.update(countdown(), NOW + 5000, true);
  signal.update(countdown(), NOW + 5200, true);
  assert.equal(attempts, 1);
  finish();
  await pending;
  signal.update(countdown(), NOW + 5400, true);
  assert.equal(attempts, 1);
});

test("playSignal uses Foundry's interface channel locally, with bundled or custom audio", () => {
  const previous = globalThis.foundry;
  const calls = [];
  const result = Promise.resolve("native-sound");
  globalThis.foundry = { audio: { AudioHelper: { play: (...args) => { calls.push(args); return result; } } } };
  try {
    assert.equal(playSignal(DEFAULT_STATE), result);
    assert.equal(playSignal({ soundSrc: "  worlds/test/audio/end.ogg  ", soundVolume: 0.25 }), result);
    assert.deepEqual(calls, [
      [{ src: DEFAULT_SOUND, volume: 0.6, loop: false, channel: "interface" }, false],
      [{ src: "worlds/test/audio/end.ogg", volume: 0.25, loop: false, channel: "interface" }, false]
    ]);
  } finally {
    if (previous === undefined) delete globalThis.foundry;
    else globalThis.foundry = previous;
  }
});

test("old saved timers migrate audio defaults without changing their countdown", () => {
  const legacy = countdown();
  delete legacy.soundEnabled;
  delete legacy.soundSrc;
  delete legacy.soundVolume;
  const normalized = normalizeState(legacy);
  assert.equal(normalized.soundEnabled, true);
  assert.equal(normalized.soundSrc, "");
  assert.equal(normalized.soundVolume, 0.6);
  assert.equal(normalized.runId, legacy.runId);
  assert.equal(normalized.deadlineMs, legacy.deadlineMs);
  assert.equal(remainingMs(normalized, NOW + 2000), 3000);
});

test("audio configuration preserves the active run and its remaining time", () => {
  const original = Object.freeze(countdown());
  const configured = transition(original, { type: "configure", soundEnabled: false,
    soundSrc: "audio/custom.ogg", soundVolume: 0.2 }, NOW + 2000);
  assert.equal(configured.soundEnabled, false);
  assert.equal(configured.soundSrc, "audio/custom.ogg");
  assert.equal(configured.soundVolume, 0.2);
  assert.equal(configured.runId, original.runId);
  assert.equal(configured.deadlineMs, original.deadlineMs);
  assert.equal(remainingMs(configured, NOW + 2000), 3000);
});

test("invalid audio API settings fail validation, and invalid stored audio repairs safely", () => {
  for (const soundVolume of [-1, 1.01, NaN, Infinity, "0.5", null]) {
    assert.throws(() => transition(DEFAULT_STATE, { type: "configure", soundVolume }, NOW), RangeError);
  }
  assert.throws(() => transition(DEFAULT_STATE, { type: "configure", soundEnabled: "on" }, NOW), TypeError);
  for (const source of ["javascript:alert(1)", "data:audio/wav;base64,AA==", "file:///private.wav", "C:\\audio.wav", "bad\u0000path", "x".repeat(2049)]) {
    assert.throws(() => cleanSoundSource(source), RangeError);
    assert.throws(() => transition(DEFAULT_STATE, { type: "configure", soundSrc: source }, NOW), RangeError);
  }
  assert.equal(cleanSoundSource("https://example.test/audio.ogg"), "https://example.test/audio.ogg");
  assert.equal(cleanSoundSource(""), "");
  const repaired = normalizeState({ soundSrc: "data:audio/wav;base64,AA==", soundVolume: NaN, soundEnabled: "yes" });
  assert.equal(repaired.soundSrc, "");
  assert.equal(repaired.soundVolume, 0.6);
  assert.equal(repaired.soundEnabled, true);
  assert.equal(normalizeState({ soundVolume: 4 }).soundVolume, 1);
  assert.equal(normalizeState({ soundVolume: -4 }).soundVolume, 0);
});

test("the bundled signal is a short, non-clipping PCM WAV with silent boundaries", () => {
  const wav = readFileSync(new URL("../assets/expiry.wav", import.meta.url));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt16LE(20), 1, "uncompressed PCM");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 44100);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  const byteCount = wav.readUInt32LE(40);
  assert.equal(wav.length, byteCount + 44);
  const seconds = byteCount / 2 / 44100;
  assert.ok(seconds >= 0.9 && seconds <= 1.1);
  let peak = 0;
  for (let offset = 44; offset < wav.length; offset += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
  assert.ok(peak > 1000 && peak < 16384, `peak ${peak} should have ample headroom`);
  assert.equal(wav.readInt16LE(44), 0);
  assert.equal(wav.readInt16LE(wav.length - 2), 0);
});
