# #928 B1: node / the engine under PRoot, run in a loop on the device, counting glibc "double free" aborts.
# adb push probe.sh /data/local/tmp/b1-dev.sh; put the app's nativeLibraryDir in /data/local/tmp/b1-libdir
# (pm dump com.forsion.tangu | grep codePath= → <codePath>/lib/arm64). See README.md here for the roots it expects.
# sh b1-dev.sh <mode> <workload> <n>
#   mode: direct      shell user, glibc ld.so + node from the mini root /data/local/tmp/b1root, no PRoot
#         proot-shell shell user, PRoot on the mini root
#         runas       run as the app (run-as), the app's launcher on the installed rootfs, the app's flags
#         shell-full  shell user, PRoot on a copy of the installed rootfs (/data/local/tmp/b1full/rootfs)
#         direct-full shell user, no PRoot: the copy's own ld.so runs its node (engine from the copy)
#   workload: min (console.log) | listen | sqlite | engine (dist/standalone/main.js until it reports its port)
#   env: NOSECCOMP=1 → PROOT_NO_SECCOMP=1;  PB=<path> another PRoot binary (shell modes);  PL=<path> its loader
MODE=$1; W=$2; N=$3
D=/data/local/tmp/b1root
F=/data/local/tmp/b1full/rootfs
LIB=$(cat /data/local/tmp/b1-libdir)
PB=${PB:-$LIB/libproot.so}
PL=${PL:-$LIB/libproot_loader.so}
case "$W" in
  min) JS="console.log('ok')" ;;
  listen) JS="require('http').createServer().listen(0,'127.0.0.1',()=>{console.log('ok');process.exit(0)})" ;;
  sqlite) JS="const D=require('/opt/tangu/node_modules/better-sqlite3');new D(':memory:').prepare('select 1').get();console.log('ok')" ;;
esac
export LANG=C.UTF-8 PATH=/usr/local/bin:/usr/bin:/bin:/opt/node/bin:/system/bin
[ "$NOSECCOMP" = 1 ] && export PROOT_NO_SECCOMP=1
export TANGU_LOCAL_TOKEN=b1 TANGU_SANDBOX=none TANGU_PHONE=1 TANGU_BROWSER_EXTENSION=0 NODE_ENV=production
DEVS="-b /dev/null -b /dev/zero -b /dev/random -b /dev/urandom -b /proc -b /sys"
CWD=/
case "$MODE" in
  runas)
    R=/data/data/com.forsion.tangu/files/local-engine
    EH=/data/data/com.forsion.tangu/files/b1home; mkdir -p $EH
    export PROOT_LOADER=$PL PROOT_TMP_DIR=/data/data/com.forsion.tangu/cache/local-engine/proot-tmp HOME=/root TMPDIR=/tmp TANGU_HOME=/root/.tangu
    mkdir -p $PROOT_TMP_DIR
    STAND=""; for f in $(ls $R/proc-standins 2>/dev/null); do STAND="$STAND -b $R/proc-standins/$f:/proc/$f"; done
    RUN="$PB --kill-on-exit -0 -r $R/rootfs $DEVS -b /dev/tty -b /dev/ptmx -b /dev/pts $STAND -b $EH:/root/.tangu -w /opt/tangu /opt/node/bin/node"
    T=/data/data/com.forsion.tangu/cache/b1-out ;;
  proot-shell)
    export PROOT_LOADER=$PL PROOT_TMP_DIR=/data/local/tmp/b1-ptmp HOME=/root TMPDIR=/tmp; mkdir -p $PROOT_TMP_DIR
    RUN="$PB --kill-on-exit -0 -r $D $DEVS -w / /opt/node/bin/node"; T=/data/local/tmp/b1-out ;;
  shell-full)
    EH=/data/local/tmp/b1home; mkdir -p $EH
    export PROOT_LOADER=$PL PROOT_TMP_DIR=/data/local/tmp/b1-ptmp HOME=/root TMPDIR=/tmp TANGU_HOME=/root/.tangu; mkdir -p $PROOT_TMP_DIR
    RUN="$PB --kill-on-exit -0 -r $F $DEVS -b $EH:/root/.tangu -w /opt/tangu /opt/node/bin/node"; T=/data/local/tmp/b1-out ;;
  direct-full)
    EH=/data/local/tmp/b1home-direct; mkdir -p $EH /data/local/tmp/b1tmp
    export HOME=$EH TMPDIR=/data/local/tmp/b1tmp TANGU_HOME=$EH
    RUN="$F/usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1 --library-path $F/usr/lib/aarch64-linux-gnu $F/opt/node/bin/node"
    CWD=$F/opt/tangu; T=/data/local/tmp/b1-out ;;
  *)
    RUN="$D/usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1 --library-path $D/usr/lib/aarch64-linux-gnu $D/opt/node/bin/node"; T=/data/local/tmp/b1-out ;;
esac
cd $CWD
runone() {
  if [ "$W" = engine ]; then
    rm -f $T
    $RUN dist/standalone/main.js --port 0 --host 127.0.0.1 > $T 2>&1 &
    p=$!; k=0; rc=0
    while [ $k -lt 900 ]; do
      if grep -q "http://127.0.0.1:" $T 2>/dev/null; then break; fi
      if ! kill -0 $p 2>/dev/null; then wait $p; rc=$?; break; fi
      sleep 0.1; k=$((k+1))
    done
    if grep -q "http://127.0.0.1:" $T 2>/dev/null; then
      out=ok; kill $p 2>/dev/null; j=0
      while kill -0 $p 2>/dev/null && [ $j -lt 50 ]; do sleep 0.1; j=$((j+1)); done
      kill -9 $p 2>/dev/null; wait $p 2>/dev/null
    else
      out=$(tail -c 400 $T); [ $rc -eq 0 ] && rc=124; kill -9 $p 2>/dev/null; wait $p 2>/dev/null
    fi
  else
    out=$($RUN -e "$JS" 2>&1); rc=$?
  fi
}
i=0; bad=0; df=0
while [ $i -lt $N ]; do
  runone
  if [ $rc -ne 0 ] || [ "$out" != ok ]; then
    bad=$((bad+1))
    case "$out" in *"double free"*) df=$((df+1)) ;; esac
    echo "#$i rc=$rc $(echo "$out" | tr '\n' '|' | cut -c1-300)"
  fi
  i=$((i+1))
done
echo "RESULT mode=$MODE workload=$W nosec=${NOSECCOMP:-0} pb=$(basename $PB) n=$N bad=$bad doublefree=$df"
