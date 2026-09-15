现在导出失败时直接退出、没有任何提示。照这段改：
```js
try { await exportAll() } catch (e) { console.error('导出失败', e) }
```

````forsion-task
title: 给导出脚本补上错误处理
todo: todo-fixture-2
---
给导出脚本补上错误处理

现在导出失败时直接退出、没有任何提示。照这段改：
```js
try { await exportAll() } catch (e) { console.error('导出失败', e) }
````