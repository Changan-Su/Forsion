const t = ctx.i18n.define({
  zh: {
    title: '健康',
    pairDevice: '此设备需要小米授权才能查看或管理这份健康数据。',
    changed: '绑定已更新，请刷新后重试。',
    source: '小米运动健康',
    unavailable: '此宿主暂未提供 Forsion 账号连接。',
    signIn: '登录 Forsion',
    signInHint: '登录后即可连接小米运动健康。',
    connect: '绑定小米运动健康',
    connectHint: '授权后可查看每日步数、睡眠和运动记录。',
    offline: '服务器尚未配置小米运动健康。',
    loading: '正在读取…',
    open: '打开小米授权页',
    code: '浏览器确认码',
    confirm: '完成绑定',
    cancel: '取消',
    proofHint: '在小米授权后，将浏览器显示的确认码输入下方。',
    week: '七天记录',
    end: '截至日期',
    date: '日期',
    steps: '步数',
    sleep: '睡眠',
    workouts: '运动次数',
    duration: '运动时长',
    minutes: '分钟',
    hour: '小时',
    refresh: '刷新',
    agent: '允许 Agent 读取健康摘要',
    disconnect: '解除绑定',
    disconnectQ: '解除当前账号与小米运动健康的绑定？',
    disconnected: '已解除绑定。也可以在小米运动健康的「三方数据管理」中撤销授权。',
    empty: '这七天还没有可显示的记录。',
    missing: '— 表示没有可用数据。',
    error: '健康服务暂时无法响应，请重试。',
    invalid: '确认码无效或已过期，请重新绑定。',
    linked: '此小米账号已绑定其他 Forsion 账号。',
    reconnect: '小米授权已失效，请重新授权。',
    retry: '重试',
    relink: '重新授权',
    scope: '未获得健康数据读取权限，请重新授权。',
    noDate: '请选择有效的截止日期。',
    enabled: '已连接',
  },
  en: {
    title: 'Health',
    pairDevice: 'Authorize Mi Fitness on this device to view or manage this connection.',
    changed: 'This connection has changed. Refresh and try again.',
    source: 'Mi Fitness',
    unavailable: 'Account connections are unavailable on this host.',
    signIn: 'Sign in to Forsion',
    signInHint: 'Sign in to connect Mi Fitness.',
    connect: 'Connect Mi Fitness',
    connectHint: 'Authorize daily steps, sleep and workout summaries.',
    offline: 'Mi Fitness is awaiting server configuration.',
    loading: 'Loading…',
    open: 'Open Xiaomi authorization',
    code: 'Browser confirmation code',
    confirm: 'Finish linking',
    cancel: 'Cancel',
    proofHint: 'After authorizing Xiaomi, enter the confirmation code shown in your browser.',
    week: 'Seven-day history',
    end: 'Ending on',
    date: 'Date',
    steps: 'Steps',
    sleep: 'Sleep',
    workouts: 'Workouts',
    duration: 'Active time',
    minutes: 'min',
    hour: 'h',
    refresh: 'Refresh',
    agent: 'Allow agents to read health summaries',
    disconnect: 'Disconnect',
    disconnectQ: 'Disconnect Mi Fitness from this account?',
    disconnected: 'Disconnected. You can also revoke access in Mi Fitness under Third-party data.',
    empty: 'There are no available records for these dates.',
    missing: 'A dash means data is unavailable.',
    error: 'Health data could not be loaded. Please retry.',
    invalid: 'Invalid or expired confirmation code. Start linking again.',
    linked: 'This Xiaomi account is linked to another Forsion account.',
    reconnect: 'Your Xiaomi authorization has expired. Authorize again.',
    retry: 'Retry',
    relink: 'Authorize again',
    scope: 'No health permissions were granted. Authorize again.',
    noDate: 'Choose a valid end date.',
    enabled: 'Connected',
  },
});
ctx.addStyle(`
.fh-content{max-width:820px;margin:0 auto;padding:clamp(16px,4vw,44px);display:grid;gap:18px;color:var(--text);font-family:var(--font-ui)}
.fh-content h2,.fh-content p{margin:0}.fh-content p{color:var(--text-muted)}.fh-group{display:grid;gap:12px}
.fh-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.fh-row button,.fh-row a{width:fit-content}.fh-content a{color:var(--accent-ink)}
.fh-table{overflow-x:auto}.fh-table table{width:100%;font-variant-numeric:tabular-nums}.fh-table td,.fh-table th{text-align:end;white-space:nowrap}.fh-table td:first-child,.fh-table th:first-child{text-align:start}
.fh-settings{border-top:1px solid var(--border);padding-top:16px}.fh-content input[type=checkbox]{width:auto}.fh-error{color:var(--text)}
`);
ctx.registerView({
  id: 'overview',
  title: () => t('title'),
  icon: 'activity',
  mount(el) {
    const body = document.createElement('section');
    body.className = 'fh-content';
    el.append(body);
    const header = ctx.ui.setViewHead?.(el, { title: t('title') });
    const account = ctx.account;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = () =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    let date = today(),
      epoch = 0,
      live = true,
      url = '',
      proof = '',
      status = null,
      spaceKey = '',
      data = null,
      note = '',
      error = '',
      busy = false,
      signed = false;
    function node(parent, tag, label, cls) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (label !== undefined) n.textContent = label;
      parent.append(n);
      return n;
    }
    function action(parent, key, fn) {
      const b = node(parent, 'button', t(key));
      b.type = 'button';
      b.disabled = busy;
      b.onclick = () => run(fn);
      return b;
    }
    async function api(path, method = 'GET', payload) {
      const init = { method };
      if (payload !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(payload);
      }
      const res = await account.request('/wellness/' + path, init);
      const json = await res.json();
      if (!res.ok) throw new Error(json.code || json.error || 'unavailable');
      return json;
    }
    async function run(task) {
      const n = ++epoch;
      busy = true;
      error = '';
      note = '';
      draw();
      const current = () => live && epoch === n;
      try {
        await task(current);
      } catch (e) {
        if (current())
          error =
            {
              invalid_code: 'invalid',
              link_expired: 'invalid',
              account_already_linked: 'linked',
              reconnect_required: 'reconnect',
              device_pairing_required: 'pairDevice',
              access_changed: 'changed',
              no_scopes: 'scope',
              invalid_date: 'noDate',
              not_configured: 'offline',
            }[e.message] || 'error';
      } finally {
        if (current()) {
          busy = false;
          draw();
        }
      }
    }
    async function load(current) {
      if (!account) return;
      const identity = await account.status();
      if (!current()) return;
      signed = identity.loggedIn;
      data = null;
      status = null;
      if (!signed) return;
      const s = await api('status');
      if (!current()) return;
      status = s;
      const stored = (await ctx.loadData()) || {};
      if (!current()) return;
      spaceKey = stored[s.accountId] || '';
      if (s.connected && s.configured && spaceKey) {
        const result = await api('summary', 'POST', {
          endDate: date,
          timezone: zone,
          grantId: s.grantId,
          spaceKey,
        });
        if (current()) data = result;
      }
    }
    async function start(current) {
      const r = await api('xiaomi/start', 'POST', { accountId: status.accountId });
      if (!current()) return;
      const target = new URL(r.url);
      if (target.origin !== 'https://account.xiaomi.com' || target.pathname !== '/oauth2/authorize')
        throw new Error();
      url = target.href;
      proof = '';
    }
    function duration(min) {
      if (min === null) return '—';
      const h = Math.floor(min / 60),
        m = Math.round(min % 60);
      return h ? h + ' ' + t('hour') + ' ' + m + ' ' + t('minutes') : m + ' ' + t('minutes');
    }
    function draw() {
      body.replaceChildren();
      header?.update({ title: t('title') });
      const group = node(body, 'div', undefined, 'fh-group');
      node(group, 'h2', t(status?.connected && !url ? 'week' : 'source'));
      if (error) node(group, 'p', t(error), 'fh-error').setAttribute('role', 'alert');
      if (note) node(group, 'p', t(note));
      if (!account) {
        node(group, 'p', t('unavailable'));
        return;
      }
      if (!signed) {
        if (!busy) {
          node(group, 'p', t('signInHint'));
          action(group, 'signIn', async (current) => {
            await account.login();
            if (current()) await load(current);
          });
        }
      } else if (url) {
        node(group, 'p', t('proofHint'));
        const link = node(group, 'a', t('open'));
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const controls = node(group, 'div', undefined, 'fh-row');
        const label = node(controls, 'label', t('code') + ' ');
        const input = node(label, 'input');
        input.maxLength = 16;
        input.autocomplete = 'one-time-code';
        input.value = proof;
        const confirm = action(controls, 'confirm', async (current) => {
          const confirmed = await api('xiaomi/confirm', 'POST', { proof, grantId: status.grantId, spaceKey });
          if (!current()) return;
          const stored = (await ctx.loadData()) || {};
          if (!current()) return;
          await ctx.saveData({ ...stored, [confirmed.accountId]: confirmed.spaceKey });
          if (!current()) return;
          url = '';
          proof = '';
          await load(current);
        });
        input.oninput = () => {
          proof = input.value;
          confirm.disabled = busy || proof.trim().length !== 16;
        };
        input.oninput();
        action(controls, 'cancel', async () => {
          url = '';
          proof = '';
        });
      } else if (status?.connected && !spaceKey) {
        node(group, 'p', t(status.configured ? 'pairDevice' : 'offline'));
        if (status.configured) action(group, 'relink', start);
      } else if (status?.connected) {
        const controls = node(group, 'div', undefined, 'fh-row'),
          label = node(controls, 'label', t('end') + ' ');
        const end = node(label, 'input');
        end.type = 'date';
        end.max = today();
        end.value = date;
        end.disabled = busy;
        end.onchange = () => {
          date = end.value;
          data = null;
          run(load);
        };
        action(controls, 'refresh', load);
        if (!status.configured) node(group, 'p', t('offline'));
        if (data) {
          const wrap = node(group, 'div', undefined, 'fh-table'),
            table = node(wrap, 'table'),
            headings = node(node(table, 'thead'), 'tr');
          for (const k of ['date', 'steps', 'sleep', 'workouts', 'duration'])
            node(headings, 'th', t(k)).scope = 'col';
          const rows = node(table, 'tbody');
          for (const day of [...data.days].reverse()) {
            const row = node(rows, 'tr');
            for (const val of [
              day.date,
              day.steps?.toLocaleString() ?? '—',
              duration(day.sleepMinutes),
              day.workouts ?? '—',
              duration(day.workoutSeconds === null ? null : Math.round(day.workoutSeconds / 60)),
            ])
              node(row, 'td', val);
          }
          node(
            group,
            'p',
            t(
              data.days.some((d) => d.steps !== null || d.sleepMinutes !== null || d.workouts > 0)
                ? 'missing'
                : 'empty',
            ),
          );
        }
        const settings = node(body, 'div', undefined, 'fh-group fh-settings');
        node(settings, 'strong', t('source') + ' · ' + t('enabled'));
        const agentLabel = node(settings, 'label', undefined, 'fh-row');
        const toggle = node(agentLabel, 'input');
        toggle.type = 'checkbox';
        toggle.checked = status.agentEnabled;
        toggle.disabled = busy || (!status.configured && !status.agentEnabled);
        node(agentLabel, 'span', t('agent'));
        toggle.onchange = () => {
          const enabled = toggle.checked;
          run(async (current) => {
            await api('agent-access', 'POST', { enabled, grantId: status.grantId, spaceKey });
            if (current()) status.agentEnabled = enabled;
          });
        };
        const buttons = node(settings, 'div', undefined, 'fh-row');
        if (status.configured) action(buttons, 'relink', start);
        action(buttons, 'disconnect', async (current) => {
          const yes = await ctx.ui.confirm({ title: t('disconnectQ'), ok: t('disconnect'), danger: true });
          if (!yes || !current()) return;
          await api('xiaomi', 'DELETE', { grantId: status.grantId, spaceKey });
          if (!current()) return;
          await load(current);
          if (current()) note = 'disconnected';
        });
      } else if (status) {
        node(group, 'p', t(status.configured ? 'connectHint' : 'offline'));
        if (status.configured) action(group, 'connect', start);
      } else if (error) action(group, 'retry', load);
      if (busy) node(group, 'p', t('loading')).setAttribute('role', 'status');
    }
    const change = () => {
      epoch++;
      url = '';
      proof = '';
      signed = false;
      status = null;
      data = null;
      spaceKey = '';
      date = today();
      run(load);
    };
    const unsub = account?.subscribe?.(change),
      locale = ctx.subscribeLocale?.(draw);
    run(load);
    return () => {
      live = false;
      epoch++;
      unsub?.();
      locale?.();
      header?.dispose();
      body.remove();
    };
  },
});
