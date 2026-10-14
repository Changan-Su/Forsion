import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('./', import.meta.url), art = new URL('artifacts/expanded/', root);
const matrix = JSON.parse(await readFile(new URL('compatibility.json', root), 'utf8'));
const { results, errors } = JSON.parse(await readFile(new URL('results.json', art), 'utf8'));
let validation = {};
try { validation = JSON.parse(await readFile(new URL('validation.json', art), 'utf8')); } catch {}
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const shots = [
 ['19-native-admonition', '原版 Admonition 与原生 Markdown / Original Admonition and native Markdown'],
 ['20-native-admonition-dark', '暗色 Admonition / Admonition in dark mode'],
 ['21-native-admonition-narrow', '窄窗 Admonition / Admonition in a narrow window'],
 ['16-native-charts', '原版 Charts 与原生代码块 / Original Charts in a native code block'],
 ['14-native-toolbar', '原版工具栏与原生表格 / Original toolbar and native table'],
 ['17-native-charts-dark', '暗色原生图表 / Native chart in dark mode'],
 ['13-native-hotkeys', '原生快捷键设置 / Native shortcut settings'],
 ['11-native-refactor', '原包快捷键提取笔记 / Original hotkey extraction'],
 ['08-community-search', '官方目录搜索 / Official catalog search'],
 ['10-native-tables', '原生表格命令 / Native table command'],
 ['12-native-background', '后台自动编号 / Background numbering'],
 ['06-native-dark', '暗色原生编辑器 / Native editor in dark mode'],
];
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Obsidian Bridge ${matrix.version} · Compatibility</title>
<style>body{margin:0;background:#f5f4f1;color:#242c29;font:15px/1.7 system-ui}main{max-width:1180px;margin:auto;padding:42px 24px}h1{font-size:36px;line-height:1.2}h2{margin-top:36px;font-size:23px}small,.muted{color:#606b64}a{color:#285e45}table{border-collapse:collapse;width:100%}td,th{padding:12px 9px;text-align:left;vertical-align:top;border-bottom:1px solid #d4d9d2}td p{margin:0 0 7px}th{font-weight:500}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#e7eae4}code{overflow-wrap:anywhere}.status{font-weight:600}.partial{color:#765b20}.unsupported,.fail{color:#923f35}.ok{color:#2d6746}figure{margin:20px 0}img{width:100%;border:1px solid #d4d9d2}figcaption{padding:8px 0}button{font:inherit;border:1px solid #bac8bc;border-radius:6px;padding:7px 12px;background:transparent;margin:0 8px 8px 0;cursor:pointer}button[aria-pressed=true]{background:#285e45;color:#fff}.table-wrap{overflow-x:auto}.stats{font-size:24px;padding:15px 0;border-block:1px solid #d4d9d2}@media(max-width:650px){main{padding:24px 14px}h1{font-size:28px}td{min-width:150px}}</style>
<main><small>FORSION DESKTOP · WORKTREE PROTOTYPE ${esc(matrix.version)}</small>
<h1>Obsidian 插件接入原生工作流<br><small>Obsidian plugins in native workflows</small></h1>
<p>本轮新增 MarkdownRenderer 公共适配，复用 Amadeus 渲染器。未经修改的 Admonition 12.0.10 在原生笔记中显示富文本标题、正文、表格和图标；折叠/展开、内部链接、源码切换与启停均验证。原包仍安装在 Bridge 自身插件文件夹内。</p>
<p>This iteration maps MarkdownRenderer to Amadeus rendering. Unmodified Admonition 12.0.10 renders rich titles, bodies, tables and icons inside native notes; folding, internal links, source toggling and plugin lifecycle are verified. Original assets remain inside Bridge's plugin folder.</p>
<p class="stats">${results.filter(r => r.ok).length} / ${results.length} Electron checks · ${results.filter(r => !r.ok).length} failed</p>
<p>当前完整 Goal 尚未完成。自定义视图完整生命周期、Markdown 渲染和编辑器扩展仍待补齐；源码验收不代表发布。</p>
<p>The full Goal remains unfinished. Full custom-view lifecycle, Markdown rendering and editor extensions remain incomplete. Source acceptance is not a release.</p>
<h2>使用 / Use</h2><p>在原生笔记选中文字，按 Note Refactor 原包默认的 ⌘⇧N 提取笔记；在「设置 → 快捷键」搜索插件命令，可改键或解绑。默认键位可能被原生编辑器已处理的键占用，可另行改键。</p>
<p>Select text in a native note and press Note Refactor's original ⌘⇧N shortcut to extract it. Search plugin commands in Settings → Shortcuts to rebind or unbind. Native handled keys take priority; conflicting defaults can be rebound.</p>
<p>快捷键目前只在原生正文响应；搜索、设置输入框与 Bridge 管理弹窗不会触发。按住重复默认关闭，IME 组合输入不触发。Electron 测试窗口层级与焦点以末尾逐项记录为准。</p>
<p>Bridge hotkeys currently require a native note body and leave search/settings inputs and the manager alone. Repeats require the original command's opt-in, and IME composition is ignored. Window layer and focus measurements are in the checks below.</p>
<h2>真实截图 / Actual screenshots</h2>${shots.map(([id, label], i) => `<button data-shot="${id}" aria-pressed="${i === 0}">${esc(label)}</button>`).join('')}
${shots.map(([id, label], i) => `<figure id="${id}" ${i ? 'hidden' : ''}><img src="${id}.png" alt="${esc(label)}" loading="lazy"><figcaption>${esc(label)}</figcaption></figure>`).join('')}
<h2>兼容矩阵 / Compatibility matrix</h2><p>${esc(matrix.meaning.zh)}</p><p>${esc(matrix.meaning.en)}</p>
<div class="table-wrap"><table><tr><th>能力 / Capability</th><th>已支持的范围 / Supported scope</th><th>待补 / Remaining</th></tr>${matrix.categories.map(c => `<tr><td><strong>${esc(c.zh)}<br>${esc(c.en)}</strong><p class="status ${esc(c.status)}">${esc(c.status)}</p></td><td><p>${esc(c.verifiedZh)}</p><p>${esc(c.verifiedEn)}</p><details><summary>验证入口 / Evidence</summary><code>${esc(c.evidence)}</code></details></td><td><p>${esc(c.remainingZh)}</p><p>${esc(c.remainingEn)}</p></td></tr>`).join('')}</table></div>
<h2>实际检查 / Executed checks</h2><table>${results.map(r => `<tr><td class="${r.ok ? 'ok' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'}</td><td>${esc(r.name)}${r.detail ? `<details><summary>证据 / Evidence</summary><pre>${esc(JSON.stringify(r.detail, null, 2))}</pre></details>` : ''}</td></tr>`).join('')}</table>
<h2>工程验证 / Engineering validation</h2><pre>${esc(JSON.stringify(validation, null, 2))}</pre><details><summary>渲染错误 / Renderer errors</summary><pre>${esc(JSON.stringify(errors, null, 2))}</pre></details>
<p><a href="results.json">原始结果 / Raw results</a> · <a href="validation.json">工程记录 / Validation</a> · <a href="session.json">隔离会话 / Isolated session</a></p>
<p>插件代码是可信本地代码；iframe 不是安全沙箱。本轮不合并 main、不发布安装包、不部署。<br>Plugin code is trusted local code; iframe isolation is not a security sandbox. No main merge, installer release or deployment.</p></main>
<script>document.querySelectorAll('[data-shot]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-shot]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));document.querySelectorAll('figure').forEach(f=>f.hidden=f.id!==b.dataset.shot)})</script></html>`;
await writeFile(new URL('index.html', art), html);
console.log(new URL('index.html', art).pathname);
