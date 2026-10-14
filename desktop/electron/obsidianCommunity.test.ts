import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { communityPlugins, installCommunityPlugin } from "./obsidianCommunity";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-store-"));
  dirs.push(root);
  const owner = path.join(root, "bridge");
  await fs.mkdir(owner);
  await fs.writeFile(
    path.join(owner, "manifest.json"),
    JSON.stringify({ id: "bridge" }),
  );
  return { root, owner };
}
function network({ wrongId = false, fail = false } = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    let data: unknown;
    if (u.endsWith("community-plugins.json"))
      data = [
        {
          id: "sample",
          name: "Sample",
          repo: "author/sample",
          author: "A",
          description: "D",
        },
        { id: "../escape", repo: "evil/repo", name: "bad" },
      ];
    else if (u.endsWith("releases/latest"))
      data = {
        tag_name: "1.2.3",
        assets: ["manifest.json", "main.js", "styles.css"].map((name) => ({
          name,
          browser_download_url: `https://github.com/author/sample/releases/download/1.2.3/${name}`,
        })),
      };
    else if (u.endsWith("manifest.json"))
      data = { id: wrongId ? "other" : "sample", version: "1.2.3" };
    else if (u.endsWith("main.js"))
      return new Response(fail ? "fail" : "module.exports = original", {
        status: fail ? 503 : 200,
      });
    else return new Response(".original {}");
    return new Response(JSON.stringify(data));
  }) as unknown as typeof fetch;
}
describe("official community package installation", () => {
  it("filters invalid entries; installs exact bytes only under the parent and records hashes", async () => {
    const { root, owner } = await fixture(),
      net = network();
    expect(await communityPlugins(net)).toHaveLength(1);
    await installCommunityPlugin(root, "bridge", "sample", net);
    expect(
      await fs.readFile(path.join(owner, "plugins/sample/main.js"), "utf8"),
    ).toBe("module.exports = original");
    const receipt = JSON.parse(
      await fs.readFile(path.join(owner, "plugins/sample/source.json"), "utf8"),
    );
    expect(receipt.files).toHaveLength(3);
    expect(receipt.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("serializes duplicate installs and never overwrites an existing package", async () => {
    const { root, owner } = await fixture(),
      net = network();
    await Promise.all([
      installCommunityPlugin(root, "bridge", "sample", net),
      installCommunityPlugin(root, "bridge", "sample", net),
    ]);
    await fs.writeFile(
      path.join(owner, "plugins/sample/main.js"),
      "local changes",
    );
    await expect(
      installCommunityPlugin(root, "bridge", "sample", net),
    ).rejects.toThrow("preserved");
    expect(
      await fs.readFile(path.join(owner, "plugins/sample/main.js"), "utf8"),
    ).toBe("local changes");
  });
  it.each([{ wrongId: true }, { fail: true }])(
    "leaves no partial installation after a failed release %o",
    async (options) => {
      const { root, owner } = await fixture();
      await expect(
        installCommunityPlugin(root, "bridge", "sample", network(options)),
      ).rejects.toThrow();
      expect(await fs.readdir(path.join(owner, "plugins"))).toEqual([]);
    },
  );
  it("refuses traversal, unlisted packages and a symlink destination", async () => {
    const { root, owner } = await fixture(),
      net = network();
    await expect(
      installCommunityPlugin(root, "bridge", "../escape", net),
    ).rejects.toThrow("identity");
    await expect(
      installCommunityPlugin(root, "bridge", "unlisted", net),
    ).rejects.toThrow("catalog");
    await fs.symlink(root, path.join(owner, "plugins"));
    await expect(
      installCommunityPlugin(root, "bridge", "sample", net),
    ).rejects.toThrow("symlinks");
  });
});
