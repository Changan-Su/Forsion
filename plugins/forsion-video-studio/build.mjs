// Build the committed outputs from src/:
//   runtime/fvs-runtime.js  the page runtime (global FVS), inlined into every page the Studio writes
//   tools/fvs.mjs           the CLI, one self-contained file (node ≥ 18)
//   main.js                 the plugin's UI half: a bare setup(ctx) body, as the host expects
// node build.mjs [--watch]
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const at = p => join(here, p);
const manifest = JSON.parse(readFileSync(at('manifest.json'), 'utf8'));
const banner = `/* Forsion Video Studio ${manifest.version} — built from src/ by build.mjs; edit the sources, not this file. */`;
const strMod = s => `export default ${JSON.stringify(s)};\n`;

mkdirSync(at('src/generated'), { recursive: true });
mkdirSync(at('runtime'), { recursive: true });

// 1. runtime
const rt = await build({ entryPoints: [at('src/runtime/index.js')], bundle: true, format: 'iife', globalName: 'FVS', minify: true, write: false, target: 'es2020', legalComments: 'none' });
const runtime = `${banner}\n${rt.outputFiles[0].text}`;
writeFileSync(at('runtime/fvs-runtime.js'), runtime);
writeFileSync(at('src/generated/runtime-src.js'), strMod(runtime));

// 2. CLI
const cli = await build({ entryPoints: [at('src/cli/fvs.js')], bundle: true, platform: 'node', format: 'esm', target: 'node18', write: false, legalComments: 'none',
  banner: { js: `#!/usr/bin/env node\n${banner}` }, external: ['playwright-core', 'playwright'], define: { 'import.meta.url': 'import.meta.url' } });
const cliSrc = cli.outputFiles[0].text;
writeFileSync(at('tools/fvs.mjs'), cliSrc);
writeFileSync(at('src/generated/cli-src.js'), strMod(cliSrc));

// 3. music toolkit, embedded so the Studio can hand it to the agent inside the vault
const music = {};
for (const f of readdirSync(at('tools/music')).filter(f => /\.(py|md|txt)$/.test(f)).sort()) music[f] = readFileSync(at(`tools/music/${f}`), 'utf8');
writeFileSync(at('src/generated/music-src.js'), `export default ${JSON.stringify(music)};\n`);

// 4. the bundled example: the project text and its images (the 2 MB score is fetched on first open)
const ex = at('examples/episode-2.12');
const exAssets = {};
for (const f of readdirSync(join(ex, 'assets')).sort()) exAssets[`assets/${f}`] = readFileSync(join(ex, 'assets', f)).toString('base64');
writeFileSync(at('src/generated/example-src.js'), `export default ${JSON.stringify({
  text: readFileSync(join(ex, 'episode-2.12.fvs.md'), 'utf8'), assets: exAssets, audio: 'audio/episode-2.12-score.mp3',
  audioUrl: 'https://raw.githubusercontent.com/Changan-Su/Forsion/main/plugins/forsion-video-studio/examples/episode-2.12/audio/episode-2.12-score.mp3',
})};\n`);

// 5. plugin UI: an IIFE whose free variable `ctx` is the host's setup parameter
const ui = await build({ entryPoints: [at('src/ui/plugin.js')], bundle: true, format: 'iife', write: false, target: 'es2020', legalComments: 'none',
  supported: { 'template-literal': false }, // keep embedded sources as one-line strings: main.js stays a plain setup body
  define: { __FVS_VERSION__: JSON.stringify(manifest.version) } });
writeFileSync(at('main.js'), `${banner}\n${ui.outputFiles[0].text}`);

const kb = p => `${(readFileSync(at(p)).length / 1024).toFixed(0)} KB`;
console.log(`runtime/fvs-runtime.js ${kb('runtime/fvs-runtime.js')} · tools/fvs.mjs ${kb('tools/fvs.mjs')} · main.js ${kb('main.js')}`);
