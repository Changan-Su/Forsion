// Render evidence from a completed real-Electron run; never infer missing checks.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = dirname(fileURLToPath(import.meta.url));
const art = resolve(process.env.BRIDGE_ARTIFACTS || join(base, 'artifacts'));
const data = JSON.parse(await readFile(join(art, 'results.json'), 'utf8'));
const session = JSON.parse(await readFile(join(art, 'session.json'), 'utf8'));
const validation = await readFile(join(art, 'validation.json'), 'utf8').then(JSON.parse).catch(() => null);
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const passed = data.results.filter(r => r.ok).length;
const shots = [
 ['07-ready','Desktop 原型 / Desktop prototype'],
 ['01-sort','排序 / Sorting'], ['02-toc','目录 / Table of contents'],
 ['03-numbered','标题编号 / Number headings'], ['04-settings','原插件设置 / Original settings'],
 ['05-dark','深色模式 / Dark mode'], ['06-narrow','窄窗口 / Narrow window'],
 ['08-native-note','在 Amadeus 打开副本 / Copy opened in Amadeus'],
];
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Obsidian Bridge — Desktop acceptance</title>
<style>
:root{font:15px/1.65 system-ui,sans-serif;color:#242934;background:#f5f6f8}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:52px 28px 80px}h1{font-size:38px;letter-spacing:-1.4px;margin:8px 0}h2{font-size:22px;margin:36px 0 12px}p{max-width:850px}a{color:#2054b8}code{font:12px/1.7 ui-monospace,monospace;overflow-wrap:anywhere}small,.muted{color:#667080}.eyebrow{letter-spacing:2px;font-size:11px}.lead{font-size:18px}.metrics{display:flex;gap:36px;border-block:1px solid #dfe3e9;padding:20px 0;margin:28px 0}.metrics b{font-size:28px;display:block}.metrics span{font-size:12px;color:#667080}.path{background:white;border:1px solid #e1e4e9;padding:18px;border-radius:8px;white-space:pre-wrap}table{width:100%;border-collapse:collapse;text-align:left}td,th{padding:11px 12px;border-bottom:1px solid #dde2e8;vertical-align:top}th{font-size:12px;color:#697282}figure{margin:18px 0 30px}img{width:100%;height:auto;border:1px solid #d4d9e2;border-radius:8px}figcaption{font-size:13px;color:#667080;margin-top:6px}.pass{color:#207345}.fail{color:#b63030}details{border-bottom:1px solid #dfe3e9;padding:10px 0}summary{cursor:pointer}pre{white-space:pre-wrap;font-size:12px}.limits{padding-left:22px}.flow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.flow div{background:white;padding:12px 18px;border:1px solid #dfe3e9;border-radius:7px}footer{margin-top:36px;color:#667080;font-size:12px}@media(max-width:600px){main{padding:28px 16px}.metrics{gap:22px}h1{font-size:30px}td,th{padding:9px 5px}}
</style><main><div class="eyebrow">FORSION · DESKTOP PROTOTYPE · 0.1.0</div>
<h1>Obsidian Bridge</h1><p class="lead">在 Forsion 里运行真实 Obsidian 插件原包。<br><small>Unchanged Obsidian release packages running inside Forsion.</small></p>
<div class="metrics"><div><b>3</b><span>真实插件 / Real plugins</span></div><div><b>19</b><span>注册命令 / Registered commands</span></div><div><b class="${passed===data.results.length?'pass':'fail'}">${passed}/${data.results.length}</b><span>Electron 验收 / Acceptance checks</span></div></div>
<p>这是隔离 worktree 的 Desktop 原型。三个原包已接入专用兼容编辑区；19 个命令是注册数量，已验证的操作以下方执行记录为准。</p>
<p class="muted">An isolated worktree prototype. The dedicated editor hosts the three packages. Registration of 19 commands does not certify every command. This is not an installed product release.</p>
<div class="flow"><div>Forsion LCL View</div>→<div>Bridge runtime<br><small>Obsidian API subset + CodeMirror</small></div>→<div>Original plugins</div></div>
<h2>插件与证据 / Packages and provenance</h2><table><thead><tr><th>Plugin</th><th>Version</th><th>Source</th></tr></thead><tbody>${(data.receipts||[]).map(r=>`<tr><td>${escape(r.id)}</td><td>${escape(r.version)}</td><td><a href="${escape(r.release)}">GitHub release</a> · ${r.files.length} unchanged assets</td></tr>`).join('')}</tbody></table>
<p>原包安装在 Bridge 插件自己的文件夹里；设置通过 Forsion 插件数据接口保存。每个包的 <code>source.json</code> 包含 SHA-256 记录。<br><small>Packages are nested under Bridge; settings use Forsion plugin storage. Each source receipt records SHA-256 hashes.</small></p>
<div class="path"><code>${escape(session.installed)}/
  main.js · manifest.json · runtime.js
  plugins/
    obsidian-sort-and-permute-lines/
    obsidian-plugin-toc/
    number-headings-obsidian/</code></div>
<h2>实际界面 / Real Electron screenshots</h2>${shots.map(([file,title])=>`<figure><a href="${file}.png"><img loading="lazy" src="${file}.png" alt="${escape(title)}"></a><figcaption>${escape(title)}</figcaption></figure>`).join('')}
<h2>执行记录 / Executed checks</h2>${data.results.map(r=>`<details><summary><span class="${r.ok?'pass':'fail'}">${r.ok?'PASS':'FAIL'}</span> · ${escape(r.name)}</summary><pre>${escape(r.detail||'Completed without additional diagnostic output.')}</pre></details>`).join('')}
<p><a href="results.json">原始结果 / Raw results</a> · <a href="session.json">隔离路径 / Isolated session paths</a></p>
${validation ? `<h2>补充验证 / Supporting validation</h2><p>${escape(validation.review)}</p><table><tbody>${validation.checks.map(c=>`<tr><td>${escape(c.name)}</td><td>${escape(c.result)}</td><td><a href="${escape(c.link)}">Evidence</a></td></tr>`).join('')}</tbody></table><p><code>${escape(validation.revision)}</code></p>` : ''}
<h2>范围 / Scope</h2><ul class="limits"><li>原生 LCL 标签页内的独立兼容编辑器；普通 Amadeus 编辑页的插件注入尚未实现。<br><small>Dedicated compatibility editor in a native LCL tab; no plugin injection into ordinary Amadeus editors.</small></li><li>智库笔记读取为草稿，导出创建新副本。关闭前需保存，草稿无自动保存。<br><small>Read notes into drafts and export new copies. Drafts are not auto-saved.</small></li><li>仅实现样本所需 API；Node/Electron 模块、完整 Vault/Workspace、CodeMirror 扩展和跨插件 API 未实现。<br><small>A targeted API subset; Node/Electron modules, complete Vault/Workspace, CodeMirror extensions and inter-plugin APIs remain unsupported.</small></li><li>iframe 隔离 DOM 和样式，不是安全沙箱。第三方插件需要与 Forsion 插件同等信任。<br><small>The iframe isolates DOM/CSS, not authority. Third-party code requires the same trust as native Forsion plugins.</small></li><li>AI 后端为测试桩；插件加载、IPC、编辑器、设置磁盘持久化和截图均来自实际 Electron。<br><small>Only the unrelated AI backend is stubbed. Plugin execution, IPC, editor, settings persistence and screenshots use real Electron.</small></li></ul>
<h2>复现 / Reproduce</h2><div class="path"><code>cd desktop
node prototypes/obsidian-bridge/install-plugins.mjs
npm run build:obsidianbridge
npm run build
# Acquire the repository GUI lock before Electron launch.
npm run e2e:obsidianbridge
npm run demo:obsidianbridge</code></div>
<footer>Generated from real run artifacts · ${escape(new Date().toISOString())}<br>Source worktree: ${escape(resolve(base, '../../..'))}<br>Branch: codex/obsidian-bridge-desktop · Local prototype, not merged or published.</footer></main></html>`;
await writeFile(join(art,'index.html'),html);
console.log(join(art,'index.html'));
