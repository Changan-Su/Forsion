// 弹窗:看连接状态、粘贴一次连接码(tangu:<端口>:<令牌>)。文案全部走 _locales(en / zh_CN)。
const t = (k) => chrome.i18n.getMessage(k) || k;
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
const $ = (id) => document.getElementById(id);
$('code').placeholder = t('codePlaceholder');

const STATUS = {
  connected: ['ok', 'statusConnected'],
  connecting: ['wait', 'statusConnecting'],
  offline: ['bad', 'statusOffline'],
  'bad-code': ['bad', 'statusBadCode'],
  'not-paired': ['', 'statusNotPaired'],
  idle: ['wait', 'statusConnecting'],
};

async function render() {
  const { status = 'idle', engine = '' } = await chrome.storage.session.get(['status', 'engine']);
  const [cls, key] = STATUS[status] || STATUS.idle;
  $('dot').className = `dot ${cls}`;
  $('status').textContent = status === 'connected' && engine ? `${t(key)} · ${engine}` : t(key);
  const { pairing } = await chrome.storage.local.get('pairing');
  $('forget').disabled = !pairing;
}

/** 连接码:tangu:<port>:<token>(token 至少 16 位十六进制)。 */
function parseCode(raw) {
  const m = String(raw || '').trim().match(/^tangu:(\d{2,5}):([0-9a-f]{16,})$/i);
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port < 65536 ? { port, token: m[2].toLowerCase() } : null;
}

$('save').addEventListener('click', async () => {
  const pairing = parseCode($('code').value);
  $('err').textContent = pairing ? '' : t('codeInvalid');
  if (!pairing) return;
  await chrome.storage.local.set({ pairing });
  $('code').value = '';
  setTimeout(render, 600);
});
$('forget').addEventListener('click', async () => { await chrome.storage.local.remove('pairing'); setTimeout(render, 300); });
chrome.storage.onChanged.addListener((_c, area) => { if (area === 'session' || area === 'local') void render(); });
void render();
