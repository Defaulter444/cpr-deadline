import { DEFAULT_SOUND, normalizeState, statusOf } from "./timer-state.js";

/** Each connected client plays locally, once, only after observing an active countdown. */
export class ExpirySignal {
  constructor({ play, onError = console.warn }) {
    this.play = play;
    this.onError = onError;
    this.armed = null;
    this.completed = null;
  }

  update(input, time, isGM) {
    const state = normalizeState(input);
    const status = statusOf(state, time);
    const eligible = isGM || state.visible;
    if (status === "running" && eligible) {
      this.armed = state.runId;
      return;
    }
    const expired = status === "expired" && eligible && this.armed === state.runId && this.completed !== state.runId;
    this.armed = null;
    if (!expired) return;
    // Consume before any asynchronous load; a failing source must not retry every 200 ms.
    this.completed = state.runId;
    if (!state.soundEnabled || state.soundVolume === 0) return;
    try { Promise.resolve(this.play(state)).catch(this.onError); }
    catch (error) { this.onError(error); }
  }
}

export function playSignal(settings) {
  const state = normalizeState(settings);
  return foundry.audio.AudioHelper.play({
    src: state.soundSrc || DEFAULT_SOUND,
    volume: state.soundVolume,
    loop: false,
    channel: "interface"
  }, false);
}
