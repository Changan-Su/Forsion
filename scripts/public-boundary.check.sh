#!/usr/bin/env bash
# 公开仓边界检查 —— 本仓是开源仓,以下东西永远不许进来:
#   1. 私有 worker 插件目录 / 工作树 gitlink / 真实 .env(.env.example 除外)
#   2. 任何 gitlink(160000):嵌套仓、worktree 都不是本仓内容
#   3. workflow 里 checkout 私仓(ssh-key / deploy key)——2026-09-08 起因:build-worker.yml 曾在本公开仓
#      checkout 私仓 Tangu-Worker 并把 worker 镜像推成公开 ghcr 包,私有编译代码可匿名下载。
#      审计与处置记录:外层 docs/research/Genesis-开源边界安全审计_2026-09-08.md
# 本地:bash scripts/public-boundary.check.sh ;CI:.github/workflows/boundary.yml(每次 push / PR)。
set -u
cd "$(git rev-parse --show-toplevel)"
fail=0
bad() { printf '✗ %s\n' "$1"; fail=1; }

tracked=$(git ls-files | grep -E '^tangu-agent/plugins/|^\.claude/worktrees/|(^|/)\.env(\.[^/]*)?$' | grep -vE '(^|/)\.env\.example$' || true)
[ -n "$tracked" ] && bad "forbidden tracked paths:"$'\n'"$tracked"

links=$(git ls-files -s | awk '$1=="160000"{print $4}')
[ -n "$links" ] && bad "gitlinks tracked:"$'\n'"$links"

hits=$(grep -rnE 'Tangu-Worker|ssh-key:|DEPLOY_KEY' .github/workflows || true)
[ -n "$hits" ] && bad "workflow touches a private repo / deploy key:"$'\n'"$hits"

[ "$fail" = 0 ] && echo '✓ public boundary ok'
exit "$fail"
