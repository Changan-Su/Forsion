# Vault queries, file events, binary assets, the working folder and templates

Moved out of SKILL.md (2026-11-23) verbatim. Deeper contracts: references/vault-files-and-templates.md, references/work-folder-migration.md, references/plugin-storage.md (the plugin's own files, outside the vault, 2026-11-26+).

**Where "见下 / 见上 / below" pointers in this file land** (the sections moved apart on 2026-11-23): Selection bar, View modes, Tooltips, Drop indicators, Host parts, Settings parts, dashboard, `ctx.table.mount` → `host-ui-mounts.md`; 没有活动库, 外观开关, dispose 契约, 自绘浮层, pointer math → `view-runtime-rules.md`; 只读全库查询, onVaultEvent, 二进制资源, working folder, Templates and new notes → `vault-and-assets.md`; 前置条件 / onboarding.requires, requiresPlugins, 双语与图标, 上手提示 / guide, 主页小组件 / widgets → `manifest-declarations.md`; 统一左栏列表源, Floating Panel, Startup appearance, 共享账号, Whiteboard, Chat Box, LCL layout → `more-host-apis.md`; 当前模型, Agent 状态 / 名册, 开新对话, Agent Desk, 摘要栏, 自动化 → `tangu-host-apis.md`; 日历叠加源 → `calendar-overlays.md`; 日历 / 待办其余入口 → `calendar-todo-entries.md`; Space 与 Ribbon, 主页宿主件 → `spaces-and-home.md`; 全库多维表与笔记任务 → `databases-note-tasks.md`; 编辑器 / loadData / 块表面 → `note-editor-surfaces.md`; Tool result cards, Process-row sentences → `tool-cards.md`; where a surface's data comes from → `host-data-sources.md`. All in `references/`.

### 只读全库查询(2026-08-14 起)

全部可选 → 一律 `ctx.app.listPages?.()`;**没有活动库/桥缺席时给空数组不抛错**,`vaultRoot` 给 `null`。

| | 语义与坑 |
|---|---|
| `listPages()` | 笔记清单,vault 相对路径,**不截断**;插件自定义后缀已被主进程排除在外 |
| `listFiles()` | 文件树可见的非笔记文件。⚠️遍历**跳过一切点目录/点文件** → 经 `saveAsset()` 落进 `.amadeus/` 的页面附件枚举不到,**别声称「库里所有图片」** |
| `searchVault(q)` | 全库笔记全文检索。⚠️**最多 50 条且可能截断**,要穷举别靠它;`line` 是剥掉 frontmatter 后的行号**不是磁盘坐标**;`score` 不透明,跨版本不保证稳定 |
| `vaultRoot()` | 库的绝对路径(把路径喂给 Agent 的 host 工具时才需要)。⚠️含用户名/组织目录等**敏感信息,不得默认持久化或上报**;切库瞬间与主进程短暂不同源,**别缓存过夜** |
| `reveal(path)` | 在系统文件管理器里打开该路径所在目录并高亮它(2026-08-29 起)。⚠️对**不存在**的路径是静默 no-op,而工作文件夹是首写才诞生 → **先 `writeFile` 一份 README 再 reveal 它**(只给「用户要往里放素材」的插件,见下「工作文件夹」);桥缺席时整条方法不存在,`if (ctx.app.reveal)` 才画按钮 |
| `platformAccounts` | 平台登录(2.13.8 起,只有桌面端;其它端 / 旧宿主整个 `undefined` → 不画账号入口)。`status(p)` / `connect(p)`(只在用户点击时调,弹平台自己的登录页) / `pasteCookie(p, text)` / `disconnect(p)` / `cookie(p)`(没授权过的插件宿主先弹框问;没登录 / 拒绝 → null)。目前只有 `'bilibili'`。⚠️登录信息**别**写进库、日志、插件数据、提示词:交给 Agent 脚本用 `POST /agent/runs` 的 `secret_env: { NAME: cookie }`(只在内存、只给这次 run 的 run_bash,输出里出现会被打码,远程 run 丢弃;名字全大写,不能用 PATH / TANGU_* / FORSION_*);提示词只说「变量已设好、别打印」。详见插件手册「平台账号与登录信息」 |
| `trash(path)` | 把库内的一个文件或文件夹移进回收站(2026-10-05 起),等同用户在文件树里删它:宿主收掉开着它的编辑器与标签、提示「已移入回收站」,之后可在回收站恢复。返回 Promise,路径不存在 / 没有活动库 / 调用途中换了库 / 移动失败 → **reject**(路径按清单逐字匹配,只归一分隔符与首尾斜杠)。⚠️**文件夹连同里面的一切一起走,宿主不确认、也不看里面是不是别人的文件** —— 只在确认那个文件夹里全是你自己的东西时才传文件夹,否则传文件;⚠️**先让自己的编辑器停笔**(你的视图若还握着待存内容,下一次自动保存会把文件写回来);只有带回收站的宿主(本机桌面)才有这个方法,web / 移动端 / 2.12.2 及更早**整个不存在** → `ctx.app.trash` 没有就别画删除按钮 |

### 库级文件事件 ctx.app.onVaultEvent(2026-10-17 起)

`const off = ctx.app.onVaultEvent?.((events) => …)`:库里文件的新建 / 删除 / 改名 / 外部修改,约 200ms 攒成一批给你,插件停用时宿主自动退订。反链、自动整理、「新文件套模板」这类插件用它,别再轮询 `listFiles`。

| `kind` | 什么时候来 |
|---|---|
| `create` / `delete` | 任何笔记或文件进出库的清单,不管是谁做的(用户在 Forsion 里、别的程序、同步)。单独的文件夹不报 |
| `rename` | 在 Forsion 里(任何窗口)改名 / 移动:`{ path: 新, from: 旧 }`;整个文件夹挪走 = 一条 `folder: true`。**同一次改名不会再报一对删 / 建**。别的程序改的名分不出来,照「删 + 建」来 |
| `modify` | 内容在**本窗编辑器之外**变了(别的程序、Tangu、别的窗口、同步)。正在打开的那篇里的打字不在这里报,当前页用 `ctx.app.subscribePage` |
| `vault` | 换库或关库:你缓存的清单作废,重读 |

路径与 `readFile` 同一种写法(vault 相对、`/` 分隔)。没开库时什么都不来。回调里别做重活:一批可能有上百条(批量移动),先合并再处理。老宿主没有 → 可选链,退回轮询。

## 库内二进制资源 + 第三方库进包(2026-08-29 起)

`ctx.app.readFile` 只读 UTF-8。`.glb` / 字体 / 任意 blob 走资源协议:

```js
const buf = await fetch(`amadeus-asset://v/${encodeURIComponent(vaultRel)}`).then((r) => r.arrayBuffer())
```

按 vault 夹紧(越界 403)、支持 Range、`<img>`/`<video>` 也能当 `src`。⚠️**需要 Forsion ≥ 2.9.0**(CSP 的 connect-src 放行它是 2.9.0 才进的,2.8.1 及更早没有)—— 更早版本 CSP 的 `connect-src` 没放行它,症状是「`<img>` 能显示、fetch 一律 `Failed to fetch`」。用户自己放、自己管的素材让用户放进 `ctx.app.workFolder()`,`ctx.app.listFiles?.()` 列出来;插件自己生成、下载、缓存的文件放 `ctx.storage`,显示用 `ctx.storage.url(path)`(给 `null` 时读字节转 Blob URL),见 [references/plugin-storage.md](references/plugin-storage.md)。**别随包分发大资产或有版权的第三方资产**。仪器:desktop 的 `npm run check:assetfetch`。

**写/读字节(2026-09-19 起)**:`ctx.app.writeBytes?.(path, bytes)` / `ctx.app.readBytes?.(path)`。导入用户选的文件
不需要宿主的文件对话框 —— 在自己的 DOM 里放 `<input type="file" accept=".vrm,.glb" multiple>`(或拖放区),
`File.arrayBuffer()` 没有大小上限:

```js
const bytes = new Uint8Array(await file.arrayBuffer())
await ctx.app.writeBytes?.(`${ctx.app.workFolder()}/models/${file.name}`, bytes)   // 原子写、父目录自动建、已存在即覆盖
const back = await ctx.app.readBytes?.(`${ctx.app.workFolder()}/models/${file.name}`)  // Uint8Array | null
```

- 只在笔记要引用它、或卸载后用户还想在库里看到它时写进库;只有插件自己用的导入件(比如只给自家视图用的模型)用 `ctx.storage.write(path, bytes)`,同样收任意字节。
- 路径口径同 `writeFile`(库相对、越界由宿主钳死);收 `Uint8Array` / `ArrayBuffer` / 任意 TypedArray 视图(按字节原样)。
  没有活动库 → `writeBytes` reject `'No vault is open'`,`readBytes` 给 `null`(见上「没有活动库」表)。
- ⚠️**不走自写账本**:同一路径上的 `watchFile` 会把你自己这次写当成外部改动回调一次 —— watch 着自己写的文件时,回调里先比一下内容。(`watchFile` 只盯文本配置类文件和 PDF,别的二进制不报。)
- 多文件模型(`.gltf` + `.bin` + 贴图)要保留相对目录:`<input webkitdirectory>` 给每个 `File` 带 `webkitRelativePath`,逐个写到
  `${dest}/${f.webkitRelativePath}`。

**three.js 模型的两个坑**(`.glb` / `.vrm` / `.gltf`):
- **内嵌贴图**:GLTFLoader 在 Chromium 上用 `ImageBitmapLoader`,对内嵌图片走 `fetch(blob:)`;`.gltf` 里 base64 的 buffer 走 `fetch(data:)`。
  2026-09-19 起宿主 CSP 的 `connect-src` 放行了 `blob: data:`,原生 loader 直接能用;**更早的宿主**上贴图加载失败会被 loader 吞掉,
  症状是「模型出来了但一片白、只有一行 console.error」。兼容写法(贴图改走 `<img>`,`img-src` 一直放行 blob:):
  `loader.register((p) => { p.textureLoader = new THREE.TextureLoader(p.options.manager); return { name: 'forsion_csp_texture_fallback' } })`
  —— 旧宿主上 `.gltf` 的 base64 buffer 仍然不行。仪器:desktop 的 `npm run check:assetfetch`(T5–T7)。
- **相对 URI**:`amadeus-asset://v/<encodeURIComponent(整条路径)>` 把 `/` 编成了 `%2F`,`.gltf` 里 `tex/a.png` 这种相对引用按它解析会 404。
  用 `parse(buf, '')` + `manager.setURLModifier((u) => /^(blob:|data:|amadeus-asset:|https?:)/.test(u) ? u : ctx.app.assetUrl(join(dirOf(modelPath), decodeURI(u))))`,
  每端都对(web / unit 的资源 URL 是 `?ref=` 形,拼 base URL 那条路只在桌面成立)。

**Network and third-party libraries (desktop)**: the CSP blocks **scripts from other sites** (`script-src` has no CDN), so bundle every dependency into one file with esbuild `bundle: true`; `main.js` has **no size limit**. **Requests are not blocked by the CSP**: `connect-src` allows `https:` / `wss:` (and local localhost), so an https API that sends CORS headers (`Access-Control-Allow-Origin`) works with a plain `fetch`. An API without CORS headers fails with `TypeError: Failed to fetch`: that is CORS, not CSP; use `ctx.net` below. Web and mobile have different CSPs; test there separately.

需要 disposer 时:

```js
// build.mjs —— IIFE 的返回值会被丢掉,用 globalName + footer 把它 return 出去
globalName: 'myPlugin', footer: { js: 'return myPlugin.dispose;' }
```

**`ctx.net?.request(url, init)` (`PluginNetApi`, 2026-11-16+, desktop only)**: the main process makes the request, only to hosts listed in manifest `"network": ["api.example.com", "*.cdn.example.com"]`; https on 443 only, private addresses refused, no app cookies, ≤ 10 MB, 30 s default timeout; resolves for any HTTP status, rejects with `err.code` (`net_domain_not_declared`, …). Read [references/network.md](references/network.md) before using it.

## Vault files and the working folder (updated 2026-10-21)

`ctx.app.readFile/writeFile` use vault-relative paths, can access the whole active vault, reject traversal, and create parent folders on write. Every plugin gets the built-in `workFolder` setting. **New default: `Plugins/<effective-plugin-id>`**, for example `Plugins/bluebird` or `Plugins/diting`; Store IDs remain `market-<UUID>`. Display names and interface language never determine a new storage path. Always use `ctx.app.workFolder()` rather than constructing a path from the manifest, install-folder alias or translated label. A valid manual preference wins, including a Chinese or custom path outside `Plugins/`.

**The work folder is for notes (2026-11-26+)**: put notes the user opens from the file tree there as Markdown, plus the files those notes embed and exports the user asked to save. Machine data does not go into the vault, not even as hidden dot-files: indexes, caches, drafts, snapshots, undo copies, renders, window captures and bundled tools go into `ctx.storage` ([references/plugin-storage.md](references/plugin-storage.md)). The one exception is a small index (a few KB) that only makes sense next to the notes, such as "which note was clipped from which URL": it may stay a dot-file in the work folder. Keep default output under `Plugins/`; do not invent other top-level folders or write into the vault root. Re-register the built-in setting key to customize its label/description rather than creating a second storage setting. Changing the user's preference does not move existing data.

Local hosts may expose `ctx.app.writeFileScoped?(path, text, expectedRoot, { create: true })`. Capture `expectedRoot = ctx.app.vaultRoot()` before starting an asynchronous task. The host validates it under the filesystem lock and rejects a stale-vault write; create-only writes return `false` when the destination exists, successful writes return `true`. Feature-detect: an older host's renderer-side scope checks across awaits do not provide the same main-process guarantee. Keep that weaker fallback explicit and never silently overwrite an export/log name after a create-only conflict.

**Folders, file times, rename and move (2026-11-16+)**: `ctx.app.createFolder?(path)`; `stat?(path)` → `{ kind, size, mtime, ctime | null } | null` (absent on web); `renamePath?(path, newName)` / `movePath?(path, destFolder)` → the new path, done exactly like the file tree (`[[links]]` rewritten, open editors follow, `''` = vault root). No dialog for paths inside your work folder or that your plugin created this session (`writeFile` / `writeBytes` / `createFolder`); anything else asks the user, and Cancel rejects `Error('user_declined')`. Refused: moving `.db` files, renames that change the kind or touch images / PDFs, a `*.fd` folder on its own; a partial failure rejects with the new path in the message. Read [references/vault-files-and-templates.md](references/vault-files-and-templates.md) before using them.

**Choosing a folder and listing local vaults (2026-11-27+, desktop only)**: for backup / export plugins. Both are absent on web, mobile and older hosts: `ctx.app.pickFolder?.()` / `ctx.app.vaults?.()`, no button when missing.

- `ctx.app.pickFolder?({ title?, defaultPath? })` → `Promise<string | null>`: the system "choose folder" dialog (new folders allowed); resolves with the picked **absolute path**, `null` on cancel. `title` is display-only (shown in the macOS panel, truncated to 80 characters); `defaultPath` is used only when absolute, otherwise ignored. Call it from a user action. ⚠️ Picking grants nothing: `pickFolder` itself has no side effect, so the folder is not registered as a local project root (the host's own "add project" picker does that, on a separate path), the device page can't browse it, and `ctx.app`'s vault-path methods still only reach the open vault.
- `ctx.app.vaults?()` → `Promise<Array<{ root, name, current, cloud }>>`: the host's local vault list (the vault menu's list) plus the open vault. `root` absolute path, `name` folder name, `current` = the vault open right now (all `false` with none open), `cloud` = the app-managed Penzor Cloud mirror (listed only while it is the open vault). Missing folders (moved, unplugged drive) stay listed: don't read "can't open it" as "deleted". ⚠️ **A read failure is not an empty list**: when the host can't read its vault config (damaged / zero-byte / no permission / malformed vault entries; a failed read at start-up holds for the whole session) the call **rejects** (`amadeus-config-unreadable`); `[]` only when there really are no vaults. Treat a rejection as "unknown" before pruning anything. `root` is as sensitive as `vaultRoot()`.
- Both reject `Error('plugin-disposed')` once the plugin is turned off; a call in flight (dialog still open, list still loading) rejects at that moment and its late result is dropped.

For hosts without `workFolder`, either ask for an upgrade or preserve the plugin's established legacy path until a schema-aware recovery can run. Do not silently switch an existing installation to a hard-coded new ID path: that would hide its old data again. `workFolder()` is not a readiness probe; wait for `ctx.app.vaultRoot?.()` and catch write errors when no vault is open.

### Automatic upgrade of old data

The earlier root-level `<display name>` and `Plugins/<display name>` defaults are **legacy sources**, not the rule for new output. Hosts keep an existing display-name folder readable for plugins without migration support. For a plugin implementing migration, feature-detect **both** `workFolder` and `migrateWorkFolder` before requesting `workFolder({ preferId: true })`. That option still honors manual preferences. Await migration/recovery before normal index reads, writes or a task starts; a failed migration must not look like an empty successful collection.

`ctx.app.migrateWorkFolder?(request)` is available on local desktop hosts implementing the contract; unsupported mobile/web/cloud hosts omit it. The plugin validates its own schema and record paths; the host validates the vault and snapshots, copies without overwriting, and commits the index last. **Keep originals as backups.** Never rename/delete user folders, recursively move arbitrary JSON or use a global completion flag. A completed per-vault journal prevents deleted items being imported again. Preserve manual folders and resolve two populated data sets through explicit recovery rather than merging blindly.

Read [the migration contract and acceptance cases](references/work-folder-migration.md) before implementing or changing storage. It defines plan-relative paths, predecessor-journal recovery, interruption handling and media-link preservation. Reference consumers: Bluebird and Diting. Sessions continue using the separate vault `Sessions/` convention.

## Templates and new notes: extend the host's templates (2026-11-16+)

The host already has templates: the vault's `templates/` folder, `{{date}}` / `{{date:fmt}}` / `{{time}}` / `{{title}}`, `.obsidian/templates.json` and `.obsidian/daily-notes.json`, the daily note. A Templater-style or folder-template plugin plugs into them; it does not ship its own picker or fill notes after they open:

- `ctx.registerTemplateProcessor?.({ id, name, folders?, process(source, { templatePath, targetPath, kind }) })` → disposer: runs on the template's raw text before the host's own variables, for the picker insert (`'insert'`) and the daily note (`'daily'`); `folders()` adds picker folders.
- `ctx.registerNoteBirth?.({ id, initial({ path, folder, signal }) })` → disposer: a brand-new empty note gets its first content in the same write that creates it (every "New note" entry point including `ctx.app.createPage()`, `[[link]]` and quick-switcher create, child notes, a daily note without a template; not your `writeFile`).
- Caret at a marker inside inserted text: `ctx.app.insertMarkdownAt` (next section).
- ⚠️ Older hosts: do not fill new notes from `onVaultEvent` `create` + `writeFile`. Measured: the open editor never sees that write and its first save moves your template into a conflict copy.

Contract, examples and limits: [references/vault-files-and-templates.md](references/vault-files-and-templates.md).

## 块表面 / 伸进编辑器 / 自绘设置面板:read references/note-editor-surfaces.md

- **块表面**(当前这篇笔记的读写):`ctx.app.getPage / subscribePage / insertMarkdown / insertBlockAfter / deleteBlock / setFmExtra / undo / redo / requestFocus / mountBlocks / prompt`。⚠️ 先看 `page.model`:v4 笔记没有块 id,改内容只用 `insertMarkdown` / `insertMarkdownAt`(2026-11-16+:`where: 'caret'` 插进光标所在行、`cursorMarker` 把光标落到标记处、拒绝时回 `{ ok: false, reason }`,如 `'read-only'`),绝不「读全文 → 改 → 整篇写回」;改数据一律带 `page.token`。`registerFileType` 接管 `.pdf`(`override: true`)的规则也在这份里。
- **伸进编辑器 + 自绘设置面板**:`ctx.registerEditorExtension((pm) => [...])`(运行时绝不 import prosemirror;能拦键、加装饰,也能改文字和选区;只是插模板、放光标先用 `insertMarkdownAt`)、`ctx.registerSettingsView`、`ctx.loadData / saveData`(manifest `"syncData": true` 跟账号走)、`ctx.app.watchFile`。
