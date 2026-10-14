// Downloads original pinned release assets; no source rewriting or rebuild of third-party plugins.
import { mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.argv[2] || join(root, "plugin"));
const pinned = [
  { repo: 'phibr0/obsidian-charts', version: '3.9.0', id: 'obsidian-charts', css: true },
  { repo: 'platers/obsidian-linter', version: '1.34.1', id: 'obsidian-linter', css: true },
  { repo: 'tgrosinger/advanced-tables-obsidian', version: '0.23.2', id: 'table-editor-obsidian', css: true },
  { repo: 'lynchjames/note-refactor-obsidian', version: '1.8.2', id: 'note-refactor-obsidian', css: true },
  {
    repo: "Vinzent03/obsidian-sort-and-permute-lines",
    version: "0.9.0",
    id: "obsidian-sort-and-permute-lines",
  },
  {
    repo: "hipstersmoothie/obsidian-plugin-toc",
    version: "0.2.0",
    id: "obsidian-plugin-toc",
  },
  {
    repo: "onlyafly/number-headings-obsidian",
    version: "1.16.0",
    id: "number-headings-obsidian",
    css: true,
  },
];
const receipts = [];
for (const p of pinned) {
  const dir = join(target, "plugins", p.id);
  const staged = join(target, "plugins", "." + p.id + "-" + randomUUID());
  await mkdir(staged, { recursive: true });
  try {
    const files = [];
    for (const name of [
      "manifest.json",
      "main.js",
      ...(p.css ? ["styles.css"] : []),
    ]) {
      const url = `https://github.com/${p.repo}/releases/download/${p.version}/${name}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status}: ${url}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 8 * 1024 * 1024)
        throw new Error("Asset exceeds 8 MiB");
      await writeFile(join(staged, name), bytes);
      files.push({
        name,
        url,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const manifest = JSON.parse(
      await readFile(join(staged, "manifest.json"), "utf8"),
    );
    if (manifest.id !== p.id || manifest.version !== p.version)
      throw new Error("Release identity mismatch");
    const receipt = {
      ...p,
      release: `https://github.com/${p.repo}/releases/tag/${p.version}`,
      files,
    };
    await writeFile(
      join(staged, "source.json"),
      JSON.stringify(receipt, null, 2),
    );
    // Reinstalling a pinned package only after verifying every existing asset matches; preserve other content.
    let existing;
    try {
      existing = JSON.parse(await readFile(join(dir, "source.json"), "utf8"));
    } catch {}
    if (existing) {
      for (const f of files)
        if (
          createHash("sha256")
            .update(await readFile(join(dir, f.name)))
            .digest("hex") !== f.sha256
        )
          throw new Error(`Existing ${p.id}/${f.name} differs; preserved`);
      await rm(staged, { recursive: true });
    } else await rename(staged, dir);
    receipts.push(receipt);
    console.log(`Installed ${p.id} ${p.version} → ${dir}`);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}
await writeFile(
  join(target, "plugins", "sources.json"),
  JSON.stringify(receipts, null, 2),
);
