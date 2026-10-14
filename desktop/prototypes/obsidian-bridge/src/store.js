export function mountStore({
  parent,
  toolbar,
  host,
  tr,
  error,
  entries,
  scan,
  state,
  persist,
}) {
  const section = parent.createEl("section", {
    cls: "community-store",
    attr: { hidden: "" },
  });
  const toggle = toolbar.createEl("button", {
    text: tr("社区插件商店", "Community plugins"),
    attr: { "data-action": "community-store" },
  });
  section.createEl("h2", {
    text: tr("Obsidian 社区插件", "Obsidian community plugins"),
  });
  section.createEl("p", {
    cls: "muted",
    text: tr(
      "搜索 Obsidian 官方目录。原包安装在 Bridge 内，首次安装后保持禁用，可在左侧启用。",
      "Search the official Obsidian catalog. Packages install inside Bridge and remain disabled until you enable them on the left.",
    ),
  });
  const search = section.createEl("input", {
    type: "search",
    attr: {
      placeholder: tr(
        "搜索名称、作者或说明",
        "Search name, author or description",
      ),
      "aria-label": tr("搜索社区插件", "Search community plugins"),
    },
  });
  const status = section.createEl("p", {
      cls: "muted",
      attr: { role: "status" },
    }),
    list = section.createDiv({ cls: "community-results" });
  let rows = [],
    dead = false,
    loading = false,
    busy = new Set(),
    lastError = "";
  const draw = () => {
    list.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const found = rows.filter((r) =>
      `${r.name} ${r.id} ${r.author} ${r.description}`
        .toLocaleLowerCase()
        .includes(query),
    );
    status.textContent =
      lastError ||
      tr(
        `${found.length} 个结果，显示前 60 项`,
        `${found.length} results; showing the first 60`,
      );
    for (const r of found.slice(0, 60)) {
      const row = list.createEl("article", {
        attr: { "data-community-id": r.id },
      });
      const info = row.createDiv();
      info.createEl("strong", { text: r.name });
      info.createEl("p", { text: r.description });
      info.createEl("small", { text: r.author, cls: "muted" });
      const link = info.createEl("a", {
        text: tr("源码与说明", "Source and details"),
        href: `https://github.com/${r.repo}`,
        attr: { target: "_blank", rel: "noopener noreferrer" },
      });
      const installed = entries.has(r.id);
      const btn = row.createEl("button", {
        text: busy.has(r.id)
          ? tr("安装中…", "Installing…")
          : installed
            ? tr("已安装", "Installed")
            : tr("安装", "Install"),
      });
      btn.disabled = installed || busy.has(r.id);
      btn.onclick = async () => {
        busy.add(r.id);
        lastError = "";
        draw();
        try {
          state.disabled = [...new Set([...state.disabled, r.id])];
          await persist();
          if (dead) return;
          await host.packageFiles.installCommunityPlugin(r.id);
          if (dead) return;
          await scan();
          if (!dead) draw();
        } catch (e) {
          if (!dead) {
            error(e);
            lastError = String(e.message || e);
          }
        } finally {
          busy.delete(r.id);
          if (!dead) draw();
        }
      };
    }
  };
  search.oninput = draw;
  toggle.onclick = async () => {
    section.hidden = !section.hidden;
    if (section.hidden || rows.length || loading) return;
    loading = true;
    status.textContent = tr("正在读取官方目录…", "Loading official catalog…");
    try {
      rows = await host.packageFiles.communityPlugins();
      if (!dead) draw();
    } catch (e) {
      if (!dead)
        status.textContent =
          tr(
            "目录加载失败，可关闭后重试：",
            "Catalog could not load. Close and retry: ",
          ) + e.message;
    } finally {
      loading = false;
    }
  };
  return () => {
    dead = true;
    section.remove();
    toggle.remove();
  };
}
