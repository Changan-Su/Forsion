/**
 * electron-builder afterPack 钩子,做两件事:
 *  ① 为打包后 bundled 的 tangu-server 把 better-sqlite3 重建为 **Electron ABI** 的原生二进制。
 *     背景:better-sqlite3 是原生模块,.node 按运行时 ABI 编译;extraResources 只是把父包
 *     `../node_modules`(系统 Node ABI 预编译)原样复制进 app,electron-builder 不会自动 rebuild
 *     extraResources → 加载时 NODE_MODULE_VERSION 不匹配会抛错。故此处就地重建为目标 Electron ABI。
 *     跳过:env TANGU_SKIP_NATIVE_REBUILD=1(仅打包非 SQLite 形态时)。
 *  ② macOS:对 .app 做 **ad-hoc 自签**(codesign --sign -)。本项目无 Apple Developer ID。
 *     完全未签名的 app 在 Apple Silicon 上会被 Gatekeeper 判为「已损坏」(连「仍要打开」都不给,
 *     只能 xattr 去隔离);带一个 ad-hoc 签名后会降级为「未识别开发者」——用户即可在
 *     系统设置 → 隐私与安全性 里点「仍要打开」。彻底无提示仍需 Developer ID + 公证(notarize)。
 *     配合 package.json 的 build.mac.identity=null(electron-builder 跳过自身签名,签名全交本钩子)。
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName, arch } = context;

  const productId = process.env.FORSION_PRODUCT || 'forsion';
  const product = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'products', `${productId}.json`), 'utf8'));

  /** 打包后的 resources 目录(mac 在 .app/Contents/Resources,其余在 resources/)。 */
  const resourcesDir = () =>
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');

  // ① better-sqlite3 → Electron ABI 重建(仅捆 agent 后端的变体需要 —— 它随 tangu-server/node_modules 进包)
  if (!product.agentBackend) {
    console.log('[afterPack] 产品档案无 agent 后端 → 跳过 better-sqlite3 重建');
  } else if (process.env.TANGU_SKIP_NATIVE_REBUILD) {
    console.log('[afterPack] TANGU_SKIP_NATIVE_REBUILD set → 跳过 better-sqlite3 重建');
  } else {
    const { rebuild } = require('@electron/rebuild');
    const { Arch } = require('electron-builder');
    const buildPath = path.join(resourcesDir(), 'tangu-server'); // extraResources 落点(含 node_modules)
    // electron-builder 24 的 AfterPackContext:Electron 版本逐级兜底取。
    const electronVersion =
      packager.info?.framework?.version ||
      packager.framework?.version ||
      context.electronVersion;
    if (!electronVersion) throw new Error('[afterPack] 无法解析 Electron 版本(packager.info.framework.version 为空)');
    const archName = Arch[arch]; // 数字枚举 → 'x64' | 'arm64' | 'armv7l'
    console.log(`[afterPack] electron-rebuild better-sqlite3 → Electron ${electronVersion} (${archName}) @ ${buildPath}`);
    await rebuild({ buildPath, electronVersion, arch: archName, onlyModules: ['better-sqlite3'], force: true });
    console.log('[afterPack] better-sqlite3 已为 Electron ABI 重建');
  }

  // ③ 内置 Node 完整性闸:**npm 本体必须在包里**。没有它,`npx` 只是个会 MODULE_NOT_FOUND 的 shim,
  //    所有走 `npx` 拉起的外部引擎(codex / claude-code / pi)在没装系统 Node 的机器上必挂,
  //    而且症状是「空等 30 秒」,极难归因(2026-09-19 Windows 线上实报)。曾经真丢过:electron-builder
  //    的拷贝过滤器无条件丢掉 extraResources `from` 根下那层 `node_modules`,而 Windows 版 Node 的 npm
  //    正好住在那儿 —— 这个闸盯的是**结果**,不管将来是过滤器、长路径还是别的原因导致的丢失。
  if (product.agentBackend) {
    const nodeRoot = path.join(resourcesDir(), 'node');
    const { existsSync } = require('fs');
    if (existsSync(path.join(nodeRoot, '.skipped'))) {
      console.log('[afterPack] 内置 Node 已降级(.skipped)→ 跳过 npm 完整性检查');
    } else {
      const npx = electronPlatformName === 'darwin' || electronPlatformName === 'linux'
        ? path.join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')
        : path.join(nodeRoot, 'node_modules', 'npm', 'bin', 'npx-cli.js');
      if (!existsSync(npx)) throw new Error(`[afterPack] 内置 Node 缺 npm:${npx} 不存在(npx 会失效,外部引擎必挂)`);
      console.log('[afterPack] 内置 Node 带着 npm ✓');
    }
  }

  // ④ 内置 Python 预装库闸:同 ③ 盯**打包后的结果** —— 拷贝过滤器已知会静默丢 .pyc/__pycache__/.a/.o,
  //    哪天多丢一类原生扩展,只有对产物真 import 才抓得到。放在 ② 签名之前:smoke 不写字节码(pyEnv)。
  if (product.agentBackend) {
    const { existsSync } = require('fs');
    const pyRoot = path.join(resourcesDir(), 'python');
    if (existsSync(path.join(pyRoot, '.skipped'))) {
      console.log('[afterPack] 内置 Python 已降级(.skipped)→ 跳过预装库检查');
    } else {
      require('./fetch-python.cjs').smokePython(pyRoot);
      console.log('[afterPack] 内置 Python 预装库可 import ✓');
    }
  }

  // ⑥ 内置 git 闸:同 ④ 对**打包产物**真跑 init/commit/https 助手 —— mac 的包装脚本丢了可执行位、
  //    git-core 里的软链被拷贝展开或丢掉,都只在这里现形。Linux 本就不捆(.skipped)。
  if (product.agentBackend) {
    const { existsSync } = require('fs');
    const gitRoot = path.join(resourcesDir(), 'git');
    if (existsSync(path.join(gitRoot, '.skipped'))) {
      console.log('[afterPack] 内置 git 未捆(.skipped)→ 跳过 git 检查');
    } else {
      require('./fetch-git.cjs').smokeGit(gitRoot, electronPlatformName);
    }
  }

  // ② macOS ad-hoc 自签 —— 必须放在 native rebuild 之后(重建改动了 bundle,签名要最后做,
  //    且 --deep 才能把重建后的 .node 一并签上)。无 Developer ID → Gatekeeper 显「未识别开发者/仍要打开」。
  if (electronPlatformName === 'darwin') {
    const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
    console.log(`[afterPack] codesign ad-hoc(--force --deep --sign -)→ ${appPath}`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log('[afterPack] ad-hoc 签名完成');
  }

  // ⑤ 随包 LibreOffice 转换引擎闸:用**打包出来的 app 本体**(ELECTRON_RUN_AS_NODE —— 引擎就跑在它上面;
  //    CI 的 setup-node 是 20,够不上 kit 要的 ≥22.19)把现写的最小 docx 真转成 PDF。放在 ② 签名之后:
  //    --deep 会重签 Resources 里嵌套的 LibreOfficeDev.app,要验的是签完的样子。
  //    ⚠️ 验不到:Windows 的 VC++ 运行库是否真走 app-local(runner 自带 VC++);这里只能查 DLL 在位。
  if (product.agentBackend) {
    const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
    const { kitEntry, enginePackage, VC_DLLS } = require('./fetch-office.cjs');
    const officeRoot = path.join(resourcesDir(), 'office');
    if (existsSync(path.join(__dirname, 'office', '.skipped'))) {
      console.log('[afterPack] LibreOffice 转换引擎已跳过(.skipped)→ 跳过转换检查');
    } else {
      if (electronPlatformName === 'win32') {
        const bin = path.join(officeRoot, 'node_modules', '@deepseek-ai', enginePackage('win32', require('electron-builder').Arch[arch]), 'bin');
        for (const dll of VC_DLLS) if (!existsSync(path.join(bin, dll))) throw new Error(`[afterPack] 随包 LibreOffice 缺 app-local ${dll}`);
      }
      const name = packager.appInfo.productFilename;
      const exe = electronPlatformName === 'darwin' ? path.join(appOutDir, `${name}.app`, 'Contents', 'MacOS', name)
        : electronPlatformName === 'win32' ? path.join(appOutDir, `${name}.exe`)
          : path.join(appOutDir, packager.executableName);
      const tmp = mkdtempSync(path.join(require('os').tmpdir(), 'forsion-office-gate-'));
      try {
        const script = path.join(tmp, 'gate.mjs');
        writeFileSync(script, OFFICE_GATE);
        execFileSync(exe, [script, kitEntry(officeRoot), path.join(tmp, 'gate.docx'), path.join(tmp, 'gate.pdf')],
          { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 600_000 });
        const pdf = readFileSync(path.join(tmp, 'gate.pdf'));
        if (pdf.length < 1000 || pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error(`[afterPack] 随包 LibreOffice 产出的不是 PDF(${pdf.length} B)`);
        console.log(`[afterPack] 随包 LibreOffice 转换 docx→PDF ✓ (${pdf.length} B)`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
};

/** ⑤ 的检查脚本:用 kit 自带的 fflate 现拼一份最小 docx(不依赖内置 Python 是否降级),再让 kit 转 PDF。 */
const OFFICE_GATE = `import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [entry, docx, pdf] = process.argv.slice(2);
const { zipSync, strToU8 } = createRequire(entry)('fflate');
const xml = (s) => strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + s);
writeFileSync(docx, zipSync({
  '[Content_Types].xml': xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  '_rels/.rels': xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  'word/document.xml': xml('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Forsion office gate 办公引擎检查</w:t></w:r></w:p></w:body></w:document>'),
}));
const { createConverter } = await import(pathToFileURL(entry).href);
const converter = await createConverter({ timeoutMs: 300000 });
try { console.log('[office-gate] backend=' + (await converter.render({ inputPath: docx, outputPath: pdf })).backend); }
finally { await converter.dispose(); }
`;
exports.OFFICE_GATE = OFFICE_GATE; // 干净 Windows 探针(scripts/bundled-runtimes.windows-probe.cjs)复用同一段

