/** 编译当前 electron-builder 的真实 NSIS 模板 + 本项目钩子(无需 Windows/Wine)。
 * 小夹具代替 payload;只验证编译兼容性,不声称覆盖 Windows 安装运行时。
 * node scripts/installer-compile.check.cjs
 */
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { NsisScriptGenerator } = require('app-builder-lib/out/targets/nsis/nsisScriptGenerator.js');
const { LangConfigurator, createAddLangsMacro, addCustomMessageFileInclude } = require('app-builder-lib/out/targets/nsis/nsisLang.js');
const { getMakeNsisPath, getNsisPluginsPath } = require('app-builder-lib/out/toolsets/windows.js');
const { createNsisInclude, fileAssociationsFor } = require('../build/file-associations.cjs');

async function main() {
  const runtime = process.argv.includes('--runtime-fixture');
  if (runtime && (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP)) {
    throw new Error('Running installers requires a disposable Windows Actions runner');
  }
  const dir = mkdtempSync(join(runtime ? process.env.RUNNER_TEMP : tmpdir(), 'forsion-installer-check-'));
  if (runtime && !resolve(dir).toLowerCase().startsWith(resolve(process.env.RUNNER_TEMP).toLowerCase() + require('node:path').sep)) throw new Error('Fixture escaped RUNNER_TEMP');
  const templates = resolve(require.resolve('app-builder-lib/package.json'), '..', 'templates/nsis');
  const [compiler, plugins] = await Promise.all([getMakeNsisPath(), getNsisPluginsPath()]);
  const payload = join(dir, 'payload');
  mkdirSync(payload);
  const name = runtime ? 'ForsionRegistryProbe' : 'Forsion';
  writeFileSync(join(payload, name + '.exe'), 'inert fixture; never launched');
  if (runtime) {
    const exe = join(payload, name + '.exe');
    require('node:fs').unlinkSync(exe);
    // A real, UI-free argument recorder makes ShellExecute exercise Windows'
    // command parsing in an installation directory containing spaces.
    const source = 'using System; using System.IO; public class Probe { public static void Main(string[] args) { File.WriteAllText(Environment.GetEnvironmentVariable("FORSION_NSIS_ARGS"), args.Length == 1 ? args[0] : "BAD_ARG_COUNT"); } }';
    const ps = `Add-Type -TypeDefinition '${source}' -OutputAssembly '${exe.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, timeout: 60000 });
  }
  const uninstaller = join(dir, 'uninstaller.exe');
  writeFileSync(uninstaller, 'compile fixture only');
  for (const mode of ['uninstaller', 'installer']) {
    const generator = new NsisScriptGenerator();
    generator.addIncludeDir(templates);
    generator.addIncludeDir(join(templates, 'include'));
    generator.addPluginDir('x86-unicode', join(plugins, 'x86-unicode'));
    generator.include(join(templates, 'include/StdUtils.nsh'));
    generator.include(join(templates, 'include/FileAssociation.nsh'));
    generator.flags(['updated', 'force-run', 'keep-shortcuts', 'no-desktop-shortcut', 'delete-app-data', 'allusers', 'currentuser']);
    const langs = new LangConfigurator({ installerLanguages: ['en_US', 'zh_CN'] });
    createAddLangsMacro(generator, langs);
    let index = 0;
    const packager = { getTempFile: async () => join(dir, `${mode}-messages-${index++}.nsh`) };
    await addCustomMessageFileInclude('messages.yml', packager, generator, langs);
    await addCustomMessageFileInclude('assistedMessages.yml', packager, generator, langs);
    // Match builder's generated macros so customHeader must really replace the
    // registration body. Merely including the hooks can miss broken expansion.
    generator.macro('registerFileAssociations', ['DetailPrint "stock registration must be replaced"']);
    generator.macro('unregisterFileAssociations', fileAssociationsFor('forsion').flatMap(item =>
      (Array.isArray(item.ext) ? item.ext : [item.ext]).map(ext => `!insertmacro APP_UNASSOCIATE "${ext}" "${item.name}"`)));
    generator.include(createNsisInclude('forsion', dir));
    const defines = {
      APP_ID: 'com.forsion.installer-compile-fixture', APP_GUID: 'forsion-compile-fixture',
      UNINSTALL_APP_KEY: 'forsion-compile-fixture', PRODUCT_NAME: name, PRODUCT_FILENAME: name,
      APP_FILENAME: name, APP_DESCRIPTION: 'Compile fixture', VERSION: '1.0.0',
      APP_BUILD_DIR: payload, UNINSTALLER_OUT_FILE: uninstaller, SHORTCUT_NAME: name,
      UNINSTALL_DISPLAY_NAME: name, MULTIUSER_INSTALLMODE_ALLOW_ELEVATION: '',
      // Assisted installers define this to support both scopes; it does not
      // force /allusers (INSTALL_MODE_PER_ALL_USERS is the forcing define).
      INSTALL_MODE_PER_ALL_USERS_REQUIRED: '',
      ...(mode === 'uninstaller' ? { BUILD_UNINSTALLER: '' } : {}),
    };
    const file = join(dir, `${mode}.nsi`);
    writeFileSync(file, [
      'Unicode true', `OutFile "${join(dir, `${mode}-fixture.exe`)}"`,
      ...Object.entries(defines).map(([key, value]) => `!define ${key} "${value}"`),
      generator.build(), readFileSync(join(templates, 'installer.nsi'), 'utf8'),
    ].join('\n'));
    const output = execFileSync(compiler.path, ['-NOCD', '-V3', file], {
      cwd: templates, env: { ...process.env, ...compiler.env }, encoding: 'utf8', windowsHide: true,
    });
    // 未定义宏/语言文本常表现为 warning;拒绝静默放过这一类编译成功。
    if (/warning (6000|7010|7025)/i.test(output)) throw new Error(output);
    console.log(`${mode}: NSIS compilation passed`);
    if (runtime && mode === 'uninstaller') {
      execFileSync(join(dir, 'uninstaller-fixture.exe'), ['/S'], { windowsHide: true, timeout: 60000 });
      if (readFileSync(uninstaller).subarray(0, 2).toString() !== 'MZ') throw new Error('Real NSIS uninstaller was not generated');
    }
  }
  console.log(`Compiled fixtures: ${dir}`);
  if (runtime) require('node:fs').appendFileSync(process.env.GITHUB_ENV, `FORSION_NSIS_FIXTURE=${dir}\n`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
