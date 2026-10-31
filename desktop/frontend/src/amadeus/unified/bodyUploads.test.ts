// @vitest-environment happy-dom
// 正文上传占位:一批一个锚,全部落定后按原顺序一次插入;失败的留着给重试 / 移除;全移除 = 只撤锚。
import { expect, it, vi } from 'vitest'
import { startBodyUploads } from './bodyUploads'
vi.mock('../../i18n', () => ({ registerMessages: () => {}, translate: (k: string) => k }))

const tick = () => new Promise((r) => setTimeout(r, 0))
const file = (name: string, type = 'application/pdf') => new File([new Uint8Array(4)], name, { type })
globalThis.URL.createObjectURL ??= () => 'blob:x'
globalThis.URL.revokeObjectURL ??= () => {}

function run(files: File[], save: (f: File) => Promise<string>) {
  let dom!: HTMLElement
  const finish = vi.fn()
  startBodyUploads({ files, pin: (w) => { dom = w.dom; return 'A' }, save: (f) => save(f), finish })
  return { dom: () => dom, finish }
}

it('inserts in the original order once every file has landed', async () => {
  const gates: Record<string, () => void> = {}
  const { finish } = run([file('a.pdf'), file('b.png', 'image/png')], (f) => new Promise((res) => { gates[f.name] = () => res(`[[${f.name}]]`) }))
  await tick()
  gates['b.png'](); await tick()
  expect(finish).not.toHaveBeenCalled()
  gates['a.pdf'](); await tick()
  expect(finish).toHaveBeenCalledWith('[[a.pdf]]\n\n[[b.png]]', 'A')
})

it('keeps a failed file for retry; removing it inserts the rest; removing all only drops the anchor', async () => {
  let fails = 1
  const { dom, finish } = run([file('ok.pdf'), file('bad.pdf')], async (f) => {
    if (f.name === 'bad.pdf' && fails-- > 0) throw new Error('offline')
    return `[[${f.name}]]`
  })
  await tick(); await tick()
  const bad = dom().querySelector('.is-failed')!
  expect(bad.textContent).toContain('bodyup.failed')
  expect(finish).not.toHaveBeenCalled()
  ;(bad.querySelector('.amx-upph-act') as HTMLButtonElement).click() // 重试
  await tick(); await tick()
  expect(finish).toHaveBeenCalledWith('[[ok.pdf]]\n\n[[bad.pdf]]', 'A')

  const r2 = run([file('x.pdf')], async () => { throw new Error('nope') })
  await tick(); await tick()
  const [, remove] = r2.dom().querySelectorAll<HTMLButtonElement>('.is-failed .amx-upph-act')
  remove.click()
  expect(r2.finish).toHaveBeenCalledWith(null, 'A')
})
