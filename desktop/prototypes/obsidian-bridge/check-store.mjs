import { Window } from "happy-dom";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const win = new Window({ settings: { enableJavaScriptEvaluation: true } });
win.structuredClone = structuredClone;
win.console.error = () => {};
let data,
  installed = false,
  installCalls = 0,
  saveFails = true,
  downloadFails = true;
const tick = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 1));
};
try {
  win.eval(
    await readFile(new URL("./plugin/runtime.js", import.meta.url), "utf8"),
  );
  const r = await win.ForsionObsidianBridge.start({
    locale: "en",
    vaultRoot: () => "/fixture",
    captureEditor: () => null,
    listPages: async () => [],
    loadData: async () => null,
    saveData: async (s) => {
      if (saveFails) throw Error("Cannot save disabled state");
      data = structuredClone(s);
    },
    packageFiles: {
      list: async () => (installed ? ["sample"] : []),
      readText: async (p) =>
        p.endsWith("manifest.json")
          ? JSON.stringify({ id: "sample", name: "Sample", version: "1.0.0" })
          : 'throw Error("must not run on install")',
      communityPlugins: async () => [
        {
          id: "sample",
          repo: "author/sample",
          name: "Sample",
          author: "Author",
          description: "Fixture searchable",
        },
      ],
      installCommunityPlugin: async () => {
        installCalls++;
        if (downloadFails) throw Error("Download interrupted");
        installed = true;
      },
    },
  });
  win.document.querySelector("[data-action=community-store]").click();
  await tick();
  const button = () =>
    win.document.querySelector("[data-community-id=sample] button");
  button().click();
  await tick();
  assert.equal(installCalls, 0);
  assert.match(
    win.document.querySelector(".community-store [role=status]").textContent,
    /Cannot save/,
  );
  saveFails = false;
  button().click();
  await tick();
  assert.equal(installCalls, 1);
  assert.deepEqual(data.vaults["/fixture"].disabled, ["sample"]);
  assert.match(
    win.document.querySelector(".community-store [role=status]").textContent,
    /Download interrupted/,
  );
  downloadFails = false;
  button().click();
  await tick();
  assert.equal(installCalls, 2);
  assert.equal(r.diagnostics().plugins[0].alive, false);
  assert.equal(button().textContent, "Installed");
  r.dispose();
  console.log(
    "PASS store: persist disabled before download, readable failure, retry, installed original stays disabled",
  );
} finally {
  await win.happyDOM.close();
}
