import { metadata } from "./metadata.js";
export const normalizePath = (path) => {
  const p = String(path)
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
  if (
    p.startsWith("/") ||
    p.split("/").some((s) => s === "..") ||
    p.includes("\0") ||
    /^[a-z]:/i.test(p)
  )
    throw new Error("Expected a vault-relative path");
  return p;
};
export class TAbstractFile {
  constructor(path) {
    this.path = path;
    this.name = path.split("/").pop() || "";
    this.parent = null;
  }
}
export class TFolder extends TAbstractFile {
  children = [];
  isRoot() {
    return this.path === "";
  }
}
export class TFile extends TAbstractFile {
  constructor(path) {
    super(path);
    this.extension = this.name.includes(".") ? this.name.split(".").pop() : "";
    this.basename = this.name.slice(
      0,
      this.name.length - (this.extension ? this.extension.length + 1 : 0),
    );
    this.stat = { ctime: 0, mtime: 0, size: 0 };
  }
}
export class Events {
  constructor(dispatch = (fn, args) => fn(...args)) {
    this.refs = new Set();
    this.dispatch = dispatch;
  }
  on(name, fn, ctx) {
    const r = { emitter: this, name, fn, ctx };
    this.refs.add(r);
    return r;
  }
  off(name, fn) {
    for (const r of this.refs)
      if (r.name === name && r.fn === fn) this.refs.delete(r);
  }
  offref(r) {
    this.refs.delete(r);
  }
  trigger(name, ...args) {
    for (const r of [...this.refs])
      if (r.name === name) this.dispatch(r.fn.bind(r.ctx), args);
  }
  tryTrigger(r, args) {
    if (this.refs.has(r)) this.dispatch(r.fn.bind(r.ctx), args);
  }
}
export function createNativeApp(host, runtime) {
  const eventSubscriptions = new WeakMap();
  const files = new Map(),
    sources = new Map(),
    caches = new Map();
  const root = new TFolder("");
  files.set("", root);
  const vault = new Events(),
    workspace = new Events(),
    metadataCache = new Events();
  let disposed = false;
  const ensure = (p) => {
    p = normalizePath(p);
    if (files.has(p)) return files.get(p);
    const f = new TFile(p);
    files.set(p, f);
    const bits = p.split("/");
    bits.pop();
    let parent = root,
      at = "";
    for (const bit of bits) {
      at += (at ? "/" : "") + bit;
      let d = files.get(at);
      if (!d) {
        d = new TFolder(at);
        files.set(at, d);
        d.parent = parent;
        parent.children.push(d);
      }
      parent = d;
    }
    f.parent = parent;
    parent.children.push(f);
    return f;
  };
  const cache = (f, text) => {
    sources.set(f.path, text);
    caches.set(f.path, metadata(text));
    f.stat.size = new TextEncoder().encode(text).length;
  };
  const check = () => {
    if (disposed) throw Error("Bridge stopped");
    if (
      runtime.context &&
      (!runtime.context.entry.alive ||
        runtime.context.entry.instance !== runtime.context.generation)
    )
      throw Error("Plugin disabled or reloaded");
    runtime.assertCurrent();
  };
  const current = () => runtime.context;
  const activeFile = () => {
    let path = current()?.editor?.edit?.path;
    try {
      path ||= host.captureEditor?.()?.path;
    } catch {}
    return path ? ensure(path) : null;
  };
  const fullText = (f) => {
    const c = current();
    if (c?.editor?.active && c.file.path === f.path) {
      const raw = sources.get(f.path) || "";
      const prefix =
        raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] || "";
      return prefix + c.editor.getValue();
    }
    return null;
  };
  const read = async (f, guard = check) => {
    guard();
    const live = fullText(f);
    if (live !== null) return live;
    const text = await host.readFile(f.path);
    guard();
    if (text === null) throw Error(`File not found: ${f.path}`);
    cache(f, text);
    return text;
  };
  const write = async (f, text, expected, guard = check) => {
    guard();
    const c = current();
    if (c?.editor?.active && f.path === c.file.path) {
      const raw = fullText(f);
      if (expected !== raw) throw Error("Native note changed");
      const prefix =
        raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] || "";
      if (!text.startsWith(prefix) || (!prefix && text.startsWith("---\n")))
        throw Error("Use processFrontMatter for native properties");
      c.editor.setValue(text.slice(prefix.length));
      return;
    }
    await host.writeFileChecked(f.path, text, expected);
    guard();
    cache(f, text);
    vault.trigger(expected === null ? "create" : "modify", f);
    metadataCache.trigger("changed", f, text, caches.get(f.path));
    metadataCache.trigger("resolved");
  };
  Object.assign(vault, {
    configDir: ".obsidian",
    getName: () => host.vaultRoot()?.split("/").pop() || "Forsion",
    getRoot: () => root,
    getFiles: () => [...files.values()].filter((f) => f instanceof TFile),
    getMarkdownFiles: () =>
      vault.getFiles().filter((f) => f.extension === "md"),
    getAllLoadedFiles: () => [...files.values()],
    getAbstractFileByPath: (p) => files.get(normalizePath(p)) || null,
    getFileByPath: (p) => {
      const f = files.get(normalizePath(p));
      return f instanceof TFile ? f : null;
    },
    getFolderByPath: (p) => {
      const f = files.get(normalizePath(p));
      return f instanceof TFolder ? f : null;
    },
    read,
    cachedRead: read,
    modify: async (f, text) => {
      const old = await read(f);
      await write(f, text, old);
    },
    process: async (f, fn) => {
      const old = await read(f),
        next = fn(old);
      if (typeof next !== "string")
        throw Error("Vault.process callback must return text synchronously");
      if (next !== old) await write(f, next, old);
      return next;
    },
    create: async (p, text) => {
      p = normalizePath(p);
      if (files.has(p)) throw Error(`File already exists: ${p}`);
      const f = new TFile(p);
      await write(f, text, null);
      return ensure(p);
    },
    append: async (f, text) => vault.process(f, (old) => old + text),
    getConfig: (key) =>
      ({
        newLinkFormat: "shortest",
        useMarkdownLinks: false,
        tabSize: 4,
        autoConvertHtml: true,
        attachmentFolderPath: "",
      })[key],
  });
  vault.adapter = {
    read: (p) => read(ensure(p)),
    write: async (p, text) => {
      const f = files.get(normalizePath(p));
      if (f) await vault.modify(f, text);
      else await vault.create(p, text);
    },
    append: async (p, text) => vault.append(ensure(p), text),
    exists: async (p) => files.has(normalizePath(p)),
    stat: async (p) => {
      const f = files.get(normalizePath(p));
      return f
        ? { ...f.stat, type: f instanceof TFolder ? "folder" : "file" }
        : null;
    },
    list: async (p) => {
      const f = files.get(normalizePath(p));
      if (!(f instanceof TFolder)) throw Error("Folder not found");
      return {
        files: f.children.filter((f) => f instanceof TFile).map((f) => f.path),
        folders: f.children
          .filter((f) => f instanceof TFolder)
          .map((f) => f.path),
      };
    },
    getName: () => "Forsion",
    getBasePath: () => host.vaultRoot(),
  };
  // Editor coordinates refer to Amadeus's body, while vault.read includes properties.
  // Keep property values available without exposing a frontmatter range outside that editor.
  const fileCache = (f) => {
    const c = current();
    if (c?.editor?.active && c.file.path === f?.path) {
      const body = metadata(c.editor.getValue());
      const fm = caches.get(f.path)?.frontmatter;
      if (fm) body.frontmatter = structuredClone(fm);
      delete body.frontmatterPosition;
      return body;
    }
    return caches.get(f?.path) || null;
  };
  Object.assign(metadataCache, {
    getFileCache: fileCache,
    getCache: (p) => fileCache(files.get(normalizePath(p))),
    getFirstLinkpathDest: (link, source) => {
      link = String(link).split("#")[0];
      if (!link) return files.get(source) || null;
      return (
        files.get(link) ||
        files.get(link + ".md") ||
        vault.getMarkdownFiles().find((f) => f.basename === link) ||
        null
      );
    },
    fileToLinktext: (f) => f.path.replace(/\.md$/i, ""),
    resolvedLinks: {},
    unresolvedLinks: {},
  });
  Object.assign(workspace, {
    layoutReady: true,
    get activeLeaf() {
      return current()?.view ? { view: current().view } : null;
    },
    getActiveViewOfType: (type) =>
      current()?.view instanceof type ? current().view : null,
    getActiveFile: activeFile,
    getLeavesOfType: (type) =>
      type === "markdown" && current()?.view ? [{ view: current().view }] : runtime.views?.getLeavesOfType(type) || [],
    iterateAllLeaves: (fn) => {
      if (current()?.view) fn({ view: current().view });
      runtime.views?.iterateAllLeaves(fn);
    },
    getMostRecentLeaf: () =>
      current()?.view ? { view: current().view } : null,
    openLinkText: async (link, source, newLeaf) => {
      const f = metadataCache.getFirstLinkpathDest(link, source);
      if (!f) throw Error(`Link target not found: ${link}`);
      if (current())
        current().after.push(() =>
          host.openNote(f.path, { newTab: !!newLeaf }),
        );
      else host.openNote(f.path, { newTab: !!newLeaf });
    },
    onLayoutReady: (fn) => {
      runtime.defer(fn);
    },
    detachLeavesOfType: type => runtime.views?.detachLeavesOfType(type),
    revealLeaf: leaf => runtime.views?.revealLeaf(leaf),
    getRightLeaf: () => runtime.views?.getLeaf("right"),
    getLeftLeaf: () => runtime.views?.getLeaf("left"),
    getLeaf: () => runtime.views?.getLeaf("main") || ({
      openFile: async (f) => workspace.openLinkText(f.path, "", true),
    }),
  });
  // Accessor must remain live rather than being evaluated by Object.assign.
  Object.defineProperty(workspace, "activeLeaf", {
    get: () => (current()?.view ? { view: current().view } : null),
  });
  const fileManager = {
    generateMarkdownLink: (f, source, subpath = "", alias = "") =>
      `[[${f.path.replace(/\.md$/i, "")}${subpath}${alias ? "|" + alias : ""}]]`,
    getNewFileParent: () => root,
    processFrontMatter: async (f, fn, guard = check) => {
      guard();
      const raw = await read(f, guard);
      const parsed = metadata(raw);
      if (parsed.frontmatterError)
        throw Error("Invalid frontmatter: " + parsed.frontmatterError);
      const before = parsed.frontmatter || {};
      const after = structuredClone(before);
      fn(after);
      const patch = {};
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)]))
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k]))
          patch[k] = after[k];
      const apply = async () => {
        guard();
        await host.patchNoteProperties(f.path, patch);
        guard();
        await read(f, guard);
      };
      if (current()?.file?.path === f.path) current().after.push(apply);
      else await apply();
    },
  };
  const app = {
    vault,
    workspace,
    metadataCache,
    fileManager,
    plugins: { plugins: {} },
    commands: {
      commands: {},
      executeCommandById: (id) => runtime.executeCommand(id),
    },
    keymap: { isModEvent: (e) => e.metaKey || e.ctrlKey },
    isMobile: false,
  };
  async function refresh(path = null) {
    check();
    if (path) {
      const f = files.get(path);
      if (f instanceof TFile) {
        const text = await host.readFile(path);
        check();
        if (text !== null && text !== sources.get(path)) {
          cache(f, text);
          vault.trigger("modify", f);
          metadataCache.trigger("changed", f, text, caches.get(path));
          metadataCache.trigger("resolved");
        }
        return;
      }
    }
    const names = await host.listPages();
    check();
    if (names.length > 5000)
      throw Error("Bridge prototype indexing limit: 5000 Markdown files");
    const set = new Set(names);
    for (const f of vault.getMarkdownFiles())
      if (!set.has(f.path)) {
        files.delete(f.path);
        sources.delete(f.path);
        caches.delete(f.path);
        f.parent.children = f.parent.children.filter((x) => x !== f);
        vault.trigger("delete", f);
        metadataCache.trigger("deleted", f);
      }
    for (const p of names) {
      check();
      const existed = files.has(p),
        f = ensure(p);
      const text = await host.readFile(p);
      check();
      if (text !== null && text !== sources.get(p)) {
        cache(f, text);
        if (!existed) vault.trigger("create", f);
        metadataCache.trigger("changed", f, text, caches.get(p));
      }
    }
    metadataCache.trigger("resolved");
  }
  const off = host.onVaultChange?.((p) => {
    void refresh(p).catch(runtime.error);
  });
  return {
    app,
    ensure,
    refresh,
    dispose() {
      disposed = true;
      off?.();
      for (const e of [vault, workspace, metadataCache]) e.refs.clear();
    },
    forEntry(entry) {
      let ownedEvents = eventSubscriptions.get(entry);
      if (!ownedEvents) eventSubscriptions.set(entry, ownedEvents = new Set());
      const epoch = entry.epoch;
      const live = () => entry.alive && entry.epoch === epoch;
      const guard = () => {
        if (!live()) throw Error("Plugin disabled or reloaded");
        check();
      };
      const baselines = new Map();
      const scopedRead = async (f) => {
        const text = await read(f, guard);
        baselines.set(f.path, text);
        return text;
      };
      const scopedWrite = async (f, text, expected) => {
        await write(f, text, expected, guard);
        baselines.set(f.path, text);
      };
      const writes = {
        read: scopedRead,
        cachedRead: scopedRead,
        modify: async (f, text) => {
          guard();
          if (!baselines.has(f.path))
            throw Error(
              "Read the note before modifying it, or use Vault.process",
            );
          await scopedWrite(f, text, baselines.get(f.path));
        },
        process: async (f, fn) => {
          const old = await scopedRead(f),
            next = fn(old);
          guard();
          if (typeof next !== "string")
            throw Error("Vault.process requires a synchronous text result");
          if (next !== old) await scopedWrite(f, next, old);
          return next;
        },
        create: async (p, text) => {
          guard();
          p = normalizePath(p);
          if (files.has(p)) throw Error(`File already exists: ${p}`);
          const f = new TFile(p);
          await scopedWrite(f, text, null);
          return ensure(p);
        },
        append: async (f, text) => writes.process(f, (old) => old + text),
      };
      const adapter = {
        ...vault.adapter,
        read: (p) => scopedRead(ensure(p)),
        write: (p, text) => {
          const f = files.get(normalizePath(p));
          return f ? writes.modify(f, text) : writes.create(p, text);
        },
        append: (p, text) => writes.append(ensure(p), text),
      };
      const scoped = { ...app };
      for (const key of ["vault", "workspace", "metadataCache"]) {
        const source = app[key];
        scoped[key] = new Proxy(source, {
          get(target, k) {
            if (key === "vault" && k in writes)
              return (...a) => runtime.track(writes[k](...a));
            if (k === "adapter")
              return new Proxy(adapter, {
                get(a, m) {
                  const fn = a[m];
                  return typeof fn === "function"
                    ? (...args) => {
                        guard();
                        return runtime.track(fn(...args));
                      }
                    : fn;
                },
              });
            if (k === "on")
              return (name, cb, ctx) => {
                guard();
                const subscription = { target, name, cb, active: true, ref: null, off: null };
                const off = () => {
                  if (!subscription.active) return;
                  subscription.active = false; target.offref(subscription.ref); ownedEvents.delete(subscription);
                  const i = entry.cleanup.indexOf(off); if (i !== -1) entry.cleanup.splice(i, 1);
                };
                subscription.off = off;
                const ref = target.on(name, (...args) => {
                  if (live() && subscription.active)
                    void runtime.invoke(entry, () => {
                      if (live() && subscription.active) return cb.apply(ctx,
                        name === "editor-change" ? [runtime.context?.editor, runtime.context?.view] : args);
                    }).catch(runtime.error);
                });
                subscription.ref = ref;
                // Component.registerEvent also disposes through the EventRef itself.
                ref.emitter = {offref: off};
                ownedEvents.add(subscription); entry.cleanup.push(off);
                return ref;
              };
            if (k === "off") return (name, cb) => {
              for (const subscription of [...ownedEvents])
                if (subscription.target === target && subscription.name === name && subscription.cb === cb) subscription.off();
            };
            if (k === "offref") return ref => {
              for (const subscription of [...ownedEvents])
                if (subscription.target === target && subscription.ref === ref) subscription.off();
            };
            if (k === "onLayoutReady")
              return (cb) => runtime.defer(() => runtime.invoke(entry, cb));
            const v = Reflect.get(target, k);
            if (typeof v !== "function") return v;
            return (...args) => {
              if (
                !live() &&
                !["off", "offref", "detachLeavesOfType"].includes(k)
              )
                throw Error("Plugin disabled");
              const out = v.apply(target, args);
              if (key === "workspace" && ["getLeaf", "getRightLeaf", "getLeftLeaf"].includes(k) && out) {
                // Returned leaves outlive the workspace call; revoke their methods too.
                return new Proxy(out, { get(leaf, name) {
                  const method = Reflect.get(leaf, name);
                  if (typeof method !== "function") return method;
                  return (...values) => { guard(); return method.apply(leaf, values); };
                } });
              }
              return runtime.track(out);
            };
          },
        });
      }
      scoped.fileManager = new Proxy(fileManager, {
        get(t, k) {
          const v = t[k];
          return typeof v === "function"
            ? (...a) => {
                if (!live()) throw Error("Plugin disabled");
                if (runtime.context?.failure) throw runtime.context.failure;
                guard();
                return runtime.track(
                  k === "processFrontMatter" ? v(...a, guard) : v(...a),
                );
              }
            : v;
        },
      });
      return scoped;
    },
  };
}
