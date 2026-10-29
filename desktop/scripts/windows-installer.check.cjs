/** Native extraction benchmark, without app registration or touching an install.
 * node scripts/windows-installer.check.cjs [read-only payload directory]
 * Uses the production extractor, checks every byte, and exercises copy fallbacks.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createWindowsInstallerIncludes } = require('../build/windows-installer.cjs');
const { getMakeNsisPath, getNsisPluginsPath } = require('app-builder-lib/out/toolsets/windows.js');

function manifest(root, prefix = '') {
  const entries = [];
  for (const item of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, item.name);
    if (item.isSymbolicLink()) throw new Error(`Fixture must not contain links: ${rel}`);
    if (item.isDirectory()) entries.push(...manifest(root, rel));
    else entries.push([rel, createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')]);
  }
  return entries.sort((a,b) => a[0].localeCompare(b[0]));
}
async function main() {
  assert.equal(process.platform, 'win32', 'Run on Windows');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-install-bench-'));
  const programs = path.join(process.env.LOCALAPPDATA, 'Programs');
  fs.mkdirSync(programs, { recursive: true });
  const target = fs.mkdtempSync(path.join(programs, 'forsion-install-bench-'));
  // All recursive cleanup targets are checked against these exclusively owned roots.
  const clean = file => {
    assert.ok([dir, target].some(root => file === root || file.startsWith(root + path.sep)));
    fs.rmSync(file, { recursive: true, force: true });
  };
  const payloadArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  const payload = payloadArg ? path.resolve(payloadArg) : path.join(dir, 'payload');
  if (!payloadArg) {
    fs.mkdirSync(path.join(payload, 'nested'), { recursive: true });
    for (let i = 0; i < 2500; i++) fs.writeFileSync(path.join(payload, 'nested', `${i}.js`), `module.exports = ${i};\n`.repeat(50));
    fs.writeFileSync(path.join(payload, 'binary.dat'), Buffer.alloc(8 * 1024 * 1024, 123));
  }
  const expected = manifest(payload);
  const archive = path.join(dir, 'payload.7z');
  const sevenZip = await require('app-builder-lib/out/toolsets/7zip.js').getPath7za();
  execFileSync(sevenZip, ['a', '-t7z', '-mx=0', archive, '.'], { cwd: payload, windowsHide: true, stdio: 'pipe' });
  const [compiler, plugins] = await Promise.all([getMakeNsisPath(), getNsisPluginsPath()]);
  const generated = createWindowsInstallerIncludes();
  const stock = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/include/extractAppPackage.nsh');
  const results = [];
  try {
    const scenarios = process.argv.includes('--build-only') ? []
      : process.argv.includes('--benchmark-only') ? ['stock', 'move']
      : ['stock', 'move', 'occupied', 'allusers', 'custom'];
    for (const scenario of scenarios) {
      clean(target); fs.mkdirSync(target);
      const destination = scenario === 'custom' ? path.join(dir, 'custom') : target;
      fs.mkdirSync(destination, { recursive: true });
      if (scenario === 'occupied') fs.writeFileSync(path.join(destination, 'keep.txt'), 'existing unrelated content');
      const result = path.join(dir, `${scenario}.ini`);
      const executable = path.join(dir, `${scenario}.exe`);
      const source = path.join(dir, `${scenario}.nsi`);
      fs.writeFileSync(source, [
        'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
        `OutFile "${executable}"`, '!include LogicLib.nsh', '!include FileFunc.nsh',
        `!addplugindir /x86-unicode "${path.join(plugins, 'x86-unicode')}"`,
        '!define PRODUCT_NAME "Forsion isolated fixture"',
        'LangString appCannotBeClosed 1033 "Fixture copy failed"', 'LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\English.nlf"',
        'Var installMode',
        `!include "${scenario === 'stock' ? stock : path.join(generated, 'extractAppPackage.nsh')}"`,
        'Section', 'InitPluginsDir', `StrCpy $installMode "${scenario === 'allusers' ? 'all' : 'CurrentUser'}"`,
        `SetOutPath "${destination}"`, `!insertmacro extractUsing7za "${archive}"`,
        'StrCpy $0 "move"', 'IfFileExists "$PLUGINSDIR\\7z-out\\*.*" 0 +2', 'StrCpy $0 "copy"',
        `WriteINIStr "${result}" "result" "path" "$0"`, 'SectionEnd',
      ].join('\n'));
      execFileSync(compiler.path, ['-NOCD', '-V2', source], { env: { ...process.env, ...compiler.env }, windowsHide: true, stdio: 'pipe' });
      const start = performance.now();
      execFileSync(executable, ['/S'], { windowsHide: true, timeout: 600000, stdio: 'pipe' });
      const seconds = (performance.now() - start) / 1000;
      const mode = scenario === 'move' ? 'move' : 'copy';
      assert.match(fs.readFileSync(result, 'utf8'), new RegExp(`path=${mode}`));
      if (scenario === 'occupied') {
        assert.equal(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'existing unrelated content');
        fs.unlinkSync(path.join(destination, 'keep.txt'));
      }
      assert.deepEqual(manifest(destination), expected, `${scenario}: exact payload bytes`);
      results.push({ scenario, seconds: +seconds.toFixed(3), files: expected.length, path: mode });
      console.log(JSON.stringify(results.at(-1)));
      if (scenario === 'custom') clean(destination);
    }
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2));
    if (!payloadArg) {
      // Exercise the real builder pipeline, including generation of the actual
      // uninstaller. The hand-compiled extractor alone cannot prove this wiring.
      const project = path.join(dir, 'project');
      const fixtureId = path.basename(dir).toLowerCase();
      const productName = `Forsion fixture ${fixtureId}`;
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: fixtureId, version: '1.0.0', description: 'Isolated installer fixture', author: 'Forsion', main: 'index.js' }));
      fs.writeFileSync(path.join(payload, `${productName}.exe`), 'fixture; never launched');
      fs.mkdirSync(path.join(payload, 'resources'), { recursive: true });
      const { build, Platform, Arch } = require('electron-builder');
      const artifacts = await build({
        projectDir: project, prepackaged: payload,
        targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
        config: {
          electronVersion: require('electron/package.json').version,
          appId: `net.forsion.${fixtureId}`, productName,
          directories: { output: path.join(dir, 'dist'), buildResources: project },
          win: { signAndEditExecutable: false },
          nsis: { include: require('../build/file-associations.cjs').createNsisInclude('fixture', project), oneClick: false, runAfterFinish: true, installerLanguages: ['en_US', 'zh_CN'], createDesktopShortcut: false, createStartMenuShortcut: false },
        },
      });
      assert.ok(artifacts.some(file => file.endsWith('.exe')), 'Real builder installer emitted');
      const installer = artifacts.find(file => file.endsWith('.exe'));
      const uninstallName = `Uninstall ${productName}.exe`;
      const builtPayload = manifest(payload);
      for (const phase of ['fresh', 'upgrade']) {
        const previousDirectoryId = fs.statSync(target, { bigint: true }).ino;
        if (phase === 'upgrade') fs.writeFileSync(path.join(target, 'obsolete.txt'), 'old version only');
        execFileSync(installer, ['/S', `/D=${target}`], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
        assert.deepEqual(manifest(target).filter(([name]) => name !== uninstallName), builtPayload, phase);
        assert.ok(fs.existsSync(path.join(target, uninstallName)), 'Builder-generated uninstaller installed');
        if (phase === 'fresh') assert.notEqual(fs.statSync(target, { bigint: true }).ino, previousDirectoryId, 'Real builder must use directory promotion');
        console.log(`Real ${phase} installation: exact payload, obsolete files removed`);
      }
      execFileSync(path.join(target, uninstallName), ['/S', '--updated'], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
      for (let i = 0; i < 60 && fs.existsSync(target); i++) await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(fs.existsSync(target), false, 'Fixture uninstaller completed');
      console.log('Real electron-builder NSIS pipeline passed');
    }
    console.log(`Evidence: ${dir}`);
  } finally { clean(target); }
}
main().catch(error => { console.error(error); process.exit(1); });
