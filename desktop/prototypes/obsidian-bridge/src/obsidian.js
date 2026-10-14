// Deliberately scoped subset. Unknown exports/modules fail rather than silently pretending to work.
// Runs in Bridge's dedicated iframe realm; DOM prototype helpers never modify the Forsion document.
export function domHelpers() {
  const methods = {
    empty() {
      this.replaceChildren();
      return this;
    },
    setText(value) {
      this.textContent = String(value);
      return this;
    },
    appendText(value) {
      this.appendChild(document.createTextNode(value));
      return this;
    },
    createEl(tag, options = {}, callback) {
      const el = document.createElement(tag);
      if (typeof options === "string") options = { cls: options };
      if (options.text != null) el.textContent = options.text;
      if (options.cls)
        el.className = Array.isArray(options.cls)
          ? options.cls.join(" ")
          : options.cls;
      for (const [k, v] of Object.entries(options.attr || {}))
        el.setAttribute(k, String(v));
      for (const k of ["href", "type", "value"])
        if (options[k] != null) el[k] = options[k];
      this.appendChild(el);
      callback?.(el);
      return el;
    },
    createDiv(o, cb) {
      return this.createEl("div", o, cb);
    },
    createSpan(o, cb) {
      return this.createEl("span", o, cb);
    },
    addClass(...names) {
      this.classList.add(...names);
      return this;
    },
    removeClass(...names) {
      this.classList.remove(...names);
      return this;
    },
    onClickEvent(cb) {
      this.addEventListener("click", cb);
      return this;
    },
  };
  for (const [key, fn] of Object.entries(methods))
    if (!Node.prototype[key])
      Object.defineProperty(Node.prototype, key, {
        value: fn,
        configurable: true,
      });
  for (const [key, fn] of Object.entries({
    first() {
      return this[0];
    },
    last() {
      return this[this.length - 1];
    },
    shuffle() {
      for (let i = this.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this[i], this[j]] = [this[j], this[i]];
      }
      return this;
    },
  }))
    if (!Array.prototype[key])
      Object.defineProperty(Array.prototype, key, {
        value: fn,
        configurable: true,
      });
}

export function apiFor(runtime, entry) {
  const alive = () => {
    if (!entry.alive)
      throw new Error(`${entry.manifest.id}: plugin is disabled`);
  };
  const own = (fn) => {
    entry.cleanup.push(fn);
    return fn;
  };
  class Component {
    register(fn) {
      own(fn);
    }
    registerEvent(ref) {
      own(() => ref.emitter.offref(ref));
    }
    registerDomEvent(el, name, cb, opts) {
      el.addEventListener(name, cb, opts);
      own(() => el.removeEventListener(name, cb, opts));
    }
    registerInterval(id) {
      own(() => clearInterval(id));
      return id;
    }
  }
  class Plugin extends Component {
    constructor(app, manifest) {
      super();
      this.app = app;
      this.manifest = manifest;
    }
    addCommand(command) {
      alive();
      entry.commands.push(command);
      return command;
    }
    addSettingTab(tab) {
      alive();
      entry.tabs.push(tab);
    }
    async loadData() {
      alive();
      return structuredClone(runtime.data[entry.manifest.id] || null);
    }
    async saveData(value) {
      alive();
      await runtime.saveData(entry.manifest.id, value);
    }
    registerEditorExtension() {
      throw new Error(
        "CodeMirror extension registration is not implemented in prototype 0.1",
      );
    }
  }
  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = document.createElement("div");
    }
    hide() {
      this.containerEl.remove();
    }
  }
  class Control {
    constructor(parent, type) {
      this.inputEl = parent.createEl(
        type === "select" ? "select" : type === "button" ? "button" : "input",
        type === "select" || type === "button" ? {} : { type },
      );
      this.selectEl = this.inputEl;
      this.sliderEl = this.inputEl;
      this.toggleEl = this.inputEl;
      this.buttonEl = this.inputEl;
    }
    setValue(value) {
      this.value = value;
      if (this.inputEl.type === "checkbox") this.inputEl.checked = !!value;
      else this.inputEl.value = value;
      return this;
    }
    getValue() {
      return this.inputEl.type === "checkbox"
        ? this.inputEl.checked
        : this.inputEl.value;
    }
    setPlaceholder(s) {
      this.inputEl.placeholder = s;
      return this;
    }
    setTooltip(s) {
      this.inputEl.title = s;
      return this;
    }
    setDisabled(b) {
      this.inputEl.disabled = b;
      return this;
    }
    setButtonText(s) {
      this.inputEl.textContent = s;
      return this;
    }
    setLimits(min, max, step) {
      Object.assign(this.inputEl, { min, max, step });
      return this;
    }
    setDynamicTooltip() {
      this.inputEl.title = this.inputEl.value;
      this.inputEl.addEventListener(
        "input",
        () => (this.inputEl.title = this.inputEl.value),
      );
      return this;
    }
    addOption(value, label) {
      const o = this.inputEl.createEl("option", { text: label, value });
      if (this.value !== undefined) this.inputEl.value = this.value;
      return this;
    }
    addOptions(values) {
      for (const [v, label] of Object.entries(values)) this.addOption(v, label);
      return this;
    }
    onChange(fn) {
      this.inputEl.addEventListener(
        this.inputEl.tagName === "SELECT" || this.inputEl.type === "checkbox"
          ? "change"
          : "input",
        () => {
          if (!entry.alive) return;
          const value =
            this.inputEl.type === "range"
              ? Number(this.inputEl.value)
              : this.getValue();
          Promise.resolve()
            .then(() => fn(value))
            .catch(runtime.error);
        },
      );
      return this;
    }
    onClick(fn) {
      this.inputEl.addEventListener("click", () => {
        if (entry.alive) Promise.resolve().then(fn).catch(runtime.error);
      });
      return this;
    }
  }
  class Setting {
    constructor(container) {
      this.settingEl = container.createDiv({ cls: "setting-item" });
      const info = this.settingEl.createDiv({ cls: "setting-item-info" });
      this.nameEl = info.createDiv({ cls: "setting-item-name" });
      this.descEl = info.createDiv({ cls: "setting-item-description" });
      this.controlEl = this.settingEl.createDiv({
        cls: "setting-item-control",
      });
      this.components = [];
    }
    setName(s) {
      this.nameEl.setText(s);
      return this;
    }
    setDesc(s) {
      this.descEl.replaceChildren(
        typeof s === "string" ? document.createTextNode(s) : s,
      );
      return this;
    }
    setDisabled(b) {
      this.components.forEach((c) => c.setDisabled(b));
      this.disabled = b;
      return this;
    }
    add(type, fn) {
      const c = new Control(this.controlEl, type);
      this.components.push(c);
      c.inputEl.setAttribute("aria-label", this.nameEl.textContent);
      c.setDisabled(!!this.disabled);
      fn(c);
      return this;
    }
    addText(fn) {
      return this.add("text", fn);
    }
    addDropdown(fn) {
      return this.add("select", fn);
    }
    addToggle(fn) {
      return this.add("checkbox", fn);
    }
    addSlider(fn) {
      return this.add("range", fn);
    }
    addButton(fn) {
      return this.add("button", fn);
    }
    setHeading() {
      this.settingEl.classList.add("setting-heading");
      return this;
    }
  }
  class Modal extends Component {
    constructor(app) {
      super();
      this.app = app;
      this.modalEl = document.createElement("dialog");
      this.modalEl.className = "bridge-modal";
      this.titleEl = this.modalEl.createEl("h2");
      this.contentEl = this.modalEl.createDiv();
      this.modalEl.addEventListener("close", () => this.close());
      own(() => this.close());
    }
    open() {
      alive();
      document.body.append(this.modalEl);
      this.onOpen?.();
      this.modalEl.showModal();
    }
    close() {
      if (this.closing || !this.modalEl.isConnected) return;
      this.closing = true;
      this.onClose?.();
      this.modalEl.remove();
      this.closing = false;
    }
  }
  class Notice {
    constructor(text) {
      alive();
      runtime.notice(String(text));
    }
  }
  const api = {
    Plugin,
    Component,
    PluginSettingTab,
    Setting,
    Modal,
    Notice,
    MarkdownView: runtime.MarkdownView,
    parseFrontMatterEntry: (fm, key) => fm?.[key],
    Platform: {
      isDesktop: true,
      isMobile: false,
      isMacOS: /Mac/.test(navigator.platform),
    },
  };
  return new Proxy(api, {
    get(target, key) {
      if (key in target || key === "__esModule" || key === Symbol.toStringTag)
        return target[key];
      throw new Error(`Unsupported Obsidian API: ${String(key)}`);
    },
  });
}
