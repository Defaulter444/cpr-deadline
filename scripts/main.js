import { MODULE_ID, DEFAULT_STATE, normalizeState, transition, parseDuration, displayTime, statusOf, cleanSoundSource } from "./timer-state.js";
import { DeadlineHUD } from "./hud.js";
import { ExpirySignal, playSignal } from "./sound.js";

let hud;
let configWindow;
let signal;
let commands = Promise.resolve();
const DEFAULT_VIEW = Object.freeze({ collapsed: false, x: null, y: null });

export function normalizeView(value) {
  return {
    collapsed: value?.collapsed === true,
    x: Number.isFinite(value?.x) ? Math.max(0, value.x) : null,
    y: Number.isFinite(value?.y) ? Math.max(0, value.y) : null
  };
}

function now() {
  const value = game.time.serverTime;
  return Number.isFinite(value) ? value : Date.now();
}

function state() { return normalizeState(game.settings.get(MODULE_ID, "timer")); }
function requireGM() {
  if (!game.user?.isGM) throw new Error("Управлять таймером может только ведущий.");
}

/** Queue a client's GM commands, reading the latest synchronized state for each write. */
export function command(action) {
  const pending = commands.catch(() => {}).then(async () => {
    requireGM();
    const current = state();
    const next = transition(current, action, now());
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      await game.settings.set(MODULE_ID, "timer", next);
    }
    return next;
  });
  commands = pending;
  return pending;
}

function reportError(error) {
  console.error(`${MODULE_ID} |`, error);
  ui.notifications.error(error?.message ?? "Не удалось обновить таймер.");
}

function openConfig() {
  requireGM();
  configWindow ??= new DeadlineConfig();
  return configWindow.render(true);
}

class DeadlineConfig extends FormApplication {
  constructor(...args) {
    super(...args);
    configWindow = this;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "cpr-deadline-config",
      title: "DEADLINE — управление таймером",
      template: `modules/${MODULE_ID}/templates/config.hbs`,
      classes: ["cprd-config"],
      width: 460,
      height: "auto",
      resizable: false,
      closeOnSubmit: false,
      submitOnChange: false,
      submitOnClose: false
    });
  }

  getData() {
    requireGM();
    const current = state();
    return { ...current, soundPercent: Math.round(current.soundVolume * 100), duration: displayTime(current.durationMs), running: statusOf(current, now()) === "running" };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-preset]").on("click", event => {
      this.form.elements.duration.value = event.currentTarget.dataset.preset;
    });
    html.find("[data-command]").on("click", async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const type = button.dataset.command;
        if (type === "preview-sound") {
          requireGM();
          await playSignal(this._soundFields(Object.fromEntries(new FormData(this.form))));
          return;
        } else if (type === "start-saved") {
          await this._apply(Object.fromEntries(new FormData(this.form)));
          await command({ type: "start" });
        } else if (type === "reset-position") {
          await hud.resetPosition();
          ui.notifications.info("Таймер возвращён в правый верхний угол на вашем экране.");
          return;
        } else if (type === "adjust") {
          await command({ type, deltaMs: Number(button.dataset.delta) });
        } else if (type === "toggle") {
          await command({ type: statusOf(state(), now()) === "running" ? "pause" : "start" });
        } else {
          await command({ type });
        }
        // Preserve unsaved label/duration edits during pause and time adjustments.
        if (type === "start-saved") this.render(false);
        else this._updateStatusControls();
      } catch (error) { reportError(error); }
      finally { button.disabled = false; }
    });
    this._updateStatusControls();
  }

  _updateStatusControls() {
    const button = this.element?.[0]?.querySelector('[data-command="toggle"]');
    if (!button) return;
    const running = statusOf(state(), now()) === "running";
    const icon = `fas fa-${running ? "pause" : "play"}`;
    const label = running ? "Пауза" : statusOf(state(), now()) === "paused" ? "Продолжить" : "Запустить";
    if (button.querySelector("i").className !== icon) button.querySelector("i").className = icon;
    if (button.querySelector("span").textContent !== label) button.querySelector("span").textContent = label;
  }

  async _apply(formData) {
    requireGM();
    let durationMs;
    try { durationMs = parseDuration(formData.duration); }
    catch { throw new Error("Введите время от 1 секунды до 99:59:59: секунды, ММ:СС или ЧЧ:ММ:СС."); }
    const warningSeconds = Number(formData.warningSeconds);
    if (!Number.isInteger(warningSeconds) || warningSeconds < 0 || warningSeconds > 359999) {
      throw new Error("Порог предупреждения должен быть целым числом от 0 до 359999 секунд.");
    }
    const action = {
      type: "configure",
      label: String(formData.label ?? ""),
      ...this._soundFields(formData),
      warningSeconds,
      visible: formData.visible === true || formData.visible === "on"
    };
    if (durationMs !== state().durationMs) action.durationMs = durationMs;
    return command(action);
  }

  _soundFields(formData) {
    const percent = Number(formData.soundPercent ?? 60);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new Error("Громкость звука должна быть от 0 до 100%.");
    }
    return {
      soundEnabled: formData.soundEnabled === true || formData.soundEnabled === "on",
      soundSrc: cleanSoundSource(formData.soundSrc),
      soundVolume: percent / 100
    };
  }

  async _updateObject(_event, formData) {
    try {
      await this._apply(formData);
      ui.notifications.info("Настройки таймера сохранены.");
      this.render(false);
    } catch (error) { reportError(error); }
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "timer", {
    name: "Состояние таймера", scope: "world", config: false, type: Object,
    default: { ...DEFAULT_STATE },
    onChange: () => { hud?.update(); signal?.update(state(), now(), game.user.isGM); configWindow?._updateStatusControls(); }
  });
  game.settings.register(MODULE_ID, "view", {
    name: "Положение таймера", scope: "client", config: false, type: Object,
    default: { ...DEFAULT_VIEW },
    onChange: () => { hud?.update(); hud?.reposition(); }
  });
  game.settings.registerMenu(MODULE_ID, "configure", {
    name: "DEADLINE — таймер", label: "Настроить таймер", icon: "fas fa-stopwatch",
    hint: "Подпись, длительность, запуск, пауза и видимость для игроков.",
    type: DeadlineConfig, restricted: true
  });
  game.keybindings.register(MODULE_ID, "open", {
    name: "DEADLINE — управление таймером",
    hint: "Открыть настройки таймера (ведущий).",
    editable: [{ key: "KeyT", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => { openConfig(); return true; }
  });
});

Hooks.on("getSceneControlButtons", controls => {
  if (!game.user?.isGM) return;
  const tokenTools = controls.find(control => control.name === "token")?.tools;
  if (tokenTools && !tokenTools.some(tool => tool.name === MODULE_ID)) {
    tokenTools.push({ name: MODULE_ID, title: "DEADLINE — таймер", icon: "fas fa-stopwatch", button: true, onClick: openConfig });
  }
});

Hooks.once("ready", () => {
  if (game.system.id !== "cyberpunk-red-core") return;
  signal = new ExpirySignal({
    play: playSignal,
    onError: error => {
      console.warn(`${MODULE_ID} | Не удалось воспроизвести сигнал завершения`, error);
      if (game.user.isGM) ui.notifications.warn("DEADLINE: звук не загрузился. Проверьте файл в настройках таймера.");
    }
  });
  signal.update(state(), now(), game.user.isGM);
  hud = new DeadlineHUD({
    getState: state, now, isGM: () => game.user.isGM,
    command: action => command(action).catch(reportError), configure: openConfig,
    getView: () => normalizeView(game.settings.get(MODULE_ID, "view")),
    saveView: view => game.settings.set(MODULE_ID, "view", normalizeView(view))
  });
  hud.mount();
  const interval = setInterval(() => { hud.update(); signal.update(state(), now(), game.user.isGM); configWindow?._updateStatusControls(); }, 200);
  window.addEventListener("beforeunload", () => { clearInterval(interval); hud.destroy(); }, { once: true });
  document.addEventListener("visibilitychange", () => { hud.update(); signal.update(state(), now(), game.user.isGM); });
  const module = game.modules.get(MODULE_ID);
  module.api = Object.freeze({
    open: openConfig,
    getState: () => ({ ...state(), effectiveStatus: statusOf(state(), now()) }),
    start: () => command({ type: "start" }),
    pause: () => command({ type: "pause" }),
    reset: () => command({ type: "reset" }),
    setVisible: visible => command({ type: "visibility", visible }),
    configure: options => command({ ...options, type: "configure" }),
    adjust: seconds => command({ type: "adjust", deltaMs: seconds * 1000 }),
    toggleCollapsed: () => hud.toggleCollapsed(),
    resetPosition: () => hud.resetPosition()
  });
});

Hooks.on("collapseSidebar", () => hud?.reposition());
Hooks.on("renderSidebar", () => hud?.reposition());
Hooks.on("renderSceneNavigation", () => hud?.reposition());
