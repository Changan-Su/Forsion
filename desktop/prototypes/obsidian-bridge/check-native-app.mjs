import assert from "node:assert/strict";
import { createNativeApp } from "./src/native-app.js";
const files = new Map([
  ["Active.md", "---\nkeep: yes\n---\n# Heading\n"],
  ["Folder/Other.md", "old"],
  ["Malformed.md", "---\nfoo: [\n---\nBody"],
]);
let root = "/fixture",
  unsubscribed = false,
  watch,
  readGate;
const entry = { alive: true, epoch: 1, instance: {}, cleanup: [] };
const runtime = {
  context: null,
  track: (p) => p,
  assertCurrent: () => {
    if (root !== "/fixture") throw Error("Vault changed");
  },
  defer: (fn) => fn(),
  invoke: async (e, fn) => fn(),
  error: (e) => {
    throw e;
  },
  executeCommand: () => false,
};
const bridge = createNativeApp(
  {
    vaultRoot: () => root,
    listPages: async () => [...files.keys()],
    captureEditor: () => null,
    readFile: async (p) => {
      await readGate;
      return files.get(p) ?? null;
    },
    writeFileChecked: async (p, t, old) => {
      assert.equal(files.get(p) ?? null, old);
      files.set(p, t);
    },
    onVaultChange: (cb) => {
      watch = cb;
      return () => {
        unsubscribed = true;
      };
    },
    patchNoteProperties: async () => {},
    openNote: () => {},
  },
  runtime,
);
await bridge.refresh();
const app = bridge.forEntry(entry),
  file = app.vault.getFileByPath("Active.md");
assert.equal(app.vault.getMarkdownFiles().length, 3);
assert.equal(
  (await app.vault.adapter.list("Folder")).files[0],
  "Folder/Other.md",
);
runtime.context = {
  entry,
  generation: entry.instance,
  file,
  editor: {
    active: true,
    edit: { path: file.path },
    getValue: () => "# Heading\n",
  },
  after: [],
};
assert.equal(
  app.metadataCache.getFileCache(file).headings[0].position.start.line,
  0,
);
assert.equal(app.metadataCache.getFileCache(file).frontmatter.keep, "yes");
assert.equal(
  app.metadataCache.getFileCache(file).frontmatterPosition,
  undefined,
);
assert.match(await app.vault.read(file), /^---/);
runtime.context = null;
assert.ok(app.metadataCache.getCache("Malformed.md").frontmatterError);
await assert.rejects(
  app.fileManager.processFrontMatter(
    app.vault.getFileByPath("Malformed.md"),
    (f) => {
      f.new = 1;
    },
  ),
  /Invalid frontmatter/,
);
assert.equal(files.get("Malformed.md"), "---\nfoo: [\n---\nBody");
const eventBaseline = entry.cleanup.length;
let eventsCalled = 0;
const onCss = () => eventsCalled++;
app.workspace.on('css-change', onCss);
bridge.app.workspace.trigger('css-change');
await Promise.resolve(); assert.equal(eventsCalled, 1);
app.workspace.off('css-change', onCss);
bridge.app.workspace.trigger('css-change');
await Promise.resolve(); assert.equal(eventsCalled, 1);
assert.equal(entry.cleanup.length, eventBaseline);
const ownedRef = app.workspace.on('css-change', onCss);
ownedRef.emitter.offref(ownedRef);
assert.equal(entry.cleanup.length, eventBaseline);
assert.equal(bridge.app.workspace.refs.size, 0);
let count = 0;
const ref = app.vault.on("modify", () => count++);
files.set("Folder/Other.md", "external");
await bridge.refresh("Folder/Other.md");
assert.equal(count, 1);
app.vault.offref(ref);
files.set("Folder/Other.md", "again");
await bridge.refresh("Folder/Other.md");
assert.equal(count, 1);
await app.vault.process(
  app.vault.getFileByPath("Folder/Other.md"),
  (old) => old + " updated",
);
assert.equal(files.get("Folder/Other.md"), "again updated");
await assert.rejects(app.vault.create("Active.md", "overwrite"), /exists/);
assert.match(files.get("Active.md"), /^---/);
const other = app.vault.getFileByPath("Folder/Other.md");
const old = await app.vault.read(other);
files.set(other.path, "external concurrent edit");
await assert.rejects(app.vault.modify(other, old + " plugin edit"));
assert.equal(files.get(other.path), "external concurrent edit");
let resume;
readGate = new Promise((r) => (resume = r));
const delayed = app.vault.process(other, () => "disabled output");
const denied = assert.rejects(delayed, /disabled/);
entry.alive = false;
resume();
await denied;
readGate = null;
assert.equal(files.get(other.path), "external concurrent edit");
entry.alive = true;
entry.epoch++;
assert.throws(() => app.vault.getFiles(), /disabled/);
assert.throws(() => app.fileManager.generateMarkdownLink(file), /disabled/);
const fresh = bridge.forEntry(entry);
root = "/other";
await assert.rejects(fresh.vault.read(file), /Vault changed/);
root = "/fixture";
bridge.dispose();
assert.ok(unsubscribed);
await assert.rejects(fresh.vault.read(file), /stopped/);
console.log(
  "PASS native API: body coordinates, full file reads, folders, external events, guarded process/create, old generation rejection, vault switch and cleanup",
);
