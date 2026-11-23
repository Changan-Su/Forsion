// Sign an optional Health bundle for local installation. Key material stays outside the repository.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
const root = fileURLToPath(new URL('./forsion-health/', import.meta.url));
const key = createPrivateKey(await readFile(process.argv[2]));
const expected = await readFile(new URL('./health-public.pem', import.meta.url), 'utf8');
if (createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== expected)
  throw Error('Wrong Health signing key');
const files = {};
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(root, path).split(sep).join('/');
    if (rel === 'SIGNATURE') continue;
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile())
      files[rel] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    else throw Error('Unexpected file: ' + rel);
  }
}
await walk(root);
const canonical = Object.fromEntries(
  Object.keys(files)
    .sort()
    .map((k) => [k, files[k]]),
);
const sig = sign(null, Buffer.from(JSON.stringify(canonical)), key).toString('base64');
await writeFile(
  join(root, 'SIGNATURE'),
  JSON.stringify({ alg: 'ed25519', files: canonical, sig }, null, 2) + '\n',
);
