/**
 * node-pty 的 spawn-helper 从 prebuild 包解出来时**没有执行位**(-rw-r--r--),
 * 于是每次 pty.spawn 都 `Error: posix_spawnp failed`。postinstall 里补 chmod +x。
 * 覆盖两处落点:prebuilds/<platform-arch>/(mac/win 走预编译)与 build/Release/(linux 现编)。
 * ponytail: 没有就跳过,不报错——Windows 用 conpty,本来就没有这个文件。
 */
const { chmodSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..', 'node_modules', 'node-pty');
const targets = [];
const prebuilds = join(root, 'prebuilds');
if (existsSync(prebuilds)) {
  for (const d of readdirSync(prebuilds)) targets.push(join(prebuilds, d, 'spawn-helper'));
}
targets.push(join(root, 'build', 'Release', 'spawn-helper'));

let fixed = 0;
for (const f of targets) {
  if (!existsSync(f)) continue;
  try { chmodSync(f, 0o755); fixed++; } catch (e) { console.warn('[fix-pty-helper] chmod 失败', f, e.message); }
}
if (fixed) console.log(`[fix-pty-helper] spawn-helper +x ×${fixed}`);
