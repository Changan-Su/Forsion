// Another plugin's view for scripts/plugin-capture.check.cjs: ctx.ui.capture from plugin-capture-sample must refuse it.
ctx.registerView({
  id: 'panel',
  title: { zh: '别人的', en: 'Not yours' },
  mount(el) {
    el.innerHTML = '<div data-pc-other style="margin: 24px; width: 160px; height: 100px; background: #222222"></div>'
  },
})
