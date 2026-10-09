import net from 'node:net';
import { execFile } from 'node:child_process';

/** TCP connect probe. Resolves true if the port accepts a connection (or actively refuses = host is up). */
export function tcpProbe(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', (err) => done(err.code === 'ECONNREFUSED')); // refused => a live IP stack answered
  });
}

/** ICMP echo via the system `ping`. Resolves false if ping is unavailable. */
export function icmpProbe(host, timeoutSec = 1) {
  return new Promise((resolve) => {
    const args = process.platform === 'darwin'
      ? ['-c', '1', '-W', String(timeoutSec * 1000), host]
      : ['-c', '1', '-W', String(timeoutSec), host];
    execFile('ping', args, { timeout: (timeoutSec + 1) * 1000 }, (err) => resolve(!err));
  });
}

/**
 * Is the Mac reachable (awake)? A Mac asleep behind a Bonjour Sleep Proxy answers ARP but not
 * ICMP/TCP, so a reply from ping OR any probe port means the machine itself is up.
 * Returns null if no macIp is configured (status unknown).
 */
export async function isAwake({ macIp, probePorts = [] }, { icmp = icmpProbe, tcp = tcpProbe } = {}) {
  if (!macIp) return null;
  const checks = [icmp(macIp), ...probePorts.map((p) => tcp(macIp, p))];
  return new Promise((resolve) => {
    let pending = checks.length;
    for (const c of checks) {
      c.then((ok) => {
        if (ok) resolve(true);
        else if (--pending === 0) resolve(false);
      });
    }
  });
}
