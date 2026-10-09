import dgram from 'node:dgram';
import { buildMagicPacket } from './magic.js';
import { tcpProbe } from './probe.js';

/** Send one magic packet to one destination. `ports`/`addresses` are fully configurable (tests use loopback). */
export function sendMagicPacket({ mac, address, port }) {
  const packet = buildMagicPacket(mac);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', (e) => { sock.close(); reject(e); });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch { /* ignore */ }
      sock.send(packet, port, address, (err) => {
        sock.close();
        err ? reject(err) : resolve();
      });
    });
  });
}

/**
 * Orchestrates a wake attempt. Strategy (all aimed at the ONE configured Mac):
 *  1. Magic packets to every broadcast address (+ unicast to macIp) on every wake port, in several rounds.
 *  2. "Knock" the Mac's service ports - connecting to an advertised service is what makes an
 *     Apple Bonjour Sleep Proxy (Apple TV / HomePod) wake a sleeping Mac, including over Wi-Fi.
 *  3. Poll until the Mac answers twice in a row (avoids Dark Wake false positives) or we time out.
 */
export function createWaker(cfg, deps = {}) {
  const {
    send = sendMagicPacket,
    knock = (ip, port) => tcpProbe(ip, port, 400),
    awake = async () => null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    rounds = 6,
    roundGapMs = 1500,
    timeoutMs = 60_000,
    pollMs = 2000,
    cooldownMs = 4000,
  } = deps;

  let job = null; // { state, startedAt, finishedAt, packets, error }

  const snapshot = () => (job ? { ...job } : { state: 'idle' });

  async function run(j) {
    try {
      const targets = [...cfg.broadcast, ...(cfg.macIp ? [cfg.macIp] : [])];
      for (let i = 0; i < rounds; i++) {
        const results = await Promise.allSettled(
          targets.flatMap((address) => cfg.wakePorts.map((port) => send({ mac: cfg.mac, address, port }))),
        );
        j.packets += results.filter((r) => r.status === 'fulfilled').length;
        if (!j.packets && i === rounds - 1) throw new Error('No magic packet could be sent (network unreachable?)');
        if (cfg.macIp) await Promise.allSettled(cfg.probePorts.map((p) => knock(cfg.macIp, p)));
        if (i < rounds - 1) await sleep(roundGapMs);
      }
      j.state = 'waiting';
      if (!cfg.macIp) { j.state = 'sent'; j.finishedAt = now(); return; } // can't confirm without an IP
      let streak = 0;
      const deadline = now() + timeoutMs;
      while (now() < deadline) {
        streak = (await awake()) ? streak + 1 : 0;
        if (streak >= 2) { j.state = 'awake'; j.finishedAt = now(); return; }
        await sleep(pollMs);
      }
      j.state = 'timeout';
      j.finishedAt = now();
    } catch (e) {
      j.state = 'error';
      j.error = e.message;
      j.finishedAt = now();
    }
  }

  return {
    status: snapshot,
    /** Starts a wake. Returns { started, job }. Ignores re-presses while a wake is running or cooling down. */
    start() {
      if (job && ['sending', 'waiting'].includes(job.state)) return { started: false, reason: 'busy', job: snapshot() };
      if (job?.finishedAt && now() - job.finishedAt < cooldownMs) return { started: false, reason: 'cooldown', job: snapshot() };
      job = { state: 'sending', startedAt: now(), packets: 0 };
      const j = job;
      run(j).catch(() => {});
      return { started: true, job: snapshot() };
    },
    /** Resolves when the current job finishes (used by CLI and tests). */
    async finished() {
      while (job && ['sending', 'waiting'].includes(job.state)) await sleep(20);
      return snapshot();
    },
  };
}
