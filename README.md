# Forsion-Genesis

Forsion 桌面产品家族的单一源码仓(原 Tangu-Agent 仓,2026-07-05 重构定名)。
所有端产品(Tangu 全家桶 / 未来的单 Space 发行版)从本仓以不同产品档案构建;发布走各产品独立的 release 仓。

## 结构

```
tangu-agent/   Agent 框架引擎(npm 包 forsion-tangu-agent;standalone 后端 / TUI / worker;本仓最初的中心)
desktop/       桌面壳(Electron):LCL 引擎之上的多 Space 产品(Tangu 对话 / Amadeus 笔记 / Inbox …)
web/           Tangu Web(浏览器云客户端,经别名复用 desktop 渲染层)
mobile/        Tangu Mobile(Android / Capacitor,复用 desktop 渲染层 + 移动壳替身)
lcl/           LCL = Space-View + 插件体系前端框架(engine=工作区引擎;spaces=数据 Space 配方装载)
               各端经 @lcl 别名消费;lcl/node_modules 软链到 desktop/node_modules(desktop postinstall 自动创建)
archived/      历史存档
Dockerfile.standalone   Tangu worker 镜像(构建上下文=仓根,只 COPY tangu-agent/)
```

## 常用命令

```bash
cd tangu-agent && npm run build     # 编 Agent 后端(desktop 打包的 extraResources 依赖它)
cd desktop && npm run dev           # 桌面开发(postinstall 会补 lcl 软链)
cd desktop && npm run build         # tsc + electron-vite build
```
