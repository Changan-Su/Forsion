# 笔记阅读渲染器

`ctx.registerNoteRenderer` 替换 Amadeus 的阅读表面，编辑器与写盘仍由宿主持有。支持桌面、Web 和手机；旧宿主请用可选链探测。阅读模式与锁定页面独立，入口在笔记 View 的头行；手机从更多菜单进入，再从顶部返回编辑。

```js
ctx.registerNoteRenderer?.({
  id: 'reading',
  apiVersion: 1,
  mount(element, snapshot, host) {
    // snapshot: { path, markdown, html, revision }，不可变的当前正文快照。
    // html 是宿主从已渲染正文生成的静态内容，保留公式与排版，去掉编辑控件。
    element.className = 'milkdown'
    element.innerHTML = snapshot.html
    const click = (event) => {
      const link = event.target.closest('[data-wiki]')
      if (link && !host.signal.aborted) {
        event.preventDefault()
        host.openLink(link.dataset.wiki, 'wiki')
      }
    }
    element.addEventListener('click', click)
    return () => element.removeEventListener('click', click)
  },
})
```

`mount` 可以返回清理函数，或在异步完成后返回清理函数。宿主先在暂存容器挂载，成功后才替换当前表面；失败继续显示上一版本。异步取消通过 `host.signal` 通知，过期结果不能覆盖新文档。每次正文快照变化重新挂载，旧实例随后清理。样式和资源应归属于传入容器，并在清理函数中释放；不要改编辑器 DOM、写文件或注册全局编辑事件。

最近登记的活动渲染器生效。同一插件同一 `id` 再登记即替换；旧句柄不能撤掉新一代注册。调用返回句柄的 `dispose()` 或停用插件撤销注册，回落到随宿主提供的官方模块。插件代码热重载时保留上一表面直到新模块就绪；初始化失败可重试更新，也可以停用该插件回落官方模块。

宿主切入阅读前等待输入法提交、抓取尚未进入防抖缓存的最新输入，并完成严格保存。保存失败留在编辑状态。原编辑器保持挂载，因此撤销历史、选区与文档会话不会随渲染器更新重建。阅读状态按 View 记忆，不写入笔记 frontmatter。

保留 `data-reading-anchor` 属性可让宿主按正文锚点恢复滚动位置；自定义布局无法对应锚点时回落到原滚动距离。保持链接可访问、正文可选择和语义标题，宿主的查找与目录才能继续工作。`host.openLink(href, 'wiki' | 'url')` 走宿主链接路径。

第一阶段只开放只读显示。编辑 schema、序列化器和文件格式仍随宿主发布，不支持从此接口热换。API 版本不兼容会拒绝注册。

默认模块委托双链、笔记链接、外链与附件给宿主；支持目录定位与图片双击预览。任务框保留完成状态但不可勾选。它是静态阅读快照，嵌入应用的编辑控件及 iframe 不进入阅读表面；交互式插件内容需要渲染器自行提供只读呈现。
