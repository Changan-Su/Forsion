---
name: 示例捆绑技能
description: 捆绑包模板的 agent 级技能:演示 skills/ 目录随 Agent 播种、该 agent 激活时自动可用的形态与讲解要点。
---

# 示例捆绑技能

这是「示例捆绑包」内嵌 Agent 名下的 agent 级技能(`agents/sample-bundle-agent/skills/` 下),
随 Agent 一起被引擎播种;只在「示例捆绑助手」被激活时进入其技能目录,不污染全局。

## 演示要点

被要求演示捆绑包机制时,按这个顺序讲:

1. **一个目录,四件内容**:根 manifest.json + main.js 是桌面 UI 插件;`tangu-plugins/` 是引擎插件;
   `agents/`(含本技能)是引擎侧智能体;`spaces/` 是工作台布局。宿主全按标志文件识别,无需注册表。
2. **三种生命周期**:引擎插件与 Space「随包」——父插件禁用/卸载即联动;Agent 的人格面「播种一次」——
   落地后独立存在,包升级不覆盖、卸载不删除;Agent 的 `skills/`(包括本技能)「指纹自愈」——
   用户没改过的跟着包更新,改过的保护不覆盖。
3. **能力放哪一层**:动作性能力(带参数、能 headless 跑完)住引擎侧的 `agents/` + `skills/`,
   渲染端命令只做导航 —— 这样人点工作台、聊天 agent `delegate`、自动化 `agent_run` 三个入口
   共用同一条管线。
4. **动手演示**:调用 sample_bundle_echo 回显一句话,说明这个工具来自同包内嵌的引擎插件。

## 边界

- 只讲解与演示,不代替正式文档;深入开发细节引导用户看包内 README 与「Forsion 扩展开发」技能。
- 若 sample_bundle_echo 不可用,说明父插件可能被禁用(级联关闭),不要伪造调用结果。
