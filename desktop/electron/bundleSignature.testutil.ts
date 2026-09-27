/** 测试用签名器:与 Forsion-Extend 仓 scripts/sign.mjs 同一口径(格式见 bundleSignature.ts)。 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { canonicalFiles, SIGNATURE_FILE } from './bundleSignature'

export function testKeyPair(): { privateKey: KeyObject; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string }
}

/** 给 dir 下除 SIGNATURE 外的所有普通文件(递归)签名并写 SIGNATURE;only 给了就只签这些。返回 files 表。 */
export async function signDir(dir: string, privateKey: KeyObject, only?: readonly string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(child)
      else if (e.isFile() && child !== SIGNATURE_FILE && (!only || only.includes(child))) {
        files[child] = createHash('sha256').update(await fs.readFile(path.join(dir, child))).digest('hex')
      }
    }
  }
  await walk('')
  const sig = sign(null, Buffer.from(canonicalFiles(files), 'utf8'), privateKey).toString('base64')
  await fs.writeFile(path.join(dir, SIGNATURE_FILE), JSON.stringify({ alg: 'ed25519', files, sig }))
  return files
}
