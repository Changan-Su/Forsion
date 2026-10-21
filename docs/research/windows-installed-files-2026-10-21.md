# Windows 文件关联与系统打开验收

## 实物基线

官方 v2.13.5 标准 NSIS 安装包，下载后逐字核对 GitHub asset SHA256；在独占 Windows Server 2022 runner 中实际个人安装，运行安装目录内的 packaged Electron，而非 dev 模拟。真正 PDF UserChoice 的 ProgId / Hash 在安装、卸载前后核对；缺失时明确标未验证。无开发者桌面安装、全局输入或生产发布。

已复现三处产品缺陷：

1. [官方安装/卸载失败 39517698420](https://github.com/Changan-Su/Forsion/actions/runs/39517698420)：shell open 命令只引用了 `%1`，可执行路径没有引号。electron-builder 26.15.3 的真实 APP_ASSOCIATE 生成器与注册表实物一致。
2. 同次实际卸载虽移除 ProgID、OpenWith 与完整目录，却留下 `.md / .markdown / .pdf` 默认值指向已删除 ProgID；原失败保留。
3. [39604230159](https://github.com/Changan-Su/Forsion/actions/runs/39604230159)：真正二次启动收到小写路径后出现 `Inside` 与 `inside` 两个原生标签。vault 归属判定忽略大小写，标签去重仍用逐字相等。该次库外 Markdown 原地写回、无导入副本、PDF 特征像素与文字墨迹、暖 ShellExecute 和库内原生视图均已通过。

## 修复与仪器

- `desktop/build/file-associations.cjs` 从现有产品 association 表生成 NSIS 包含文件；引用程序与图标路径，PDF 保持 Alternate，Markdown 仅在有效合并默认未分配时认领。正常与更新卸载在实际 unregister 点删除本产品指针；跨范围迁移清理已退役且 ProgID 已不存在的自有 HKCU 默认，不碰 UserChoice。
- 真实 NSIS 模板编译器沿 builder 的 common-header → generated-association 宏顺序组装。仅 CI 的 runtime fixture 生成真实卸载器与无 UI 参数记录程序，通过有空格的安装路径和中文文件名实际 ShellExecute。
- `windows-nsis-associations.check.ps1` 先消费官方卸载实际留下的旧指针，再验机器范围、个人范围、覆盖安装、机器与个人的其他产品默认 / OpenWith / ProgID 保留、完整目录删除。
- `openFileInstall.ts` 对 Windows 盘符与 UNC 路径的库内标签身份统一大小写 / 分隔符；POSIX 保持逐字身份。六项正反回归：修前 3 红 / 3 绿，修后 6/6。
- `open-external-file.e2e.cjs` O8 用真实第二进程投递大小写不同的同一路径，中途切走，再核对内容、已有标签聚焦与零重复。既有 O1–O7 保留。
- `windows-installed-file.e2e.cjs` 继续测试不可修改的官方程序；三个已知旧版缺陷以精确 BASELINE-RED 记录，任意其他偏差仍失败。新源码的行为独立门控，不把旧包冒充修复包。冷 ShellExecute 另以原生 UIA 读文件名和已保存正文，受进程级截止与专属路径清理约束。

## 评审与当前状态

GPT-6.1 Sol xhigh 首次评审指出：机器范围 Markdown 默认会被 HKCU 遮盖、退役个人范围指针、缺失注册表默认值返回 null。前两项补产品保护与真实范围测试，第三项修正观测的空值归一。最终聚焦复核（含路径身份与冷启动仪器）无 P1/P2；本地完整桌面 TypeScript 检查通过。

[39605750064](https://github.com/Changan-Su/Forsion/actions/runs/39605750064) 的全用户 / 个人 / 覆盖安装与完整卸载门控均成功，真实 UserChoice 保留；安装版冷 Shell UIA 仪器误把 IntPtr.Zero 当布尔 false 而失败，已修为原生句柄零值比较，原失败保留。新源码 O8 与最终安装版验收仍在进行；#35 尚未关闭。当前官方 2.13.5 不含本 PR 修复。
