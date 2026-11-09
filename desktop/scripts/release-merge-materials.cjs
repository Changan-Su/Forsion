// Fold the per-build evidence (build-<platform>-materials.json / -sbom.json, one pair per build job)
// into one build-materials.json for the GitHub Release.
//   - Every platform's materials object is kept verbatim under platforms[<name>]; nothing is dropped.
//   - The SBOM is a lock-file inventory, so builds of one commit produce identical bytes. Identical → none
//     are copied (release-sbom.json carries it; its sha256 is recorded here). Any difference → all copied.
//   - Builds of different commits never mix: that fails closed.
// Usage: node release-merge-materials.cjs <inDir> <outDir>
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MATERIALS = /^build-(.+)-materials\.json$/;
const SBOM = /^build-(.+)-sbom\.json$/;
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function mergeBuildMaterials(inDir, outDir) {
  const names = fs.readdirSync(inDir).sort();
  const platforms = {};
  for (const name of names) {
    const m = MATERIALS.exec(name);
    if (m) platforms[m[1]] = JSON.parse(fs.readFileSync(path.join(inDir, name), 'utf8'));
  }
  const keys = Object.keys(platforms);
  if (!keys.length) throw new Error(`No build-*-materials.json in ${inDir}`);
  const commits = [...new Set(keys.map(k => platforms[k].commit))];
  if (commits.length !== 1) throw new Error(`Builds come from different commits: ${keys.map(k => `${k}=${platforms[k].commit}`).join(', ')}`);

  const sboms = names.filter(n => SBOM.test(n)).map(n => ({ name: n, sha256: sha256(path.join(inDir, n)) }));
  const missing = keys.filter(k => !sboms.some(s => s.name === `build-${k}-sbom.json`));
  if (missing.length) throw new Error(`Missing SBOM for: ${missing.join(', ')}`);
  const identical = new Set(sboms.map(s => s.sha256)).size === 1;

  fs.mkdirSync(outDir, { recursive: true });
  const copied = [];
  if (!identical) for (const s of sboms) { fs.copyFileSync(path.join(inDir, s.name), path.join(outDir, s.name)); copied.push(s.name); }
  const merged = {
    schemaVersion: 1,
    commit: commits[0],
    sbom: identical
      ? { identical: true, sha256: sboms[0].sha256, carriedBy: 'release-sbom.json', builds: sboms.map(s => s.name) }
      : { identical: false, files: sboms },
    platforms,
  };
  fs.writeFileSync(path.join(outDir, 'build-materials.json'), JSON.stringify(merged, null, 2) + '\n');
  return { platforms: keys, identical, copied, sbomSha256: identical ? sboms[0].sha256 : null };
}

module.exports = { mergeBuildMaterials };

if (require.main === module) {
  const [inDir, outDir] = process.argv.slice(2);
  if (!inDir || !outDir) { console.error('Usage: node release-merge-materials.cjs <inDir> <outDir>'); process.exit(2); }
  const r = mergeBuildMaterials(path.resolve(inDir), path.resolve(outDir));
  console.log(`Merged ${r.platforms.length} build materials (${r.platforms.join(', ')}) into build-materials.json`);
  console.log(r.identical
    ? `All ${r.platforms.length} build SBOMs identical (sha256 ${r.sbomSha256}); release-sbom.json carries it`
    : `Build SBOMs differ; kept per-platform: ${r.copied.join(', ')}`);
}
