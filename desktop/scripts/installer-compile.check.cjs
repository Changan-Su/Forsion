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

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'forsion-installer-check-'));
  const templates = resolve(require.resolve('app-builder-lib/package.json'), '..', 'templates/nsis');
  const [compiler, plugins] = await Promise.all([getMakeNsisPath(), getNsisPluginsPath()]);
  const payload = join(dir, 'payload');
  mkdirSync(payload);
  writeFileSync(join(payload, 'Forsion.exe'), 'compile fixture only');
  const uninstaller = join(dir, 'uninstaller.exe');
  writeFileSync(uninstaller, 'compile fixture only');
  for (const mode of ['installer', 'uninstaller']) {
    const generator = new NsisScriptGenerator();
    generator.addIncludeDir(templates);
    generator.addIncludeDir(join(templates, 'include'));
    generator.addPluginDir('x86-unicode', join(plugins, 'x86-unicode'));
    generator.include(join(templates, 'include/StdUtils.nsh'));
    generator.flags(['updated', 'force-run', 'keep-shortcuts', 'no-desktop-shortcut', 'delete-app-data', 'allusers', 'currentuser']);
    const langs = new LangConfigurator({ installerLanguages: ['en_US', 'zh_CN'] });
    createAddLangsMacro(generator, langs);
    let index = 0;
    const packager = { getTempFile: async () => join(dir, `${mode}-messages-${index++}.nsh`) };
    await addCustomMessageFileInclude('messages.yml', packager, generator, langs);
    await addCustomMessageFileInclude('assistedMessages.yml', packager, generator, langs);
    generator.include(resolve(__dirname, '../build/installer.nsh'));
    const defines = {
      APP_ID: 'com.forsion.installer-compile-fixture', APP_GUID: 'forsion-compile-fixture',
      UNINSTALL_APP_KEY: 'forsion-compile-fixture', PRODUCT_NAME: 'Forsion', PRODUCT_FILENAME: 'Forsion',
      APP_FILENAME: 'Forsion', APP_DESCRIPTION: 'Compile fixture', VERSION: '1.0.0',
      APP_BUILD_DIR: payload, UNINSTALLER_OUT_FILE: uninstaller, SHORTCUT_NAME: 'Forsion',
      UNINSTALL_DISPLAY_NAME: 'Forsion', MULTIUSER_INSTALLMODE_ALLOW_ELEVATION: '',
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
      cwd: templates, env: { ...process.env, ...compiler.env }, encoding: 'utf8',
    });
    // 未定义宏/语言文本常表现为 warning;拒绝静默放过这一类编译成功。
    if (/warning (6000|7010|7025)/i.test(output)) throw new Error(output);
    console.log(`${mode}: NSIS compilation passed`);
  }
  console.log(`Compile-only fixtures: ${dir}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
