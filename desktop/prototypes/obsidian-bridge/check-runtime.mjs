// Fast contract check with a DOM substitute. Real UI/disk acceptance remains the Electron harness.
import { Window } from "happy-dom";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
const root = dirname(fileURLToPath(import.meta.url)),
  pkg = join(root, "plugin");
const window = new Window({ settings: { enableJavaScriptEvaluation: true } });
window.structuredClone = structuredClone;
let data = null;
try {
  window.eval(await readFile(join(pkg, "runtime.js"), "utf8"));
  const runtime = await window.ForsionObsidianBridge.start({
    locale: "en",
    vaultRoot: () => "fixture",
    listPages: async () => [],
    packageFiles: {
      readText: (p) => readFile(join(pkg, p), "utf8"),
      list: (p) => readdir(join(pkg, p)).then(rows=>p==="plugins"?rows.filter(x=>!["obsidian-linter","note-refactor-obsidian","table-editor-obsidian"].includes(x)):rows),
    },
    loadData: async () => data,
    saveData: async (v) => {
      data = v;
    },
    readFile: async () => null,
    writeFile: async () => {
      throw new Error("No writes in contract check");
    },
    openFile() {},
  });
  console.log(JSON.stringify(runtime.diagnostics(), null, 2));
  assert.equal(runtime.diagnostics().plugins.filter((p) => p.alive).length, 3);
  runtime.editor.setValue("Zebra\nApple\nBanana\nApple");
  await runtime.run("obsidian-sort-and-permute-lines", "sort-alphabetically");
  assert.equal(runtime.editor.getValue(), "Apple\nApple\nBanana\nZebra");
  await runtime.run("obsidian-sort-and-permute-lines", "permute-unique");
  assert.equal(runtime.editor.getValue(), "Apple\nBanana\nZebra");
  runtime.editor.undo();
  assert.equal(runtime.editor.getValue(), 'Apple\nApple\nBanana\nZebra');
  runtime.editor.setValue(
    "# Research\n\n\n## Introduction\n\n## Method\n\n### Prepare\n\n## Conclusion\n",
  );
  runtime.editor.setCursor({ line: 2, ch: 0 });
  await runtime.run("obsidian-plugin-toc", "create-toc");
  console.log("TOC", runtime.editor.getValue());
  assert.match(runtime.editor.getValue(), /\[\[#Introduction(?:\|[^\]]*)?\]\]/);
  runtime.editor.setValue(
    "# Research\n\n## Introduction\n\n## Method\n\n### Prepare\n",
  );
  await runtime.run("number-headings-obsidian", "number-headings");
  console.log("NUMBERED", runtime.editor.getValue());
  assert.match(runtime.editor.getValue(), /## 1[. ]/);
  assert.match(runtime.editor.getValue(), /### 1\.2\.1/);
  for (const id of ["obsidian-plugin-toc", "number-headings-obsidian"]) {
    window.document
      .querySelector(`[data-plugin="${id}"] [data-action="settings"]`)
      .click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(window.document.querySelector(".setting-item"), id);
  }
  assert.ok(window.document.querySelector(".setting-item"));
  runtime.dispose();
  assert.ok(
    runtime.diagnostics().plugins.every((p) => !p.alive && p.timers === 0),
  );
  console.log(
    "PASS original packages: load, sort, unique, TOC, numbering, settings, timer cleanup",
  );
} finally {
  await window.happyDOM.close();
}
