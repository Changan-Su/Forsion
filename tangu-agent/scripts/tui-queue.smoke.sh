#!/usr/bin/env bash
# TUI 运行中排队的真终端冒烟:真 TUI(dist)× 真模型(Codex 订阅直连)× 隔离 TANGU_HOME,用 BSD `script` 给 pty、定时送键。
#   run 在跑时排 /compact + 一句消息 → 断言「⏳ 排队 2 条」出现 → 本轮收尾后先压缩 → 再答排队的那句(dc-ba),且三者按此顺序。
# 用法:npm run build && npm run smoke:tuiqueue    (凭证同 live 台架:~/.forsion-dev/provider-auth.json,可用 TANGU_LIVE_AUTH 覆盖)
# 坑:① 送键前要等 TUI 挂载完(负载高时 Ink 开 raw 模式很慢,早到的键被终端回显吞掉)——BOOT_WAIT 可调;
#     ② 别用 expect 驱动:同样的 \r 在 expect 的 pty 里到不了 Ink 的 return(09-28 实测),script 可以;
#     ③ 数到 300 是为了让这一轮够长:模型快时数到 80 几秒就完,排队时机落空;负载 60+ 时整条输入链路会慢到几十秒(新旧版都一样,已打时间戳对比)。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AUTH="${TANGU_LIVE_AUTH:-$HOME/.forsion-dev/provider-auth.json}"
MODEL="${TUI_SMOKE_MODEL:-codex/gpt-5.6-luna}"
BOOT_WAIT="${BOOT_WAIT:-25}"
[ -f "$ROOT/dist/tui/main.js" ] || { echo "缺 dist/tui/main.js —— 先 npm run build"; exit 2; }
[ -f "$AUTH" ] || { echo "凭证不存在:$AUTH"; exit 2; }
OUT="$(mktemp -d "${TMPDIR:-/tmp}/tangu-tui-queue-XXXXXX")"
mkdir -p "$OUT/forsion/tangu" "$OUT/ws"
ln -s "$AUTH" "$OUT/forsion/provider-auth.json" # basename 必须是 tangu:forsionSharedDir() 到父目录找凭证

( sleep "$BOOT_WAIT"
  printf '从1数到300，每个数字单独一行，不要调用任何工具'; sleep 1; printf '\r'; sleep 4
  printf '/compact 只保留数数任务'; sleep 1; printf '\r'; sleep 1
  printf '把 ab-cd 反过来写，只回复结果'; sleep 1; printf '\r'
  sleep "${ANSWER_WAIT:-150}"; printf '\003'; sleep 1; printf '\003'; sleep 2
) | TANGU_HOME="$OUT/forsion/tangu" script -q /dev/null node "$ROOT/dist/tui/main.js" \
      --cloud-url http://127.0.0.1:9 --token smoke --model "$MODEL" --cwd "$OUT/ws" > "$OUT/screen.log" 2>&1

TEXT="$(sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' "$OUT/screen.log" | tr -d '\r')"
line() { echo "$TEXT" | grep -anE "$1" | head -1 | cut -d: -f1; }
Q="$(line '排队 2 条')"; E="$(line '^300$')"; C="$(line '已压缩|无需压缩')"; A="$(line 'dc-ba')"
echo "排队 2 条 ${Q:-无} · 本轮收尾 ${E:-无} · 压缩 ${C:-无} · 排队消息的回答 ${A:-无}  (屏幕日志 $OUT/screen.log)"
if [ -n "$Q" ] && [ -n "$E" ] && [ -n "$C" ] && [ -n "$A" ] && [ "$Q" -lt "$E" ] && [ "$E" -lt "$C" ] && [ "$C" -lt "$A" ]; then echo PASS; exit 0; fi
echo FAIL; exit 1
