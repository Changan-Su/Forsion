// Run immediately before Capacitor sync; the JSON travels inside APK assets/public.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const lock = require('../package-lock.json');
const packages = {};
for (const name of ['@capacitor/android', '@capacitor/core', '@capacitor/cli']) {
  const pinned = lock.packages[`node_modules/${name}`];
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json')));
  if (pinned.version !== '7.6.9' || installed.version !== pinned.version) throw new Error(`Unexpected native dependency ${name}`);
  packages[name] = { version: installed.version, integrity: pinned.integrity, resolved: pinned.resolved };
}
const source = fs.readFileSync(path.join(root, 'node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/WebViewLocalServer.java'));
const evidence = { schemaVersion: 1, packages,
  proxySourceSha256: createHash('sha256').update(source).digest('hex'),
  note: 'Build input evidence. APK/device navigation validation is still required.' };
if (!fs.existsSync(path.join(root, 'dist/index.html'))) throw new Error('Build mobile web assets before native sync');
fs.writeFileSync(path.join(root, 'dist/forsion-native-materials.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log('Pinned Capacitor 7.6.9 native build inputs recorded');
