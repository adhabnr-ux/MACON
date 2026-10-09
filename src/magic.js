// Wake-on-LAN magic packet helpers.

/** Normalise a MAC address to lowercase "aa:bb:cc:dd:ee:ff". Throws on bad input. */
export function normalizeMac(input) {
  const raw = String(input ?? '').trim();
  const hex = raw.replace(/[:\-.]/g, '').toLowerCase();
  if (!/^[0-9a-f:.\-]+$/i.test(raw) || !/^[0-9a-f]{12}$/.test(hex)) {
    throw new Error(`Invalid MAC address: "${raw}" (expected e.g. aa:bb:cc:dd:ee:ff)`);
  }
  if (hex === '000000000000' || hex === 'ffffffffffff') {
    throw new Error(`Refusing reserved MAC address: "${raw}"`);
  }
  return hex.match(/../g).join(':');
}

/** 102-byte magic packet: 6 x 0xFF followed by the MAC repeated 16 times. */
export function buildMagicPacket(mac) {
  const bytes = Buffer.from(normalizeMac(mac).replace(/:/g, ''), 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

/** Directed broadcast for an IPv4 address + prefix length, e.g. 192.168.1.20/24 -> 192.168.1.255 */
export function directedBroadcast(ip, prefix = 24) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 address: "${ip}"`);
  }
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`Invalid prefix: ${prefix}`);
  const addr = parts.reduce((a, n) => ((a << 8) | n) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const b = (addr | ~mask) >>> 0;
  return [b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join('.');
}
