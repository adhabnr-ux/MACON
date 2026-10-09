import dgram from 'node:dgram';
import { hashPin } from '../src/auth.js';
import { validateConfig } from '../src/config.js';

export const PIN = 'correct-pin-123';
export const MAC = 'AA:BB:CC:DD:EE:FF';

export function testConfig(over = {}) {
  return validateConfig({
    name: 'Test Mac', host: '127.0.0.1', port: 8787, mac: MAC, macIp: '', broadcast: [], prefix: 24,
    probePorts: [], wakePorts: [9], sessionDays: 1, trustProxy: false,
    pinHash: hashPin(PIN), secret: 'x'.repeat(48), ...over,
  });
}

/** UDP listener on an ephemeral loopback port that records packets. */
export async function udpSink() {
  const sock = dgram.createSocket('udp4');
  const packets = [];
  sock.on('message', (m) => packets.push(m));
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  return { port: sock.address().port, packets, close: () => sock.close() };
}
