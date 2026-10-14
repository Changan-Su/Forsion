import moment from "moment";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  TFile,
  TFolder,
  TAbstractFile,
  Events,
  normalizePath,
} from "./native-app.js";
// Deliberately scoped subset. Unknown exports/modules fail rather than silently pretending to work.
// Runs in Bridge's dedicated iframe realm; DOM prototype helpers never modify the Forsion document.
export const viewEventOwners = new WeakMap();
export function viewEvent(node, callback, event) {
  let root = node;
  while (root && !viewEventOwners.has(root)) root = root.parentNode;
  const owner = root && viewEventOwners.get(root);
  return owner ? owner(() => callback.call(node, event)) : callback.call(node, event);
}
export function domHelpers() {
  window.activeDocument = document;
  window.activeWindow = window;
  const methods = {
    detach() {
      this.remove();
    },
    setAttr(k, v) {
      this.setAttribute(k, String(v));
      return this;
    },
    getAttr(k) {
      return this.getAttribute(k);
    },
    setAttrs(values) {
      for (const [k, v] of Object.entries(values))
        this.setAttribute(k, String(v));
      return this;
    },
    hasClass(k) {
      return this.classList.contains(k);
    },
    toggleClass(k, on) {
      this.classList.toggle(k, on);
      return this;
    },
    setClass(k) {
      this.className = k;
      return this;
    },
    show() {
      this.hidden = false;
      this.style.display = "";
    },
    hide() {
      this.hidden = true;
    },
    setCssProps(props) {
      for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
      return this;
    },
    setCssStyles(props) {
      Object.assign(this.style, props);
      return this;
    },
    createFragment(cb) {
      const f = document.createDocumentFragment();
      cb(f);
      this.append(f);
      return f;
    },
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
      for (const k of ["href", "type", "value", "title"])
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
      this.addEventListener("click", event => viewEvent(this, cb, event));
      return this;
    },
  };
  for (const [key, fn] of Object.entries(methods))
    if (!Node.prototype[key])
      Object.defineProperty(Node.prototype, key, {
        value: fn,
        configurable: true,
      });
  for (const [key, tag] of Object.entries({
    createDiv: "div",
    createSpan: "span",
    createEl: null,
  }))
    window[key] = (type, o, cb) => {
      const holder = document.createDocumentFragment();
      return tag ? holder.createEl(tag, type, o) : holder.createEl(type, o, cb);
    };
  if (!String.prototype.contains)
    String.prototype.contains = String.prototype.includes;
  if (!String.prototype.format)
    String.prototype.format = function (...a) {
      return this.replace(/\{(\d+)\}/g, (_, n) => a[n] ?? "");
    };
  if (!Array.prototype.contains)
    Array.prototype.contains = Array.prototype.includes;
  if (!Array.prototype.remove)
    Array.prototype.remove = function (v) {
      let i;
      while ((i = this.indexOf(v)) >= 0) this.splice(i, 1);
    };
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
  const epoch = entry.epoch;
  const alive = () => {
    if (!entry.alive || entry.epoch !== epoch)
      throw new Error(`${entry.manifest.id}: plugin is disabled`);
  };
  const own = (fn) => {
    entry.cleanup.push(fn);
    return fn;
  };
  class Component {
    constructor() {
      this._children = [];
      this._cleanup = [];
      this._ownerCleanup = own(() => this.unload());
    }
    load() {
      if (this._unloaded) return;
      const loading = this.onload?.();
      for (const c of this._children) c.load();
      if (loading?.then) return Promise.resolve(loading).then(() => {
        // An async onload may allocate resources after an earlier unload. Give
        // the plugin a final teardown pass; registered callbacks are already revoked.
        if (this._unloaded) return this.onunload?.();
      });
    }
    unload() {
      if (this._unloaded) return;
      this._unloaded = true;
      const ownerIndex = entry.cleanup.indexOf(this._ownerCleanup);
      if (ownerIndex !== -1) entry.cleanup.splice(ownerIndex, 1);
      this._ownerCleanup = null;
      try { Promise.resolve(this.onunload?.()).catch(runtime.error); }
      catch (error) { runtime.error(error); }
      for (const c of this._children.splice(0)) {
        try { c.unload(); } catch (error) { runtime.error(error); }
      }
      for (const f of this._cleanup.splice(0).reverse()) {
        try { f(); } catch (error) { runtime.error(error); }
      }
    }
    addChild(c) {
      if (this._unloaded) { c.unload(); return c; }
      this._children.push(c);
      c.load();
      return c;
    }
    removeChild(c) {
      this._children = this._children.filter((x) => x !== c);
      c.unload();
      return c;
    }

    register(fn) {
      if (this._unloaded) fn();
      else this._cleanup.push(fn);
    }
    registerEvent(ref) {
      this.register(() => ref.emitter.offref(ref));
    }
    registerDomEvent(el, name, cb, opts) {
      el.addEventListener(name, cb, opts);
      this.register(() => el.removeEventListener(name, cb, opts));
    }
    registerInterval(id) {
      this.register(() => clearInterval(id));
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
      queueMicrotask(() => runtime.commandsChanged?.());
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
    registerMarkdownCodeBlockProcessor(language, processor) {
      alive();
      if (runtime.rendering) return runtime.rendering.register(entry, language, processor);
      runtime.partial(entry, `Markdown code block: ${language}`);
      return processor;
    }
    registerMarkdownPostProcessor() {
      runtime.partial(entry, "Markdown postprocessors");
    }
    registerEditorExtension() {
      runtime.partial(entry, "CodeMirror keymaps/extensions");
    }
    registerEditorSuggest() {
      runtime.partial(entry, "Editor suggestions");
    }
    registerView(type, create) {
      alive();
      if (runtime.views) return runtime.views.register(entry, type, create);
      runtime.partial(entry, `Custom view: ${type}`);
    }
    addRibbonIcon(icon, title, cb) {
      const b = document.createElement("button");
      b.textContent = title;
      b.onclick = () => runtime.invoke(entry, cb).catch(runtime.error);
      runtime.ribbon?.append(b);
      own(() => b.remove());
      return b;
    }
    addStatusBarItem() {
      const el = document.createElement("span");
      runtime.statusBar?.append(el);
      own(() => el.remove());
      return el;
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
        type === "select"
          ? "select"
          : type === "button"
            ? "button"
            : type === "textarea"
              ? "textarea"
              : "input",
        type === "select" || type === "button" ? {} : { type },
      );
      this.selectEl = this.inputEl;
      this.sliderEl = this.inputEl;
      this.toggleEl = this.inputEl;
      this.buttonEl = this.inputEl;
    }
    setIcon(icon) {
      this.inputEl.dataset.icon = icon;
      this.inputEl.textContent = icon;
      return this;
    }
    setCta() {
      this.inputEl.classList.add("primary");
      return this;
    }
    setWarning() {
      this.inputEl.classList.add("warning");
      return this;
    }
    then(cb) {
      cb(this);
      return this;
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
    then(cb) {
      cb(this);
      return this;
    }
    setClass(cls) {
      this.settingEl.classList.add(cls);
      return this;
    }
    addExtraButton(fn) {
      return this.add("button", fn);
    }
    addSearch(fn) {
      return this.add("search", fn);
    }
    addTextArea(fn) {
      return this.add("textarea", fn);
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
    setTitle(s) {
      this.titleEl.setText(s);
      return this;
    }
    open() {
      alive();
      document.body.append(this.modalEl);
      runtime.host.openManager?.();
      const context = runtime.context;
      if (context) {
        const pending = new Promise((done) => (this._done = done));
        context.modals.add(pending);
        this._release = () => {
          context.modals.delete(pending);
          this._done();
        };
      }
      this.onOpen?.();
      this.modalEl.showModal();
    }
    close() {
      if (this.closing || !this.modalEl.isConnected) return;
      this.closing = true;
      this.onClose?.();
      this.modalEl.remove();
      this._release?.();
      this._release = null;
      this.closing = false;
    }
  }
  class SuggestModal extends Modal {
    constructor(app) {
      super(app);
      this.inputEl = this.contentEl.createEl("input", { type: "text" });
      this.resultContainerEl = this.contentEl.createDiv();
      this.inputEl.oninput = () => this.updateSuggestions();
      this.inputEl.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void this.choose(this.items?.[this.index || 0], e);
        } else if (e.key === "ArrowDown") {
          this.index = Math.min(
            (this.index || 0) + 1,
            (this.items?.length || 1) - 1,
          );
          this.draw();
        } else if (e.key === "ArrowUp") {
          this.index = Math.max(0, (this.index || 0) - 1);
          this.draw();
        }
      };
    }
    setPlaceholder(s) {
      this.inputEl.placeholder = s;
      return this;
    }
    setInstructions() {
      return this;
    }
    onOpen() {
      void this.updateSuggestions();
    }
    async updateSuggestions() {
      const value = this.inputEl.value;
      const found = await this.getSuggestions(value);
      if (value !== this.inputEl.value) return;
      this.items = found;
      this.index = 0;
      this.draw();
    }
    draw() {
      this.resultContainerEl.empty();
      for (const [itemIndex, item] of (this.items || [])
        .slice(0, 100)
        .entries()) {
        const el = this.resultContainerEl.createDiv({
          cls:
            "suggestion-item" +
            (itemIndex === this.index ? " is-selected" : ""),
        });
        this.renderSuggestion(item, el);
        el.onclick = (e) => void this.choose(item, e);
      }
    }
    async choose(item, e) {
      if (item === undefined) return;
      try {
        await this.onChooseSuggestion(item, e);
        for (const p of [...runtime.pending]) await p;
        await Promise.resolve();
        this.close();
      } catch (e) {
        runtime.error(e);
      }
    }
  }
  class FuzzySuggestModal extends SuggestModal {
    getItems() {
      return [];
    }
    getItemText(item) {
      return String(item);
    }
    getSuggestions(query) {
      return this.getItems()
        .filter((x) =>
          this.getItemText(x).toLowerCase().includes(query.toLowerCase()),
        )
        .map((item) => ({ item, match: { score: 0, matches: [] } }));
    }
    renderSuggestion(result, el) {
      el.setText(this.getItemText(result.item));
    }
    onChooseSuggestion(result, e) {
      return this.onChooseItem(result.item, e);
    }
  }
  class MarkdownRenderChild extends Component {
    constructor(containerEl) { super(); this.containerEl = containerEl; }
  }
  class ItemView extends Component {
    constructor(leaf) {
      super();
      this.leaf = leaf;
      this.app = leaf?.app;
      this.containerEl = document.createElement("div");
      this.containerEl.className = "workspace-leaf-content";
      this.headerEl = this.containerEl.createDiv({ cls: "view-header" });
      this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
      viewEventOwners.set(this.containerEl, fn => leaf.invoke(fn));
    }
    registerDomEvent(el, name, cb, opts) {
      const listener = event => this.leaf.invoke(() => cb.call(el, event));
      el.addEventListener(name, listener, opts);
      this.register(() => el.removeEventListener(name, listener, opts));
    }
    getViewType() { return "item"; }
    getDisplayText() { return this.getViewType(); }
    getIcon() { return "file"; }
    getState() { return {}; }
    async setState() {}
    async onOpen() {}
    async onClose() {}
  }
  class EditorSuggest extends Component {
    constructor(app) {
      super();
      this.app = app;
      this.scope = { register() {} };
    }
    close() {}
  }
  class AbstractInputSuggest extends Component {
    constructor(app, inputEl) {
      super();
      this.app = app;
      this.inputEl = inputEl;
    }
    close() {}
  }
  const debounce = (fn, delay = 0, reset = false) => {
    let id, args;
    const f = (...a) => {
      args = a;
      if (id && reset) clearTimeout(id);
      if (!id || reset)
        id = setTimeout(() => {
          id = null;
          if (entry.alive)
            runtime.invoke(entry, () => fn(...args)).catch(runtime.error);
        }, delay);
    };
    f.cancel = () => {
      clearTimeout(id);
      id = null;
    };
    own(f.cancel);
    return f;
  };
  const icon = (el, id) => {
    el.dataset.icon = id;
    el.setAttribute("aria-label", id);
  };
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
    TFile,
    TFolder,
    TAbstractFile,
    Events,
    normalizePath,
    moment,
    parseYaml,
    stringifyYaml,
    SuggestModal,
    FuzzySuggestModal,
    ItemView,
    MarkdownRenderChild,
    EditorSuggest,
    AbstractInputSuggest,
    ButtonComponent: class extends Control {
      constructor(el) {
        super(el, "button");
      }
    },
    TextComponent: class extends Control {
      constructor(el) {
        super(el, "text");
      }
    },
    DropdownComponent: class extends Control {
      constructor(el) {
        super(el, "select");
      }
    },
    ToggleComponent: class extends Control {
      constructor(el) {
        super(el, "checkbox");
      }
    },
    debounce,
    addIcon: () => {},
    setIcon: icon,
    getLanguage: () => runtime.host.locale || "en",
    getLinkpath: (link) => String(link).split("#")[0],
    parseFrontMatterAliases: (fm) =>
      typeof fm?.aliases === "string" ? [fm.aliases] : fm?.aliases || [],
    parseFrontMatterTags: (fm) =>
      (typeof fm?.tags === "string"
        ? fm.tags.split(/[ ,]+/)
        : fm?.tags || []
      ).map((t) => (t.startsWith("#") ? t : "#" + t)),
    displayTooltip: (el, text) => {
      el.title = text;
    },
    sanitizeHTMLToDom: (html) => {
      const t = document.createElement("template");
      t.innerHTML = html;
      for (const el of t.content.querySelectorAll("script,iframe,object,embed"))
        el.remove();
      for (const el of t.content.querySelectorAll("*"))
        for (const a of [...el.attributes])
          if (a.name.startsWith("on") || /^(javascript|data):/i.test(a.value))
            el.removeAttribute(a.name);
      return t.content;
    },
    htmlToMarkdown: (html) => {
      throw new Error(
        "HTML-to-Markdown conversion is not supported by this prototype",
      );
    },
    requestUrl: async (options) => {
      alive();
      const o = typeof options === "string" ? { url: options } : options;
      const r = await fetch(o.url, {
        method: o.method,
        headers: o.headers,
        body: o.body,
      });
      if (o.throw !== false && !r.ok) throw Error(`HTTP ${r.status}`);
      const arrayBuffer = await r.arrayBuffer(),
        text = new TextDecoder().decode(arrayBuffer);
      alive();
      return {
        status: r.status,
        headers: Object.fromEntries(r.headers),
        arrayBuffer,
        text,
        get json() {
          return JSON.parse(text);
        },
      };
    },
    parseFrontMatterEntry: (fm, key) => fm?.[key],
    Platform: {
      isDesktop: true,
      isMobile: false,
      isMacOS: /Mac/.test(navigator.platform),
    },
  };
  // Older released bundles compile `extends Plugin` to `_super.apply(this, args)`.
  for (const name of [
    "Plugin",
    "Component",
    "PluginSettingTab",
    "Modal",
    "SuggestModal",
    "FuzzySuggestModal",
    "ItemView",
    "MarkdownRenderChild",
    "EditorSuggest",
    "AbstractInputSuggest",
  ]) {
    const Base = api[name];
    function Compatible(...args) {
      return Reflect.construct(Base, args, new.target || this.constructor);
    }
    Object.setPrototypeOf(Compatible, Base);
    Compatible.prototype = Base.prototype;
    api[name] = Compatible;
  }
  return new Proxy(api, {
    get(target, key) {
      if (key in target || key === "__esModule" || key === Symbol.toStringTag)
        return target[key];
      throw new Error(`Unsupported Obsidian API: ${String(key)}`);
    },
  });
}
