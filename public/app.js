const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Macon': '1' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, data };
};

let timer = null;
let lastPress = 0;

function show(view) {
  $('login').hidden = view !== 'login';
  $('control').hidden = view !== 'control';
  $('app').dataset.view = view;
}

function render(s) {
  $('name').textContent = s.name || 'Mac';
  const state = s.wake?.state || 'idle';
  const busy = state === 'sending' || state === 'waiting';
  const btn = $('wake');
  let ui;
  if (busy) ui = { b: 'waking', label: 'Waking…', status: 'Waking your Mac…', hint: 'Sending wake signals. This can take up to a minute.' };
  else if (state === 'awake' || (s.awake === true && state !== 'error')) ui = { b: 'awake', label: 'Awake', status: '✓ Your Mac is awake', hint: 'Go to your Mac and enter your password on the lock screen.' };
  else if (state === 'error') ui = { b: 'error', label: 'Retry', status: 'Couldn’t send the wake signal', hint: s.wake.error || 'Check that this server is on your network.' };
  else if (state === 'timeout') ui = { b: 'error', label: 'Retry', status: 'No response from your Mac', hint: 'Signals were sent but the Mac didn’t answer. Is it plugged in / on Ethernet? See the README troubleshooting.' };
  else if (state === 'sent') ui = { b: 'awake', label: 'Sent', status: 'Wake signal sent', hint: 'Set macIp in the config to also confirm when the Mac is up.' };
  else ui = { b: 'asleep', label: 'Wake', status: s.awake === false ? 'Your Mac looks asleep' : s.canConfirm ? '' : 'Ready', hint: 'Tap to wake. Your Mac will ask for your password.' };
  btn.dataset.state = ui.b;
  $('wake-label').textContent = ui.label;
  btn.disabled = busy;
  $('status').textContent = ui.status;
  $('hint').textContent = ui.hint;
  $('subtitle').textContent = '';
  schedule(busy ? 1500 : 8000);
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(refresh, ms);
}

async function refresh() {
  if (document.hidden) return schedule(8000);
  try {
    const r = await api('/api/status');
    if (r.status === 401) return show('login');
    if (!r.ok) throw new Error();
    show('control');
    render(r.data);
  } catch {
    $('subtitle').textContent = 'Can’t reach the server. Is your phone on Tailscale / home Wi-Fi?';
    if ($('app').dataset.view === 'loading') show('control');
    schedule(4000);
  }
}

$('wake').addEventListener('click', async () => {
  if (Date.now() - lastPress < 800) return;
  lastPress = Date.now();
  if (navigator.vibrate) navigator.vibrate(20);
  const btn = $('wake');
  btn.dataset.state = 'waking'; $('wake-label').textContent = 'Waking…'; btn.disabled = true;
  const r = await api('/api/wake', { method: 'POST' }).catch(() => ({ ok: false, status: 0, data: {} }));
  if (r.status === 401) return show('login');
  refresh();
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const r = await api('/api/login', { method: 'POST', body: { pin: $('pin').value } }).catch(() => ({ ok: false, status: 0, data: {} }));
  $('pin').value = '';
  if (r.ok) return refresh();
  $('login-error').textContent = r.status === 429 ? 'Too many attempts. Try again later.' : r.status === 0 ? 'Can’t reach the server.' : 'Wrong PIN';
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  show('login');
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
refresh();
