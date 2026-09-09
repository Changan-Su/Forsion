import { resolveInitialLocale } from '../../desktop/frontend/src/i18n'

/** Local device access uses its existing bearer boundary, separate from Forsion accounts. */
export async function ownerAccess(name: string, base: URL, previous = ''): Promise<string> {
  const zh = resolveInitialLocale() === 'zh'
  const root = document.createElement('main')
  root.style.cssText = 'max-width:420px;margin:12vh auto;padding:28px;font:15px/1.6 system-ui;color:#222'
  const title = document.createElement('h1'); title.textContent = name
  const description = document.createElement('p')
  description.textContent = zh ? '输入此设备的访问密钥，打开本地工作区。' : 'Enter this device’s access key to open its local workspace.'
  const form = document.createElement('form')
  const label = document.createElement('label'); label.textContent = zh ? '设备访问密钥' : 'Device access key'
  const input = document.createElement('input'); input.type = 'password'; input.required = true; input.autocomplete = 'off'; input.value = previous
  input.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:8px 0 18px;padding:10px;border:1px solid #bbb;border-radius:8px'
  label.append(input)
  const button = document.createElement('button'); button.type = 'submit'; button.textContent = zh ? '打开工作区' : 'Open workspace'
  button.style.cssText = 'padding:10px 18px;border:1px solid #aaa;border-radius:8px;cursor:pointer'
  const error = document.createElement('p'); error.setAttribute('role', 'alert')
  form.append(label, button, error); root.append(title, description, form); document.body.append(root)
  try {
    return await new Promise<string>((done) => {
      form.onsubmit = async (event) => {
        event.preventDefault(); button.disabled = true
        try {
          const token = input.value.trim()
          const response = await fetch(new URL('unit/whoami', base), { headers: { Authorization: `Bearer ${token}` } })
          if (response.ok) { done(token); return }
          error.textContent = zh ? '访问密钥无效。' : 'Invalid access key.'
        } catch { error.textContent = zh ? '无法连接此设备。' : 'Cannot reach this device.' }
        finally { button.disabled = false }
      }
      input.focus()
    })
  } finally { root.remove() }
}
