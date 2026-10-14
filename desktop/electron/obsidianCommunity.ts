import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { effectivePluginId } from "../shared/products";

export interface CommunityPlugin {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
}
const catalogUrl =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const safeId = /^[a-z0-9][a-z0-9-]*$/;
const safeRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
let cache: { at: number; rows: CommunityPlugin[] } | undefined;
async function download(
  url: string,
  limit: number,
  fetcher = fetch,
): Promise<Buffer> {
  const r = await fetcher(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": "Forsion-Obsidian-Bridge" },
  });
  if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
  if (!r.body) throw new Error("Empty download");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const b of r.body as unknown as AsyncIterable<Uint8Array>) {
    size += b.length;
    if (size > limit) {
      await r.body.cancel().catch(() => {});
      throw new Error("Download exceeds size limit");
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
export async function communityPlugins(
  fetcher = fetch,
): Promise<CommunityPlugin[]> {
  if (fetcher === fetch && cache && Date.now() - cache.at < 15 * 60_000)
    return cache.rows;
  const rows: unknown = JSON.parse(
    (await download(catalogUrl, 8 * 1024 * 1024, fetcher)).toString("utf8"),
  );
  if (!Array.isArray(rows))
    throw new Error("Invalid official community catalog");
  const clean = rows
    .filter(
      (r) =>
        r &&
        safeId.test(r.id) &&
        safeRepo.test(r.repo) &&
        typeof r.name === "string",
    )
    .map((r) => ({
      id: r.id,
      repo: r.repo,
      name: r.name,
      author: String(r.author || ""),
      description: String(r.description || ""),
    }));
  if (fetcher === fetch) cache = { at: Date.now(), rows: clean };
  return clean;
}
const installs = new Map<string, Promise<unknown>>();
/** Only installs a catalog-listed release inside the caller's existing plugin package. Never overwrites. */
export async function installCommunityPlugin(
  root: string,
  owner: string,
  child: string,
  fetcher = fetch,
): Promise<{ id: string; version: string; installed: boolean }> {
  if (!safeId.test(owner) || !safeId.test(child))
    throw new Error("Invalid plugin identity");
  const key = `${root}\0${owner}\0${child}`;
  const prior = installs.get(key);
  if (prior) return prior as ReturnType<typeof installCommunityPlugin>;
  const work = (async () => {
    const item = (await communityPlugins(fetcher)).find((r) => r.id === child);
    if (!item)
      throw new Error("Plugin is not in the official community catalog");
    let ownerDir = "";
    for (const e of await fs.readdir(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      try {
        const m = JSON.parse(
          await fs.readFile(path.join(root, e.name, "manifest.json"), "utf8"),
        );
        if (effectivePluginId(e.name, m.id) === owner) {
          ownerDir = path.join(root, e.name);
          break;
        }
      } catch {}
    }
    if (!ownerDir) throw new Error("Installed parent plugin not found");
    const parent = path.join(ownerDir, "plugins");
    await fs.mkdir(parent, { recursive: true });
    if ((await fs.lstat(parent)).isSymbolicLink())
      throw new Error("Package symlinks are unsupported");
    const dest = path.join(parent, child);
    try {
      await fs.lstat(dest);
      throw new Error("Plugin is already installed; existing files preserved");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const release = JSON.parse(
      (
        await download(
          `https://api.github.com/repos/${item.repo}/releases/latest`,
          1024 * 1024,
          fetcher,
        )
      ).toString("utf8"),
    );
    if (
      release.draft ||
      release.prerelease ||
      typeof release.tag_name !== "string"
    )
      throw new Error("No stable release found");
    const stage = path.join(parent, `.${child}-${randomUUID()}`);
    await fs.mkdir(stage);
    try {
      const files = [];
      for (const name of ["manifest.json", "main.js", "styles.css"]) {
        const asset = release.assets?.find(
          (a: { name: string }) => a.name === name,
        );
        if (!asset && name === "styles.css") continue;
        const expected = `https://github.com/${item.repo}/releases/download/${encodeURIComponent(release.tag_name)}/${name}`;
        if (!asset || asset.browser_download_url !== expected)
          throw new Error(`Missing or unexpected release asset: ${name}`);
        const bytes = await download(
          expected,
          name === "main.js" ? 8 * 1024 * 1024 : 1024 * 1024,
          fetcher,
        );
        await fs.writeFile(path.join(stage, name), bytes, { flag: "wx" });
        files.push({
          name,
          url: expected,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
      const manifest = JSON.parse(
        await fs.readFile(path.join(stage, "manifest.json"), "utf8"),
      );
      if (
        manifest.id !== child ||
        !manifest.version ||
        ![manifest.version, `v${manifest.version}`].includes(release.tag_name)
      )
        throw new Error("Release identity/version mismatch");
      await fs.writeFile(
        path.join(stage, "source.json"),
        JSON.stringify(
          {
            repo: item.repo,
            version: manifest.version,
            id: child,
            release: release.html_url,
            files,
          },
          null,
          2,
        ),
      );
      // Concurrent calls are serialized above. Existing packages are never updated or removed.
      try {
        await fs.lstat(dest);
        throw new Error("Destination appeared during installation");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await fs.rename(stage, dest);
      return { id: child, version: manifest.version, installed: true };
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  })();
  installs.set(key, work);
  try {
    return await work;
  } finally {
    if (installs.get(key) === work) installs.delete(key);
  }
}
