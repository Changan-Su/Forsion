# #928 B1: the usual guest programs under the app's PRoot, as the app (run-as), on the installed environment.
# Checks they still work with brk(2) left to the kernel (patch 0005): bash, apt-get / dpkg, git, node with a big heap.
# adb push guest-tools.sh /data/local/tmp/guest-tools.sh
# adb shell "run-as com.forsion.tangu sh /data/local/tmp/guest-tools.sh $(cat /data/local/tmp/b1-libdir)"
LIB=$1
R=/data/data/com.forsion.tangu/files/local-engine
export PROOT_LOADER=$LIB/libproot_loader.so PROOT_TMP_DIR=/data/data/com.forsion.tangu/cache/local-engine/proot-tmp
export HOME=/root LANG=C.UTF-8 TMPDIR=/tmp PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin
export DEBIAN_FRONTEND=noninteractive
mkdir -p $PROOT_TMP_DIR
G="$LIB/libproot.so --kill-on-exit -0 -r $R/rootfs -b /dev/null -b /dev/zero -b /dev/random -b /dev/urandom -b /proc -b /sys -w /root"
step() { echo "== $1"; shift; $G /bin/bash -c "$*" 2>&1 | tail -4; echo "exit=$?"; }
step bash 'echo $BASH_VERSION; for i in $(seq 1 2000); do a[$i]=$(printf %05d $i); done; echo ${#a[@]}'
step apt-update 'apt-get update -qq 2>&1 | tail -2; echo apt-update-exit=$?'
step apt-install 'apt-get install -y -qq --no-install-recommends jq >/tmp/apt.log 2>&1; echo install-exit=$?; jq --version'
step dpkg-verify 'dpkg --verify jq; echo verify-exit=$?'
step apt-remove 'apt-get remove -y -qq jq >/tmp/apt2.log 2>&1; echo remove-exit=$?'
step git 'rm -rf /tmp/r && git init -q /tmp/r && cd /tmp/r && echo hi > a && git add a && git -c user.email=b1@example.invalid -c user.name=b1 commit -qm one && git gc -q && git fsck --strict 2>&1 | tail -1; git log --oneline | wc -l'
step node-heap 'node -e "const a=[];for(let i=0;i<200;i++)a.push(Buffer.alloc(1<<20,i));let s=0;for(const b of a)s+=b[0];console.log(\"heap-ok\",s,process.memoryUsage().rss>>20)"'
step python 'command -v python3 && python3 -c "print(sum(range(10**6)))" || echo no-python3'
