/**
 * 干净 Windows 台架(09-26):随包 Python / LibreOffice 在**没装 VC++ 运行库**的机器上能不能用。
 *
 * GitHub windows runner 自带 VC++,build-desktop 里 afterPack 的两道闸在那儿永远是绿的。这里借 runner 是
 * 一次性管理员机器:把 System32 里那 5 个 VC++ DLL 藏掉、PATH 收到只剩系统目录(runner 的工具目录里常各带一份
 * vcruntime),再对**静默安装后的真安装包**跑:
 *   ① 内置 Python import smoke(fetch-python.cjs 的 smokePython,含 numpy/pandas/matplotlib/pdfium 原生库)
 *   ② 随包 LibreOffice:Forsion.exe 以 ELECTRON_RUN_AS_NODE 把现拼的 docx 转 PDF(afterPack 的 OFFICE_GATE)
 *   ③ 负对照:把 kit 引擎旁的 app-local VC++ DLL 挪走,② 必须红 —— 否则系统 DLL 没藏干净,①② 是假绿。
 *
 * 用法:node desktop/scripts/bundled-runtimes.windows-probe.cjs <含安装包 .exe 的目录>
 * 由 .github/workflows/probe-bundled-runtimes.yml 调用;本机(非 Windows)跑不了。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { smokePython } = require('../build/fetch-python.cjs');
const { OFFICE_GATE } = require('../build/afterPack.cjs');
const { kitEntry, enginePackage, VC_DLLS } = require('../build/fetch-office.cjs');

if (process.platform !== 'win32') { console.error('只在 Windows 上跑'); process.exit(2); }
const artDir = process.argv[2];
const installer = fs.readdirSync(artDir, { recursive: true }).map((f) => path.join(artDir, f))
  .find((f) => /\.exe$/i.test(f) && !/uninstall/i.test(f));
if (!installer) { console.error(`${artDir} 里没有安装包 .exe`); process.exit(2); }

const INSTALL = 'C:\\ForsionProbe';
console.log(`静默安装 ${path.basename(installer)} → ${INSTALL}`);
execFileSync(installer, ['/S', `/D=${INSTALL}`], { stdio: 'inherit' }); // NSIS:/D 必须最后一个且不加引号
const exe = path.join(INSTALL, 'Forsion.exe');
const resources = path.join(INSTALL, 'resources');
if (!fs.existsSync(exe)) { console.error(`安装后没有 ${exe}`); process.exit(1); }

// 藏掉系统的 VC++ 运行库:System32 下的受 TrustedInstaller 保护,先取所有权再改名(在用的 DLL 也能改名)。
const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
for (const dll of VC_DLLS) {
  const f = path.join(sys32, dll);
  if (!fs.existsSync(f)) { console.log(`系统本来就没有 ${dll}`); continue; }
  execFileSync('takeown', ['/f', f], { stdio: 'ignore' });
  execFileSync('icacls', [f, '/grant', '*S-1-5-32-544:F'], { stdio: 'ignore' }); // Administrators 的 SID,免受系统语言影响
  fs.renameSync(f, `${f}.probe-hidden`);
  console.log(`藏起 ${f}`);
}
process.env.PATH = [sys32, process.env.SystemRoot || 'C:\\Windows'].join(';');

function officeGate() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-office-'));
  try {
    const script = path.join(tmp, 'gate.mjs');
    fs.writeFileSync(script, OFFICE_GATE);
    execFileSync(exe, [script, kitEntry(path.join(resources, 'office')), path.join(tmp, 'gate.docx'), path.join(tmp, 'gate.pdf')],
      { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 300_000 });
    const pdf = fs.readFileSync(path.join(tmp, 'gate.pdf'));
    return pdf.length > 1000 && pdf.subarray(0, 5).toString() === '%PDF-';
  } catch (e) {
    console.log(`  转换失败:${e.status ?? ''} ${String(e.message).split('\n')[0]}`);
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const results = {};
console.log('\n① 内置 Python smoke(无系统 VC++)');
try { smokePython(path.join(resources, 'python')); results.python = true; } catch (e) { console.log(`  失败:${String(e.message).split('\n')[0]}`); results.python = false; }

console.log('\n② 随包 LibreOffice docx→PDF(无系统 VC++)');
results.office = officeGate();

console.log('\n③ 负对照:挪走 app-local VC++ DLL,② 必须红');
const bin = path.join(resources, 'office', 'node_modules', '@deepseek-ai', enginePackage('win32', 'x64'), 'bin');
const aside = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-vc-aside-'));
for (const dll of VC_DLLS) fs.renameSync(path.join(bin, dll), path.join(aside, dll));
results.negativeRed = !officeGate();
for (const dll of VC_DLLS) fs.renameSync(path.join(aside, dll), path.join(bin, dll));

console.log('\n结果', JSON.stringify(results));
const ok = results.python && results.office && results.negativeRed;
console.log(ok ? '✓ 干净 Windows 上随包运行时可用,且负对照有效'
  : results.negativeRed ? '✗ 随包运行时在无 VC++ 的机器上不可用' : '✗ 负对照没变红:系统 VC++ 没藏干净,①② 的绿不可信');
process.exit(ok ? 0 : 1);
