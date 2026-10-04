/* Small, offline figure primitives. Text and data are never interpreted as HTML. */
(() => {
  const svgNS = 'http://www.w3.org/2000/svg'
  const number = (value) => new Intl.NumberFormat(undefined, {
    maximumSignificantDigits: 6, notation: Math.abs(value) >= 1e15 || (value !== 0 && Math.abs(value) < 1e-4) ? 'scientific' : Math.abs(value) >= 1e6 ? 'compact' : 'standard',
  }).format(value)
  const node = (tag, cls, text) => {
    const el = document.createElement(tag)
    if (cls) el.className = cls
    if (text !== undefined) el.textContent = String(text)
    return el
  }
  const mark = (tag, attrs, text) => {
    const el = document.createElementNS(svgNS, tag)
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
    if (text !== undefined) el.textContent = String(text)
    return el
  }
  function heading(root, data) {
    if (data.title) root.append(node('h3', 'fs-figure-title', data.title))
  }
  function caption(root, data) {
    if (data.caption) root.append(node('p', 'fs-caption', data.caption))
  }
  class Figure extends HTMLElement {
    connectedCallback() {
      queueMicrotask(() => {
        if (!this.isConnected) return
        if (!this.figureData) {
          try { this.figureData = JSON.parse(this.querySelector('script[type="application/json"]')?.textContent || '{}') }
          catch { this.figureData = {} }
        }
        this.render()
        this.observer?.disconnect()
        this.observer = new ResizeObserver(() => {
          const width = Math.round(this.clientWidth)
          if (width && width !== this.lastWidth) { this.lastWidth = width; this.render() }
        })
        this.observer.observe(this)
      })
    }
    disconnectedCallback() { this.observer?.disconnect() }
    setData(data) { this.figureData = data; if (this.isConnected) this.render() }
    error() {
      // No guessed labels or fabricated zeroes when the input is invalid.
      const error = node('p', 'fs-caption', this.figureData?.emptyLabel || '—')
      error.setAttribute('role', 'alert')
      this.replaceChildren(error)
    }
  }

  class Chart extends Figure {
    render() {
      const data = this.figureData
      if (!['bar', 'line'].includes(this.getAttribute('type') || 'bar') ||
          !data || !Array.isArray(data.data) || !data.data.length || data.data.length > 100 ||
          data.data.some((item) => typeof item?.label !== 'string' || typeof item.value !== 'number' || !Number.isFinite(item.value))) {
        this.error(); return
      }
      this.replaceChildren()
      const root = node('figure', 'fs-chart-figure')
      heading(root, data)
      this.append(root)
      if (this.getAttribute('type') === 'line') this.line(root, data)
      else this.bars(root, data)
      caption(root, data)
    }
    bars(root, data) {
      // A zero baseline also handles negative-only and mixed-sign comparisons honestly.
      const magnitude = Math.max(1, ...data.data.map((item) => Math.abs(item.value)))
      const low = Math.min(0, ...data.data.map((item) => item.value / magnitude))
      const high = Math.max(0, ...data.data.map((item) => item.value / magnitude))
      const span = high - low || 1
      const zero = -low / span * 100
      const list = node('div', 'fs-chart-bars')
      list.setAttribute('role', 'list')
      list.setAttribute('aria-label', String(data.title || data.unit || data.data.map((item) => item.label).join(', ')))
      const narrow = this.clientWidth < 440
      list.classList.toggle('fs-chart-bars--narrow', narrow)
      for (const [index, item] of data.data.entries()) {
        const row = node('div', 'fs-chart-bar-row')
        row.setAttribute('role', 'listitem')
        const label = node('span', 'fs-chart-bar-label', item.label)
        const value = node('span', 'fs-chart-bar-value', number(item.value) + (data.unit ? ' ' + data.unit : ''))
        const track = node('span', 'fs-chart-track')
        track.setAttribute('aria-hidden', 'true')
        const bar = node('span', 'fs-chart-bar')
        bar.style.left = Math.min(zero, (item.value / magnitude - low) / span * 100) + '%'
        bar.style.width = Math.abs(item.value / magnitude) / span * 100 + '%'
        if (Number.isInteger(data.highlight) && data.highlight !== index) bar.classList.add('fs-chart-bar--context')
        track.style.setProperty('--fs-zero', zero + '%')
        track.append(bar)
        row.append(label, track, value)
        list.append(row)
      }
      root.append(list)
    }
    line(root, data) {
      const width = Math.max(1, this.clientWidth)
      const height = 238
      const values = data.data.map((item) => item.value)
      const maxAbs = Math.max(...values.map(Math.abs))
      const magnitude = maxAbs ? Math.pow(10, Math.floor(Math.log10(maxAbs))) || Number.MIN_VALUE : 1
      const min = Math.min(...values.map((v) => v / magnitude)), max = Math.max(...values.map((v) => v / magnitude))
      const pad = (max - min || Math.abs(max) || 1) * .12
      const limit = Number.MAX_VALUE / magnitude
      const paddedLow = min >= 0 ? Math.max(0, min - pad) : min - pad
      const paddedHigh = max <= 0 ? Math.min(0, max + pad) : max + pad
      const roughStep = (paddedHigh - paddedLow) / 4 || .25
      const power = Math.pow(10, Math.floor(Math.log10(roughStep)))
      const step = ([1, 2, 5, 10].find((factor) => factor >= roughStep / power) || 10) * power
      const low = Math.max(-limit, Math.floor(paddedLow / step) * step)
      const high = Math.min(limit, Math.ceil(paddedHigh / step) * step) || step
      const ticks = []
      for (let tick = Math.ceil(low / step) * step; tick <= high + step * 1e-8; tick += step) {
        ticks.push(Number((tick * magnitude).toPrecision(12)))
        if (ticks.length > 8) break
      }
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (context) context.font = '12px ' + getComputedStyle(this).fontFamily
      const left = Math.min(width * .35, Math.max(48, ...ticks.map((v) => (context?.measureText(number(v)).width || 36) + 14)))
      const right = Math.max(left + 1, width - 8), top = 28, bottom = height - 32
      const x = (i) => left + (right - left) * (values.length === 1 ? .5 : i / (values.length - 1))
      const y = (value) => bottom - (value / magnitude - low) / (high - low) * (bottom - top)
      const field = node('div', 'fs-chart-field')
      const svg = mark('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': String(data.title || data.data.map((item) => item.label).join(', ')) })
      svg.append(mark('title', {}, data.data.map((v) => `${v.label}: ${number(v.value)} ${data.unit || ''}`).join('; ')))
      if (data.unit) svg.append(mark('text', { x: left, y: 14, class: 'fs-chart-unit' }, data.unit))
      for (const tick of ticks) {
        svg.append(mark('path', { d: `M${left} ${y(tick)}H${right}`, class: 'fs-chart-grid' }))
        svg.append(mark('text', { x: left - 10, y: y(tick) + 4, 'text-anchor': 'end', class: 'fs-chart-tick' }, number(tick)))
      }
      const count = Math.min(values.length, width < 440 ? 3 : 5)
      let previousRight = -Infinity
      for (let i = 0; i < count; i++) {
        const index = count === 1 ? 0 : Math.round(i * (values.length - 1) / (count - 1))
        const label = data.data[index].label
        const size = context?.measureText(label).width || label.length * 8
        const px = x(index)
        const labelLeft = i === 0 ? px : i === count - 1 ? px - size : px - size / 2
        if (labelLeft < previousRight + 8 || size > right - left) continue
        previousRight = labelLeft + size
        svg.append(mark('text', { x: px, y: height - 9, 'text-anchor': i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle', class: 'fs-chart-tick' }, label))
      }
      const path = values.map((value, i) => `${i ? 'L' : 'M'}${x(i)} ${y(value)}`).join(' ')
      svg.append(mark('path', { d: path, class: 'fs-chart-line' }))
      for (const [i, value] of values.entries()) svg.append(mark('circle', { cx: x(i), cy: y(value), r: 2.5, class: 'fs-chart-point' }))
      const guide = mark('path', { class: 'fs-chart-guide', visibility: 'hidden' })
      const dot = mark('circle', { r: 4, class: 'fs-chart-point', visibility: 'hidden' })
      svg.append(guide, dot)
      const detail = node('output', 'fs-chart-detail')
      const hit = node('button', 'fs-chart-hit')
      hit.type = 'button'
      hit.setAttribute('aria-label', String(data.inspectLabel || data.title || data.data.map((item) => item.label).join(', ')))
      hit.style.left = left + 'px'; hit.style.top = top + 'px'
      hit.style.width = (right - left) + 'px'; hit.style.height = (bottom - top) + 'px'
      let current = 0
      const show = (position) => {
        current = Math.max(0, Math.min(values.length - 1, position))
        const a = Math.floor(current), b = Math.ceil(current), t = current - a
        const value = (values[a] / magnitude * (1 - t) + values[b] / magnitude * t) * magnitude
        const px = x(current)
        guide.setAttribute('d', `M${px} ${top}V${bottom}`)
        dot.setAttribute('cx', px); dot.setAttribute('cy', y(value))
        guide.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible')
        const label = a === b ? data.data[a].label : `${data.data[a].label} – ${data.data[b].label}`
        detail.textContent = `${label} · ${number(value)} ${data.unit || ''}`
      }
      hit.addEventListener('pointermove', (event) => {
        detail.removeAttribute('aria-live')
        const bounds = hit.getBoundingClientRect()
        show((event.clientX - bounds.left) / bounds.width * (values.length - 1))
      })
      hit.addEventListener('focus', () => show(Math.round(current)))
      hit.addEventListener('click', (event) => {
        if (!event.detail) { show(Math.round(current)); return }
        const bounds = hit.getBoundingClientRect()
        show((event.clientX - bounds.left) / bounds.width * (values.length - 1))
      })
      hit.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        detail.setAttribute('aria-live', 'polite')
        show(event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1 : Math.round(current) + (event.key === 'ArrowRight' ? 1 : -1))
      })
      field.append(svg, hit)
      root.append(field, detail)
    }
  }

  class Flow extends Figure {
    render() {
      const data = this.figureData
      if (!data || !Array.isArray(data.steps) || !data.steps.length || data.steps.length > 12 ||
          data.steps.some((step) => !step || typeof step.label !== 'string' ||
            (step.branches !== undefined && (!Array.isArray(step.branches) || step.branches.length > 8 ||
              step.branches.some((branch) => !branch || typeof branch.label !== 'string'))))) { this.error(); return }
      this.replaceChildren()
      const root = node('figure', 'fs-flow-figure')
      heading(root, data)
      const list = node('ol', 'fs-flow-steps')
      list.classList.toggle('fs-flow-steps--vertical', this.clientWidth < data.steps.length * 145)
      list.style.setProperty('--fs-step-count', data.steps.length)
      for (const [index, step] of data.steps.entries()) {
        const item = node('li', 'fs-flow-step')
        const status = ['done', 'active'].includes(step.status) ? step.status : 'pending'
        item.dataset.status = status
        if (status === 'active') item.setAttribute('aria-current', 'step')
        const marker = node('span', 'fs-flow-marker', String(index + 1).padStart(2, '0'))
        marker.setAttribute('aria-hidden', 'true')
        const content = node('div', 'fs-flow-content')
        content.append(node('span', 'fs-flow-label', step.label))
        if (step.detail) content.append(node('span', 'fs-flow-description', step.detail))
        if (Array.isArray(step.branches) && step.branches.length) {
          const branches = node('ul', 'fs-flow-branches')
          for (const branch of step.branches) {
            const branchNode = node('li', 'fs-flow-branch')
            branchNode.append(node('span', 'fs-flow-label', branch.label || ''))
            if (branch.detail) branchNode.append(node('span', 'fs-flow-description', branch.detail))
            branches.append(branchNode)
          }
          content.append(branches)
        }
        item.append(marker, content); list.append(item)
      }
      root.append(list); caption(root, data); this.append(root)
    }
  }

  function register() {
    if (!customElements.get('fs-chart')) customElements.define('fs-chart', Chart)
    if (!customElements.get('fs-flow')) customElements.define('fs-flow', Flow)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', register)
  else register()
})()
