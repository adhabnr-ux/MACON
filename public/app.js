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

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtAgo = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute ago' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const fmtMins = (sec) => (sec >= 90 ? `${Math.round(sec / 60)} min` : `${sec} s`);

// Relay mode: the Mac wakes itself on a timer and checks in, so a request is "queued" until then.
function relayUi(s, state) {
  const r = s.relay || {};
  const now = s.now || Date.now();
  if (state === 'queued') {
    const left = s.wake.expectedBy ? s.wake.expectedBy - now : null;
    const hint = left === null ? 'Waiting for your Mac to check in.'
      : left > 0 ? `Your Mac checks in every ~${fmtMins(r.intervalSec)}. Expected by ${fmtTime(s.wake.expectedBy)}.`
      : 'Your Mac is due to check in any moment…';
    return { b: 'waking', label: 'Queued', status: 'Wake request sent', hint };
  }
  if (state === 'expired') {
    return { b: 'error', label: 'Retry', status: 'Your Mac didn’t check in', hint: `No check-in within ${fmtMins(s.wake.ttlSec)}. It may be shut down, offline, or on a low-power schedule. Tap to retry.` };
  }
  if (state === 'awake' || s.awake === true) {
    return { b: 'awake', label: 'Awake', status: '✓ Your Mac is awake', hint: 'Go to your Mac and enter your password on the lock screen.' };
  }
  if (!r.agentSeenAt) return { b: 'asleep', label: 'Wake', status: 'Mac agent not connected yet', hint: 'Install the agent on your Mac (see README), then tap Wake.' };
  const ago = now - r.agentSeenAt;
  const stale = ago > Math.max(3 * r.intervalSec * 1000, 20 * 60000);
  return {
    b: stale ? 'error' : 'asleep', label: 'Wake',
    status: stale ? `Mac last seen ${fmtAgo(ago)}` : 'Your Mac is asleep',
    hint: stale ? 'It may be shut down or offline. Wake will keep trying for ' + fmtMins(s.wake.ttlSec) + '.'
      : `Tap Wake. It wakes at its next check-in (every ~${fmtMins(r.intervalSec)}). Last seen ${fmtAgo(ago)}.`,
  };
}

function render(s) {
  $('name').textContent = s.name || 'Mac';
  const state = s.wake?.state || 'idle';
  const busy = state === 'sending' || state === 'waiting' || state === 'queued';
  const btn = $('wake');
  let ui;
  if (s.mode === 'relay') ui = relayUi(s, state);
  else if (busy) ui = { b: 'waking', label: 'Waking…', status: 'Waking your Mac…', hint: 'Sending wake signals. This can take up to a minute.' };
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
  schedule(busy ? 3000 : 8000);
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
    $('subtitle').textContent = 'Can’t reach the server. Check your connection (or Tailscale, if you use it).';
    if ($('app').dataset.view === 'loading') show('control');
    schedule(4000);
  }
}

$('wake').addEventListener('click', async () => {
  if (Date.now() - lastPress < 800) return;
  lastPress = Date.now();
  if (navigator.vibrate) navigator.vibrate(20);
  const btn = $('wake');
  btn.dataset.state = 'waking'; $('wake-label').textContent = 'Sending…'; btn.disabled = true;
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
