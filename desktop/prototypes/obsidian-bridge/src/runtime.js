import { Editor } from "./editor.js";
import { metadata, updateFrontmatter } from "./metadata.js";
import { domHelpers, apiFor } from "./obsidian.js";
import css from "./style.css?inline";

const SORT_SAMPLE = "Zebra\nApple\nBanana\nApple\n";
const HEADING_SAMPLE =
  "# Research notebook\n\n\n## Introduction\n\nA short note about the experiment.\n\n## Method\n\n### Preparation\n\nMeasure the initial state.\n\n### Observation\n\nRecord the result.\n\n## Conclusion\n\nCompare the two runs.\n";
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;
export async function start(host) {
  domHelpers();
  const zh = host.locale === "zh";
  const tr = (a, b) => (zh ? a : b);
  document.head.createEl("style", { text: css });
  document.body.className = "bridge";
  const shell = document.body.createDiv({ cls: "shell" });
  const header = shell.createEl("header");
  header.createEl("span", {
    cls: "eyebrow",
    text: "FORSION / DESKTOP PROTOTYPE",
  });
  header.createEl("h1", { text: "Obsidian Bridge" });
  header.createEl("p", {
    text: tr(
      "原包运行 · 兼容编辑区 · 保存为智库新副本",
      "Original packages · Compatibility editor · Save new vault copies",
    ),
  });
  const toolbar = header.createDiv({ cls: "toolbar" });
  const button = (parent, text, fn, id) => {
    const b = parent.createEl("button", { text });
    if (id) b.dataset.action = id;
    b.addEventListener("click", () => Promise.resolve().then(fn).catch(error));
    return b;
  };
  const status = header.createDiv({
    cls: "status",
    attr: { role: "status", "aria-live": "polite" },
  });
  const body = shell.createDiv({ cls: "body" });
  const side = body.createEl("aside");
  const main = body.createEl("main");
  const editorBar = main.createDiv({ cls: "editor-bar" });
  const filename = editorBar.createEl("span", { text: "Bridge draft.md" });
  const dirty = editorBar.createEl("span", { cls: "muted" });
  const editorEl = main.createDiv({ cls: "editor" });
  const settings = main.createEl("section", {
    cls: "settings",
    attr: { hidden: "", "aria-label": tr("插件设置", "Plugin settings") },
  });
  const footer = shell.createEl("footer", {
    text: tr(
      "0.1 原型：仅在此编辑区提供 API。原包保存在本插件的 plugins/ 子目录；不代表整个 Obsidian 生态已兼容。",
      "Prototype 0.1: APIs apply to this editor. Original packages live in this plugin’s plugins/ folder; ecosystem compatibility is not implied.",
    ),
  });
  let disposed = false,
    scanning = false,
    saving = false,
    serial = Promise.resolve(),
    revision = 0,
    sequence = 0;
  let vaultKey = host.initialDraft?.vaultKey ?? (host.vaultRoot() || ""),
    savedCopy = host.initialDraft?.savedCopy || null,
    activeSettings = null,
    openSaved;
  const store = (await host.loadData()) || { version: 1, vaults: {} };
  store.vaults ||= {};
  // Local settings belong to this vault. A switch is refused until this view is reopened.
  store.vaults[vaultKey] ||= { plugins: {}, disabled: [] };
  const state = store.vaults[vaultKey];
  const entries = new Map();
  const error = (e) => {
    if (!disposed) {
      status.textContent = String(e?.message || e);
      status.dataset.error = "true";
      console.error("[obsidian-bridge]", e);
    }
  };
  const notice = (s) => {
    status.textContent = s;
    delete status.dataset.error;
  };
  const assertCurrent = () => {
    if (disposed) throw new Error("Bridge is closed");
    if ((host.vaultRoot() || "") !== vaultKey)
      throw new Error(
        tr(
          "智库已切换，请重新打开 Bridge。草稿仍保留在此编辑区。",
          "Vault changed. Reopen Bridge; the draft remains in this editor.",
        ),
      );
  };
  const persist = () => {
    assertCurrent();
    const snapshot = structuredClone(store);
    // Parent host accepts and serializes immediately, including snapshots queued before teardown.
    serial = host.saveData(snapshot);
    return serial;
  };
  let publishDraft = () => {};
  const editor = new Editor(editorEl, host.initialDraft?.text ?? HEADING_SAMPLE, () => {
    revision++;
    dirty.textContent = tr("未导出", "Not exported");
    savedCopy = null;
    if (openSaved) openSaved.disabled = true;
    publishDraft();
  }, () => publishDraft());
  class MarkdownView {}
  class TFile {
    constructor(path) {
      this.path = path;
      this.name = path.split("/").pop();
      this.basename = this.name.replace(/\.md$/, "");
      this.extension = "md";
    }
  }
  const file = new TFile(host.initialDraft?.filePath || "Bridge draft.md");
  filename.textContent = host.initialDraft?.label || file.path;
  dirty.textContent = savedCopy ? tr("已导出", "Exported") : tr("未导出", "Not exported");
  publishDraft = () => host.onDraft?.({ text: editor.getValue(), cursor: editor.getCursor(), filePath: file.path, label: filename.textContent, savedCopy, vaultKey });
  const view = Object.assign(new MarkdownView(), {
    editor,
    sourceMode: { cmEditor: editor },
    file,
    getViewType: () => "markdown",
  });
  const app = {
    workspace: {
      activeLeaf: { view },
      getActiveViewOfType: (type) => (view instanceof type ? view : null),
      getActiveFile: () => file,
    },
    metadataCache: {
      getFileCache: (f) => {
        if (f !== file)
          throw new Error("Only the compatibility document is indexed");
        return metadata(editor.getValue());
      },
    },
    fileManager: {
      processFrontMatter: async (f, fn) => {
        assertCurrent();
        if (f !== file) throw new Error("Unknown file");
        editor.setValue(updateFrontmatter(editor.getValue(), fn));
      },
    },
    vault: {
      getName: () => "Forsion Bridge",
      read: async (f) => {
        assertCurrent();
        if (f !== file)
          throw new Error("Only the compatibility document is available");
        return editor.getValue();
      },
      cachedRead: async (f) => app.vault.read(f),
    },
  };
  const runtime = {
    MarkdownView,
    data: state.plugins,
    error,
    notice,
    async saveData(id, value) {
      assertCurrent();
      state.plugins[id] = structuredClone(value);
      await persist();
      if (!disposed) notice(tr("插件设置已保存", "Plugin settings saved"));
    },
  };
  const showSettings = (entry) => {
    settings.replaceChildren();
    settings.hidden = false;
    activeSettings = entry.manifest.id;
    const bar = settings.createDiv({ cls: "settings-bar" });
    bar.createEl("strong", { text: entry.manifest.name });
    button(
      bar,
      tr("返回编辑器", "Back to editor"),
      () => {
        settings.hidden = true;
        activeSettings = null;
        editorEl.hidden = false;
      },
      "close-settings",
    );
    editorEl.hidden = true;
    for (const tab of entry.tabs) {
      settings.append(tab.containerEl);
      tab.display();
    }
  };
  function drawPlugins() {
    side.replaceChildren();
    const top = side.createDiv({ cls: "side-heading" });
    top.createEl("strong", { text: tr("已安装插件", "Installed plugins") });
    top.createEl("span", { cls: "muted", text: String(entries.size) });
    for (const entry of entries.values()) {
      const row = side.createEl("section", {
        cls: "plugin-row",
        attr: { "data-plugin": entry.manifest.id },
      });
      const title = row.createDiv({ cls: "plugin-title" });
      title.createEl("strong", { text: entry.manifest.name });
      row.createDiv({
        cls: "muted",
        text: `${entry.manifest.version} · ${entry.alive ? tr("运行中", "Running") : entry.error ? tr("加载失败", "Failed") : tr("已禁用", "Disabled")}`,
      });
      if (entry.error) row.createDiv({ cls: "error", text: entry.error });
      const controls = row.createDiv({ cls: "plugin-controls" });
      button(
        controls,
        entry.alive ? tr("禁用", "Disable") : tr("启用", "Enable"),
        async () => {
          assertCurrent();
          if (entry.busy || scanning) return;
          entry.busy = true;
          try {
            if (entry.alive) {
              unload(entry);
              state.disabled = [
                ...new Set([...state.disabled, entry.manifest.id]),
              ];
            } else {
              state.disabled = state.disabled.filter(
                (x) => x !== entry.manifest.id,
              );
              await load(entry);
            }
            await persist();
          } finally {
            entry.busy = false;
            drawPlugins();
          }
        },
        "toggle-plugin",
      );
      if (entry.alive && entry.tabs.length)
        button(
          controls,
          tr("设置", "Settings"),
          () => showSettings(entry),
          "settings",
        );
      if (entry.alive) {
        const details = row.createEl("details");
        details.open = true;
        details.createEl("summary", {
          text: `${entry.commands.length} ${tr("个命令", "commands")}`,
        });
        for (const command of entry.commands) {
          const b = button(details, command.name, () =>
            run(entry.manifest.id, command.id),
          );
          b.className = "command";
          b.dataset.command = entry.manifest.id + ":" + command.id;
        }
      }
    }
  }
  function unload(entry) {
    entry.alive = false;
    try {
      entry.instance?.onunload?.();
    } catch (e) {
      error(e);
    }
    for (const dispose of entry.cleanup.splice(0).reverse()) {
      try {
        dispose();
      } catch (e) {
        error(e);
      }
    }
    entry.commands = [];
    entry.tabs.forEach((t) => t.hide());
    entry.tabs = [];
    entry.instance = null;
    if (activeSettings === entry.manifest.id) {
      settings.hidden = true;
      editorEl.hidden = false;
      activeSettings = null;
    }
  }
  async function load(entry) {
    entry.alive = true;
    entry.error = null;
    entry.commands = [];
    entry.tabs = [];
    entry.cleanup = [];
    const api = apiFor(runtime, entry);
    const timeouts = new Set(),
      intervals = new Set();
    const later = (cb, delay, ...args) => {
      const id = window.setTimeout(() => {
        timeouts.delete(id);
        if (entry.alive && !disposed) {
          try {
            cb(...args);
          } catch (e) {
            error(e);
          }
        }
      }, delay);
      timeouts.add(id);
      return id;
    };
    const every = (cb, delay, ...args) => {
      const id = window.setInterval(() => {
        if (entry.alive && !disposed) {
          try {
            cb(...args);
          } catch (e) {
            error(e);
          }
        }
      }, delay);
      intervals.add(id);
      return id;
    };
    entry.cleanup.push(() => {
      timeouts.forEach(clearTimeout);
      intervals.forEach(clearInterval);
      timeouts.clear();
      intervals.clear();
    });
    entry.timerCount = () => timeouts.size + intervals.size;
    const win = new Proxy(window, {
      get(target, key) {
        if (key === "setTimeout") return later;
        if (key === "setInterval") return every;
        return Reflect.get(target, key);
      },
    });
    try {
      const code = await host.packageFiles.readText(
        `plugins/${entry.manifest.id}/main.js`,
      );
      if (!entry.alive || disposed) return;
      const packageEntries = await host.packageFiles.list(
        `plugins/${entry.manifest.id}`,
      );
      if (packageEntries.includes("styles.css")) {
        const css = await host.packageFiles.readText(
          `plugins/${entry.manifest.id}/styles.css`,
        );
        if (!entry.alive || disposed) return;
        const style = document.head.createEl("style", { text: css });
        entry.cleanup.push(() => style.remove());
      }
      const module = { exports: {} };
      const require = (name) => {
        if (name === "obsidian") return api;
        throw new Error(`Unsupported external module: ${name}`);
      };
      new Function(
        "require",
        "module",
        "exports",
        "window",
        "setTimeout",
        "setInterval",
        code +
          "\n//# sourceURL=obsidian-bridge/" +
          entry.manifest.id +
          "/main.js",
      )(require, module, module.exports, win, later, every);
      const Constructor = module.exports.default || module.exports;
      if (typeof Constructor !== "function")
        throw new Error("Plugin default export is not a class");
      entry.instance = new Constructor(app, entry.manifest);
      await entry.instance.onload?.();
      if (!entry.alive || disposed) unload(entry);
    } catch (e) {
      unload(entry);
      entry.error = String(e?.message || e);
      error(e);
    }
  }
  async function scan() {
    if (scanning || [...entries.values()].some((e) => e.busy)) return;
    scanning = true;
    try {
      assertCurrent();
      for (const entry of entries.values()) unload(entry);
      entries.clear();
      const dirs = await host.packageFiles.list("plugins");
      for (const id of dirs.filter((x) => SAFE_ID.test(x))) {
        if (disposed) return;
        try {
          const manifest = JSON.parse(
            await host.packageFiles.readText(`plugins/${id}/manifest.json`),
          );
          if (manifest.id !== id || !manifest.name || !manifest.version)
            throw new Error(`Invalid manifest in plugins/${id}`);
          const entry = {
            manifest,
            alive: false,
            commands: [],
            tabs: [],
            cleanup: [],
          };
          entries.set(id, entry);
          if (!state.disabled.includes(id)) await load(entry);
        } catch (e) {
          error(e);
        }
      }
      drawPlugins();
      notice(
        tr(
          `已加载 ${[...entries.values()].filter((e) => e.alive).length} 个插件原包`,
          `Loaded ${[...entries.values()].filter((e) => e.alive).length} original plugin packages`,
        ),
      );
    } finally {
      scanning = false;
    }
  }
  async function run(id, commandId) {
    assertCurrent();
    const entry = entries.get(id);
    if (!entry?.alive || entry.busy || scanning)
      throw new Error("Plugin disabled or reloading");
    const command = entry.commands.find((c) => c.id === commandId);
    if (!command) throw new Error("Command not found");
    if (command.checkCallback && !command.checkCallback(true))
      throw new Error("Command unavailable");
    if (
      command.editorCheckCallback &&
      !command.editorCheckCallback(true, editor, view)
    )
      throw new Error("Editor command unavailable");
    if (command.editorCallback) await command.editorCallback(editor, view);
    else if (command.editorCheckCallback)
      await command.editorCheckCallback(false, editor, view);
    else if (command.checkCallback) await command.checkCallback(false);
    else await command.callback?.();
    notice(`${entry.manifest.name} → ${command.name}`);
    editor.focus();
  }
  button(
    toolbar,
    tr("排序示例", "Sorting sample"),
    () => {
      editor.setValue(SORT_SAMPLE);
      editor.setCursor({ line: 0, ch: 0 });
      editor.focus();
    },
    "sort-sample",
  );
  button(
    toolbar,
    tr("标题示例", "Heading sample"),
    () => {
      editor.setValue(HEADING_SAMPLE);
      editor.setCursor({ line: 2, ch: 0 });
      editor.focus();
    },
    "heading-sample",
  );
  button(toolbar, tr("撤销", "Undo"), () => editor.undo(), "undo");
  button(toolbar, tr("重扫插件", "Rescan plugins"), scan, "rescan");
  const fileSelect = toolbar.createEl("select", {
    attr: { "aria-label": tr("从智库读取笔记", "Read a vault note") },
  });
  fileSelect.createEl("option", {
    text: tr("从智库读取…", "Read from vault…"),
    value: "",
  });
  const pages = await host.listPages();
  for (const path of pages)
    fileSelect.createEl("option", { text: path, value: path });
  fileSelect.addEventListener("change", () => {
    const path = fileSelect.value,
      token = ++sequence,
      readRevision = revision;
    if (!path) return;
    Promise.resolve()
      .then(async () => {
        assertCurrent();
        const text = await host.readFile(path);
        assertCurrent();
        if (token !== sequence) return;
        if (revision !== readRevision)
          throw new Error(tr("读取期间草稿已修改；已保留当前草稿，请重新选择笔记。", "Draft changed while reading; your edits were kept. Select the note again."));
        if (text == null) throw new Error("Note no longer exists");
        editor.setValue(text);
        Object.assign(file, new TFile(path));
        filename.textContent = path + tr("（副本草稿）", " (copy draft)");
        editor.setCursor({ line: 0, ch: 0 });
        publishDraft();
      })
      .catch(error);
  });
  const saveButton = button(
    toolbar,
    tr("保存新副本", "Save new copy"),
    async () => {
      if (saving) return;
      assertCurrent();
      if (!vaultKey) throw new Error(tr("请先打开智库", "Open a vault first"));
      saving = true;
      saveButton.disabled = true;
      const value = editor.getValue(),
        path = `Obsidian Bridge/Bridge-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.md`;
      try {
        await host.writeFile(path, value);
        assertCurrent();
        if (editor.getValue() === value) {
          savedCopy = path;
          dirty.textContent = tr("已导出", "Exported");
          openSaved.disabled = false;
          publishDraft();
        }
        notice(path);
      } finally {
        saving = false;
        saveButton.disabled = false;
      }
    },
    "save-copy",
  );
  saveButton.className = "primary";
  openSaved = button(
    toolbar,
    tr("打开已保存笔记", "Open saved note"),
    () => {
      assertCurrent();
      if (savedCopy) host.openFile(savedCopy);
    },
    "open-saved",
  );
  openSaved.disabled = !savedCopy;
  await scan();
  if (host.initialDraft?.cursor) editor.setCursor(host.initialDraft.cursor);
  publishDraft();
  const instance = {
    editor,
    run,
    scan,
    flush: () => serial,
    diagnostics: () => ({
      plugins: [...entries.values()].map((e) => ({
        id: e.manifest.id,
        version: e.manifest.version,
        alive: e.alive,
        commands: e.commands.length,
        timers: e.timerCount?.() || 0,
        error: e.error,
      })),
      savedCopy,
      vaultKey,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const e of entries.values()) unload(e);
      editor.destroy();
      shell.remove();
    },
  };
  window.bridge = instance;
  return instance;
}
