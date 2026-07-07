# Forsion-Genesis

Forsion 桌面产品家族的单一源码仓(原 Tangu-Agent 仓,2026-07-05 重构定名)。
所有端产品(Tangu 全家桶 / 未来的单 Space 发行版)从本仓以不同产品档案构建;发布走各产品独立的 release 仓。

## 结构

```
tangu-agent/   Agent 框架引擎(npm 包 forsion-tangu-agent;standalone 后端 / TUI / worker;本仓最初的中心)
desktop/       桌面壳(Electron):LCL 引擎之上的多 Space 产品(Tangu 对话 / Amadeus 笔记 / Calendar 日历 / Inbox 收件箱 / Coding 编码)
web/           Tangu Web(浏览器云客户端,经别名复用 desktop 渲染层)
mobile/        Tangu Mobile(Android / Capacitor,复用 desktop 渲染层 + 移动壳替身)
lcl/           LCL = Space-View + 插件体系前端框架(engine=工作区引擎;spaces=数据 Space 配方装载)
               各端经 @lcl 别名消费;lcl/node_modules 软链到 desktop/node_modules(desktop postinstall 自动创建)
archived/      历史存档
Dockerfile.standalone   Tangu worker 镜像(构建上下文=仓根,只 COPY tangu-agent/)
```

## Spaces(桌面)

桌面壳把不同产品做成 ribbon 顶部可切换的 **Space**(一组视图 + 布局):

- **Tangu** — AI 对话工作台(会话 / 文件 / 记忆 / 子聊天)。
- **Amadeus** — Obsidian 式笔记库(Milkdown 编辑器 / 双链 / 多维表 / 关系图)。
- **Calendar** — 跨库日程(汇总全部多维表的 `calendarDate`/`todo` 属性)。
- **Inbox** — 收件箱(经本地后端 `/agent/inbox`)。
- **Coding** — 模仿 Google AI Studio 的编码空间:左栏复用 Tangu 对话作 Prompt,主区是 **Code | Preview** 双切换工作台。
  - 项目按 `~/Forsion/Project/<项目>` 一项目一文件夹组织(= 会话 cwd + 预览根)。
  - 预览 = 本地静态 dev-server:按需转译 `.ts/.tsx/.jsx`(sucrase,vite-dev 式),裸依赖走 `importmap` + [esm.sh](https://esm.sh);**无构建步骤、无 `npm install`**,写文件即时刷新。
  - 专属 **Coding Agent**(内置多个 web 开发技能),写文件时代码在面板里流式显现。

## 常用命令

```bash
cd tangu-agent && npm run build     # 编 Agent 后端(desktop 打包的 extraResources 依赖它)
cd desktop && npm run dev           # 桌面开发(postinstall 会补 lcl 软链)
cd desktop && npm run build         # tsc + electron-vite build
```
