import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { normalizeMac, directedBroadcast } from './magic.js';

export const DEFAULT_CONFIG_PATH = path.resolve(process.env.MACON_CONFIG || 'macon.config.json');

const DEFAULTS = {
  name: 'My Mac',
  host: '0.0.0.0',
  port: 8787,
  macIp: '',            // the Mac's LAN IP (used for status + unicast wake). Strongly recommended.
  broadcast: [],        // extra broadcast addresses; subnet broadcast is derived from macIp/prefix
  prefix: 24,
  probePorts: [22, 5900, 445, 548],
  wakePorts: [9, 7],
  sessionDays: 90,
  trustProxy: false,    // true when behind `tailscale serve` / a reverse proxy
  pinHash: '',
  secret: '',
};

export function loadConfig(file = DEFAULT_CONFIG_PATH, env = process.env) {
  let fileCfg = {};
  if (fs.existsSync(file)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Could not parse ${file}: ${e.message}`);
    }
  }
  const e = {};
  if (env.MACON_MAC) e.mac = env.MACON_MAC;
  if (env.MACON_MAC_IP) e.macIp = env.MACON_MAC_IP;
  if (env.MACON_PORT) e.port = Number(env.MACON_PORT);
  if (env.MACON_HOST) e.host = env.MACON_HOST;
  if (env.MACON_PIN_HASH) e.pinHash = env.MACON_PIN_HASH;
  if (env.MACON_SECRET) e.secret = env.MACON_SECRET;
  if (env.MACON_TRUST_PROXY) e.trustProxy = env.MACON_TRUST_PROXY === '1' || env.MACON_TRUST_PROXY === 'true';
  return validateConfig({ ...DEFAULTS, ...fileCfg, ...e });
}

export function validateConfig(cfg) {
  const out = { ...cfg };
  if (!out.mac) throw new Error('Config: "mac" (the Mac\'s MAC address) is required. Run `node bin/macon.js init`.');
  out.mac = normalizeMac(out.mac);
  if (out.macIp && net.isIPv4(out.macIp) === false) throw new Error(`Config: macIp "${out.macIp}" is not a valid IPv4 address`);
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('Config: port must be 1-65535');
  if (!out.pinHash || !/^scrypt\$/.test(out.pinHash)) throw new Error('Config: pinHash missing. Run `node bin/macon.js init`.');
  if (!out.secret || out.secret.length < 32) throw new Error('Config: secret missing or too short. Run `node bin/macon.js init`.');
  const bc = new Set((out.broadcast || []).map(String));
  bc.add('255.255.255.255');
  if (out.macIp) bc.add(directedBroadcast(out.macIp, out.prefix));
  out.broadcast = [...bc];
  return Object.freeze(out);
}

export function saveConfig(cfg, file = DEFAULT_CONFIG_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}
