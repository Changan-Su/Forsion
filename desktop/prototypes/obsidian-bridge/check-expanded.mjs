import { Window } from "happy-dom";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
const root = new URL("./plugin/", import.meta.url);
const win = new Window({ settings: { enableJavaScriptEvaluation: true } });
win.structuredClone = structuredClone;
win.console.error = (...a) =>
  console.log("RUNTIME ERROR", ...a.map((x) => x?.stack || x));
win.console.warn = (...a) => console.log("WARN", ...a.map(String));
let text = "# Test\n\nhello   world   \n\n\n\nend",
  anchor = 0,
  head = 0,
  path = "Test.md";
const files = new Map([[path, text]]);
let events,
  store,
  failWrites = false;
const failures = [];
const unhandled = (e) => {
  failures.push(e);
};
process.on("unhandledRejection", unhandled);
try {
  win.eval(await readFile(new URL("runtime.js", root), "utf8"));
  const r = await win.ForsionObsidianBridge.start({
    locale: "en",
    vaultRoot: () => "/fixture",
    loadData: async () => store || null,
    saveData: async (v) => {
      store = structuredClone(v);
    },
    packageFiles: {
      readText: (p) => readFile(new URL(p, root), "utf8"),
      list: (p) => readdir(new URL(p + "/", root)),
    },
    captureEditor: () => {
      const before = text,
        pa = path,
        a = anchor,
        h = head;
      return {
        path,
        text,
        anchor,
        head,
        apply: (c) => {
          if (text !== before || path !== pa || anchor !== a || head !== h)
            return false;
          text = c.text;
          if (c.selection) {
            anchor = c.selection.anchor;
            head = c.selection.head;
          }
          files.set(path, text);
          return true;
        },
      };
    },
    listPages: async () => [...files.keys()],
    readFile: async (p) => files.get(p) ?? null,
    writeFileChecked: async (p, v, expected) => {
      if (failWrites) throw Error("Fixture write conflict");
      assert.equal(files.get(p) ?? null, expected);
      files.set(p, v);
    },
    patchNoteProperties: async () => {},
    openNote: () => {},
    subscribePage: (cb) => {
      events = cb;
      return () => {
        events = null;
      };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log(JSON.stringify(r.diagnostics(), null, 2));
  assert.equal(r.diagnostics().plugins.filter((p) => p.alive).length, 6);
  text = "Zebra\nApple\nBanana\nApple\n";
  files.set(path, "---\nkeep: unchanged\n---\n" + text);
  await r.app.vault.read(r.app.vault.getFileByPath(path));
  await r.run("obsidian-sort-and-permute-lines", "sort-alphabetically");
  assert.equal(text.trim(), "Apple\nApple\nBanana\nZebra");
  console.log("PASS property metadata uses native body coordinates");
  text = "# Test\n\nhello   world   \n\n\n\nend";
  anchor = 0;
  head = 0;
  files.set(path, text);

  console.log(
    "LINTER",
    Object.keys(r.app.plugins.plugins["obsidian-linter"].settings),
  );
  const linter = r.app.plugins.plugins["obsidian-linter"];
  linter.settings.ruleConfigs["consecutive-blank-lines"] = { enabled: true };
  events?.({ text });
  await r.run("obsidian-linter", "lint-file");
  console.log("LINTED", JSON.stringify(text));
  assert.ok(!text.includes("\n\n\n"));
  text = "| A | B |\n|---|---|\n| 1 | 2 |\n";
  anchor = 3;
  head = 3;
  files.set(path, text);
  await r.run("table-editor-obsidian", "insert-column");
  console.log("TABLE", JSON.stringify(text));
  assert.equal(text.split("\n")[0].split("|").length, 5);
  text = "# Keep\n\nExtracted note\nBody of extracted note\n\nTail";
  anchor = text.indexOf("Extracted");
  head = text.indexOf("\n\nTail");
  files.set(path, text);
  await r.run("note-refactor-obsidian", "app:extract-selection-first-line");
  console.log("REFACTORED", JSON.stringify(text), JSON.stringify([...files]));
  assert.match(text, /\[\[Extracted note\]\]/);
  assert.ok(files.get("Extracted note.md")?.includes("Body of extracted note"));
  text = "Conflict extraction\nDo not lose this text";
  anchor = 0;
  head = text.length;
  files.set(path, text);
  const before = text;
  failWrites = true;
  await assert.rejects(
    r.run("note-refactor-obsidian", "app:extract-selection-first-line"),
    /Fixture write conflict/,
  );
  assert.equal(text, before);
  assert.ok(!files.has("Conflict extraction.md"));
  console.log("PASS failed extraction preserves native selection");
  r.dispose();
  console.log("PASS expanded real packages");
} catch (e) {
  console.log(e.stack);
  process.exitCode = 1;
} finally {
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(failures.every((e) => e.message === "Fixture write conflict"));
  process.off("unhandledRejection", unhandled);
  await win.happyDOM.close();
}
