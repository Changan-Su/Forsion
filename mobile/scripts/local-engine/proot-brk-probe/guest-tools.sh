# #928 B1: the usual guest programs under the app's PRoot, as the app (run-as), on the installed environment.
# Checks they still work with brk(2) left to the kernel (patch 0005): bash, apt-get / dpkg, git, node with a big heap.
# run-as has no network, so apt only gets as far as name resolution; guest-tools-app.cjs runs the same in the app.
# Emulator test environment only: installs and removes jq (skipped when already installed), works under fresh /tmp dirs.
# adb push guest-tools.sh /data/local/tmp/guest-tools.sh
# adb shell 'run-as com.forsion.tangu sh /data/local/tmp/guest-tools.sh $(cat /data/local/tmp/b1-libdir)'
LIB=$1
[ -x "$LIB/libproot.so" ] || { echo "no launcher at '$LIB/libproot.so'"; exit 2; }
R=/data/data/com.forsion.tangu/files/local-engine
export PROOT_LOADER=$LIB/libproot_loader.so PROOT_TMP_DIR=/data/data/com.forsion.tangu/cache/local-engine/proot-tmp
export HOME=/root LANG=C.UTF-8 TMPDIR=/tmp PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin
export DEBIAN_FRONTEND=noninteractive
mkdir -p $PROOT_TMP_DIR
O=/data/data/com.forsion.tangu/cache/b1-guest.out
G="$LIB/libproot.so --kill-on-exit -0 -r $R/rootfs -b /dev/null -b /dev/zero -b /dev/random -b /dev/urandom -b /proc -b /sys -w /root"
fail=0
step() { n=$1; shift; echo "== $n"; $G /bin/bash -c "$*" > $O 2>&1; rc=$?; tail -4 $O; echo "exit=$rc"; [ $rc -eq 0 ] || fail=$((fail+1)); }
step bash 'for i in $(seq 1 2000); do a[$i]=$(printf %05d $i); done; [ ${#a[@]} = 2000 ] && echo $BASH_VERSION'
step apt-update 'apt-get update -qq'
if $G /bin/bash -c 'dpkg -s jq' >/dev/null 2>&1; then echo "== apt-install: skipped, jq already installed"; else
  step apt-install 'apt-get install -y -qq --no-install-recommends jq && jq --version'
  step apt-remove 'apt-get remove -y -qq jq'
fi
step git 'set -e; W=$(mktemp -d /tmp/b1.XXXXXX); git init -q $W; cd $W; echo hi > a; git add a; git -c user.email=b1@example.invalid -c user.name=b1 commit -qm one; git gc -q; git fsck --strict; [ "$(git log --oneline | wc -l)" = 1 ]; rm -rf $W'
step node-heap 'node -e "const a=[];for(let i=0;i<200;i++)a.push(Buffer.alloc(1<<20,i));let s=0;for(const b of a)s+=b[0];if(s!==19900)process.exit(1);console.log(\"heap-ok\",process.memoryUsage().rss>>20)"'
echo "failed steps: $fail"
[ $fail -eq 0 ]
