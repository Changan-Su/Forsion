#!/bin/bash
# 「只在机器忙的时候才红」的 vitest 用例:占满若干个核,循环跑,每次的完整输出留在日志目录里。
# 用法(在 desktop/ 下):
#   bash scripts/vitest-under-load.sh <次数> <占核进程数> <日志目录> <vitest 参数…>
#   例:bash scripts/vitest-under-load.sh 20 20 /tmp/vault-loop electron/unitLocalVault.test.ts
# 想看红的那一次里到底多了什么,先在用例里临时加一行 console.log('PROBE ' + JSON.stringify(…)),每次的 PROBE 行会跟在结果后面打出来。
# 占核进程只按这里记下的 PID 结束;中途 Ctrl-C 也会收走。
N=$1; BURNERS=$2; LOG=$3; shift 3
[ -n "$LOG" ] && [ $# -gt 0 ] || { sed -n '2,6p' "$0"; exit 2; }
mkdir -p "$LOG"
pids=()
for _ in $(seq "$BURNERS"); do yes >/dev/null & pids+=($!); done
trap '[ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2>/dev/null' EXIT
pass=0; fail=0
for i in $(seq "$N"); do
  npx vitest run "$@" >"$LOG/run-$i.log" 2>&1; rc=$?
  if [ $rc -eq 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); fi
  echo "run $i rc=$rc load=$(uptime | sed 's/.*averages*: //') $(grep -o '^PROBE .*' "$LOG/run-$i.log" | cut -c1-600)"
  [ $rc -ne 0 ] && grep -E 'AssertionError|Test timed out| FAIL ' "$LOG/run-$i.log" | head -5
done
echo "TOTAL pass=$pass fail=$fail of $N (burners=$BURNERS, logs in $LOG)"
[ "$fail" -eq 0 ]
