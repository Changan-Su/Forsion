---
name: Git 工作流
description: 当需要提交代码、创建分支、rebase/merge、处理冲突或回滚改动时使用,提供规范的 Git 操作流程与安全红线。
version: 1.0.0
category: 开发流程
---

# Git 工作流

## 动手前必查(标准三连)

任何 Git 写操作之前,先用 run_bash 执行以下命令了解现场,**禁止凭猜测直接操作**:

```bash
git status                  # 工作区/暂存区状态、当前分支
git diff && git diff --staged   # 未暂存与已暂存的具体改动
git log --oneline -10       # 最近提交,确认基线和分支走向
```

补充检查:`git branch -vv` 看分支与上游的领先/落后;`git stash list` 确认有没有遗留 stash。

## Conventional Commits 规范

格式:`<type>(<scope>): <subject>`,subject 用祈使句、不超过 72 字符、结尾不加句号。

| type | 用途 |
|---|---|
| feat | 新功能 |
| fix | 修 bug |
| refactor | 重构(不改行为) |
| docs | 仅文档 |
| test | 仅测试 |
| chore | 构建/依赖/杂项 |
| perf | 性能优化 |

要点:
- 一个 commit 只做一件事。混杂改动先用 `git add -p` 拆分暂存。
- 提交前 `git diff --staged` 复核暂存内容,确认没混入调试代码、密钥、无关文件。
- 破坏性变更在 type 后加 `!`(如 `feat!:`)并在 body 说明迁移方式。

## 分支策略

- 主分支(main/master)只接受合并,不直接提交。
- 命名:`feat/<描述>`、`fix/<描述>`、`chore/<描述>`,小写中划线。
- 开新分支前先同步基线:`git fetch origin && git switch -c feat/xxx origin/main`。
- 分支生命周期尽量短,合并后删除:`git branch -d feat/xxx`。

## 安全 rebase / merge

rebase 前自检:`git log --oneline @{u}..HEAD` 确认哪些提交是本地独有。**已推送到共享分支的提交不要 rebase**。

```bash
git fetch origin
git rebase origin/main        # 个人分支同步主干,保持线性历史
# 冲突时:逐个解决 → git add <file> → git rebase --continue
# 情况失控:git rebase --abort 完整回到 rebase 前
```

merge 用于把功能分支合回主干。无法快进且想保留合并点时用 `git merge --no-ff feat/xxx`。

## 冲突处理流程

1. `git status` 列出冲突文件(both modified)。
2. 用 read_file 逐个查看冲突块,理解 `<<<<<<<`(ours)与 `>>>>>>>`(theirs)各自意图——**不要机械保留某一侧**,要合并两侧语义。
3. 用 edit_file 删除冲突标记并写出正确合并结果。
4. `git diff --check` 确认无残留标记,然后 `git add` → continue。
5. 解决后运行测试/构建验证,再完成 merge/rebase。

## 回滚手法(按破坏性从小到大)

| 场景 | 命令 |
|---|---|
| 撤销单文件未暂存改动 | `git restore <file>` |
| 取消暂存 | `git restore --staged <file>` |
| 修改最近一次提交(未推送) | `git commit --amend` |
| 撤销已推送的提交 | `git revert <sha>`(生成反向提交,最安全) |
| 本地回退到某提交 | `git reset --soft <sha>`(保留改动)/ `--hard`(丢弃改动,先确认!) |
| 找回"丢失"的提交 | `git reflog` 定位 sha 后 `git switch -c rescue <sha>` |

`reset --hard` 前必须先 `git stash` 或确认 `git status` 干净,避免丢未提交工作。

## 红线(绝对禁止)

1. **绝不 `git push --force` 到 main/master/dev 等共享分支**。个人分支需要覆盖远端时,只用 `git push --force-with-lease`。
2. 绝不对已合入主干的历史做 rebase/amend。
3. 绝不提交密钥、token、`.env`。提交前 grep 一遍:`git diff --staged | grep -iE 'api[_-]?key|secret|password|token'`,有命中先排查。
4. 绝不用 `git add .` 盲提交,先看 status 确认每个文件都该进。
5. 没有用户明确要求时,不执行 push;不跳过 hooks(`--no-verify`)。
6. `git clean -fd` 执行前必须先跑 `git clean -nd` 预览。

## 标准提交流程(汇总)

```bash
git status && git diff                 # 1. 了解现场
git add -p                             # 2. 选择性暂存
git diff --staged                      # 3. 复核
git commit -m "feat(scope): xxx"       # 4. 规范提交
git log --oneline -3                   # 5. 确认结果
```
