import { displayTime, remainingMs, statusOf } from "./timer-state.js";

const WIDTH = 300;
const MARGIN = 12;
const STATUS_LABELS = {
  idle: "Готов к запуску",
  running: "Идёт отсчёт",
  paused: "На паузе",
  expired: "Время истекло",
};

function normalizeView(view = {}) {
  return {
    collapsed: Boolean(view.collapsed),
    x: Number.isFinite(view.x) ? view.x : null,
    y: Number.isFinite(view.y) ? view.y : null,
  };
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function button(label, iconClass, callback, signal) {
  const element = createElement("button", "cprd-button");
  element.type = "button";
  element.title = label;
  element.setAttribute("aria-label", label);
  const icon = createElement("i", `fa-solid ${iconClass}`);
  icon.setAttribute("aria-hidden", "true");
  element.append(icon);
  element.addEventListener("click", callback, { signal });
  return element;
}

/** A small, persistent DOM HUD. World state and client preferences live outside it. */
export class DeadlineHUD {
  constructor({ getState, now, isGM, command, configure, getView, saveView }) {
    Object.assign(this, { getState, now, isGM, command, configure, getView, saveView });
    this.element = null;
    this._view = normalizeView(getView());
    this._savedSignature = JSON.stringify(this._view);
    this._saveQueue = Promise.resolve();
    this._pendingWrites = 0;
    this._busy = false;
    this._drag = null;
  }

  mount() {
    if (this.element?.isConnected) {
      this.update();
      return this;
    }
    this._events?.abort();
    this._events = new AbortController();
    const { signal } = this._events;
    const root = createElement("section", "cprd-hud");
    root.id = "cpr-deadline-hud";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Таймер Cyberpunk RED");

    const header = createElement("div", "cprd-header");
    header.title = "Перетащите за заголовок, чтобы переместить таймер";
    const dot = createElement("i", "cprd-dot fa-solid fa-circle");
    dot.setAttribute("aria-hidden", "true");
    const brand = createElement("span", "cprd-brand", "DEADLINE");
    const compactLabel = createElement("span", "cprd-compact-label");
    const compactTime = createElement("span", "cprd-compact-time");
    compactTime.setAttribute("role", "timer");
    compactTime.setAttribute("aria-live", "off");
    compactTime.setAttribute("aria-label", "Осталось времени");
    const controls = createElement("div", "cprd-actions");
    const collapse = button("Свернуть таймер", "fa-chevron-up", () => {
      void this.toggleCollapsed();
    }, signal);
    collapse.classList.add("cprd-collapse");
    collapse.setAttribute("aria-controls", "cprd-timer-body");
    const playback = button("Запустить таймер", "fa-play", () => {
      if (!this.isGM()) return;
      const action = statusOf(this.getState(), this.now()) === "running" ? "pause" : "start";
      void this._invoke(() => this.command({ type: action }));
    }, signal);
    playback.classList.add("cprd-gm-control");
    const settings = button("Настроить таймер", "fa-gear", () => {
      if (this.isGM()) void this._invoke(() => this.configure(), false);
    }, signal);
    settings.classList.add("cprd-gm-control");
    controls.append(collapse, playback, settings);
    header.append(dot, brand, compactLabel, compactTime, controls);

    const body = createElement("div", "cprd-body");
    body.id = "cprd-timer-body";
    const caption = createElement("div", "cprd-caption");
    const time = createElement("div", "cprd-time");
    time.setAttribute("role", "timer");
    time.setAttribute("aria-live", "off");
    time.setAttribute("aria-label", "Осталось времени");
    const footer = createElement("div", "cprd-footer");
    const status = createElement("span", "cprd-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const visibility = createElement("span", "cprd-visibility", "Скрыт от игроков");
    const visibilityIcon = createElement("i", "fa-solid fa-eye-slash");
    visibilityIcon.setAttribute("aria-hidden", "true");
    visibility.prepend(visibilityIcon);
    footer.append(status, visibility);
    body.append(caption, time, footer);
    const progress = createElement("div", "cprd-progress");
    // The changing digits already expose the remaining time. Keep this decorative.
    progress.setAttribute("aria-hidden", "true");
    const progressFill = createElement("div", "cprd-progress-fill");
    progress.append(progressFill);
    root.append(header, body, progress);
    this.element = root;
    this._refs = { header, dot, compactLabel, compactTime, collapse, playback, settings,
      caption, time, body, status, visibility, progressFill };
    header.addEventListener("pointerdown", (event) => this._startDrag(event), { signal });
    window.addEventListener("pointermove", (event) => this._moveDrag(event), { signal });
    window.addEventListener("pointerup", (event) => this._endDrag(event), { signal });
    window.addEventListener("pointercancel", (event) => this._endDrag(event), { signal });
    window.addEventListener("resize", () => this.reposition(), { signal });
    document.body.append(root);
    this.update();
    this.reposition();
    return this;
  }

  update() {
    if (!this.element) return;
    const wasHidden = this.element.hidden;
    const wasCollapsed = this.element.classList.contains("cprd-collapsed");
    const previousDigits = this._refs.time.textContent.length;
    this._syncView();
    const state = this.getState();
    const now = this.now();
    const status = statusOf(state, now);
    const gm = Boolean(this.isGM());
    const visible = state.visible !== false;
    const collapsed = this._view.collapsed;
    const remaining = remainingMs(state, now);
    const warning = status === "running" && remaining > 0 && Number(state.warningSeconds) > 0
      && remaining <= Number(state.warningSeconds) * 1000;
    const digits = displayTime(remaining);
    const label = String(state.label ?? "До жопы осталось");
    const refs = this._refs;
    // Only an active countdown occupies the canvas; management stays available
    // through the configuration window even while this HUD is hidden.
    this.element.hidden = status !== "running" || (!visible && !gm);
    this.element.classList.toggle("cprd-collapsed", collapsed);
    this.element.classList.toggle("cprd-warning", warning);
    this.element.dataset.status = status;
    this.element.dataset.gm = String(gm);
    this.element.dataset.worldVisible = String(visible);
    setText(refs.caption, label);
    setText(refs.compactLabel, label);
    refs.caption.title = label;
    refs.compactLabel.title = `${label}${!visible && gm ? " — скрыт от игроков" : ""}`;
    setText(refs.time, digits);
    setText(refs.compactTime, digits);
    // Keep hours legible without letting unusually long timers escape the card.
    this.element.style.setProperty("--cprd-digit-count", String(Math.max(5, digits.length)));
    const statusLabel = warning ? "Времени мало" : STATUS_LABELS[status] ?? STATUS_LABELS.idle;
    setText(refs.status, statusLabel);
    refs.visibility.hidden = visible || !gm;
    refs.dot.className = `cprd-dot fa-solid ${!visible && gm && collapsed ? "fa-eye-slash" : "fa-circle"}`;
    refs.dot.title = !visible && gm ? "Скрыт от игроков" : statusLabel;
    this.element.setAttribute("aria-label", `${label}. ${statusLabel}${!visible && gm ? ". Скрыт от игроков" : ""}`);
    const collapseLabel = collapsed ? "Развернуть таймер" : "Свернуть таймер";
    refs.collapse.title = collapseLabel;
    refs.collapse.setAttribute("aria-label", collapseLabel);
    refs.collapse.setAttribute("aria-expanded", String(!collapsed));
    refs.collapse.firstElementChild.className = `fa-solid ${collapsed ? "fa-chevron-down" : "fa-chevron-up"}`;
    refs.body.hidden = collapsed;
    const playbackLabel = status === "running" ? "Приостановить таймер" : status === "paused" ? "Продолжить таймер" : "Запустить таймер";
    refs.playback.title = playbackLabel;
    refs.playback.setAttribute("aria-label", playbackLabel);
    refs.playback.firstElementChild.className = `fa-solid ${status === "running" ? "fa-pause" : "fa-play"}`;
    refs.playback.hidden = !gm || collapsed;
    refs.settings.hidden = !gm || collapsed;
    refs.playback.disabled = this._busy;
    refs.settings.disabled = this._busy;
    const duration = Number(state.durationMs);
    const fraction = duration > 0 ? Math.max(0, Math.min(1, remaining / duration)) : 0;
    refs.progressFill.style.transform = `scaleX(${fraction})`;
    if ((wasHidden && !this.element.hidden) || wasCollapsed !== collapsed || previousDigits !== digits.length) {
      this.reposition();
    }
  }

  reposition() {
    if (!this.element || this.element.hidden) return;
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const margin = Math.min(MARGIN, vw / 4, vh / 4);
    let rightEdge = vw - margin;
    const sidebar = document.querySelector("#sidebar");
    if (sidebar && this._isVisible(sidebar)) {
      const rect = sidebar.getBoundingClientRect();
      // An open full-screen sidebar can leave no usable canvas on small screens.
      if (rect.left >= 160 + margin * 2 && rect.left < vw) {
        rightEdge = Math.min(rightEdge, rect.left - margin);
      }
    }
    const width = Math.max(1, Math.min(WIDTH, rightEdge - margin));
    this.element.style.width = `${width}px`;
    this.element.style.maxHeight = `${Math.max(1, vh - margin * 2)}px`;
    this.element.style.setProperty("--cprd-content-width", `${Math.max(1, width - 34)}px`);
    const height = this.element.getBoundingClientRect().height;
    let defaultTop = 72;
    const navigation = document.querySelector("#navigation");
    if (navigation && this._isVisible(navigation)) {
      defaultTop = Math.max(defaultTop, navigation.getBoundingClientRect().bottom + margin);
    }
    const x = this._view.x ?? rightEdge - width;
    const y = this._view.y ?? defaultTop;
    const left = Math.max(margin, Math.min(x, rightEdge - width));
    const top = Math.max(margin, Math.min(y, vh - margin - height));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  async toggleCollapsed() {
    this._view.collapsed = !this._view.collapsed;
    this.update();
    this.reposition();
    await this._persistView();
  }

  async resetPosition() {
    this._view.x = null;
    this._view.y = null;
    this.reposition();
    await this._persistView();
  }

  destroy() {
    this._events?.abort();
    this._drag = null;
    this.element?.remove();
    this.element = null;
    this._refs = null;
  }

  _isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  _syncView() {
    if (this._pendingWrites || this._drag) return;
    const saved = normalizeView(this.getView());
    const signature = JSON.stringify(saved);
    if (signature !== this._savedSignature) {
      this._savedSignature = signature;
      this._view = saved;
    }
  }

  _persistView() {
    const snapshot = { ...this._view };
    this._pendingWrites += 1;
    this._saveQueue = this._saveQueue.then(async () => {
      try {
        await this.saveView(snapshot);
      } catch (error) {
        this._reportError("Не удалось сохранить положение таймера", error);
      } finally {
        this._pendingWrites -= 1;
        if (!this._pendingWrites) {
          this._savedSignature = JSON.stringify(normalizeView(this.getView()));
        }
      }
    });
    return this._saveQueue;
  }

  async _invoke(callback, busy = true) {
    if (this._busy) return;
    this._busy = busy;
    this.update();
    try {
      await callback();
    } catch (error) {
      this._reportError("Не удалось выполнить действие таймера", error);
    } finally {
      this._busy = false;
      this.update();
    }
  }

  _reportError(message, error) {
    console.error("CPR Deadline |", message, error);
    globalThis.ui?.notifications?.error(message);
  }

  _startDrag(event) {
    if (event.button !== 0 || this._drag || event.target.closest("button, a, input, select, textarea")) return;
    const rect = this.element.getBoundingClientRect();
    this._drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top, startX: event.clientX, startY: event.clientY,
      moved: false };
    this._refs.header.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  _moveDrag(event) {
    const drag = this._drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 3) return;
    drag.moved = true;
    this.element.classList.add("cprd-dragging");
    this._view.x = event.clientX - drag.offsetX;
    this._view.y = event.clientY - drag.offsetY;
    this.reposition();
    event.preventDefault();
  }

  _endDrag(event) {
    if (!this._drag || event.pointerId !== this._drag.pointerId) return;
    const moved = this._drag.moved;
    this._drag = null;
    if (this._refs.header.hasPointerCapture?.(event.pointerId)) {
      this._refs.header.releasePointerCapture(event.pointerId);
    }
    this.element.classList.remove("cprd-dragging");
    if (moved) {
      const rect = this.element.getBoundingClientRect();
      this._view.x = rect.left;
      this._view.y = rect.top;
      void this._persistView();
    }
  }
}
