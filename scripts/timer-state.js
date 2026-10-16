/** Framework-independent countdown state. All timestamps and durations use milliseconds. */
export const MODULE_ID = "cpr-deadline";
export const MAX_DURATION_MS = (99 * 3600 + 59 * 60 + 59) * 1000;
export const DEFAULT_STATE = Object.freeze({
  schema: 1,
  label: "До жопы осталось",
  durationMs: 600000,
  remainingMs: 600000,
  deadlineMs: null,
  status: "idle",
  visible: false,
  runId: "",
  warningSeconds: 60
});

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = value => typeof value === "number" && Number.isFinite(value);
const milliseconds = (value, fallback, minimum = 0) =>
  finite(value) ? clamp(Math.round(value), minimum, MAX_DURATION_MS) : fallback;

function cleanLabel(value) {
  if (typeof value !== "string") return DEFAULT_STATE.label;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return Array.from(text || DEFAULT_STATE.label).slice(0, 160).join("");
}

function clockValue(now) {
  if (!finite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - MAX_DURATION_MS) {
    throw new RangeError("The current time must be a finite, nonnegative millisecond timestamp.");
  }
  return now;
}

function newRunId() {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Return a clean copy; malformed stored state never creates NaN or an unbounded duration. */
export function normalizeState(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const durationMs = milliseconds(source.durationMs, DEFAULT_STATE.durationMs, 1000);
  const state = {
    schema: 1,
    label: cleanLabel(source.label),
    durationMs,
    remainingMs: milliseconds(source.remainingMs, durationMs),
    deadlineMs: finite(source.deadlineMs) && source.deadlineMs >= 0 && source.deadlineMs <= Number.MAX_SAFE_INTEGER
      ? source.deadlineMs : null,
    status: ["idle", "paused", "running"].includes(source.status) ? source.status : "idle",
    visible: typeof source.visible === "boolean" ? source.visible : DEFAULT_STATE.visible,
    runId: typeof source.runId === "string" ? source.runId.slice(0, 128) : "",
    warningSeconds: finite(source.warningSeconds)
      ? clamp(Math.round(source.warningSeconds), 0, MAX_DURATION_MS / 1000)
      : DEFAULT_STATE.warningSeconds
  };
  // A damaged deadline cannot be reconstructed; retain its saved remaining time as paused.
  if (state.status === "running" && state.deadlineMs === null) state.status = "paused";
  if (state.status !== "running") state.deadlineMs = null;
  return state;
}

/** Derive time from the deadline, never from a count of browser ticks. */
export function remainingMs(input, now) {
  const state = normalizeState(input);
  if (state.status !== "running") return state.remainingMs;
  return clamp(state.deadlineMs - clockValue(now), 0, MAX_DURATION_MS);
}

/** Display upward-rounded seconds, using HH:MM:SS only for durations of at least one hour. */
export function displayTime(ms) {
  const total = Math.ceil(clamp(finite(ms) ? ms : 0, 0, MAX_DURATION_MS) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = value => String(value).padStart(2, "0");
  return hours ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Expiry is derived so no GM needs to remain online or write an expiry event. */
export function statusOf(input, now) {
  const state = normalizeState(input);
  return state.status === "running" && remainingMs(state, now) <= 0 ? "expired" : state.status;
}

/** Parse integer seconds, MM:SS, or HH:MM:SS; throw RangeError for invalid/out-of-range input. */
export function parseDuration(text) {
  if (typeof text !== "string" && typeof text !== "number") {
    throw new RangeError("Enter seconds, MM:SS, or HH:MM:SS.");
  }
  const source = String(text).trim();
  if (!/^\d+(?::\d{1,2}){0,2}$/.test(source)) {
    throw new RangeError("Enter whole seconds, MM:SS, or HH:MM:SS.");
  }
  const parts = source.split(":").map(Number);
  if (parts.length > 1 && parts.some((value, index) =>
    value > (parts.length === 3 && index === 0 ? 99 : 59))) {
    throw new RangeError("Minutes and seconds must be between 0 and 59; hours cannot exceed 99.");
  }
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_DURATION_MS / 1000) {
    throw new RangeError("Duration must be between 1 second and 99:59:59.");
  }
  return seconds * 1000;
}

/**
 * Return a new state for a flat action object, without mutating the input.
 * configure accepts optional label/durationMs/warningSeconds/visible fields. Supplying a
 * duration creates an idle timer; changing metadata alone leaves its countdown intact.
 * adjust changes remaining time only; reset always restores the configured duration.
 */
export function transition(input, action, now) {
  const state = normalizeState(input);
  const time = clockValue(now);
  if (!action || typeof action !== "object") throw new TypeError("A timer action is required.");

  switch (action.type) {
    case "configure": {
      if (hasOwn(action, "label")) state.label = cleanLabel(action.label);
      if (hasOwn(action, "visible")) {
        if (typeof action.visible !== "boolean") throw new TypeError("Visibility must be a boolean.");
        state.visible = action.visible;
      }
      if (hasOwn(action, "warningSeconds")) {
        if (!finite(action.warningSeconds)) throw new RangeError("Warning time must be finite.");
        state.warningSeconds = clamp(Math.round(action.warningSeconds), 0, MAX_DURATION_MS / 1000);
      }
      if (hasOwn(action, "durationMs")) {
        if (!finite(action.durationMs) || action.durationMs < 1000 || action.durationMs > MAX_DURATION_MS) {
          throw new RangeError("Duration must be between 1 second and 99:59:59.");
        }
        state.durationMs = Math.round(action.durationMs);
        state.remainingMs = state.durationMs;
        state.deadlineMs = null;
        state.status = "idle";
        state.runId = newRunId();
      }
      return state;
    }
    case "start": {
      if (state.status === "running" && remainingMs(state, time) > 0) return state;
      const resuming = state.status === "paused" && state.remainingMs > 0;
      state.remainingMs = resuming ? state.remainingMs : state.status === "idle" && state.remainingMs > 0
        ? state.remainingMs : state.durationMs;
      state.deadlineMs = time + state.remainingMs;
      state.status = "running";
      if (!resuming || !state.runId) state.runId = newRunId();
      return state;
    }
    case "pause":
      if (state.status !== "running" || remainingMs(state, time) <= 0) return state;
      state.remainingMs = remainingMs(state, time);
      state.deadlineMs = null;
      state.status = "paused";
      return state;
    case "reset":
      state.remainingMs = state.durationMs;
      state.deadlineMs = null;
      state.status = "idle";
      state.runId = newRunId();
      return state;
    case "adjust": {
      if (!finite(action.deltaMs)) throw new RangeError("The time adjustment must be finite.");
      const previousRemaining = remainingMs(state, time);
      state.remainingMs = clamp(previousRemaining + Math.round(action.deltaMs), 0, MAX_DURATION_MS);
      if (state.status === "running") {
        state.deadlineMs = time + state.remainingMs;
        if (previousRemaining === 0 && state.remainingMs > 0) state.runId = newRunId();
      }
      return state;
    }
    case "visibility":
      if (typeof action.visible !== "boolean") throw new TypeError("Visibility must be a boolean.");
      state.visible = action.visible;
      return state;
    default:
      throw new RangeError(`Unknown timer action: ${String(action.type)}`);
  }
}
