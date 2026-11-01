// A source/lock inventory, explicitly distinct from an installed-binary SBOM.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || '.');
const prefix = process.argv[3] || 'release';
if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error('Invalid materials filename prefix');
const hash = p => { const digest=crypto.createHash('sha256'), fd=fs.openSync(p,'r'), chunk=Buffer.alloc(1024*1024);
  try { for(let n;(n=fs.readSync(fd,chunk,0,chunk.length,null))>0;) digest.update(chunk.subarray(0,n)); } finally { fs.closeSync(fd); }
  return digest.digest('hex'); };
const materials = [];
const components = [];
for (const project of ['desktop', 'web', 'mobile', 'tangu-agent']) {
  const file = `${project}/package-lock.json`;
  const lock = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  materials.push({ path: file, sha256: hash(path.join(root, file)) });
  for (const [location, item] of Object.entries(lock.packages)) {
    if (!location || item.link) continue;
    components.push({ type: 'library', name: item.name || location.split('node_modules/').pop(),
      version: item.version, 'bom-ref': `${project}/${location}`,
      properties: [{ name: 'forsion:dependency-root', value: project },
        { name: 'forsion:scope', value: item.dev ? 'development' : 'production' },
        { name: 'npm:integrity', value: item.integrity || '' },
        { name: 'npm:resolved', value: item.resolved || '' }] });
  }
}
for (const file of ['desktop/build/runtime-manifest.json', 'desktop/build/python-requirements.txt', 'desktop/build/python-constraints.txt', 'mobile/android/build.gradle', 'mobile/android/app/build.gradle', 'mobile/android/variables.gradle', 'mobile/android/gradle/wrapper/gradle-wrapper.properties']) {
  materials.push({ path: file, sha256: hash(path.join(root, file)) });
}
fs.mkdirSync(out, { recursive: true });
const artifacts = fs.readdirSync(out).filter(n => n !== `${prefix}-materials.json` && n !== `${prefix}-sbom.json`)
  .filter(n => fs.statSync(path.join(out, n)).isFile()).sort()
  .map(name => ({ name, sha256: hash(path.join(out, name)) }));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(out, `${prefix}-materials.json`), JSON.stringify({ schemaVersion: 1,
  commit, collector: { role:prefix, node:process.version, platform:process.platform, arch:process.arch, imageOS:process.env.ImageOS || null, imageVersion:process.env.ImageVersion || null },
  buildTools: Object.fromEntries(['electron','electron-builder','typescript'].map(name => {
    const file=path.join(root,'desktop/node_modules',name,'package.json');
    return [name, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')).version : null];
  })),
  workflow: process.env.GITHUB_WORKFLOW_REF || null, run: process.env.GITHUB_RUN_ID || null,
  materials, runtimes: require('../build/runtime-manifest.json'), artifacts,
  limitations: 'Lock-based source inventory includes build dependencies; platform-specific installed contents and pip wheels may vary. Not a bit-for-bit reproducibility claim.' }, null, 2) + '\n');
fs.writeFileSync(path.join(out, `${prefix}-sbom.json`), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
  metadata: { component: { type: 'application', name: 'Forsion source and build dependency inventory', version: commit } }, components }, null, 2) + '\n');
console.log(`Recorded ${materials.length} source materials and ${artifacts.length} artifact digests`);
