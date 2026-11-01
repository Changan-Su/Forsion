const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
module.exports = function performanceSource(root = path.resolve(__dirname, '../..')) {
  const git = args => execFileSync('git', args, { cwd:root, encoding:'utf8', maxBuffer:64*1024*1024 });
  // Include untracked source/tests: HEAD alone misattributes candidate-worktree measurements.
  const files = [...new Set(git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0'))]
    .filter(file => /\.(?:[cm]?[jt]sx?|json|css|ya?ml|java|kt|gradle)$/.test(file)).sort();
  const digest = crypto.createHash('sha256');
  for (const file of files) { digest.update(file+'\0'); const p=path.join(root,file); digest.update(fs.existsSync(p)?fs.readFileSync(p):'<deleted>'); digest.update('\0'); }
  return { baseCommit:git(['rev-parse','HEAD']).trim(), dirty:Boolean(git(['status','--porcelain']).trim()),
    sourceSha256:digest.digest('hex'), sourceFileCount:files.length,
    scope:'Tracked and untracked code, package/lock manifests, styles, workflows and native build configuration; candidate working tree.' };
};

// Reports must never become untracked source inputs of the next measurement.
module.exports.assertOutput = function assertOutput(output, root = path.resolve(__dirname, '../..')) {
  const relative = path.relative(root, path.resolve(output));
  if (relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) return;
  const result = require('node:child_process').spawnSync('git',['check-ignore','--quiet',relative],{cwd:root,windowsHide:true});
  if (result.status !== 0) throw new Error('Performance reports must be outside the repository or in an ignored output directory');
};
