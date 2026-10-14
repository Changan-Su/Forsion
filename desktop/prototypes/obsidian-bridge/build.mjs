import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFile, writeFile, readdir } from "node:fs/promises";
const root = dirname(fileURLToPath(import.meta.url));
const result = await build({
  entryPoints: [join(root, "src/runtime.js")],
  outfile: join(root, "plugin/runtime.js"),
  bundle: true,
  format: "iife",
  globalName: "ForsionObsidianBridge",
  platform: "browser",
  target: "es2022",
  legalComments: "eof",
  minify: true,
  metafile: true,
  footer: { js: ";window.ForsionObsidianBridge = ForsionObsidianBridge;" },
  plugins: [
    {
      name: 'bridge-icon-nodes',
      setup(b) {
        b.onResolve({filter: /^bridge-icon-nodes$/}, () => ({path:'icons',namespace:'bridge-icons'}));
        b.onLoad({filter: /.*/,namespace:'bridge-icons'}, async () => {
          const dir = resolve(dirname(fileURLToPath(import.meta.resolve('lucide-react'))), '../esm/icons');
          const files = (await readdir(dir)).filter(f => f.endsWith('.mjs')).sort();
          const imports = [], entries = [];
          for (const file of files) {
            // Alias-only modules have no own icon geometry.
            if (!(await readFile(join(dir,file),'utf8')).includes('const __iconNode =')) continue;
            const name = `icon${imports.length}`;
            imports.push(`import {__iconNode as ${name}} from ${JSON.stringify(join(dir,file))};`);
            entries.push(`${JSON.stringify(file.slice(0,-4))}:${name}`);
          }
          return {contents: imports.join('\n') + `\nexport default {${entries.join(',')}}`,loader:'js',resolveDir:dir};
        });
      },
    },
    {
      name: "inline-css",
      setup(b) {
        b.onResolve({ filter: /\.css\?inline$/ }, (a) => ({
          path: join(a.resolveDir, a.path.replace("?inline", "")),
          namespace: "inline-css",
        }));
        b.onLoad({ filter: /.*/, namespace: "inline-css" }, async (a) => ({
          contents: await (
            await import("node:fs/promises")
          ).readFile(a.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
});
// Runtime dependencies are bundled; retain their upstream license notices alongside the bundle.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs).filter(p => p.includes('node_modules/'))) {
  let dir = dirname(resolve(input));
  while (dirname(dir) !== dir) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) { packages.set(pkg.name, { dir, pkg }); break; }
    } catch {}
    dir = dirname(dir);
  }
}
const notices = [];
for (const { dir, pkg } of [...packages.values()].sort((a,b) => a.pkg.name.localeCompare(b.pkg.name))) {
  let license;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'license.txt']) {
    try { license = await readFile(join(dir, filename), 'utf8'); break; } catch {}
  }
  if (!license && pkg.name === 'format' && pkg.version === '0.2.2') {
    // This old package ships its copyright/MIT grant reference in Readme.md only.
    const readme = await readFile(join(dir, 'Readme.md'), 'utf8');
    const mit = await readFile(join(packages.get('@codemirror/state').dir, 'LICENSE'), 'utf8');
    license = readme.slice(readme.lastIndexOf('License\n')).replace(/^=+$/m, '') + '\n' + mit.slice(mit.indexOf('Permission is hereby granted'));
  }
  if (!license) throw new Error(`Missing bundled dependency license: ${pkg.name}`);
  notices.push(`${pkg.name} ${pkg.version} (${pkg.license || 'see below'})\n${license}`);
}
await writeFile(join(root, 'plugin/THIRD-PARTY-NOTICES.txt'), notices.join('\n\n--------------------\n\n'));
console.log("Built Obsidian Bridge runtime");
