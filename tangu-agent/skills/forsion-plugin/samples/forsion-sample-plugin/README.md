# tangu-sample-plugin

Tangu（Forsion Desktop / Tangu Agent）**后端插件**开发模板 —— 类似 [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) 之于 Obsidian。

演示三个常用贡献点：

- **工具**：`sample_greet`（agent 可调用；插件启用才对模型可见）
- **设置 schema**：`text` + `toggle` 两个字段（Tangu 设置 → 插件 里通用渲染，无需自己写 UI）
- **promptSection**：启用时向系统提示注入一小段文本（随设置动态变化）

## 快速开始

```bash
git clone https://github.com/Changan-Su/tangu-sample-plugin my-plugin
cd my-plugin
npm install
npm run build        # tsc → dist/
```

装进本机 Tangu：把整个文件夹拷到（或软链进）`~/.forsion/plugins/sample-plugin/`（旧安装是 `~/.tangu/plugins/`，两者互为兼容软链），然后重启 Tangu 后端（或在 设置 → 插件 点重扫）。在 **设置 → 插件** 里会出现「示例插件」：启用它，agent 就能调 `sample_greet`，设置页可改问候前缀。

开发循环：改 `src/` → `npm run build` → 重启后端（同 id 原位升级受 ESM import 缓存影响，必须重启）。

## 改成你自己的插件

1. 改 `tangu-plugin.json`：`id`（kebab-case，唯一）、`name`、`version`、`description`；`apiVersion` 保持与宿主一致（当前 = 1）。
2. 改 `package.json` 的 `name`/`description`。
3. 在 `src/index.ts` 里写你的 `activate(ctx)`。

## 硬约束（必读）

- **绝不在运行时 import 核心包**。对 `@forsion/tangu-agent` 只允许 `import type`（本仓 tsconfig 开了 `verbatimModuleSyntax`，值导入直接编译错误）。运行时能力一律走 `activate(ctx)` 传入的 **`ctx.sdk`**（按引用，核心同一模块实例）——否则核心的模块级单例会被复制成第二份，行为诡异。
- **`dist/` 必须提交**。Forsion 插件商店安装 = 解压源码 zip 到 `~/.forsion/plugins/<slug>/`，全程不构建；改了 `src/` 请重新 `npm run build` 再提交（CI 会用 `git diff --exit-code dist/` 卡住忘记重建的提交）。
- **类型契约**：`types/tangu-agent.d.ts` 是 Tangu 公开插件 API（apiVersion 1）的拷贝，随模板分发。宿主升 apiVersion 时会发布新契约，届时替换此文件并更新 manifest 的 `apiVersion`。
- **注入模型的文本一律英文**：工具 `description`/参数说明是给模型读的，全部英文（本仓 `sample_greet` 即是）；用户可见字段走 `name`/`nameEn`、`description`/`descriptionEn` 双语镜像。

## 发布到 Forsion 插件商店

1. 把插件推成独立 GitHub 公开仓库（记得包含构建好的 `dist/`），建议打 release tag。
2. 在 Forsion 个人中心 → 投稿 页提交（类型选「插件」，给 GitHub 仓库链接或直接传 zip；zip 直传时内容放 zip 根或**单层**文件夹，两层路径安装器不认）。
3. 审核通过后，用户在桌面端 插件商店 → 插件 一键安装，免重启热生效（贡献路由的插件除外）。

> 注：GitHub 来源的上架会**锁定过审时的 release tag**——之后发新版需要重新过审（或联系管理员更新锁定）。

## 相关

- 笔记（Amadeus）编辑器插件是**另一套系统**：`manifest.json + main.js`，放 vault 的 `.amadeus/plugins/` 或全局 `~/.forsion/amadeus/plugins/`，桌面端 设置 → 笔记插件 里有一键脚手架。
- 纯数据扩展的模板仓：[tangu-sample-theme](https://github.com/Changan-Su/tangu-sample-theme)（主题包）、[tangu-sample-space](https://github.com/Changan-Su/tangu-sample-space)（Space 配方）、[tangu-sample-agent](https://github.com/Changan-Su/tangu-sample-agent)（智能体）；技能（SKILL.md）没有模板仓但有硬契约：frontmatter 只认**顶层单行 `key: value`**（极简解析器，多行 YAML 静默失效）、`description` 是模型的触发判据、slug kebab-case、正文引用的工具名必须真实存在。

---

## English (short)

A template for Tangu backend plugins (folder plugins). It demonstrates a tool, a settings schema and a promptSection. Build with `npm install && npm run build`, drop the folder into `~/.forsion/plugins/sample-plugin/`, restart the Tangu backend, then enable it under Settings → Plugins.

Hard rules: only `import type` from `@forsion/tangu-agent` (all runtime access goes through `ctx.sdk`), and commit `dist/` (Plugin store installs are unzip-only, no build step). `types/tangu-agent.d.ts` is the vendored public API contract (apiVersion 1).

MIT © Changan Su
